/**
 * Mock-based unit tests for the DB-touching functions in board.ts.
 *
 * The pure helpers (applyOverrides, getReplacementPool, buildMissionView)
 * are covered in `board.test.ts`. The Miniflare integration tests in
 * `board-integration.test.ts` prove correctness against real workerd
 * SQLite. This file provides a coverage floor that runs anywhere
 * `bun test` runs — no workerd required — by routing D1 calls through
 * the shared mock in `mock-d1.ts`.
 */

import { describe, expect, test } from 'bun:test';
import { getOverrides, getProgressRows, getBoardState } from './board';
import { makeMockD1 } from './mock-d1';
import { getDailyPeriodKey, getWeeklyPeriodKey } from './periods';
import { DEFAULT_DAILY_MISSIONS, DEFAULT_WEEKLY_MISSIONS, REROLL_POOL_DAILY } from './registry';

describe('getOverrides (mocked D1)', () => {
	test('returns the results array from the D1 all() call', async () => {
		const mock = makeMockD1();
		const periodKey = getDailyPeriodKey();
		mock.onAll('SELECT originalMissionDefId', () => ({
			results: [
				{ originalMissionDefId: 'daily-blackjack-5', replacementMissionDefId: 'daily-craps-3' },
			],
		}));

		const result = await getOverrides(mock.binding, 'user-1', periodKey);
		expect(result).toEqual([
			{ originalMissionDefId: 'daily-blackjack-5', replacementMissionDefId: 'daily-craps-3' },
		]);
		// Bind params include userId and periodKey.
		expect(mock.calls).toHaveLength(1);
		expect(mock.calls[0].args).toEqual(['user-1', periodKey]);
	});

	test('returns [] when D1 returns no results', async () => {
		const mock = makeMockD1();
		mock.onAll('SELECT originalMissionDefId', () => ({ results: [] }));

		const result = await getOverrides(mock.binding, 'user-2', getDailyPeriodKey());
		expect(result).toEqual([]);
	});

	test('returns [] when D1 returns undefined results (nullish coalescing)', async () => {
		const mock = makeMockD1();
		mock.onAll('SELECT originalMissionDefId', () => ({ results: undefined }));

		const result = await getOverrides(mock.binding, 'user-3', getDailyPeriodKey());
		expect(result).toEqual([]);
	});
});

describe('getProgressRows (mocked D1)', () => {
	test('returns an empty Map when defIds is empty (short-circuit, no D1 call)', async () => {
		const mock = makeMockD1();
		const map = await getProgressRows(
			mock.binding,
			'user-1',
			[],
			getDailyPeriodKey(),
			getWeeklyPeriodKey(),
		);
		expect(map.size).toBe(0);
		// No D1 calls should have been made.
		expect(mock.calls).toHaveLength(0);
	});

	test('maps rows by `${missionDefId}:${periodKey}` and converts epoch seconds to Date', async () => {
		const mock = makeMockD1();
		const dailyKey = getDailyPeriodKey();
		const completedAtSec = Math.trunc(Date.now() / 1000);
		const claimedAtSec = completedAtSec + 60;
		mock.onAll('SELECT missionDefId', () => ({
			results: [
				{
					missionDefId: 'daily-blackjack-5',
					periodKey: dailyKey,
					progress: 5,
					metadataJson: null,
					completedAt: completedAtSec,
					claimedAt: claimedAtSec,
				},
			],
		}));

		const map = await getProgressRows(
			mock.binding,
			'user-2',
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
		expect(Math.trunc(row!.completedAt!.getTime() / 1000)).toBe(completedAtSec);
		expect(Math.trunc(row!.claimedAt!.getTime() / 1000)).toBe(claimedAtSec);
	});

	test('preserves metadataJson string and nulls completedAt/claimedAt when absent', async () => {
		const mock = makeMockD1();
		const dailyKey = getDailyPeriodKey();
		mock.onAll('SELECT missionDefId', () => ({
			results: [
				{
					missionDefId: 'daily-blackjack-5',
					periodKey: dailyKey,
					progress: 2,
					metadataJson: '["blackjack"]',
					completedAt: null,
					claimedAt: null,
				},
			],
		}));

		const map = await getProgressRows(
			mock.binding,
			'user-3',
			['daily-blackjack-5'],
			dailyKey,
			getWeeklyPeriodKey(),
		);
		const row = map.get(`daily-blackjack-5:${dailyKey}`);
		expect(row!.metadataJson).toBe('["blackjack"]');
		expect(row!.completedAt).toBeNull();
		expect(row!.claimedAt).toBeNull();
	});

	test('returns multiple rows for different defIds and period keys', async () => {
		const mock = makeMockD1();
		const dailyKey = getDailyPeriodKey();
		const weeklyKey = getWeeklyPeriodKey();
		mock.onAll('SELECT missionDefId', () => ({
			results: [
				{
					missionDefId: 'daily-blackjack-5',
					periodKey: dailyKey,
					progress: 3,
					metadataJson: null,
					completedAt: null,
					claimedAt: null,
				},
				{
					missionDefId: 'weekly-games-3',
					periodKey: weeklyKey,
					progress: 2,
					metadataJson: '["blackjack"]',
					completedAt: null,
					claimedAt: null,
				},
			],
		}));

		const map = await getProgressRows(
			mock.binding,
			'user-4',
			['daily-blackjack-5', 'weekly-games-3'],
			dailyKey,
			weeklyKey,
		);
		expect(map.size).toBe(2);
		expect(map.get(`daily-blackjack-5:${dailyKey}`)?.progress).toBe(3);
		expect(map.get(`weekly-games-3:${weeklyKey}`)?.progress).toBe(2);
	});

	test('returns an empty Map when D1 returns no results', async () => {
		const mock = makeMockD1();
		mock.onAll('SELECT missionDefId', () => ({ results: [] }));

		const map = await getProgressRows(
			mock.binding,
			'user-5',
			['daily-blackjack-5'],
			getDailyPeriodKey(),
			getWeeklyPeriodKey(),
		);
		expect(map.size).toBe(0);
	});
});

describe('getBoardState (mocked D1)', () => {
	test('returns a full board with default missions and empty progress when nothing is seeded', async () => {
		const mock = makeMockD1();
		// getOverrides → empty
		mock.onAll('SELECT originalMissionDefId', () => ({ results: [] }));
		// login_streak SELECT → null (no streak row)
		mock.onFirst('SELECT currentStreak', () => null);
		// getProgressRows → empty
		mock.onAll('SELECT missionDefId', () => ({ results: [] }));

		const state = await getBoardState(mock.binding, 'user-empty', 1500);

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
		const mock = makeMockD1();
		mock.onAll('SELECT originalMissionDefId', () => ({
			results: [
				{
					originalMissionDefId: DEFAULT_DAILY_MISSIONS[0]!.id,
					replacementMissionDefId: REROLL_POOL_DAILY[0]!.id,
				},
			],
		}));
		mock.onFirst('SELECT currentStreak', () => null);
		mock.onAll('SELECT missionDefId', () => ({ results: [] }));

		const state = await getBoardState(mock.binding, 'user-override', 1000);

		expect(state.rerollAvailable).toBe(false);
		const overrideSlots = state.daily.filter((m) => m.isOverride);
		expect(overrideSlots).toHaveLength(1);
		expect(overrideSlots[0]!.missionDefId).toBe(REROLL_POOL_DAILY[0]!.id);
		const nonOverrideIds = state.daily.filter((m) => !m.isOverride).map((m) => m.missionDefId);
		expect(nonOverrideIds).toEqual(DEFAULT_DAILY_MISSIONS.slice(1).map((m) => m.id));
	});

	test('reflects progress, completed, and claimed flags from mission_progress rows', async () => {
		const mock = makeMockD1();
		const dailyKey = getDailyPeriodKey();
		const nowSeconds = Math.trunc(Date.now() / 1000);
		mock.onAll('SELECT originalMissionDefId', () => ({ results: [] }));
		mock.onFirst('SELECT currentStreak', () => null);
		mock.onAll('SELECT missionDefId', () => ({
			results: [
				{
					missionDefId: 'daily-blackjack-5',
					periodKey: dailyKey,
					progress: 5,
					metadataJson: null,
					completedAt: nowSeconds,
					claimedAt: nowSeconds,
				},
				{
					missionDefId: 'daily-win-3',
					periodKey: dailyKey,
					progress: 3,
					metadataJson: null,
					completedAt: nowSeconds,
					claimedAt: null,
				},
				{
					missionDefId: 'daily-slots-20',
					periodKey: dailyKey,
					progress: 7,
					metadataJson: null,
					completedAt: null,
					claimedAt: null,
				},
			],
		}));

		const state = await getBoardState(mock.binding, 'user-progress', 1000);

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
		const mock = makeMockD1();
		const dailyKey = getDailyPeriodKey();
		mock.onAll('SELECT originalMissionDefId', () => ({ results: [] }));
		mock.onFirst('SELECT currentStreak', () => null);
		mock.onAll('SELECT missionDefId', () => ({
			results: [
				{
					missionDefId: 'daily-blackjack-5',
					periodKey: dailyKey,
					progress: 99,
					metadataJson: null,
					completedAt: null,
					claimedAt: null,
				},
			],
		}));

		const state = await getBoardState(mock.binding, 'user-clamp', 1000);
		const bj = state.daily.find((m) => m.missionDefId === 'daily-blackjack-5')!;
		expect(bj.progress).toBe(5);
		expect(bj.completed).toBe(true);
	});

	test('surfaces weekly mission progress under the weekly period key', async () => {
		const mock = makeMockD1();
		const weeklyKey = getWeeklyPeriodKey();
		mock.onAll('SELECT originalMissionDefId', () => ({ results: [] }));
		mock.onFirst('SELECT currentStreak', () => null);
		mock.onAll('SELECT missionDefId', () => ({
			results: [
				{
					missionDefId: 'weekly-games-3',
					periodKey: weeklyKey,
					progress: 2,
					metadataJson: null,
					completedAt: null,
					claimedAt: null,
				},
			],
		}));

		const state = await getBoardState(mock.binding, 'user-weekly', 1000);
		const weekly = state.weekly.find((m) => m.missionDefId === 'weekly-games-3')!;
		expect(weekly.progress).toBe(2);
		expect(weekly.completed).toBe(false);
		expect(weekly.isOverride).toBe(false);
	});

	test('reflects streak row — already claimed today → not claimable, current preserved', async () => {
		const mock = makeMockD1();
		const today = getDailyPeriodKey();
		mock.onAll('SELECT originalMissionDefId', () => ({ results: [] }));
		mock.onFirst('SELECT currentStreak', () => ({
			currentStreak: 4,
			longestStreak: 7,
			lastClaimPeriodKey: today,
		}));
		mock.onAll('SELECT missionDefId', () => ({ results: [] }));

		const state = await getBoardState(mock.binding, 'user-streak-today', 1000);
		expect(state.streak.current).toBe(4);
		expect(state.streak.longest).toBe(7);
		expect(state.streak.claimableToday).toBe(false);
		expect(state.streak.lastClaimPeriodKey).toBe(today);
		expect(state.streak.rewardPreview).toBe(0);
	});

	test('reflects streak row — claimed yesterday → claimable, reward preview for next day', async () => {
		const mock = makeMockD1();
		const d = new Date();
		d.setUTCDate(d.getUTCDate() - 1);
		const yesterday = d.toISOString().slice(0, 10);
		mock.onAll('SELECT originalMissionDefId', () => ({ results: [] }));
		mock.onFirst('SELECT currentStreak', () => ({
			currentStreak: 2,
			longestStreak: 5,
			lastClaimPeriodKey: yesterday,
		}));
		mock.onAll('SELECT missionDefId', () => ({ results: [] }));

		const state = await getBoardState(mock.binding, 'user-streak-yesterday', 1000);
		expect(state.streak.current).toBe(2);
		expect(state.streak.claimableToday).toBe(true);
		expect(state.streak.rewardPreview).toBeGreaterThan(0);
	});
});
