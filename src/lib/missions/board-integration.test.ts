/**
 * Miniflare integration tests for the DB-touching functions in board.ts.
 *
 * The pure helpers (applyOverrides, getReplacementPool, buildMissionView)
 * are covered in `board.test.ts`. This file covers the D1 reads that
 * `getBoardState` composes against real workerd SQLite:
 *  - getOverrides: empty / with rows
 *  - getProgressRows: empty defIds short-circuit, row mapping, date
 *    conversion from epoch-seconds to Date objects
 *  - getBoardState: full happy path with overrides + progress + streak,
 *    rerollAvailable flag, weekly views, empty streak row
 *
 * Pattern: see `claim.test.ts` / `progress-integration.test.ts` for the
 * Miniflare + drizzle migration bootstrap this follows.
 */

import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { Miniflare } from 'miniflare';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import type { D1Database } from '@cloudflare/workers-types';
import { getOverrides, getProgressRows, getBoardState } from './board';
import { getDailyPeriodKey, getWeeklyPeriodKey } from './periods';
import { DEFAULT_DAILY_MISSIONS, DEFAULT_WEEKLY_MISSIONS, REROLL_POOL_DAILY } from './registry';

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

async function insertUser(d1: D1Database, id: string, chipBalance = 1000): Promise<void> {
	await d1
		.prepare(
			'INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt, chipBalance, heldChips) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
		)
		.bind(id, `Test ${id}`, `${id}@test.local`, 0, 1000, 1000, chipBalance, 0)
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

async function seedProgress(
	d1: D1Database,
	userId: string,
	missionDefId: string,
	periodKey: string,
	progress: number,
	completedAt: number | null = null,
	claimedAt: number | null = null,
	metadataJson: string | null = null,
): Promise<void> {
	await d1
		.prepare(
			`INSERT INTO mission_progress (userId, missionDefId, periodKey, progress, metadataJson, completedAt, claimedAt)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(userId, missionDefId, periodKey, progress, metadataJson, completedAt, claimedAt)
		.run();
}

async function seedStreak(
	d1: D1Database,
	userId: string,
	currentStreak: number,
	longestStreak: number,
	lastClaimPeriodKey: string,
): Promise<void> {
	await d1
		.prepare(
			'INSERT INTO login_streak (userId, currentStreak, longestStreak, lastClaimPeriodKey) VALUES (?, ?, ?, ?)',
		)
		.bind(userId, currentStreak, longestStreak, lastClaimPeriodKey)
		.run();
}

describe('getOverrides (Miniflare D1 integration)', () => {
	beforeAll(async () => {
		mf = new Miniflare({
			modules: [
				{
					type: 'ESModule',
					path: 'file:///entry.js',
					contents: 'export default { fetch() { return new Response("ok"); } }',
				},
			],
			d1Databases: { DB: 'mission-board-overrides-test' },
			d1Persist: false,
		});
		await mf.ready;
		db = (await mf.getD1Database('DB')) as unknown as D1Database;
		await applyMigrations(db);
	});

	afterAll(async () => {
		if (mf) await mf.dispose();
	});

	test('returns [] when no override rows exist for the user/period', async () => {
		const userId = 'ov-empty';
		await insertUser(db!, userId);
		const result = await getOverrides(db!, userId, getDailyPeriodKey());
		expect(result).toEqual([]);
	});

	test('returns rows keyed by originalMissionDefId → replacementMissionDefId', async () => {
		const userId = 'ov-rows';
		await insertUser(db!, userId);
		const periodKey = getDailyPeriodKey();
		await seedOverride(db!, userId, periodKey, 'daily-blackjack-5', 'daily-craps-3');

		const result = await getOverrides(db!, userId, periodKey);
		expect(result).toHaveLength(1);
		expect(result[0]).toEqual({
			originalMissionDefId: 'daily-blackjack-5',
			replacementMissionDefId: 'daily-craps-3',
		});
	});

	test('scopes by periodKey — a different period returns no rows', async () => {
		const userId = 'ov-scope';
		await insertUser(db!, userId);
		await seedOverride(db!, userId, '2020-01-01', 'daily-blackjack-5', 'daily-craps-3');

		const result = await getOverrides(db!, userId, getDailyPeriodKey());
		expect(result).toEqual([]);
	});
});

describe('getProgressRows (Miniflare D1 integration)', () => {
	beforeAll(async () => {
		mf = new Miniflare({
			modules: [
				{
					type: 'ESModule',
					path: 'file:///entry.js',
					contents: 'export default { fetch() { return new Response("ok"); } }',
				},
			],
			d1Databases: { DB: 'mission-board-progress-test' },
			d1Persist: false,
		});
		await mf.ready;
		db = (await mf.getD1Database('DB')) as unknown as D1Database;
		await applyMigrations(db);
	});

	afterAll(async () => {
		if (mf) await mf.dispose();
	});

	test('returns an empty Map when defIds is empty (short-circuit)', async () => {
		const userId = 'pr-empty-defids';
		await insertUser(db!, userId);
		const map = await getProgressRows(db!, userId, [], getDailyPeriodKey(), getWeeklyPeriodKey());
		expect(map.size).toBe(0);
	});

	test('returns an empty Map when no matching rows exist', async () => {
		const userId = 'pr-no-rows';
		await insertUser(db!, userId);
		const map = await getProgressRows(
			db!,
			userId,
			['daily-blackjack-5'],
			getDailyPeriodKey(),
			getWeeklyPeriodKey(),
		);
		expect(map.size).toBe(0);
	});

	test('maps rows by `${missionDefId}:${periodKey}` and converts epoch seconds to Date', async () => {
		const userId = 'pr-rows';
		await insertUser(db!, userId);
		const dailyKey = getDailyPeriodKey();
		const completedAt = Math.trunc(Date.now() / 1000);
		const claimedAt = completedAt + 60;
		await seedProgress(db!, userId, 'daily-blackjack-5', dailyKey, 5, completedAt, claimedAt, null);

		const map = await getProgressRows(
			db!,
			userId,
			['daily-blackjack-5'],
			dailyKey,
			getWeeklyPeriodKey(),
		);
		expect(map.size).toBe(1);
		const row = map.get(`daily-blackjack-5:${dailyKey}`);
		expect(row).toBeDefined();
		expect(row!.missionDefId).toBe('daily-blackjack-5');
		expect(row!.periodKey).toBe(dailyKey);
		expect(row!.progress).toBe(5);
		expect(row!.metadataJson).toBeNull();
		expect(row!.completedAt).toBeInstanceOf(Date);
		expect(row!.claimedAt).toBeInstanceOf(Date);
		expect(Math.trunc(row!.completedAt!.getTime() / 1000)).toBe(completedAt);
		expect(Math.trunc(row!.claimedAt!.getTime() / 1000)).toBe(claimedAt);
	});

	test('preserves metadataJson string and nulls completedAt/claimedAt when absent', async () => {
		const userId = 'pr-meta';
		await insertUser(db!, userId);
		const dailyKey = getDailyPeriodKey();
		await seedProgress(db!, userId, 'daily-blackjack-5', dailyKey, 2, null, null, '["blackjack"]');

		const map = await getProgressRows(
			db!,
			userId,
			['daily-blackjack-5'],
			dailyKey,
			getWeeklyPeriodKey(),
		);
		const row = map.get(`daily-blackjack-5:${dailyKey}`);
		expect(row!.metadataJson).toBe('["blackjack"]');
		expect(row!.completedAt).toBeNull();
		expect(row!.claimedAt).toBeNull();
	});

	test('returns both daily and weekly rows for the same defId when both exist', async () => {
		const userId = 'pr-both-periods';
		await insertUser(db!, userId);
		const dailyKey = getDailyPeriodKey();
		const weeklyKey = getWeeklyPeriodKey();
		// weekly-games-3 is the only weekly def; seed both a daily and weekly row.
		await seedProgress(db!, userId, 'daily-blackjack-5', dailyKey, 3);
		await seedProgress(db!, userId, 'weekly-games-3', weeklyKey, 2);

		const map = await getProgressRows(
			db!,
			userId,
			['daily-blackjack-5', 'weekly-games-3'],
			dailyKey,
			weeklyKey,
		);
		expect(map.size).toBe(2);
		expect(map.get(`daily-blackjack-5:${dailyKey}`)?.progress).toBe(3);
		expect(map.get(`weekly-games-3:${weeklyKey}`)?.progress).toBe(2);
	});
});

describe('getBoardState (Miniflare D1 integration)', () => {
	beforeAll(async () => {
		mf = new Miniflare({
			modules: [
				{
					type: 'ESModule',
					path: 'file:///entry.js',
					contents: 'export default { fetch() { return new Response("ok"); } }',
				},
			],
			d1Databases: { DB: 'mission-board-state-test' },
			d1Persist: false,
		});
		await mf.ready;
		db = (await mf.getD1Database('DB')) as unknown as D1Database;
		await applyMigrations(db);
	});

	afterAll(async () => {
		if (mf) await mf.dispose();
	});

	test('returns a full board with default missions, empty progress, and zero streak when nothing is seeded', async () => {
		const userId = 'bs-empty';
		await insertUser(db!, userId, 1500);

		const state = await getBoardState(db!, userId, 1500);

		expect(state.chipBalance).toBe(1500);
		expect(state.rerollAvailable).toBe(true);
		expect(state.daily).toHaveLength(DEFAULT_DAILY_MISSIONS.length);
		expect(state.weekly).toHaveLength(DEFAULT_WEEKLY_MISSIONS.length);
		expect(state.daily.map((m) => m.missionDefId)).toEqual(DEFAULT_DAILY_MISSIONS.map((m) => m.id));
		expect(state.weekly.map((m) => m.missionDefId)).toEqual(
			DEFAULT_WEEKLY_MISSIONS.map((m) => m.id),
		);
		for (const view of [...state.daily, ...state.weekly]) {
			expect(view.progress).toBe(0);
			expect(view.completed).toBe(false);
			expect(view.claimed).toBe(false);
			expect(view.claimable).toBe(false);
			expect(view.isOverride).toBe(false);
		}
		expect(state.streak.current).toBe(0);
		expect(state.streak.longest).toBe(0);
		expect(state.streak.claimableToday).toBe(true);
		expect(state.streak.lastClaimPeriodKey).toBe('');
		expect(state.nextDailyReset).toMatch(/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/);
		expect(state.nextWeeklyReset).toMatch(/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/);
	});

	test('marks isOverride=true and rerollAvailable=false when an override exists', async () => {
		const userId = 'bs-override';
		await insertUser(db!, userId);
		const periodKey = getDailyPeriodKey();
		await seedOverride(
			db!,
			userId,
			periodKey,
			DEFAULT_DAILY_MISSIONS[0]!.id,
			REROLL_POOL_DAILY[0]!.id,
		);

		const state = await getBoardState(db!, userId, 1000);

		expect(state.rerollAvailable).toBe(false);
		// The rerolled slot is replaced by the pool def, and that slot is the
		// only one marked isOverride.
		const overrideSlots = state.daily.filter((m) => m.isOverride);
		expect(overrideSlots).toHaveLength(1);
		expect(overrideSlots[0]!.missionDefId).toBe(REROLL_POOL_DAILY[0]!.id);
		// Other daily slots retain their default ids and are not overrides.
		const nonOverrideIds = state.daily.filter((m) => !m.isOverride).map((m) => m.missionDefId);
		expect(nonOverrideIds).toEqual(DEFAULT_DAILY_MISSIONS.slice(1).map((m) => m.id));
	});

	test('reflects progress, completed, and claimed flags from mission_progress rows', async () => {
		const userId = 'bs-progress';
		await insertUser(db!, userId);
		const dailyKey = getDailyPeriodKey();
		const nowSeconds = Math.trunc(Date.now() / 1000);
		// daily-blackjack-5: completed + claimed.
		await seedProgress(db!, userId, 'daily-blackjack-5', dailyKey, 5, nowSeconds, nowSeconds);
		// daily-win-3: completed but unclaimed → claimable.
		await seedProgress(db!, userId, 'daily-win-3', dailyKey, 3, nowSeconds, null);
		// daily-slots-20: in-progress.
		await seedProgress(db!, userId, 'daily-slots-20', dailyKey, 7, null, null);

		const state = await getBoardState(db!, userId, 1000);

		const bj = state.daily.find((m) => m.missionDefId === 'daily-blackjack-5')!;
		expect(bj.progress).toBe(5);
		expect(bj.completed).toBe(true);
		expect(bj.claimed).toBe(true);
		expect(bj.claimable).toBe(false);

		const wins = state.daily.find((m) => m.missionDefId === 'daily-win-3')!;
		expect(wins.progress).toBe(3);
		expect(wins.completed).toBe(true);
		expect(wins.claimed).toBe(false);
		expect(wins.claimable).toBe(true);

		const slots = state.daily.find((m) => m.missionDefId === 'daily-slots-20')!;
		expect(slots.progress).toBe(7);
		expect(slots.completed).toBe(false);
		expect(slots.claimable).toBe(false);
	});

	test('clamps progress at target when a row exceeds the def target', async () => {
		const userId = 'bs-clamp';
		await insertUser(db!, userId);
		const dailyKey = getDailyPeriodKey();
		// daily-blackjack-5 target is 5; persist progress=99.
		await seedProgress(db!, userId, 'daily-blackjack-5', dailyKey, 99);

		const state = await getBoardState(db!, userId, 1000);
		const bj = state.daily.find((m) => m.missionDefId === 'daily-blackjack-5')!;
		expect(bj.progress).toBe(5);
		expect(bj.completed).toBe(true);
	});

	test('surfaces weekly mission progress under the weekly period key', async () => {
		const userId = 'bs-weekly';
		await insertUser(db!, userId);
		const weeklyKey = getWeeklyPeriodKey();
		await seedProgress(db!, userId, 'weekly-games-3', weeklyKey, 2);

		const state = await getBoardState(db!, userId, 1000);
		const weekly = state.weekly.find((m) => m.missionDefId === 'weekly-games-3')!;
		expect(weekly.progress).toBe(2);
		expect(weekly.completed).toBe(false);
		expect(weekly.isOverride).toBe(false);
	});

	test('reflects streak row — already claimed today → not claimable, current preserved', async () => {
		const userId = 'bs-streak-today';
		await insertUser(db!, userId);
		await seedStreak(db!, userId, 4, 7, getDailyPeriodKey());

		const state = await getBoardState(db!, userId, 1000);
		expect(state.streak.current).toBe(4);
		expect(state.streak.longest).toBe(7);
		expect(state.streak.claimableToday).toBe(false);
		expect(state.streak.lastClaimPeriodKey).toBe(getDailyPeriodKey());
		expect(state.streak.rewardPreview).toBe(0);
	});

	test('reflects streak row — claimed yesterday → claimable, reward preview for next day', async () => {
		const userId = 'bs-streak-yesterday';
		await insertUser(db!, userId);
		const d = new Date();
		d.setUTCDate(d.getUTCDate() - 1);
		const yesterday = d.toISOString().slice(0, 10);
		await seedStreak(db!, userId, 2, 5, yesterday);

		const state = await getBoardState(db!, userId, 1000);
		expect(state.streak.current).toBe(2);
		expect(state.streak.claimableToday).toBe(true);
		expect(state.streak.rewardPreview).toBeGreaterThan(0);
	});
});
