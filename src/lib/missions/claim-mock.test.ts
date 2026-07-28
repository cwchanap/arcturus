/**
 * Mock-based unit tests for the DB-touching functions in claim.ts.
 *
 * The Miniflare integration tests in `claim.test.ts` prove the
 * security-critical double-pay prevention against real workerd SQLite.
 * This file provides a coverage floor that runs anywhere `bun test` runs
 * — no workerd required — by routing D1 calls through the shared mock
 * in `mock-d1.ts`.
 *
 * Covers:
 *  - claimMission: not-found, completed, already-claimed, not-completed
 *  - claimLogin: first-ever claim, already-claimed (fast path), continuing
 *    streak, race loser (changes === 0)
 */

import { describe, expect, test } from 'bun:test';
import { claimMission, claimLogin } from './claim';
import { makeMockD1 } from './mock-d1';
import { getDailyPeriodKey, getDailyPeriodKeyForYesterday } from './periods';

describe('claimMission (mocked D1)', () => {
	test('returns not-found for an unknown mission def id', async () => {
		const mock = makeMockD1();
		const result = await claimMission(mock.binding, 'user-nf', 'does-not-exist', 1000);
		expect(result.status).toBe('not-found');
		expect(result.rewardChips).toBe(0);
		expect(result.chipBalance).toBe(1000);
		// No D1 calls — getMissionDef returns undefined before any DB work.
		expect(mock.calls).toHaveLength(0);
	});

	test('completes and grants reward when target reached and unclaimed', async () => {
		const mock = makeMockD1();
		// The claim UPDATE in the batch reports 1 row changed.
		mock.onRun('UPDATE mission_progress', () => ({ meta: { changes: 1 } }));
		mock.onRun('UPDATE user SET chipBalance', () => ({ meta: { changes: 1 } }));

		const result = await claimMission(mock.binding, 'user-ok', 'daily-blackjack-5', 1000);
		expect(result.status).toBe('completed');
		expect(result.rewardChips).toBe(500);
		expect(result.chipBalance).toBe(1500);
		// Two statements in the batch: claim UPDATE + grant UPDATE.
		expect(mock.calls).toHaveLength(2);
	});

	test('returns already-claimed when the claim UPDATE reports 0 changes and claimedAt is set', async () => {
		const mock = makeMockD1();
		// Claim UPDATE → 0 changes (already claimed or progress < target).
		mock.onRun('UPDATE mission_progress', () => ({ meta: { changes: 0 } }));
		mock.onRun('UPDATE user SET chipBalance', () => ({ meta: { changes: 0 } }));
		// The follow-up SELECT shows claimedAt is set → already-claimed.
		const nowSeconds = Math.trunc(Date.now() / 1000);
		mock.onFirst('SELECT claimedAt FROM mission_progress', () => ({ claimedAt: nowSeconds }));

		const result = await claimMission(mock.binding, 'user-idem', 'daily-blackjack-5', 1000);
		expect(result.status).toBe('already-claimed');
		expect(result.rewardChips).toBe(0);
		expect(result.chipBalance).toBe(1000);
	});

	test('returns not-completed when the claim UPDATE reports 0 changes and claimedAt is null', async () => {
		const mock = makeMockD1();
		mock.onRun('UPDATE mission_progress', () => ({ meta: { changes: 0 } }));
		mock.onRun('UPDATE user SET chipBalance', () => ({ meta: { changes: 0 } }));
		// The follow-up SELECT shows claimedAt is null → not-completed.
		mock.onFirst('SELECT claimedAt FROM mission_progress', () => ({ claimedAt: null }));

		const result = await claimMission(mock.binding, 'user-inc', 'daily-blackjack-5', 1000);
		expect(result.status).toBe('not-completed');
		expect(result.rewardChips).toBe(0);
		expect(result.chipBalance).toBe(1000);
	});

	test('returns not-completed when the follow-up SELECT returns no row', async () => {
		const mock = makeMockD1();
		mock.onRun('UPDATE mission_progress', () => ({ meta: { changes: 0 } }));
		mock.onRun('UPDATE user SET chipBalance', () => ({ meta: { changes: 0 } }));
		// No row at all → not-completed (not already-claimed).
		mock.onFirst('SELECT claimedAt FROM mission_progress', () => null);

		const result = await claimMission(mock.binding, 'user-norow', 'daily-blackjack-5', 1000);
		expect(result.status).toBe('not-completed');
	});
});

describe('claimLogin (mocked D1)', () => {
	test('first-ever claim starts streak at 1 and grants day-1 reward', async () => {
		const mock = makeMockD1();
		// No existing streak row.
		mock.onFirst('SELECT currentStreak, longestStreak, lastClaimPeriodKey', () => null);
		// The streak UPSERT in the batch reports 1 row changed.
		mock.onRun('INSERT INTO login_streak', () => ({ meta: { changes: 1 } }));
		mock.onRun('UPDATE user SET chipBalance', () => ({ meta: { changes: 1 } }));

		const result = await claimLogin(mock.binding, 'login-first', 1000);
		expect(result.status).toBe('completed');
		expect(result.currentStreak).toBe(1);
		expect(result.longestStreak).toBe(1);
		expect(result.dayOfCycle).toBe(1);
		expect(result.rewardChips).toBe(1000);
		expect(result.chipBalance).toBe(2000);
	});

	test('is idempotent — second claim same day returns already-claimed (fast path)', async () => {
		const mock = makeMockD1();
		const today = getDailyPeriodKey();
		// Existing streak row with lastClaimPeriodKey === today.
		mock.onFirst('SELECT currentStreak, longestStreak, lastClaimPeriodKey', () => ({
			currentStreak: 1,
			longestStreak: 1,
			lastClaimPeriodKey: today,
		}));

		const result = await claimLogin(mock.binding, 'login-idem', 1000);
		expect(result.status).toBe('already-claimed');
		expect(result.rewardChips).toBe(0);
		expect(result.chipBalance).toBe(1000);
		expect(result.currentStreak).toBe(1);
		expect(result.longestStreak).toBe(1);
		expect(result.dayOfCycle).toBe(1);
		// Fast path: only the initial SELECT, no batch.
		expect(mock.calls).toHaveLength(1);
	});

	test('continues the streak when lastClaimPeriodKey is yesterday', async () => {
		const mock = makeMockD1();
		const yesterday = getDailyPeriodKeyForYesterday();
		mock.onFirst('SELECT currentStreak, longestStreak, lastClaimPeriodKey', () => ({
			currentStreak: 3,
			longestStreak: 5,
			lastClaimPeriodKey: yesterday,
		}));
		mock.onRun('INSERT INTO login_streak', () => ({ meta: { changes: 1 } }));
		mock.onRun('UPDATE user SET chipBalance', () => ({ meta: { changes: 1 } }));

		const result = await claimLogin(mock.binding, 'login-next', 1000);
		expect(result.status).toBe('completed');
		expect(result.currentStreak).toBe(4);
		expect(result.longestStreak).toBe(5);
		expect(result.dayOfCycle).toBe(4);
		// Day-4 reward = 2000.
		expect(result.rewardChips).toBe(2000);
		expect(result.chipBalance).toBe(3000);
	});

	test('resets to day 1 when the gap is more than one day', async () => {
		const mock = makeMockD1();
		mock.onFirst('SELECT currentStreak, longestStreak, lastClaimPeriodKey', () => ({
			currentStreak: 5,
			longestStreak: 7,
			lastClaimPeriodKey: '2020-01-01',
		}));
		mock.onRun('INSERT INTO login_streak', () => ({ meta: { changes: 1 } }));
		mock.onRun('UPDATE user SET chipBalance', () => ({ meta: { changes: 1 } }));

		const result = await claimLogin(mock.binding, 'login-reset', 1000);
		expect(result.status).toBe('completed');
		expect(result.currentStreak).toBe(1);
		expect(result.longestStreak).toBe(7);
		expect(result.dayOfCycle).toBe(1);
		expect(result.rewardChips).toBe(1000);
		expect(result.chipBalance).toBe(2000);
	});

	test('returns already-claimed when the UPSERT reports 0 changes (race loser)', async () => {
		const mock = makeMockD1();
		const yesterday = getDailyPeriodKeyForYesterday();
		mock.onFirst('SELECT currentStreak, longestStreak, lastClaimPeriodKey', () => ({
			currentStreak: 2,
			longestStreak: 5,
			lastClaimPeriodKey: yesterday,
		}));
		// The ON CONFLICT WHERE clause rejects the upsert — another
		// request claimed between our read and write.
		mock.onRun('INSERT INTO login_streak', () => ({ meta: { changes: 0 } }));
		mock.onRun('UPDATE user SET chipBalance', () => ({ meta: { changes: 0 } }));

		const result = await claimLogin(mock.binding, 'login-race', 1000);
		expect(result.status).toBe('already-claimed');
		expect(result.rewardChips).toBe(0);
		expect(result.chipBalance).toBe(1000);
		// Race loser returns the pre-write streak values.
		expect(result.currentStreak).toBe(2);
		expect(result.longestStreak).toBe(5);
	});
});
