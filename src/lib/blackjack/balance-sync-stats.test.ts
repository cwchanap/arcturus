import { describe, expect, test } from 'bun:test';
import {
	createPendingStats,
	addPendingStats,
	ensureRoundStatsIncluded,
	clearPendingStats,
	markSyncPendingOnRateLimit,
	type PendingStats,
} from './balance-sync-stats';

describe('balance-sync-stats', () => {
	describe('createPendingStats', () => {
		test('creates initial stats with zeros', () => {
			const stats = createPendingStats();
			expect(stats).toEqual({
				winsIncrement: 0,
				lossesIncrement: 0,
				handsIncrement: 0,
				biggestWin: 0,
			});
		});
	});

	describe('addPendingStats', () => {
		test('adds win/loss/hand counts together', () => {
			const base: PendingStats = {
				winsIncrement: 2,
				lossesIncrement: 1,
				handsIncrement: 3,
				biggestWin: 100,
			};
			const increment: PendingStats = {
				winsIncrement: 3,
				lossesIncrement: 2,
				handsIncrement: 5,
				biggestWin: 150,
			};

			const result = addPendingStats(base, increment);

			expect(result.winsIncrement).toBe(5);
			expect(result.lossesIncrement).toBe(3);
			expect(result.handsIncrement).toBe(8);
		});

		test('takes maximum of biggestWin (not sum)', () => {
			const base: PendingStats = {
				winsIncrement: 1,
				lossesIncrement: 0,
				handsIncrement: 1,
				biggestWin: 200,
			};
			const increment: PendingStats = {
				winsIncrement: 1,
				lossesIncrement: 0,
				handsIncrement: 1,
				biggestWin: 150,
			};

			const result = addPendingStats(base, increment);

			// Should keep the max (200), not sum (350)
			expect(result.biggestWin).toBe(200);
		});

		test('updates biggestWin when new value is larger', () => {
			const base: PendingStats = {
				winsIncrement: 1,
				lossesIncrement: 0,
				handsIncrement: 1,
				biggestWin: 100,
			};
			const increment: PendingStats = {
				winsIncrement: 1,
				lossesIncrement: 0,
				handsIncrement: 1,
				biggestWin: 250,
			};

			const result = addPendingStats(base, increment);

			expect(result.biggestWin).toBe(250);
		});

		test('preserves biggestWin when new value is 0', () => {
			const base: PendingStats = {
				winsIncrement: 1,
				lossesIncrement: 0,
				handsIncrement: 1,
				biggestWin: 300,
			};
			const increment: PendingStats = {
				winsIncrement: 1,
				lossesIncrement: 0,
				handsIncrement: 1,
				biggestWin: 0,
			};

			const result = addPendingStats(base, increment);

			expect(result.biggestWin).toBe(300);
		});
	});

	describe('ensureRoundStatsIncluded', () => {
		test('adds stats when not yet included', () => {
			const pending = createPendingStats();
			const roundStats: PendingStats = {
				winsIncrement: 1,
				lossesIncrement: 0,
				handsIncrement: 1,
				biggestWin: 100,
			};

			const { pendingStats, statsIncluded } = ensureRoundStatsIncluded(pending, roundStats, false);

			expect(pendingStats.winsIncrement).toBe(1);
			expect(pendingStats.biggestWin).toBe(100);
			expect(statsIncluded).toBe(true);
		});

		test('skips adding stats when already included', () => {
			const pending: PendingStats = {
				winsIncrement: 5,
				lossesIncrement: 2,
				handsIncrement: 7,
				biggestWin: 200,
			};
			const roundStats: PendingStats = {
				winsIncrement: 1,
				lossesIncrement: 1,
				handsIncrement: 1,
				biggestWin: 300,
			};

			const { pendingStats, statsIncluded } = ensureRoundStatsIncluded(
				pending,
				roundStats,
				true, // Already included
			);

			// Should not change since already included
			expect(pendingStats.winsIncrement).toBe(5);
			expect(pendingStats.biggestWin).toBe(200);
			expect(statsIncluded).toBe(true);
		});

		test('aggregates biggestWin across multiple rounds', () => {
			let pending = createPendingStats();
			let statsIncluded = false;

			// First round with 100 win
			const round1: PendingStats = {
				winsIncrement: 1,
				lossesIncrement: 0,
				handsIncrement: 1,
				biggestWin: 100,
			};
			const result1 = ensureRoundStatsIncluded(pending, round1, statsIncluded);
			pending = result1.pendingStats;
			statsIncluded = result1.statsIncluded;

			// Reset statsIncluded to false to simulate a new round being added
			statsIncluded = false;

			// Second round with 200 win (larger)
			const round2: PendingStats = {
				winsIncrement: 1,
				lossesIncrement: 0,
				handsIncrement: 1,
				biggestWin: 200,
			};
			const result2 = ensureRoundStatsIncluded(pending, round2, statsIncluded);
			pending = result2.pendingStats;
			statsIncluded = result2.statsIncluded;

			expect(pending.winsIncrement).toBe(2);
			expect(pending.biggestWin).toBe(200); // Max of 100 and 200
		});
	});

	describe('clearPendingStats', () => {
		test('resets all stats to zero', () => {
			const pending: PendingStats = {
				winsIncrement: 10,
				lossesIncrement: 5,
				handsIncrement: 15,
				biggestWin: 500,
			};

			const cleared = clearPendingStats();

			expect(cleared).toEqual({
				winsIncrement: 0,
				lossesIncrement: 0,
				handsIncrement: 0,
				biggestWin: 0,
			});
		});
	});

	describe('markSyncPendingOnRateLimit', () => {
		test('always returns true', () => {
			expect(markSyncPendingOnRateLimit(false)).toBe(true);
			expect(markSyncPendingOnRateLimit(true)).toBe(true);
		});
	});
});
