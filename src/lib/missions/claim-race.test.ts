/**
 * Mocked unit test for the `claimLogin` race-loser branch.
 *
 * This branch is structurally unreachable through Miniflare integration:
 * the only way `streakChanges === 0` after the batch is if another request
 * updated `login_streak.lastClaimPeriodKey` to `today` between our read
 * (which saw `lastClaimPeriodKey !== today`, so we didn't take the fast
 * path) and our upsert (whose WHERE clause `lastClaimPeriodKey != today`
 * then matched 0 rows). Single-threaded Miniflare can't reproduce that
 * interleaving, so we mock D1 to force `batch()` to report 0 changes.
 *
 * This file is kept separate from `claim.test.ts` because the fake D1
 * would replace the real Miniflare binding used by the integration tests.
 */

import { describe, expect, test } from 'bun:test';
import type { D1Database } from '@cloudflare/workers-types';
import { claimLogin } from './claim';
import { getDailyPeriodKey, getDailyPeriodKeyForYesterday } from './periods';

/**
 * Fake D1 for the claimLogin race-loser path:
 *  - The streak SELECT returns a row whose lastClaimPeriodKey is yesterday
 *    (so the fast path `lastClaimPeriodKey === today` does NOT fire and we
 *    proceed to the upsert).
 *  - `batch()` returns results[0].meta.changes === 0, emulating the
 *    ON CONFLICT WHERE clause matching 0 rows because a concurrent request
 *    just set lastClaimPeriodKey = today.
 */
function makeRaceLoserD1(existingStreak: {
	currentStreak: number;
	longestStreak: number;
	lastClaimPeriodKey: string;
}): D1Database {
	const yesterday = getDailyPeriodKeyForYesterday();
	const chain = {
		bind: () => ({
			first: async () => existingStreak,
			// batch is called on the d1 root, not on the prepared statement.
			run: async () => ({ meta: { changes: 0 } }),
			all: async () => ({ results: [] }),
		}),
	};
	const d1 = {
		prepare: () => chain,
		batch: async () => [{ meta: { changes: 0 } }, { meta: { changes: 0 } }],
	};
	// Guard: the streak row's lastClaimPeriodKey must NOT be today, otherwise
	// claimLogin takes the fast path and never reaches the batch.
	if (existingStreak.lastClaimPeriodKey === getDailyPeriodKey()) {
		throw new Error(
			`test setup error: lastClaimPeriodKey must != today to bypass the fast path (got ${existingStreak.lastClaimPeriodKey})`,
		);
	}
	// Sanity: yesterday is the canonical non-today key used by the integration tests.
	void yesterday;
	return d1 as unknown as D1Database;
}

describe('claimLogin race-loser branch (mocked D1)', () => {
	test('returns already-claimed with 0 reward when the upsert reports 0 changes', async () => {
		const yesterday = getDailyPeriodKeyForYesterday();
		const d1 = makeRaceLoserD1({
			currentStreak: 3,
			longestStreak: 5,
			lastClaimPeriodKey: yesterday,
		});

		const result = await claimLogin(d1, 'user-race', 1000);

		expect(result.status).toBe('already-claimed');
		expect(result.rewardChips).toBe(0);
		expect(result.chipBalance).toBe(1000);
		// The race-loser branch surfaces the *pre-existing* streak values
		// (not the transition values) — the upsert didn't fire, so the
		// streak is whatever the concurrent winner left it at.
		expect(result.currentStreak).toBe(3);
		expect(result.longestStreak).toBe(5);
		// dayOfCycle is computed inline as ((currentStreak - 1) % 7) + 1.
		expect(result.dayOfCycle).toBe(((3 - 1) % 7) + 1);
	});

	test('race-loser dayOfCycle wraps correctly for a multi-cycle streak', async () => {
		// currentStreak=10 → ((10-1) % 7) + 1 = 3. Verifies the inline
		// formula matches getDayOfCycle's cycling semantics.
		const d1 = makeRaceLoserD1({
			currentStreak: 10,
			longestStreak: 12,
			lastClaimPeriodKey: getDailyPeriodKeyForYesterday(),
		});

		const result = await claimLogin(d1, 'user-race-cycle', 500);
		expect(result.dayOfCycle).toBe(3);
	});
});
