/**
 * Shop service tests against real Miniflare D1 (not mocks).
 *
 * The security-critical guarantees — the insert→changes()→debit cascade,
 * in-SQL eligibility against the CURRENT balance, and the EXISTS equip
 * guard — are integration-level behaviors of the actual D1 batch, so they
 * are proven on real workerd SQLite following the bootstrap pattern of
 * `src/lib/missions/claim.test.ts`.
 */

import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { Miniflare } from 'miniflare';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import type { D1Database } from '@cloudflare/workers-types';

import { purchaseShopItem, equipShopItem, readShopState } from './service';
import { DEFAULT_SHOP_ITEM_ID_BY_KIND, type ShopItemId } from './catalog';

const MIGRATIONS_DIR = join(process.cwd(), 'drizzle');
const MIGRATION_FILES = readdirSync(MIGRATIONS_DIR)
	.filter((f) => f.endsWith('.sql'))
	.sort();

async function applyMigrations(d1: D1Database): Promise<void> {
	for (const file of MIGRATION_FILES) {
		const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf-8');
		const statements = sql
			.split('--> statement-breakpoint')
			.map((s) => s.trim())
			.filter((s) => s.length > 0);
		const prepared = statements.map((stmt) => d1.prepare(stmt));
		await d1.batch(prepared);
	}
}

async function insertUser(d1: D1Database, id: string, chipBalance = 10000): Promise<void> {
	await d1
		.prepare(
			'INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt, chipBalance) VALUES (?, ?, ?, ?, ?, ?, ?)',
		)
		.bind(id, `Test ${id}`, `${id}@test.local`, 0, 1000, 1000, chipBalance)
		.run();
}

async function getChipBalance(d1: D1Database, userId: string): Promise<number> {
	const row = await d1
		.prepare('SELECT chipBalance FROM user WHERE id = ?')
		.bind(userId)
		.first<{ chipBalance: number }>();
	return row?.chipBalance ?? -1;
}

async function getOwnedRows(
	d1: D1Database,
	userId: string,
): Promise<Array<{ itemId: string; purchasedAt: number; equipped: number }>> {
	return d1
		.prepare('SELECT itemId, purchasedAt, equipped FROM user_cosmetic WHERE userId = ?')
		.bind(userId)
		.all<{ itemId: string; purchasedAt: number; equipped: number }>()
		.then((r) => r.results ?? []);
}

async function countRows(d1: D1Database, userId: string): Promise<number> {
	const row = await d1
		.prepare('SELECT COUNT(*) AS n FROM user_cosmetic WHERE userId = ?')
		.bind(userId)
		.first<{ n: number }>();
	return row?.n ?? 0;
}

describe('purchaseShopItem (Miniflare D1 integration)', () => {
	let mf: Miniflare | null = null;
	let db: D1Database | null = null;

	beforeAll(async () => {
		mf = new Miniflare({
			modules: [
				{
					type: 'ESModule',
					path: 'file:///entry.js',
					contents: 'export default { fetch() { return new Response("ok"); } }',
				},
			],
			d1Databases: { DB: 'shop-service-test' },
			d1Persist: false,
		});
		await mf.ready;
		db = (await mf.getD1Database('DB')) as unknown as D1Database;
		await applyMigrations(db);
	});

	afterAll(async () => {
		if (mf) await mf.dispose();
	});

	test('affordable purchase debits once, inserts ownership, returns post-debit balance from RETURNING', async () => {
		const userId = 'buy-ok';
		await insertUser(db!, userId, 10000);

		const result = await purchaseShopItem(db!, userId, 'card-back-sapphire');

		expect(result.status).toBe('purchased');
		expect(result.itemId).toBe('card-back-sapphire');
		// Balance comes from the batch's RETURNING row, not a stale cache.
		expect(result.chipBalance).toBe(5000);
		expect(await getChipBalance(db!, userId)).toBe(5000);

		const rows = await getOwnedRows(db!, userId);
		expect(rows).toHaveLength(1);
		expect(rows[0].itemId).toBe('card-back-sapphire');
		expect(rows[0].equipped).toBe(0);
		// purchasedAt is unix seconds (not ms).
		expect(rows[0].purchasedAt).toBeGreaterThan(1_000_000_000);
		expect(rows[0].purchasedAt).toBeLessThan(10_000_000_000);

		// The debit stamps user.updatedAt like the other wallet mutations.
		const userRow = await db!
			.prepare('SELECT updatedAt FROM user WHERE id = ?')
			.bind(userId)
			.first<{ updatedAt: number }>();
		expect(userRow?.updatedAt).toBeGreaterThan(1_000_000_000);
	});

	test('exact boundary balance succeeds (price == balance)', async () => {
		const userId = 'buy-boundary';
		await insertUser(db!, userId, 5000);

		const result = await purchaseShopItem(db!, userId, 'card-back-sapphire');

		expect(result.status).toBe('purchased');
		expect(result.chipBalance).toBe(0);
		expect(await getChipBalance(db!, userId)).toBe(0);
	});

	test('duplicate purchase is already-owned and never debits', async () => {
		const userId = 'buy-dup';
		await insertUser(db!, userId, 10000);
		await purchaseShopItem(db!, userId, 'felt-sapphire');

		const result = await purchaseShopItem(db!, userId, 'felt-sapphire');

		expect(result.status).toBe('already-owned');
		expect(result.itemId).toBe('felt-sapphire');
		expect(result.chipBalance).toBe(5000);
		expect(await getChipBalance(db!, userId)).toBe(5000);
		expect(await countRows(db!, userId)).toBe(1);
	});

	test('unaffordable purchase is insufficient and never debits', async () => {
		const userId = 'buy-poor';
		await insertUser(db!, userId, 4999);

		const result = await purchaseShopItem(db!, userId, 'card-back-sapphire');

		expect(result.status).toBe('insufficient');
		expect(result.chipBalance).toBe(4999);
		expect(await getChipBalance(db!, userId)).toBe(4999);
		expect(await countRows(db!, userId)).toBe(0);
	});

	test('missing user is user-not-found, never insufficient, and writes nothing', async () => {
		const result = await purchaseShopItem(db!, 'ghost-user', 'card-back-sapphire');

		expect(result.status).toBe('user-not-found');
		expect(await countRows(db!, 'ghost-user')).toBe(0);
	});

	test('default purchase is rejected without mutation', async () => {
		const userId = 'buy-default';
		await insertUser(db!, userId, 10000);

		const result = await purchaseShopItem(db!, userId, 'card-back-default');

		expect(result.status).toBe('not-purchasable');
		expect(await getChipBalance(db!, userId)).toBe(10000);
		expect(await countRows(db!, userId)).toBe(0);
	});

	test('an unknown catalog ID fails loudly and never mutates the wallet', async () => {
		const userId = 'buy-unknown';
		await insertUser(db!, userId, 10000);

		// Outside the closed union (API routes reject these first); the service
		// must not silently debit or insert for an item it cannot price.
		await expect(purchaseShopItem(db!, userId, 'card-back-gold' as ShopItemId)).rejects.toThrow();
		expect(await getChipBalance(db!, userId)).toBe(10000);
		expect(await countRows(db!, userId)).toBe(0);
	});

	test('two concurrent same-item purchases insert one row and debit once', async () => {
		const userId = 'buy-race-same';
		await insertUser(db!, userId, 10000);

		const [a, b] = await Promise.all([
			purchaseShopItem(db!, userId, 'felt-sapphire'),
			purchaseShopItem(db!, userId, 'felt-sapphire'),
		]);

		// The PK + ON CONFLICT DO NOTHING admits at most one row, and the
		// changes() cascade debits only for that one insert.
		const statuses = [a.status, b.status].sort();
		expect(statuses).toEqual(['already-owned', 'purchased']);
		const winner = a.status === 'purchased' ? a : b;
		expect(winner.chipBalance).toBe(5000);
		expect(await getChipBalance(db!, userId)).toBe(5000);
		expect(await countRows(db!, userId)).toBe(1);
	}, 20000);

	test('two concurrent different-item purchases cannot overdraw', async () => {
		const userId = 'buy-race-diff';
		await insertUser(db!, userId, 5000);

		const [a, b] = await Promise.all([
			purchaseShopItem(db!, userId, 'card-back-sapphire'),
			purchaseShopItem(db!, userId, 'felt-sapphire'),
		]);

		// Both cost 5,000 but only 5,000 chips exist: eligibility is evaluated
		// in-SQL against the CURRENT balance, so exactly one can win.
		const winners = [a, b].filter((r) => r.status === 'purchased');
		expect(winners).toHaveLength(1);
		const losers = [a, b].filter((r) => r.status === 'insufficient');
		expect(losers).toHaveLength(1);
		expect(await getChipBalance(db!, userId)).toBe(0);
		expect(await countRows(db!, userId)).toBe(1);
		// Winner's balance comes from the real RETURNING row.
		expect(winners[0].chipBalance).toBe(0);
	});
});

describe('equipShopItem (Miniflare D1 integration)', () => {
	let mf: Miniflare | null = null;
	let db: D1Database | null = null;

	beforeAll(async () => {
		mf = new Miniflare({
			modules: [
				{
					type: 'ESModule',
					path: 'file:///entry.js',
					contents: 'export default { fetch() { return new Response("ok"); } }',
				},
			],
			d1Databases: { DB: 'shop-equip-test' },
			d1Persist: false,
		});
		await mf.ready;
		db = (await mf.getD1Database('DB')) as unknown as D1Database;
		await applyMigrations(db);
	});

	afterAll(async () => {
		if (mf) await mf.dispose();
	});

	async function buy(
		db: D1Database,
		userId: string,
		itemId: Parameters<typeof purchaseShopItem>[2],
	) {
		const result = await purchaseShopItem(db, userId, itemId);
		expect(result.status).toBe('purchased');
	}

	test('equipping an owned paid item selects it within its kind', async () => {
		const userId = 'eq-basic';
		await insertUser(db!, userId, 100000);
		await buy(db!, userId, 'card-back-crimson');

		const result = await equipShopItem(db!, userId, 'card-back-crimson');

		expect(result).toEqual({
			status: 'equipped',
			kind: 'card-back',
			equippedItemId: 'card-back-crimson',
		});
		const rows = await getOwnedRows(db!, userId);
		expect(rows).toHaveLength(1);
		expect(rows[0].equipped).toBe(1);
	});

	test('equipping another paid item of the same kind replaces the selection and keeps the other kind', async () => {
		const userId = 'eq-replace';
		await insertUser(db!, userId, 200000);
		await buy(db!, userId, 'card-back-sapphire');
		await buy(db!, userId, 'card-back-jade');
		await buy(db!, userId, 'felt-sapphire');
		await equipShopItem(db!, userId, 'card-back-sapphire');
		await equipShopItem(db!, userId, 'felt-sapphire');

		const result = await equipShopItem(db!, userId, 'card-back-jade');

		expect(result.status).toBe('equipped');
		const rows = await getOwnedRows(db!, userId);
		const equippedByItem = Object.fromEntries(rows.map((r) => [r.itemId, r.equipped]));
		// Card-back selection replaced sapphire → jade…
		expect(equippedByItem['card-back-jade']).toBe(1);
		expect(equippedByItem['card-back-sapphire']).toBe(0);
		// …while the other kind's selection is untouched.
		expect(equippedByItem['felt-sapphire']).toBe(1);
	});

	test('equipping an unknown catalog ID fails loudly and leaves rows untouched', async () => {
		const userId = 'eq-unknown';
		await insertUser(db!, userId, 100000);
		await buy(db!, userId, 'felt-crimson');
		await equipShopItem(db!, userId, 'felt-crimson');

		await expect(equipShopItem(db!, userId, 'felt-gold' as ShopItemId)).rejects.toThrow();

		const rows = await getOwnedRows(db!, userId);
		expect(rows).toHaveLength(1);
		expect(rows[0].itemId).toBe('felt-crimson');
		expect(rows[0].equipped).toBe(1);
	});

	test('equipping an unowned paid item fails NOT_OWNED and cannot clear the previous selection', async () => {
		const userId = 'eq-unowned';
		await insertUser(db!, userId, 100000);
		await buy(db!, userId, 'felt-crimson');
		await equipShopItem(db!, userId, 'felt-crimson');

		const result = await equipShopItem(db!, userId, 'felt-jade');

		expect(result.status).toBe('not-owned');
		const rows = await getOwnedRows(db!, userId);
		expect(rows).toHaveLength(1);
		expect(rows[0].itemId).toBe('felt-crimson');
		expect(rows[0].equipped).toBe(1);
	});

	test('equipping a free default clears only its kind and inserts no row', async () => {
		const userId = 'eq-default';
		await insertUser(db!, userId, 200000);
		await buy(db!, userId, 'card-back-sapphire');
		await buy(db!, userId, 'felt-sapphire');
		await equipShopItem(db!, userId, 'card-back-sapphire');
		await equipShopItem(db!, userId, 'felt-sapphire');

		const result = await equipShopItem(db!, userId, 'card-back-default');

		expect(result).toEqual({
			status: 'equipped',
			kind: 'card-back',
			equippedItemId: 'card-back-default',
		});
		const rows = await getOwnedRows(db!, userId);
		const equippedByItem = Object.fromEntries(rows.map((r) => [r.itemId, r.equipped]));
		// Card-back cleared back to the implicit default…
		expect(equippedByItem['card-back-sapphire']).toBe(0);
		// …felt selection untouched, and no default row was inserted.
		expect(equippedByItem['felt-sapphire']).toBe(1);
		expect(await countRows(db!, userId)).toBe(2);
	});

	test('selection remains after a fresh service read (no write-only state)', async () => {
		const userId = 'eq-readback';
		await insertUser(db!, userId, 200000);
		await buy(db!, userId, 'felt-jade');
		await equipShopItem(db!, userId, 'felt-jade');

		const state = await readShopState(db!, userId);
		expect(state.ownedItemIds).toEqual(['felt-jade']);
		expect(state.equippedByKind['felt']).toBe('felt-jade');
		expect(state.equippedByKind['card-back']).toBe(DEFAULT_SHOP_ITEM_ID_BY_KIND['card-back']);
	});
});

describe('readShopState (Miniflare D1 integration)', () => {
	let mf: Miniflare | null = null;
	let db: D1Database | null = null;

	beforeAll(async () => {
		mf = new Miniflare({
			modules: [
				{
					type: 'ESModule',
					path: 'file:///entry.js',
					contents: 'export default { fetch() { return new Response("ok"); } }',
				},
			],
			d1Databases: { DB: 'shop-state-test' },
			d1Persist: false,
		});
		await mf.ready;
		db = (await mf.getD1Database('DB')) as unknown as D1Database;
		await applyMigrations(db);
	});

	afterAll(async () => {
		if (mf) await mf.dispose();
	});

	test('a user with no rows gets implicit defaults and no ownership', async () => {
		const userId = 'state-empty';
		await insertUser(db!, userId);

		const state = await readShopState(db!, userId);
		expect(state.ownedItemIds).toEqual([]);
		expect(state.equippedByKind).toEqual({
			'card-back': 'card-back-default',
			felt: 'felt-default',
		});
	});

	test('rows map to owned IDs and equipped selections per kind', async () => {
		const userId = 'state-full';
		await insertUser(db!, userId, 100000);
		await db!
			.prepare(
				'INSERT INTO user_cosmetic (userId, itemId, purchasedAt, equipped) VALUES (?, ?, ?, ?)',
			)
			.bind(userId, 'card-back-crimson', 1700000000, 1)
			.run();
		await db!
			.prepare(
				'INSERT INTO user_cosmetic (userId, itemId, purchasedAt, equipped) VALUES (?, ?, ?, ?)',
			)
			.bind(userId, 'felt-jade', 1700000001, 0)
			.run();

		const state = await readShopState(db!, userId);
		expect([...state.ownedItemIds].sort()).toEqual(['card-back-crimson', 'felt-jade']);
		expect(state.equippedByKind['card-back']).toBe('card-back-crimson');
		// Owned but unequipped felt falls back to the default.
		expect(state.equippedByKind['felt']).toBe('felt-default');
	});

	test('unknown item rows are ignored so the catalog stays the sole authority', async () => {
		const userId = 'state-unknown';
		await insertUser(db!, userId);
		// Simulate a row written outside the current catalog (e.g. retired item).
		await db!
			.prepare(
				'INSERT INTO user_cosmetic (userId, itemId, purchasedAt, equipped) VALUES (?, ?, ?, ?)',
			)
			.bind(userId, 'card-back-gold', 1700000002, 1)
			.run();

		const state = await readShopState(db!, userId);
		expect(state.ownedItemIds).toEqual([]);
		expect(state.equippedByKind['card-back']).toBe('card-back-default');
	});
});
