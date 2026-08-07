/**
 * Reroll logic tests.
 *
 * Two layers:
 *  1. Pure type-export check — guarantees the public `RerollResult` interface
 *     is surfaced for callers, including all five status variants.
 *  2. Miniflare D1 integration — proves every reachable guard path against
 *     real workerd SQLite: not-daily, reroll-used (one-per-day), the
 *     already-completed short-circuit, and the happy path that INSERTs an
 *     override row whose replacementId is drawn from the registry pool.
 *
 * The `no-replacement` branch is structurally unreachable with the current
 * registry sizing (see `reroll-noop.test.ts` for a mocked unit test of that
 * defensive path).
 *
 * Pattern: see `claim.test.ts` / `progress-integration.test.ts` for the
 * Miniflare + drizzle migration bootstrap this follows.
 */

import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { Miniflare } from 'miniflare';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import type { D1Database } from '@cloudflare/workers-types';
import { performReroll } from './reroll';
import type { RerollResult } from './reroll';
import { getDailyPeriodKey } from './periods';
import { REROLL_POOL_DAILY } from './registry';

// ── Layer 1: type-export surface ───────────────────────────────────────────

describe('reroll public types', () => {
	test('RerollResult has the five status variants and optional id fields', () => {
		const sample: RerollResult = {
			status: 'rerolled',
			originalMissionDefId: 'daily-blackjack-5',
			replacementMissionDefId: 'daily-craps-3',
		};
		expect(sample.status).toBe('rerolled');
		// Compile-time check that all status variants are assignable.
		const statuses: RerollResult['status'][] = [
			'rerolled',
			'reroll-used',
			'already-completed',
			'not-daily',
			'no-replacement',
		];
		expect(statuses).toHaveLength(5);
	});
});

// ── Layer 2: Miniflare D1 integration ──────────────────────────────────────

let mf: Miniflare | null = null;
let db: D1Database | null = null;

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

async function insertUser(d1: D1Database, id: string): Promise<void> {
	await d1
		.prepare(
			'INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt, chipBalance) VALUES (?, ?, ?, ?, ?, ?, ?)',
		)
		.bind(id, `Test ${id}`, `${id}@test.local`, 0, 1000, 1000, 1000)
		.run();
}

async function seedOverride(
	d1: D1Database,
	userId: string,
	periodKey: string,
	originalMissionDefId: string,
	replacementMissionDefId: string,
): Promise<void> {
	const nowSeconds = Math.trunc(Date.now() / 1000);
	await d1
		.prepare(
			`INSERT INTO mission_override (userId, periodKey, originalMissionDefId, replacementMissionDefId, rerolledAt)
			 VALUES (?, ?, ?, ?, ?)`,
		)
		.bind(userId, periodKey, originalMissionDefId, replacementMissionDefId, nowSeconds)
		.run();
}

async function seedCompletedProgress(
	d1: D1Database,
	userId: string,
	missionDefId: string,
	periodKey: string,
): Promise<void> {
	const nowSeconds = Math.trunc(Date.now() / 1000);
	await d1
		.prepare(
			`INSERT INTO mission_progress (userId, missionDefId, periodKey, progress, metadataJson, completedAt, claimedAt)
			 VALUES (?, ?, ?, ?, NULL, ?, NULL)`,
		)
		.bind(userId, missionDefId, periodKey, 5, nowSeconds)
		.run();
}

interface OverrideRow {
	originalMissionDefId: string;
	replacementMissionDefId: string;
	periodKey: string;
	rerolledAt: number;
}

async function getOverrideRows(
	d1: D1Database,
	userId: string,
	periodKey: string,
): Promise<OverrideRow[]> {
	const result = await d1
		.prepare(
			'SELECT originalMissionDefId, replacementMissionDefId, periodKey, rerolledAt FROM mission_override WHERE userId = ? AND periodKey = ?',
		)
		.bind(userId, periodKey)
		.all<OverrideRow>();
	return result.results ?? [];
}

describe('performReroll (Miniflare D1 integration)', () => {
	beforeAll(async () => {
		mf = new Miniflare({
			modules: [
				{
					type: 'ESModule',
					path: 'file:///entry.js',
					contents: 'export default { fetch() { return new Response("ok"); } }',
				},
			],
			d1Databases: { DB: 'mission-reroll-test' },
			d1Persist: false,
		});
		await mf.ready;
		db = (await mf.getD1Database('DB')) as unknown as D1Database;
		await applyMigrations(db);
	});

	afterAll(async () => {
		if (mf) await mf.dispose();
	});

	test('returns not-daily for a weekly mission', async () => {
		const userId = 'user-weekly';
		await insertUser(db!, userId);

		// weekly-games-3 has period 'weekly'.
		const result = await performReroll(db!, userId, 'weekly-games-3');
		expect(result.status).toBe('not-daily');

		// No override written.
		const rows = await getOverrideRows(db!, userId, getDailyPeriodKey());
		expect(rows).toHaveLength(0);
	});

	test('returns not-daily for an unknown mission def id', async () => {
		const userId = 'user-unknown';
		await insertUser(db!, userId);

		const result = await performReroll(db!, userId, 'does-not-exist');
		expect(result.status).toBe('not-daily');
	});

	test('returns reroll-used when an override already exists for today', async () => {
		const userId = 'user-used';
		await insertUser(db!, userId);

		const periodKey = getDailyPeriodKey();
		// Seed an existing override — the one-per-day guard must trip.
		await seedOverride(db!, userId, periodKey, 'daily-blackjack-5', 'daily-craps-3');

		const result = await performReroll(db!, userId, 'daily-win-3');
		expect(result.status).toBe('reroll-used');

		// Still exactly one override row (no second insert).
		const rows = await getOverrideRows(db!, userId, periodKey);
		expect(rows).toHaveLength(1);
	});

	test('returns already-completed when the target mission is completed today', async () => {
		const userId = 'user-done';
		await insertUser(db!, userId);

		const periodKey = getDailyPeriodKey();
		// Mark daily-blackjack-5 as completed.
		await seedCompletedProgress(db!, userId, 'daily-blackjack-5', periodKey);

		const result = await performReroll(db!, userId, 'daily-blackjack-5');
		expect(result.status).toBe('already-completed');

		// No override written.
		const rows = await getOverrideRows(db!, userId, periodKey);
		expect(rows).toHaveLength(0);
	});

	test('rerolls: inserts override with a pool replacement and enforces one-per-day on next call', async () => {
		const userId = 'user-ok';
		await insertUser(db!, userId);

		const periodKey = getDailyPeriodKey();
		const poolIds = REROLL_POOL_DAILY.map((d) => d.id);

		const result = await performReroll(db!, userId, 'daily-blackjack-5');
		expect(result.status).toBe('rerolled');
		expect(result.originalMissionDefId).toBe('daily-blackjack-5');
		expect(result.replacementMissionDefId).toBeDefined();
		// Replacement must come from the registry reroll pool.
		expect(poolIds).toContain(result.replacementMissionDefId);

		// Override row persisted with the correct mapping.
		const rows = await getOverrideRows(db!, userId, periodKey);
		expect(rows).toHaveLength(1);
		expect(rows[0]!.originalMissionDefId).toBe('daily-blackjack-5');
		expect(rows[0]!.replacementMissionDefId).toBe(result.replacementMissionDefId);
		expect(rows[0]!.rerolledAt).toBeGreaterThan(0);

		// Second reroll the same day must be blocked by the one-per-day guard.
		const second = await performReroll(db!, userId, 'daily-win-3');
		expect(second.status).toBe('reroll-used');

		// Still exactly one override row.
		const rowsAfter = await getOverrideRows(db!, userId, periodKey);
		expect(rowsAfter).toHaveLength(1);
	});
});
