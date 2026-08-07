/**
 * Claim logic tests.
 *
 * Two layers:
 *  1. Pure type-export check — guarantees the public interfaces
 *     (`ClaimResult`, `StreakClaimResult`) are surfaced for callers.
 *  2. Miniflare D1 integration — proves the security-critical
 *     double-pay prevention. The `changes() = 1` cascade is the core
 *     idempotency mechanism; we verify it against real workerd SQLite,
 *     not a mock, because the guarantee is integration-level (D1 batch
 *     statement chaining).
 *
 * Pattern: see `progress-integration.test.ts` for the Miniflare +
 * drizzle migration bootstrap this follows.
 */

import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { Miniflare } from 'miniflare';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import type { D1Database } from '@cloudflare/workers-types';
import { claimMission, claimLogin } from './claim';
import type { ClaimResult, StreakClaimResult } from './claim';
import { getDailyPeriodKey } from './periods';

// ── Layer 1: type-export surface ───────────────────────────────────────────

describe('claim public types', () => {
	test('ClaimResult has the four status variants and required fields', () => {
		const sample: ClaimResult = {
			status: 'completed',
			missionDefId: 'daily-blackjack-5',
			rewardChips: 500,
			chipBalance: 1500,
		};
		expect(sample.status).toBe('completed');
		// Compile-time check that all status variants are assignable.
		const statuses: ClaimResult['status'][] = [
			'completed',
			'already-claimed',
			'not-completed',
			'not-found',
		];
		expect(statuses).toHaveLength(4);
	});

	test('StreakClaimResult has the two status variants and required fields', () => {
		const sample: StreakClaimResult = {
			status: 'completed',
			currentStreak: 1,
			longestStreak: 1,
			dayOfCycle: 1,
			rewardChips: 1000,
			chipBalance: 2000,
		};
		expect(sample.status).toBe('completed');
		const statuses: StreakClaimResult['status'][] = ['completed', 'already-claimed'];
		expect(statuses).toHaveLength(2);
	});
});

// ── Layer 2: Miniflare D1 integration ──────────────────────────────────────

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

async function insertUser(d1: D1Database, id: string, chipBalance = 1000): Promise<void> {
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
	return row?.chipBalance ?? 0;
}

async function seedCompletedMission(
	d1: D1Database,
	userId: string,
	missionDefId: string,
	periodKey: string,
	progress: number,
): Promise<void> {
	const nowSeconds = Math.trunc(Date.now() / 1000);
	await d1
		.prepare(
			`INSERT INTO mission_progress (userId, missionDefId, periodKey, progress, metadataJson, completedAt, claimedAt)
			 VALUES (?, ?, ?, ?, NULL, ?, NULL)`,
		)
		.bind(userId, missionDefId, periodKey, progress, nowSeconds)
		.run();
}

async function getClaimedAt(
	d1: D1Database,
	userId: string,
	missionDefId: string,
	periodKey: string,
): Promise<number | null> {
	const row = await d1
		.prepare(
			'SELECT claimedAt FROM mission_progress WHERE userId = ? AND missionDefId = ? AND periodKey = ?',
		)
		.bind(userId, missionDefId, periodKey)
		.first<{ claimedAt: number | null }>();
	return row?.claimedAt ?? null;
}

async function getStreak(
	d1: D1Database,
	userId: string,
): Promise<{ currentStreak: number; longestStreak: number; lastClaimPeriodKey: string } | null> {
	return d1
		.prepare(
			'SELECT currentStreak, longestStreak, lastClaimPeriodKey FROM login_streak WHERE userId = ?',
		)
		.bind(userId)
		.first<{ currentStreak: number; longestStreak: number; lastClaimPeriodKey: string }>();
}

describe('claimMission (Miniflare D1 integration)', () => {
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
			d1Databases: { DB: 'mission-claim-test' },
			d1Persist: false,
		});
		await mf.ready;
		db = (await mf.getD1Database('DB')) as unknown as D1Database;
		await applyMigrations(db);
	});

	afterAll(async () => {
		if (mf) await mf.dispose();
	});

	test('returns not-found for an unknown mission def id', async () => {
		const userId = 'user-nf';
		await insertUser(db!, userId, 1000);

		const result = await claimMission(db!, userId, 'does-not-exist', 1000);
		expect(result.status).toBe('not-found');
		expect(result.rewardChips).toBe(0);
		expect(result.chipBalance).toBe(1000);

		// User balance unchanged.
		expect(await getChipBalance(db!, userId)).toBe(1000);
	});

	test('completes and grants reward when target reached and unclaimed', async () => {
		const userId = 'user-ok';
		await insertUser(db!, userId, 1000);

		// daily-blackjack-5 target is 5; reward is 500.
		const periodKey = getDailyPeriodKey();
		await seedCompletedMission(db!, userId, 'daily-blackjack-5', periodKey, 5);

		const result = await claimMission(db!, userId, 'daily-blackjack-5', 1000);
		expect(result.status).toBe('completed');
		expect(result.rewardChips).toBe(500);
		expect(result.chipBalance).toBe(1500);

		// Granted in DB.
		expect(await getChipBalance(db!, userId)).toBe(1500);
		// claimedAt set.
		const claimedAt = await getClaimedAt(db!, userId, 'daily-blackjack-5', periodKey);
		expect(claimedAt).not.toBeNull();
	});

	test('is idempotent — second claim returns already-claimed and does NOT double-pay', async () => {
		const userId = 'user-idem';
		await insertUser(db!, userId, 1000);

		const periodKey = getDailyPeriodKey();
		await seedCompletedMission(db!, userId, 'daily-blackjack-5', periodKey, 5);

		// First claim pays.
		const first = await claimMission(db!, userId, 'daily-blackjack-5', 1000);
		expect(first.status).toBe('completed');
		expect(first.chipBalance).toBe(1500);
		const balanceAfterFirst = await getChipBalance(db!, userId);
		expect(balanceAfterFirst).toBe(1500);

		// Second claim must NOT pay again.
		const second = await claimMission(db!, userId, 'daily-blackjack-5', balanceAfterFirst);
		expect(second.status).toBe('already-claimed');
		expect(second.rewardChips).toBe(0);
		expect(second.chipBalance).toBe(1500);

		// DB balance unchanged after the second call.
		expect(await getChipBalance(db!, userId)).toBe(1500);
	});

	test('returns not-completed and does NOT grant when progress < target', async () => {
		const userId = 'user-inc';
		await insertUser(db!, userId, 1000);

		const periodKey = getDailyPeriodKey();
		// Progress 3, target 5.
		await seedCompletedMission(db!, userId, 'daily-blackjack-5', periodKey, 3);

		const result = await claimMission(db!, userId, 'daily-blackjack-5', 1000);
		expect(result.status).toBe('not-completed');
		expect(result.rewardChips).toBe(0);
		expect(result.chipBalance).toBe(1000);

		// No grant.
		expect(await getChipBalance(db!, userId)).toBe(1000);
		// claimedAt still null.
		expect(await getClaimedAt(db!, userId, 'daily-blackjack-5', periodKey)).toBeNull();
	});

	test('reroll race guard: a completed daily mission that was rerolled away is NOT claimable', async () => {
		// Reproduces the P2 race: progress snapshots the original mission as
		// active, a reroll installs a replacement, then the in-flight progress
		// batch completes the original. claimMission() must NOT pay the
		// original — the NOT EXISTS guard on mission_override blocks it.
		const userId = 'user-reroll-race';
		await insertUser(db!, userId, 1000);

		const periodKey = getDailyPeriodKey();
		// Original mission completed by the racing progress batch.
		await seedCompletedMission(db!, userId, 'daily-blackjack-5', periodKey, 5);
		// Reroll installed a replacement for the original.
		await db!
			.prepare(
				`INSERT INTO mission_override (userId, periodKey, originalMissionDefId, replacementMissionDefId, rerolledAt)
				 VALUES (?, ?, ?, ?, ?)`,
			)
			.bind(userId, periodKey, 'daily-blackjack-5', 'daily-craps-3', Math.trunc(Date.now() / 1000))
			.run();

		const result = await claimMission(db!, userId, 'daily-blackjack-5', 1000);
		// Claim blocked by the NOT EXISTS guard — no reward, no balance change.
		expect(result.status).toBe('not-completed');
		expect(result.rewardChips).toBe(0);
		expect(result.chipBalance).toBe(1000);
		expect(await getChipBalance(db!, userId)).toBe(1000);
		// claimedAt stays null — the claim UPDATE was a no-op.
		expect(await getClaimedAt(db!, userId, 'daily-blackjack-5', periodKey)).toBeNull();
	});

	test('reroll race guard: a completed daily mission with NO override is still claimable', async () => {
		// Defense-in-depth: the guard must not block the normal path. No
		// mission_override row → NOT EXISTS is true → claim proceeds.
		const userId = 'user-no-override';
		await insertUser(db!, userId, 1000);

		const periodKey = getDailyPeriodKey();
		await seedCompletedMission(db!, userId, 'daily-blackjack-5', periodKey, 5);

		const result = await claimMission(db!, userId, 'daily-blackjack-5', 1000);
		expect(result.status).toBe('completed');
		expect(result.rewardChips).toBe(500);
		expect(result.chipBalance).toBe(1500);
		expect(await getChipBalance(db!, userId)).toBe(1500);
	});
});

describe('claimLogin (Miniflare D1 integration)', () => {
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
			d1Databases: { DB: 'mission-login-claim-test' },
			d1Persist: false,
		});
		await mf.ready;
		db = (await mf.getD1Database('DB')) as unknown as D1Database;
		await applyMigrations(db);
	});

	afterAll(async () => {
		if (mf) await mf.dispose();
	});

	test('first-ever claim starts streak at 1 and grants day-1 reward', async () => {
		const userId = 'login-first';
		await insertUser(db!, userId, 1000);

		const result = await claimLogin(db!, userId, 1000);
		expect(result.status).toBe('completed');
		expect(result.currentStreak).toBe(1);
		expect(result.longestStreak).toBe(1);
		expect(result.dayOfCycle).toBe(1);
		expect(result.rewardChips).toBe(1000);
		expect(result.chipBalance).toBe(2000);

		// Granted in DB.
		expect(await getChipBalance(db!, userId)).toBe(2000);
		// Streak row written.
		const streak = await getStreak(db!, userId);
		expect(streak?.currentStreak).toBe(1);
		expect(streak?.longestStreak).toBe(1);
		expect(streak?.lastClaimPeriodKey).toBe(getDailyPeriodKey());
	});

	test('is idempotent — second claim same day returns already-claimed, no double-pay', async () => {
		const userId = 'login-idem';
		await insertUser(db!, userId, 1000);

		// First claim pays.
		const first = await claimLogin(db!, userId, 1000);
		expect(first.status).toBe('completed');
		expect(first.rewardChips).toBe(1000);
		expect(first.chipBalance).toBe(2000);
		const balanceAfterFirst = await getChipBalance(db!, userId);
		expect(balanceAfterFirst).toBe(2000);

		// Second claim same day — fast path (lastClaimPeriodKey === today).
		const second = await claimLogin(db!, userId, balanceAfterFirst);
		expect(second.status).toBe('already-claimed');
		expect(second.rewardChips).toBe(0);
		expect(second.chipBalance).toBe(2000);
		// Fast-path dayOfCycle uses getDayOfCycle(currentStreak).
		expect(second.dayOfCycle).toBe(1);
		expect(second.currentStreak).toBe(1);
		expect(second.longestStreak).toBe(1);

		// DB balance unchanged.
		expect(await getChipBalance(db!, userId)).toBe(2000);
		// Streak unchanged.
		const streak = await getStreak(db!, userId);
		expect(streak?.currentStreak).toBe(1);
	});

	test('grants again the next day and continues the streak (via backdated lastClaimPeriodKey)', async () => {
		const userId = 'login-next';
		await insertUser(db!, userId, 1000);

		// Seed a streak row whose lastClaimPeriodKey is yesterday — claimLogin
		// should treat this as a continuing streak (currentStreak + 1).
		const today = getDailyPeriodKey();
		const d = new Date();
		d.setUTCDate(d.getUTCDate() - 1);
		const yesterday = d.toISOString().slice(0, 10);

		await db!
			.prepare(
				'INSERT INTO login_streak (userId, currentStreak, longestStreak, lastClaimPeriodKey) VALUES (?, ?, ?, ?)',
			)
			.bind(userId, 3, 5, yesterday)
			.run();

		const result = await claimLogin(db!, userId, 1000);
		expect(result.status).toBe('completed');
		expect(result.currentStreak).toBe(4);
		expect(result.longestStreak).toBe(5);
		expect(result.dayOfCycle).toBe(4);
		// Day-4 reward.
		expect(result.rewardChips).toBe(2000);
		expect(result.chipBalance).toBe(3000);

		// Granted in DB.
		expect(await getChipBalance(db!, userId)).toBe(3000);
		// Streak advanced.
		const streak = await getStreak(db!, userId);
		expect(streak?.currentStreak).toBe(4);
		expect(streak?.longestStreak).toBe(5);
		expect(streak?.lastClaimPeriodKey).toBe(today);
	});

	test('resets to day 1 when the gap is more than one day', async () => {
		const userId = 'login-reset';
		await insertUser(db!, userId, 1000);

		// lastClaimPeriodKey three days ago — broken streak.
		const d = new Date();
		d.setUTCDate(d.getUTCDate() - 3);
		const threeDaysAgo = d.toISOString().slice(0, 10);

		await db!
			.prepare(
				'INSERT INTO login_streak (userId, currentStreak, longestStreak, lastClaimPeriodKey) VALUES (?, ?, ?, ?)',
			)
			.bind(userId, 5, 7, threeDaysAgo)
			.run();

		const result = await claimLogin(db!, userId, 1000);
		expect(result.status).toBe('completed');
		expect(result.currentStreak).toBe(1);
		expect(result.longestStreak).toBe(7);
		expect(result.dayOfCycle).toBe(1);
		expect(result.rewardChips).toBe(1000);
		expect(result.chipBalance).toBe(2000);
	});
});
