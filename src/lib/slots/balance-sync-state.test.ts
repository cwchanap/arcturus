import { describe, expect, test } from 'bun:test';
import {
	addPendingStats,
	computeSlotsBatchStats,
	createPendingStats,
	getFollowUpBackoffDelayMs,
	MAX_SLOTS_SYNC_HANDS_PER_REQUEST,
	shouldAbandonFollowUpSync,
	resolveSlotsSyncState,
	subtractPendingStats,
} from './balance-sync-state';

describe('balance-sync-state', () => {
	test('createPendingStats starts empty', () => {
		expect(createPendingStats()).toEqual({
			winsIncrement: 0,
			lossesIncrement: 0,
			handsIncrement: 0,
			biggestWinCandidate: undefined,
		});
	});

	test('addPendingStats accumulates increments and tracks biggest win', () => {
		let p = createPendingStats();
		p = addPendingStats(p, 1, 0, 1, 50);
		p = addPendingStats(p, 0, 1, 1, -10);
		expect(p.winsIncrement).toBe(1);
		expect(p.lossesIncrement).toBe(1);
		expect(p.handsIncrement).toBe(2);
		expect(p.biggestWinCandidate).toBe(50);
	});

	test('subtractPendingStats removes synced portion and preserves remainder', () => {
		let p = createPendingStats();
		p = addPendingStats(p, 1, 0, 1, 50);
		p = addPendingStats(p, 0, 1, 1, -10);
		const snapshot = {
			winsIncrement: 1,
			lossesIncrement: 0,
			handsIncrement: 1,
			biggestWinCandidate: 50,
		};
		const remainder = subtractPendingStats(p, snapshot);
		expect(remainder.winsIncrement).toBe(0);
		expect(remainder.lossesIncrement).toBe(1);
		expect(remainder.handsIncrement).toBe(1);
		expect(remainder.biggestWinCandidate).toBeUndefined();
	});

	test('subtractPendingStats clamps to zero and resets biggestWinCandidate', () => {
		const p = { winsIncrement: 2, lossesIncrement: 1, handsIncrement: 3, biggestWinCandidate: 80 };
		const synced = {
			winsIncrement: 3,
			lossesIncrement: 5,
			handsIncrement: 10,
			biggestWinCandidate: 10,
		};
		const remainder = subtractPendingStats(p, synced);
		expect(remainder.winsIncrement).toBe(0);
		expect(remainder.lossesIncrement).toBe(0);
		expect(remainder.handsIncrement).toBe(0);
		expect(remainder.biggestWinCandidate).toBeUndefined();
	});

	test('shouldAbandonFollowUpSync respects the attempt cap', () => {
		expect(shouldAbandonFollowUpSync(2, 3)).toBe(false);
		expect(shouldAbandonFollowUpSync(3, 3)).toBe(true);
	});

	test('getFollowUpBackoffDelayMs grows exponentially and is capped', () => {
		expect(getFollowUpBackoffDelayMs(1)).toBe(1000);
		expect(getFollowUpBackoffDelayMs(2)).toBe(2000);
		expect(getFollowUpBackoffDelayMs(99)).toBeLessThanOrEqual(8000);
	});

	test('resolveSlotsSyncState clears on server balance or terminal error, else retries', () => {
		expect(resolveSlotsSyncState({ hasServerBalance: true })).toEqual({
			clearPendingStats: true,
			syncPending: false,
		});
		expect(resolveSlotsSyncState({ error: 'BALANCE_MISMATCH', hasServerBalance: false })).toEqual({
			clearPendingStats: true,
			syncPending: false,
		});
		expect(resolveSlotsSyncState({ error: 'RATE_LIMITED', hasServerBalance: false })).toEqual({
			clearPendingStats: false,
			syncPending: true,
		});
	});

	test('MAX_SLOTS_SYNC_HANDS_PER_REQUEST is 100 (matches server MAX_HAND_COUNT)', () => {
		expect(MAX_SLOTS_SYNC_HANDS_PER_REQUEST).toBe(100);
	});

	describe('computeSlotsBatchStats', () => {
		test('empty array produces zero stats', () => {
			expect(computeSlotsBatchStats([])).toEqual({
				winsIncrement: 0,
				lossesIncrement: 0,
				handsIncrement: 0,
				biggestWinCandidate: undefined,
			});
		});

		test('mixed wins, losses, and pushes produce correct counts', () => {
			const stats = computeSlotsBatchStats([50, -10, 0, 30, -5]);
			expect(stats.handsIncrement).toBe(5);
			expect(stats.winsIncrement).toBe(2);
			expect(stats.lossesIncrement).toBe(2);
			expect(stats.biggestWinCandidate).toBe(50);
		});

		test('biggestWinCandidate is the max positive delta, ignoring losses and pushes', () => {
			const stats = computeSlotsBatchStats([-100, 20, 0, 80, -30]);
			expect(stats.biggestWinCandidate).toBe(80);
		});

		test('all losses produce undefined biggestWinCandidate', () => {
			const stats = computeSlotsBatchStats([-10, -20, -5]);
			expect(stats.winsIncrement).toBe(0);
			expect(stats.lossesIncrement).toBe(3);
			expect(stats.handsIncrement).toBe(3);
			expect(stats.biggestWinCandidate).toBeUndefined();
		});

		test('all pushes produce zero counts and undefined biggestWinCandidate', () => {
			const stats = computeSlotsBatchStats([0, 0, 0]);
			expect(stats.winsIncrement).toBe(0);
			expect(stats.lossesIncrement).toBe(0);
			expect(stats.handsIncrement).toBe(3);
			expect(stats.biggestWinCandidate).toBeUndefined();
		});

		test('matches addPendingStats accumulation for the same sequence', () => {
			const deltas = [50, -10, 30, 0, -5, 80];
			const computed = computeSlotsBatchStats(deltas);
			let accumulated = createPendingStats();
			for (const d of deltas) {
				accumulated = addPendingStats(accumulated, d > 0 ? 1 : 0, d < 0 ? 1 : 0, 1, d);
			}
			expect(computed).toEqual(accumulated);
		});
	});
});
