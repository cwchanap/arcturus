/**
 * Miniflare integration test: proves the `WHERE changes() = 1` optimistic-lock
 * cascade in the roulette spin endpoint against real D1 (workerd SQLite),
 * not a mock simulation.
 *
 * The spin endpoint (src/pages/api/roulette/spin.ts) uses a D1 batch of 4
 * statements:
 *   1. UPDATE user SET chipBalance = ? WHERE id = ? AND chipBalance = ?
 *      (optimistic lock — only matches if balance hasn't changed)
 *   2. INSERT INTO roulette_round ... SELECT ... WHERE changes() = 1
 *   3. INSERT INTO chip_sync_receipt ... SELECT ... WHERE changes() = 1
 *   4. INSERT INTO game_stats ... SELECT ... WHERE changes() = 1
 *
 * Statements 2-4 gate on `changes() = 1` from statement 1. If a concurrent
 * request changed the balance between read and write, the UPDATE matches 0
 * rows, `changes()` returns 0, and all downstream inserts are skipped —
 * preventing phantom receipts/rounds.
 *
 * The mock in spin-api.test.ts simulates this by tracking `previousChanges`
 * in JS. This test proves the real D1/SQLite `changes()` function actually
 * propagates through a batch as expected.
 *
 * The same cascade pattern is shared with src/pages/api/chips/update.ts.
 */

import { describe, expect, test, afterAll, beforeAll } from 'bun:test';
import { Miniflare } from 'miniflare';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

let mf: Miniflare | null = null;
let db: Awaited<ReturnType<typeof mf.getD1Database>> | null = null;

const MIGRATIONS_DIR = join(process.cwd(), 'drizzle');
// Discover all migration files dynamically so future migrations are covered
// without manual list updates. Drizzle prefixes files with NNNN_, so lexical
// sort yields correct application order.
const MIGRATION_FILES = readdirSync(MIGRATIONS_DIR)
	.filter((f) => f.endsWith('.sql'))
	.sort();

async function applyMigrations(d1: Awaited<ReturnType<typeof mf.getD1Database>>): Promise<void> {
	const migrationsDir = join(process.cwd(), 'drizzle');
	for (const file of MIGRATION_FILES) {
		const sql = readFileSync(join(migrationsDir, file), 'utf-8');
		const statements = sql
			.split('--> statement-breakpoint')
			.map((s) => s.trim())
			.filter((s) => s.length > 0);
		// Use batch+prepare instead of exec — D1 exec splits on newlines and
		// chokes on multi-line CREATE TABLE statements.
		const prepared = statements.map((stmt) => d1.prepare(stmt));
		await d1.batch(prepared);
	}
}

async function insertUser(
	d1: Awaited<ReturnType<typeof mf.getD1Database>>,
	id: string,
	chipBalance: number,
): Promise<void> {
	await d1
		.prepare(
			'INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt, chipBalance, heldChips) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
		)
		.bind(id, `Test ${id}`, `${id}@test.local`, 0, 1000, 1000, chipBalance, 0)
		.run();
}

// The exact batch statements from src/pages/api/roulette/spin.ts (lines 316-381).
// Hardcoded here (not imported) to test the raw SQL against real D1 without
// pulling in the full Astro request handler.
function buildSpinBatch(
	d1: Awaited<ReturnType<typeof mf.getD1Database>>,
	params: {
		userId: string;
		syncId: string;
		winningNumber: number;
		betsJson: string;
		totalBet: number;
		totalPayout: number;
		netDelta: number;
		previousBalance: number;
		newBalance: number;
		nowSeconds: number;
		winsIncrement: number;
		lossesIncrement: number;
		biggestWinCandidate: number | null;
	},
): ReturnType<typeof d1.batch> {
	const {
		userId,
		syncId,
		winningNumber,
		betsJson,
		totalBet,
		totalPayout,
		netDelta,
		previousBalance,
		newBalance,
		nowSeconds,
		winsIncrement,
		lossesIncrement,
		biggestWinCandidate,
	} = params;

	const stmts = [
		d1
			.prepare('UPDATE user SET chipBalance = ?, updatedAt = ? WHERE id = ? AND chipBalance = ?')
			.bind(newBalance, nowSeconds, userId, previousBalance),
		d1
			.prepare(
				'INSERT INTO roulette_round (syncId, userId, winningNumber, betsJson, totalBet, totalPayout, netDelta, previousBalance, newBalance, createdAt) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE changes() = 1',
			)
			.bind(
				syncId,
				userId,
				winningNumber,
				betsJson,
				totalBet,
				totalPayout,
				netDelta,
				previousBalance,
				newBalance,
				nowSeconds,
			),
		d1
			.prepare(
				'INSERT INTO chip_sync_receipt (userId, syncId, gameType, previousBalance, balance, delta, statsDelta, outcome, handCount, winsIncrement, lossesIncrement, biggestWinCandidate, overallRank, achievementPayload, createdAt) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT COUNT(*) + 1 FROM user leaderboard_user WHERE leaderboard_user.chipBalance > ? OR (leaderboard_user.chipBalance = ? AND leaderboard_user.id < ?)), ?, ? WHERE changes() = 1',
			)
			.bind(
				userId,
				syncId,
				'roulette',
				previousBalance,
				newBalance,
				netDelta,
				netDelta,
				netDelta > 0 ? 'win' : netDelta < 0 ? 'loss' : 'push',
				1,
				winsIncrement,
				lossesIncrement,
				netDelta > 0 ? netDelta : 0,
				newBalance,
				newBalance,
				userId,
				null,
				nowSeconds,
			),
		d1
			.prepare(
				'INSERT INTO game_stats (userId, gameType, totalWins, totalLosses, handsPlayed, biggestWin, netProfit, updatedAt) SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE changes() = 1 ON CONFLICT(userId, gameType) DO UPDATE SET totalWins = game_stats.totalWins + excluded.totalWins, totalLosses = game_stats.totalLosses + excluded.totalLosses, handsPlayed = game_stats.handsPlayed + excluded.handsPlayed, biggestWin = CASE WHEN ? IS NULL THEN game_stats.biggestWin WHEN ? > 0 AND ? > game_stats.biggestWin THEN ? ELSE game_stats.biggestWin END, netProfit = game_stats.netProfit + excluded.netProfit, updatedAt = excluded.updatedAt',
			)
			.bind(
				userId,
				'roulette',
				winsIncrement,
				lossesIncrement,
				1,
				Math.max(biggestWinCandidate ?? 0, 0),
				netDelta,
				nowSeconds,
				biggestWinCandidate,
				biggestWinCandidate,
				biggestWinCandidate,
				biggestWinCandidate,
			),
	];
	return d1.batch(stmts);
}

describe('Roulette spin optimistic-lock cascade (Miniflare D1 integration)', () => {
	beforeAll(async () => {
		mf = new Miniflare({
			modules: [
				{
					type: 'ESModule',
					path: 'file:///entry.js',
					contents: 'export default { fetch() { return new Response("ok"); } }',
				},
			],
			d1Databases: { DB: 'roulette-cascade-test' },
			d1Persist: false,
		});
		await mf.ready;
		db = await mf.getD1Database('DB');
		await applyMigrations(db);
	});

	afterAll(async () => {
		if (mf) await mf.dispose();
	});

	test('successful spin: UPDATE matches → changes()=1 → all cascade inserts succeed', async () => {
		const userId = 'user-success';
		const syncId = 'sync-success-1';
		await insertUser(db!, userId, 1000);

		const results = await buildSpinBatch(db!, {
			userId,
			syncId,
			winningNumber: 17,
			betsJson: JSON.stringify([{ type: 'straight', amount: 10, target: 17 }]),
			totalBet: 10,
			totalPayout: 360,
			netDelta: 350,
			previousBalance: 1000,
			newBalance: 1350,
			nowSeconds: 1000,
			winsIncrement: 1,
			lossesIncrement: 0,
			biggestWinCandidate: 350,
		});

		// Statement 1: UPDATE matched 1 row
		expect(results[0].meta.changes).toBe(1);
		// Statements 2-4: all cascaded because changes()=1
		expect(results[1].meta.changes).toBe(1);
		expect(results[2].meta.changes).toBe(1);
		expect(results[3].meta.changes).toBe(1);

		// Verify user balance was updated
		const userRow = await db!
			.prepare('SELECT chipBalance FROM user WHERE id = ?')
			.bind(userId)
			.first<{ chipBalance: number }>();
		expect(userRow?.chipBalance).toBe(1350);

		// Verify roulette_round was inserted
		const roundRow = await db!
			.prepare(
				'SELECT winningNumber, netDelta, newBalance FROM roulette_round WHERE userId = ? AND syncId = ?',
			)
			.bind(userId, syncId)
			.first<{ winningNumber: number; netDelta: number; newBalance: number }>();
		expect(roundRow).not.toBeNull();
		expect(roundRow!.winningNumber).toBe(17);
		expect(roundRow!.netDelta).toBe(350);
		expect(roundRow!.newBalance).toBe(1350);

		// Verify chip_sync_receipt was inserted
		const receiptRow = await db!
			.prepare(
				'SELECT gameType, delta, outcome, overallRank FROM chip_sync_receipt WHERE userId = ? AND syncId = ?',
			)
			.bind(userId, syncId)
			.first<{ gameType: string; delta: number; outcome: string; overallRank: number }>();
		expect(receiptRow).not.toBeNull();
		expect(receiptRow!.gameType).toBe('roulette');
		expect(receiptRow!.delta).toBe(350);
		expect(receiptRow!.outcome).toBe('win');

		// Verify game_stats was inserted
		const statsRow = await db!
			.prepare(
				'SELECT totalWins, handsPlayed, netProfit FROM game_stats WHERE userId = ? AND gameType = ?',
			)
			.bind(userId, 'roulette')
			.first<{ totalWins: number; handsPlayed: number; netProfit: number }>();
		expect(statsRow).not.toBeNull();
		expect(statsRow!.totalWins).toBe(1);
		expect(statsRow!.handsPlayed).toBe(1);
		expect(statsRow!.netProfit).toBe(350);
	});

	test('concurrent modification: UPDATE mismatch → changes()=0 → all cascade inserts skipped', async () => {
		const userId = 'user-concurrent';
		const syncId = 'sync-concurrent-1';
		// User has 1000, but we pass previousBalance=999 (simulating a concurrent
		// update that changed the balance between read and write)
		await insertUser(db!, userId, 1000);

		const results = await buildSpinBatch(db!, {
			userId,
			syncId,
			winningNumber: 0,
			betsJson: JSON.stringify([{ type: 'red', amount: 50 }]),
			totalBet: 50,
			totalPayout: 0,
			netDelta: -50,
			previousBalance: 999, // MISMATCH — balance is actually 1000
			newBalance: 949,
			nowSeconds: 2000,
			winsIncrement: 0,
			lossesIncrement: 1,
			biggestWinCandidate: null,
		});

		// Statement 1: UPDATE matched 0 rows (balance didn't match)
		expect(results[0].meta.changes).toBe(0);
		// Statements 2-4: all skipped because changes()=0
		expect(results[1].meta.changes).toBe(0);
		expect(results[2].meta.changes).toBe(0);
		expect(results[3].meta.changes).toBe(0);

		// Verify user balance was NOT changed
		const userRow = await db!
			.prepare('SELECT chipBalance FROM user WHERE id = ?')
			.bind(userId)
			.first<{ chipBalance: number }>();
		expect(userRow?.chipBalance).toBe(1000);

		// Verify NO roulette_round was inserted
		const roundRow = await db!
			.prepare('SELECT 1 FROM roulette_round WHERE userId = ? AND syncId = ?')
			.bind(userId, syncId)
			.first();
		expect(roundRow).toBeNull();

		// Verify NO chip_sync_receipt was inserted
		const receiptRow = await db!
			.prepare('SELECT 1 FROM chip_sync_receipt WHERE userId = ? AND syncId = ?')
			.bind(userId, syncId)
			.first();
		expect(receiptRow).toBeNull();

		// Verify NO game_stats was inserted
		const statsRow = await db!
			.prepare('SELECT 1 FROM game_stats WHERE userId = ? AND gameType = ?')
			.bind(userId, 'roulette')
			.first();
		expect(statsRow).toBeNull();
	});

	test('second spin after success: game_stats upserts correctly via cascade', async () => {
		const userId = 'user-upsert';
		await insertUser(db!, userId, 1000);

		// First spin: loss of 50
		await buildSpinBatch(db!, {
			userId,
			syncId: 'upsert-1',
			winningNumber: 0,
			betsJson: JSON.stringify([{ type: 'red', amount: 50 }]),
			totalBet: 50,
			totalPayout: 0,
			netDelta: -50,
			previousBalance: 1000,
			newBalance: 950,
			nowSeconds: 3000,
			winsIncrement: 0,
			lossesIncrement: 1,
			biggestWinCandidate: null,
		});

		// Second spin: win of 350
		const results = await buildSpinBatch(db!, {
			userId,
			syncId: 'upsert-2',
			winningNumber: 17,
			betsJson: JSON.stringify([{ type: 'straight', amount: 10, target: 17 }]),
			totalBet: 10,
			totalPayout: 360,
			netDelta: 350,
			previousBalance: 950,
			newBalance: 1300,
			nowSeconds: 4000,
			winsIncrement: 1,
			lossesIncrement: 0,
			biggestWinCandidate: 350,
		});

		expect(results[0].meta.changes).toBe(1);
		expect(results[3].meta.changes).toBe(1);

		// game_stats should have accumulated: 1 win, 1 loss, 2 hands, netProfit 300
		const statsRow = await db!
			.prepare(
				'SELECT totalWins, totalLosses, handsPlayed, biggestWin, netProfit FROM game_stats WHERE userId = ? AND gameType = ?',
			)
			.bind(userId, 'roulette')
			.first<{
				totalWins: number;
				totalLosses: number;
				handsPlayed: number;
				biggestWin: number;
				netProfit: number;
			}>();
		expect(statsRow).not.toBeNull();
		expect(statsRow!.totalWins).toBe(1);
		expect(statsRow!.totalLosses).toBe(1);
		expect(statsRow!.handsPlayed).toBe(2);
		expect(statsRow!.biggestWin).toBe(350);
		expect(statsRow!.netProfit).toBe(300);

		// Both rounds should be present
		const roundCount = await db!
			.prepare('SELECT COUNT(*) as count FROM roulette_round WHERE userId = ?')
			.bind(userId)
			.first<{ count: number }>();
		expect(roundCount?.count).toBe(2);
	});

	test('overallRank subquery in chip_sync_receipt evaluates correctly under cascade', async () => {
		// Insert a few users with known balances to test leaderboard ranking
		await insertUser(db!, 'rank-a', 5000);
		await insertUser(db!, 'rank-b', 3000);
		await insertUser(db!, 'rank-c', 1000);

		// rank-c spins and wins, going from 1000 to 1350
		await buildSpinBatch(db!, {
			userId: 'rank-c',
			syncId: 'rank-sync-1',
			winningNumber: 17,
			betsJson: JSON.stringify([{ type: 'straight', amount: 10, target: 17 }]),
			totalBet: 10,
			totalPayout: 360,
			netDelta: 350,
			previousBalance: 1000,
			newBalance: 1350,
			nowSeconds: 5000,
			winsIncrement: 1,
			lossesIncrement: 0,
			biggestWinCandidate: 350,
		});

		// rank-c (1350) should be rank 3: rank-a (5000) and rank-b (3000) are above
		const receipt = await db!
			.prepare('SELECT overallRank FROM chip_sync_receipt WHERE userId = ? AND syncId = ?')
			.bind('rank-c', 'rank-sync-1')
			.first<{ overallRank: number }>();
		expect(receipt).not.toBeNull();
		expect(receipt!.overallRank).toBe(3);
	});
});
