import { describe, expect, test } from 'bun:test';
import { resolveBaccaratSyncState } from './balance-sync-state';

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
