/**
 * Mock-based unit tests for performReroll branches that are only covered
 * by Miniflare integration in `reroll.test.ts`.
 *
 * The `reroll-noop.test.ts` file covers the `no-replacement` and
 * race-loser branches using `mock.module('./board')`. This file covers
 * the remaining branches using a mock D1Database — no `mock.module`
 * needed because performReroll's imports from `./board` (getOverrides,
 * applyOverrides, getReplacementPool) all work through the mock D1.
 *
 * Covers:
 *  - not-daily: unknown mission def id, weekly mission def id
 *  - reroll-used: one-per-day guard (existing override)
 *  - already-completed: target mission completed today
 *  - rerolled: happy path with a pool replacement
 */

import { describe, expect, test } from 'bun:test';
import { performReroll } from './reroll';
import { makeMockD1 } from './mock-d1';
import { getDailyPeriodKey } from './periods';
import { REROLL_POOL_DAILY } from './registry';

describe('performReroll (mocked D1)', () => {
	test('returns not-daily for an unknown mission def id (no D1 calls)', async () => {
		const mock = makeMockD1();
		const result = await performReroll(mock.binding, 'user-unknown', 'does-not-exist');
		expect(result.status).toBe('not-daily');
		// getMissionDef returns undefined before any DB work.
		expect(mock.calls).toHaveLength(0);
	});

	test('returns not-daily for a weekly mission def id', async () => {
		const mock = makeMockD1();
		const result = await performReroll(mock.binding, 'user-weekly', 'weekly-games-3');
		expect(result.status).toBe('not-daily');
		// def.period === 'weekly' → early return before any DB work.
		expect(mock.calls).toHaveLength(0);
	});

	test('returns reroll-used when an override already exists for today (one-per-day guard)', async () => {
		const mock = makeMockD1();
		// getOverrides → one existing override row.
		mock.onAll('SELECT originalMissionDefId', () => ({
			results: [
				{
					originalMissionDefId: 'daily-blackjack-5',
					replacementMissionDefId: 'daily-craps-3',
				},
			],
		}));

		const result = await performReroll(mock.binding, 'user-used', 'daily-win-3');
		expect(result.status).toBe('reroll-used');
		// Only the getOverrides SELECT should have run — the one-per-day
		// guard fires before the completedAt check or pool lookup.
		expect(mock.calls).toHaveLength(1);
	});

	test('returns already-completed when the target mission is completed today', async () => {
		const mock = makeMockD1();
		// getOverrides → empty (one-per-day guard passes).
		mock.onAll('SELECT originalMissionDefId', () => ({ results: [] }));
		// mission_progress SELECT → completedAt is set.
		const nowSeconds = Math.trunc(Date.now() / 1000);
		mock.onFirst('SELECT completedAt FROM mission_progress', () => ({ completedAt: nowSeconds }));

		const result = await performReroll(mock.binding, 'user-done', 'daily-blackjack-5');
		expect(result.status).toBe('already-completed');
	});

	test('rerolls: inserts override with a pool replacement', async () => {
		const mock = makeMockD1();
		mock.onAll('SELECT originalMissionDefId', () => ({ results: [] }));
		// mission_progress SELECT → no row (uncompleted).
		mock.onFirst('SELECT completedAt FROM mission_progress', () => null);
		// Override INSERT → 1 row changed (success).
		mock.onRun('INSERT INTO mission_override', () => ({ meta: { changes: 1 } }));

		const result = await performReroll(mock.binding, 'user-ok', 'daily-blackjack-5');
		expect(result.status).toBe('rerolled');
		expect(result.originalMissionDefId).toBe('daily-blackjack-5');
		expect(result.replacementMissionDefId).toBeDefined();
		// Replacement must come from the registry reroll pool.
		expect(REROLL_POOL_DAILY.map((d) => d.id)).toContain(result.replacementMissionDefId);
	});

	test('returns reroll-used when the INSERT ON CONFLICT reports 0 rows (race loser)', async () => {
		const mock = makeMockD1();
		mock.onAll('SELECT originalMissionDefId', () => ({ results: [] }));
		mock.onFirst('SELECT completedAt FROM mission_progress', () => null);
		// Override INSERT → 0 rows changed (ON CONFLICT DO NOTHING — race loser).
		mock.onRun('INSERT INTO mission_override', () => ({ meta: { changes: 0 } }));

		const result = await performReroll(mock.binding, 'user-race', 'daily-blackjack-5');
		expect(result.status).toBe('reroll-used');
		expect(result.originalMissionDefId).toBeUndefined();
		expect(result.replacementMissionDefId).toBeUndefined();
	});
});
