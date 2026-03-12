import { describe, expect, test } from 'bun:test';
import {
	buildCrapsSyncBatch,
	getBalanceAfterCrapsSyncFailure,
	getBalanceAfterCrapsSyncSuccess,
} from './balanceSync';

describe('buildCrapsSyncBatch', () => {
	test('limits batches when nextStatsDelta would exceed the cap', () => {
		// pendingWagerDelta = (53100 - 50000) - (2000 + 1500 + 1000) = -1400
		// Roll 1: nextStatsDelta = 2000 ≤ maxWinDelta 2500 → include
		// Roll 2: nextStatsDelta = 3500 > maxWinDelta 2500 → deferred (independent statsDelta cap)
		const batch = buildCrapsSyncBatch({
			pendingRollSyncs: [
				{ netDelta: 2000, winsCount: 1, lossesCount: 0, pushesCount: 0 },
				{ netDelta: 1500, winsCount: 1, lossesCount: 0, pushesCount: 0 },
				{ netDelta: 1000, winsCount: 1, lossesCount: 0, pushesCount: 0 },
			],
			currentBalance: 53100,
			previousBalance: 50000,
			maxWinDelta: 2500,
			maxLossDelta: 100000,
		});

		expect(batch.ackHands).toBe(1);
		expect(batch.ackStatsDelta).toBe(2000);
		expect(batch.pendingWagerDelta).toBe(-1400);
		expect(batch.ackDelta).toBe(600);
		expect(batch.remainingRollDelta).toBe(2500);
		expect(batch.ackBiggestWin).toBe(2000);
	});

	test('forces an oversized single roll through even when it exceeds the cap alone', () => {
		// If the roll itself is larger than the cap, no future sync will ever include it
		// (pendingWagerDelta drops to 0 after the wager flush, projectedDelta == roll delta,
		// still over cap → stuck forever).  The fix: include it anyway so it is at least
		// attempted; the server is the final authority.
		const batch = buildCrapsSyncBatch({
			pendingRollSyncs: [{ netDelta: 60000, winsCount: 1, lossesCount: 0, pushesCount: 0 }],
			currentBalance: 60000,
			previousBalance: 0,
			maxWinDelta: 50000,
			maxLossDelta: 100000,
		});

		expect(batch.ackHands).toBe(1);
		expect(batch.ackStatsDelta).toBe(60000);
		expect(batch.ackDelta).toBe(60000);
		expect(batch.remainingRollDelta).toBe(0);
	});

	test('caps statsDelta independently from delta when pendingWagerDelta is large and negative', () => {
		// Regression: with pendingWagerDelta = -150,000 and two rolls summing to 210,000,
		// projectedDelta = -150,000 + 210,000 = 60,000 stays within the cap,
		// but nextStatsDelta = 210,000 exceeds maxWinDelta = 200,000.
		// The second roll must be deferred so the API's statsDelta check doesn't reject the batch.
		const batch = buildCrapsSyncBatch({
			pendingRollSyncs: [
				{ netDelta: 100000, winsCount: 1, lossesCount: 0, pushesCount: 0 },
				{ netDelta: 110000, winsCount: 1, lossesCount: 0, pushesCount: 0 },
			],
			// pendingWagerDelta = (560000 - 500000) - 210000 = -150000
			currentBalance: 560000,
			previousBalance: 500000,
			maxWinDelta: 200000,
			maxLossDelta: 200000,
		});

		expect(batch.ackHands).toBe(1);
		expect(batch.ackStatsDelta).toBe(100000);
		expect(batch.pendingWagerDelta).toBe(-150000);
		expect(batch.ackDelta).toBe(-50000);
		expect(batch.remainingRollDelta).toBe(110000);
	});

	test('sends a wager-only batch when the next roll would exceed the cap', () => {
		const batch = buildCrapsSyncBatch({
			pendingRollSyncs: [{ netDelta: 40, winsCount: 1, lossesCount: 0, pushesCount: 0 }],
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

	test('limits batches by roll count', () => {
		const batch = buildCrapsSyncBatch({
			pendingRollSyncs: [
				{ netDelta: 10, winsCount: 1, lossesCount: 0, pushesCount: 0 },
				{ netDelta: -5, winsCount: 0, lossesCount: 1, pushesCount: 0 },
				{ netDelta: 20, winsCount: 1, lossesCount: 0, pushesCount: 0 },
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

	test('records one resolved roll as one hand even with multiple settled bets', () => {
		const batch = buildCrapsSyncBatch({
			pendingRollSyncs: [
				{ netDelta: 300, winsCount: 2, lossesCount: 0, pushesCount: 0 }, // Single roll with 2 winning bets (e.g., pass line + field on 11)
				{ netDelta: -100, winsCount: 0, lossesCount: 1, pushesCount: 0 },
			],
			currentBalance: 10200,
			previousBalance: 10000,
		});

		expect(batch.ackHands).toBe(2);
		expect(batch.ackWins).toBe(1);
		expect(batch.ackLosses).toBe(1);
		expect(batch.ackStatsDelta).toBe(200);
	});

	test('records biggestWin from grossWinAmount on mixed-outcome rolls', () => {
		// A roll where a small prop win ($100) is offset by a larger place-bet loss ($200).
		// netDelta = -100, but grossWinAmount = 100 should still be tracked as a win candidate.
		const batch = buildCrapsSyncBatch({
			pendingRollSyncs: [
				{ netDelta: -100, winsCount: 1, lossesCount: 1, pushesCount: 0, grossWinAmount: 100 },
				{ netDelta: 200, winsCount: 1, lossesCount: 0, pushesCount: 0, grossWinAmount: 200 },
			],
			currentBalance: 10100,
			previousBalance: 10000,
		});

		expect(batch.ackBiggestWin).toBe(200);
	});

	test('falls back to netDelta for biggestWin when grossWinAmount is absent', () => {
		const batch = buildCrapsSyncBatch({
			pendingRollSyncs: [
				{ netDelta: 150, winsCount: 1, lossesCount: 0, pushesCount: 0 },
				{ netDelta: 50, winsCount: 1, lossesCount: 0, pushesCount: 0 },
			],
			currentBalance: 10200,
			previousBalance: 10000,
		});

		expect(batch.ackBiggestWin).toBe(150);
	});

	test('counts mixed-outcome roll as a win when grossWinAmount > 0 even if netDelta < 0', () => {
		// A batch where all rolls are net-negative but contain a winning wager.
		// ackWins must be >= 1 so the API's determineBiggestWinCandidate accepts biggestWinCandidate.
		const batch = buildCrapsSyncBatch({
			pendingRollSyncs: [
				{ netDelta: -100, winsCount: 1, lossesCount: 1, pushesCount: 0, grossWinAmount: 100 },
			],
			currentBalance: 9900,
			previousBalance: 10000,
		});

		expect(batch.ackWins).toBe(1);
		expect(batch.ackLosses).toBe(0);
		expect(batch.ackBiggestWin).toBe(100);
	});

	test('counts zero-net resolved rolls as hands and push outcomes', () => {
		const batch = buildCrapsSyncBatch({
			pendingRollSyncs: [
				{ netDelta: 0, winsCount: 1, lossesCount: 1, pushesCount: 0 }, // Single roll with one win and one loss
				{ netDelta: 500, winsCount: 1, lossesCount: 0, pushesCount: 0 },
			],
			currentBalance: 10500,
			previousBalance: 10000,
		});

		expect(batch.ackHands).toBe(2);
		expect(batch.ackWins).toBe(1);
		expect(batch.ackLosses).toBe(0);
		expect(batch.ackStatsDelta).toBe(500);
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
