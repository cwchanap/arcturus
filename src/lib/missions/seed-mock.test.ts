/**
 * Mock-based unit tests for `seedStreakFromOldMission`.
 *
 * The Miniflare integration tests in `seed.test.ts` prove correctness
 * against real workerd SQLite. This file provides a coverage floor that
 * runs anywhere `bun test` runs — no workerd required — by routing D1
 * calls through the shared mock in `mock-d1.ts`.
 *
 * Covers every branch of the seeding function:
 *  1. Streak row already exists → no-op (early return).
 *  2. No old `mission` row for daily-login → no-op.
 *  3. Old daily-login completedDate is null → no-op.
 *  4. Old daily-login completedDate is a different day → no-op.
 *  5. Old daily-login completedDate is today → seeds a login_streak row.
 *  6. Idempotent — second call after the seed does not duplicate or overwrite.
 */

import { describe, expect, test } from 'bun:test';
import { seedStreakFromOldMission } from './seed';
import { makeMockD1 } from './mock-d1';
import { getDailyPeriodKey } from './periods';

describe('seedStreakFromOldMission (mocked D1)', () => {
	test('is a no-op when a login_streak row already exists for the user', async () => {
		const mock = makeMockD1();
		// login_streak SELECT → row exists
		mock.onFirst('SELECT userId FROM login_streak', () => ({ userId: 'user-1' }));

		await seedStreakFromOldMission(mock.binding, 'user-1');

		// Only the login_streak existence check should have run — no
		// further queries because the early return fires.
		expect(mock.calls).toHaveLength(1);
		expect(mock.calls[0].sql).toContain('SELECT userId FROM login_streak');
		expect(mock.calls[0].args).toEqual(['user-1']);
	});

	test('is a no-op when no old daily-login mission row exists', async () => {
		const mock = makeMockD1();
		// login_streak SELECT → null (no streak row)
		mock.onFirst('SELECT userId FROM login_streak', () => null);
		// old mission SELECT → null (no mission row)
		mock.onFirst('SELECT completedDate FROM mission', () => null);

		await seedStreakFromOldMission(mock.binding, 'user-2');

		// Two queries: streak existence check + old mission lookup.
		expect(mock.calls).toHaveLength(2);
		expect(mock.calls[1].sql).toContain("missionId = 'daily-login'");
		// No INSERT should have been issued.
		const insertCalls = mock.calls.filter((c) => c.sql.startsWith('INSERT'));
		expect(insertCalls).toHaveLength(0);
	});

	test('is a no-op when the old daily-login row has a null completedDate', async () => {
		const mock = makeMockD1();
		mock.onFirst('SELECT userId FROM login_streak', () => null);
		mock.onFirst('SELECT completedDate FROM mission', () => ({ completedDate: null }));

		await seedStreakFromOldMission(mock.binding, 'user-3');

		// Two queries, no INSERT.
		expect(mock.calls).toHaveLength(2);
		const insertCalls = mock.calls.filter((c) => c.sql.startsWith('INSERT'));
		expect(insertCalls).toHaveLength(0);
	});

	test('is a no-op when the old daily-login was completed on a different day', async () => {
		const mock = makeMockD1();
		mock.onFirst('SELECT userId FROM login_streak', () => null);
		// Three days ago.
		const d = new Date();
		d.setUTCDate(d.getUTCDate() - 3);
		const dSeconds = Math.trunc(d.getTime() / 1000);
		mock.onFirst('SELECT completedDate FROM mission', () => ({ completedDate: dSeconds }));

		await seedStreakFromOldMission(mock.binding, 'user-4');

		// Two queries, no INSERT.
		expect(mock.calls).toHaveLength(2);
		const insertCalls = mock.calls.filter((c) => c.sql.startsWith('INSERT'));
		expect(insertCalls).toHaveLength(0);
	});

	test('seeds a streak row at 1/1/today when the old daily-login was completed today', async () => {
		const mock = makeMockD1();
		const today = getDailyPeriodKey();
		mock.onFirst('SELECT userId FROM login_streak', () => null);
		// Use a Date exactly at today's UTC midnight so completedDay === today.
		const todayMidnightSeconds = Math.trunc(
			Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()) /
				1000,
		);
		mock.onFirst('SELECT completedDate FROM mission', () => ({
			completedDate: todayMidnightSeconds,
		}));
		let insertArgs: unknown[] | null = null;
		mock.onRun('INSERT INTO login_streak', (args) => {
			insertArgs = args;
			return { meta: { changes: 1 } };
		});

		await seedStreakFromOldMission(mock.binding, 'user-5');

		// Three queries: streak check, old mission lookup, INSERT.
		expect(mock.calls).toHaveLength(3);
		const insertCalls = mock.calls.filter((c) => c.sql.startsWith('INSERT INTO login_streak'));
		expect(insertCalls).toHaveLength(1);
		expect(insertArgs).toEqual(['user-5', today]);
	});

	test('is idempotent — a second call after the seed does not duplicate or overwrite the row', async () => {
		const mock = makeMockD1();
		const todayMidnightSeconds = Math.trunc(
			Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()) /
				1000,
		);
		let streakExists = false;
		mock.onFirst('SELECT userId FROM login_streak', () => {
			// First call: no streak row. Second call: streak row exists.
			if (streakExists) return { userId: 'user-6' };
			streakExists = true;
			return null;
		});
		mock.onFirst('SELECT completedDate FROM mission', () => ({
			completedDate: todayMidnightSeconds,
		}));
		mock.onRun('INSERT INTO login_streak', () => ({ meta: { changes: 1 } }));

		// First call seeds the row.
		await seedStreakFromOldMission(mock.binding, 'user-6');
		// Second call sees the existing streak row and short-circuits.
		await seedStreakFromOldMission(mock.binding, 'user-6');

		// Second call should only have 1 query (the streak existence check).
		// Total: 3 (first call) + 1 (second call) = 4.
		expect(mock.calls).toHaveLength(4);
		// Only one INSERT across both calls.
		const insertCalls = mock.calls.filter((c) => c.sql.startsWith('INSERT INTO login_streak'));
		expect(insertCalls).toHaveLength(1);
	});
});
