import { describe, expect, test } from 'bun:test';
import {
	buildCrapsSyncBatch,
	getBalanceAfterCrapsSyncFailure,
	getBalanceAfterCrapsSyncSuccess,
} from './balanceSync';

describe('buildCrapsSyncBatch', () => {
	test('limits batches by projected positive delta', () => {
		const batch = buildCrapsSyncBatch({
			pendingRollSyncs: [
				{ netDelta: 2000, winsCount: 1, lossesCount: 0 },
				{ netDelta: 1500, winsCount: 1, lossesCount: 0 },
				{ netDelta: 1000, winsCount: 1, lossesCount: 0 },
			],
			currentBalance: 53100,
			previousBalance: 50000,
			maxWinDelta: 2500,
			maxLossDelta: 100000,
		});

		expect(batch.ackHands).toBe(2);
		expect(batch.ackStatsDelta).toBe(3500);
		expect(batch.pendingWagerDelta).toBe(-1400);
		expect(batch.ackDelta).toBe(2100);
		expect(batch.remainingRollDelta).toBe(1000);
		expect(batch.ackBiggestWin).toBe(2000);
	});

	test('sends a wager-only batch when the next roll would exceed the cap', () => {
		const batch = buildCrapsSyncBatch({
			pendingRollSyncs: [{ netDelta: 40, winsCount: 1, lossesCount: 0 }],
			currentBalance: 50005,
			previousBalance: 0,
			maxWinDelta: 50000,
			maxLossDelta: 100000,
		});

		expect(batch.ackHands).toBe(0);
		expect(batch.ackStatsDelta).toBe(0);
		expect(batch.pendingWagerDelta).toBe(49965);
		expect(batch.ackDelta).toBe(49965);
		expect(batch.remainingRollDelta).toBe(40);
	});

	test('limits batches by hand count', () => {
		const batch = buildCrapsSyncBatch({
			pendingRollSyncs: [
				{ netDelta: 10, winsCount: 1, lossesCount: 0 },
				{ netDelta: -5, winsCount: 0, lossesCount: 1 },
				{ netDelta: 20, winsCount: 1, lossesCount: 0 },
			],
			currentBalance: 1025,
			previousBalance: 1000,
			maxSyncHandsPerRequest: 2,
		});

		expect(batch.ackHands).toBe(2);
		expect(batch.ackWins).toBe(1);
		expect(batch.ackLosses).toBe(1);
		expect(batch.ackStatsDelta).toBe(5);
		expect(batch.remainingRollDelta).toBe(20);
	});
});

describe('craps sync balance reconciliation', () => {
	test('keeps unsent roll delta after a successful partial sync', () => {
		const balance = getBalanceAfterCrapsSyncSuccess({
			serverBalance: 1060,
			ackCurrentBalance: 1100,
			currentBalance: 1100,
			remainingRollDelta: 40,
		});

		expect(balance).toBe(1100);
	});

	test('keeps pending local changes after a retryable failure', () => {
		const balance = getBalanceAfterCrapsSyncFailure({
			serverBalance: 980,
			ackCurrentBalance: 1100,
			currentBalance: 1110,
			pendingBalanceDelta: 100,
		});

		expect(balance).toBe(1090);
	});
});
