import { describe, expect, test } from 'bun:test';
import {
	addPendingStats,
	createPendingStats,
	getFollowUpBackoffDelayMs,
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
		expect(remainder.biggestWinCandidate).toBe(50);
	});

	test('subtractPendingStats clamps to zero and keeps biggestWinCandidate', () => {
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
		expect(remainder.biggestWinCandidate).toBe(80);
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
});
