import { describe, expect, test } from 'bun:test';
import {
	getFollowUpBackoffDelayMs,
	reconcilePendingBiggestWinCandidate,
	resolveBaccaratSyncState,
	shouldAbandonFollowUpSync,
} from './balance-sync-state';

describe('reconcilePendingBiggestWinCandidate', () => {
	test('clears biggest win candidate when sync already covered it', () => {
		const reconciled = reconcilePendingBiggestWinCandidate(90, 90);

		expect(reconciled).toBeUndefined();
	});

	test('preserves bigger concurrent candidate for follow-up sync', () => {
		const reconciled = reconcilePendingBiggestWinCandidate(130, 90);

		expect(reconciled).toBe(130);
	});
});

describe('follow-up sync retry controls', () => {
	test('should not abandon follow-up sync before max attempts', () => {
		expect(shouldAbandonFollowUpSync(0)).toBe(false);
		expect(shouldAbandonFollowUpSync(2)).toBe(false);
	});

	test('should abandon follow-up sync at max attempts', () => {
		expect(shouldAbandonFollowUpSync(3)).toBe(true);
		expect(shouldAbandonFollowUpSync(4)).toBe(true);
	});

	test('should compute exponential backoff with cap', () => {
		expect(getFollowUpBackoffDelayMs(1)).toBe(1000);
		expect(getFollowUpBackoffDelayMs(2)).toBe(2000);
		expect(getFollowUpBackoffDelayMs(3)).toBe(4000);
		expect(getFollowUpBackoffDelayMs(4)).toBe(8000);
		expect(getFollowUpBackoffDelayMs(10)).toBe(8000);
	});

	test('should fallback to 1s for invalid attempt values', () => {
		expect(getFollowUpBackoffDelayMs(0)).toBe(1000);
		expect(getFollowUpBackoffDelayMs(-1)).toBe(1000);
		expect(getFollowUpBackoffDelayMs(Number.NaN)).toBe(1000);
	});
});

describe('resolveBaccaratSyncState', () => {
	test('clears pending stats when server balance is available', () => {
		const resolution = resolveBaccaratSyncState({
			error: 'BALANCE_MISMATCH',
			hasServerBalance: true,
		});

		expect(resolution).toEqual({
			clearPendingStats: true,
			syncPending: false,
		});
	});

	test('keeps pending stats and syncs when rate limited', () => {
		const resolution = resolveBaccaratSyncState({
			error: 'RATE_LIMITED',
			hasServerBalance: false,
		});

		expect(resolution).toEqual({
			clearPendingStats: false,
			syncPending: true,
		});
	});

	test('keeps pending stats when balance is retained after errors', () => {
		const resolution = resolveBaccaratSyncState({
			error: 'SERVER_ERROR',
			hasServerBalance: false,
		});

		expect(resolution).toEqual({
			clearPendingStats: false,
			syncPending: true,
		});
	});

	test('keeps pending stats on network errors without server balance', () => {
		const resolution = resolveBaccaratSyncState({
			error: undefined,
			hasServerBalance: false,
		});

		expect(resolution).toEqual({
			clearPendingStats: false,
			syncPending: true,
		});
	});

	test('does not retry on DELTA_EXCEEDS_LIMIT error', () => {
		const resolution = resolveBaccaratSyncState({
			error: 'DELTA_EXCEEDS_LIMIT',
			hasServerBalance: false,
		});

		expect(resolution).toEqual({
			clearPendingStats: false,
			syncPending: false,
		});
	});

	test('does not retry on INSUFFICIENT_BALANCE error', () => {
		const resolution = resolveBaccaratSyncState({
			error: 'INSUFFICIENT_BALANCE',
			hasServerBalance: false,
		});

		expect(resolution).toEqual({
			clearPendingStats: false,
			syncPending: false,
		});
	});

	test('does not retry on INVALID_REQUEST error', () => {
		const resolution = resolveBaccaratSyncState({
			error: 'INVALID_REQUEST',
			hasServerBalance: false,
		});

		expect(resolution).toEqual({
			clearPendingStats: false,
			syncPending: false,
		});
	});

	test('does not retry on BALANCE_MISMATCH without server balance', () => {
		const resolution = resolveBaccaratSyncState({
			error: 'BALANCE_MISMATCH',
			hasServerBalance: false,
		});

		expect(resolution).toEqual({
			clearPendingStats: false,
			syncPending: false,
		});
	});
});
