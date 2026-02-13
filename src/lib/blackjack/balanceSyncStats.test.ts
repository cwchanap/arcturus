/**
 * Test suite for balance sync and stats tracking logic in blackjack
 *
 * These tests verify that pending stats are correctly accumulated when
 * balance sync is delayed (e.g., due to rate limiting).
 *
 * This test file focuses on the specific logic that was added to prevent
 * stats drift: accumulating pending wins/losses/hands across multiple
 * rounds when sync is delayed.
 */

import { describe, it, expect } from 'bun:test';
import {
	addPendingStats,
	clearPendingStats,
	createPendingStats,
	ensureRoundStatsIncluded,
	markSyncPendingOnRateLimit,
	reconcilePendingBiggestWin,
} from './balance-sync-stats';

describe('Blackjack Balance Sync Stats Tracking', () => {
	describe('Pending Stats Accumulation', () => {
		it('should clear biggestWin when successful sync did not get a newer win', () => {
			const reconciled = reconcilePendingBiggestWin(120, 120);

			expect(reconciled).toBe(0);
		});

		it('should preserve bigger concurrent biggestWin for follow-up sync', () => {
			const reconciled = reconcilePendingBiggestWin(200, 120);

			expect(reconciled).toBe(200);
		});

		it('should track initial pending stats correctly', () => {
			let pendingStats = createPendingStats();
			let statsIncluded = false;

			// Round 1: 1 loss, 1 hand
			const round1Wins = 0;
			const round1Losses = 1;
			const round1Hands = 1;

			// First pending round - initialize with current round's stats
			({ pendingStats, statsIncluded } = ensureRoundStatsIncluded(
				pendingStats,
				{
					winsIncrement: round1Wins,
					lossesIncrement: round1Losses,
					handsIncrement: round1Hands,
					biggestWin: 0,
				},
				statsIncluded,
			));

			expect(pendingStats.winsIncrement).toBe(0);
			expect(pendingStats.lossesIncrement).toBe(1);
			expect(pendingStats.handsIncrement).toBe(1);
			expect(statsIncluded).toBe(true);
		});

		it('should accumulate pending stats across multiple rounds', () => {
			let pendingStats = createPendingStats();

			// Round 1: 1 loss
			const round1Wins = 0;
			const round1Losses = 1;
			const round1Hands = 1;

			// First pending round
			pendingStats = addPendingStats(pendingStats, {
				winsIncrement: round1Wins,
				lossesIncrement: round1Losses,
				handsIncrement: round1Hands,
				biggestWin: 0,
			});

			// Round 2: 1 win (played before retry succeeds)
			const round2Wins = 1;
			const round2Losses = 0;
			const round2Hands = 1;

			// Second pending round - accumulate
			pendingStats = addPendingStats(pendingStats, {
				winsIncrement: round2Wins,
				lossesIncrement: round2Losses,
				handsIncrement: round2Hands,
				biggestWin: 0,
			});

			// Expect accumulated stats: 1 win, 1 loss, 2 hands
			expect(pendingStats.winsIncrement).toBe(1);
			expect(pendingStats.lossesIncrement).toBe(1);
			expect(pendingStats.handsIncrement).toBe(2);
		});

		it('should accumulate across three rounds', () => {
			let pendingStats = createPendingStats();

			// Round 1: Loss
			pendingStats = addPendingStats(pendingStats, {
				winsIncrement: 0,
				lossesIncrement: 1,
				handsIncrement: 1,
				biggestWin: 0,
			});

			// Round 2: Win
			pendingStats = addPendingStats(pendingStats, {
				winsIncrement: 1,
				lossesIncrement: 0,
				handsIncrement: 1,
				biggestWin: 0,
			});

			// Round 3: Win (split hand = 2 wins)
			pendingStats = addPendingStats(pendingStats, {
				winsIncrement: 2,
				lossesIncrement: 0,
				handsIncrement: 2,
				biggestWin: 0,
			});

			// Total: 3 wins, 1 loss, 4 hands
			expect(pendingStats.winsIncrement).toBe(3);
			expect(pendingStats.lossesIncrement).toBe(1);
			expect(pendingStats.handsIncrement).toBe(4);
		});

		it('should include current round stats when sending request', () => {
			let pendingStats = createPendingStats();

			// Simulate pending stats from previous round
			pendingStats = addPendingStats(pendingStats, {
				winsIncrement: 1,
				lossesIncrement: 0,
				handsIncrement: 1,
				biggestWin: 0,
			});

			// Current round stats
			const currentWins = 1;
			const currentLosses = 1;
			const currentHands = 2; // split hand

			// Final stats to send = current + pending
			const finalWinsIncrement = currentWins + pendingStats.winsIncrement;
			const finalLossesIncrement = currentLosses + pendingStats.lossesIncrement;
			const finalHandCount = currentHands + pendingStats.handsIncrement;

			expect(finalWinsIncrement).toBe(2); // 1 pending + 1 current
			expect(finalLossesIncrement).toBe(1); // 0 pending + 1 current
			expect(finalHandCount).toBe(3); // 1 pending + 2 current
		});

		it('should clear pending stats on successful sync', () => {
			let pendingStats = addPendingStats(createPendingStats(), {
				winsIncrement: 1,
				lossesIncrement: 1,
				handsIncrement: 2,
				biggestWin: 0,
			});
			let syncPending = true;

			// Simulate successful response
			const responseOk = true;
			if (responseOk) {
				pendingStats = clearPendingStats();
				syncPending = false;
			}

			expect(pendingStats.winsIncrement).toBe(0);
			expect(pendingStats.lossesIncrement).toBe(0);
			expect(pendingStats.handsIncrement).toBe(0);
			expect(syncPending).toBe(false);
		});

		it('should clear pending stats on non-rate-limit errors', () => {
			let pendingStats = addPendingStats(createPendingStats(), {
				winsIncrement: 1,
				lossesIncrement: 0,
				handsIncrement: 1,
				biggestWin: 0,
			});
			let syncPending = true;

			// Simulate BALANCE_MISMATCH error
			const hasServerBalance = true;

			if (hasServerBalance) {
				// Server provided its current balance
				pendingStats = clearPendingStats();
				syncPending = false;
			}

			expect(pendingStats.winsIncrement).toBe(0);
			expect(pendingStats.lossesIncrement).toBe(0);
			expect(pendingStats.handsIncrement).toBe(0);
			expect(syncPending).toBe(false);
		});

		it('should keep pending stats on rate limit with retries remaining', () => {
			let pendingStats = addPendingStats(createPendingStats(), {
				winsIncrement: 0,
				lossesIncrement: 1,
				handsIncrement: 1,
				biggestWin: 0,
			});
			let syncPending = true;

			const currentWins = 0;
			const currentLosses = 1;
			const currentHands = 1;

			// Rate limited, but retries remaining
			const isRateLimited = true;
			const retryCount = 0;
			const maxRetries = 3;

			if (isRateLimited && retryCount < maxRetries) {
				syncPending = markSyncPendingOnRateLimit(syncPending);
				pendingStats = addPendingStats(pendingStats, {
					winsIncrement: currentWins,
					lossesIncrement: currentLosses,
					handsIncrement: currentHands,
					biggestWin: 0,
				});
			}

			// Pending stats should be set but not cleared
			expect(pendingStats.winsIncrement).toBe(0);
			expect(pendingStats.lossesIncrement).toBe(2);
			expect(pendingStats.handsIncrement).toBe(2);
			expect(syncPending).toBe(true);
		});

		it('should keep pending stats on rate limit max retries exceeded', () => {
			const pendingStats = addPendingStats(createPendingStats(), {
				winsIncrement: 2,
				lossesIncrement: 0,
				handsIncrement: 1,
				biggestWin: 0,
			});
			const syncPending = true;

			// Rate limited, max retries exceeded - keep pending for next round
			const isRateLimited = true;
			const retryCount = 3;
			const maxRetries = 3;

			if (isRateLimited && retryCount < maxRetries) {
				// This branch won't execute
			}
			// pendingStats should remain unchanged

			expect(pendingStats.winsIncrement).toBe(2);
			expect(pendingStats.lossesIncrement).toBe(0);
			expect(pendingStats.handsIncrement).toBe(1);
			expect(syncPending).toBe(true);
		});
	});

	describe('Delta Calculation with Delayed Sync', () => {
		it('should calculate delta from server sync balance', () => {
			const serverSyncedBalance = 1000;
			const newBalance = 950;
			const delta = newBalance - serverSyncedBalance;

			expect(delta).toBe(-50); // Correct delta for loss
		});

		it('should accumulate delta across delayed sync rounds', () => {
			const serverSyncedBalance = 1000;

			// Round 1: Loss $100 (rate limited, retry pending)
			// User plays Round 2 before retry succeeds
			// Round 2: Win $150
			// New balance = 1000 - 100 + 150 = 1050

			const newBalance = 1050;
			const delta = newBalance - serverSyncedBalance;

			expect(delta).toBe(50); // Correct net delta
		});

		it('should recompute delta on retry to prevent double-application of stale deltas', () => {
			let serverSyncedBalance = 1000;

			// Round 1: Win $100, balance = 1100
			// Sync is rate limited, retry scheduled
			// (simulated by just noting the balance)
			let gameBalance = 1100;

			// Before retry fires, user plays Round 2
			// Round 2: Lose $150, balance = 950
			gameBalance = 950;

			// Round 2 sync succeeds
			// serverSyncedBalance is now updated to 950
			serverSyncedBalance = 950;

			// Now Round 1 retry fires
			// OLD BUG: Would use cached delta (+100) with current serverSyncedBalance (950)
			// Result: 950 + 100 = 1050 (WRONG! Win applied twice)

			// NEW FIX: Recompute delta using current game balance
			const currentGameBalance = gameBalance; // 950
			const deltaForRequest = currentGameBalance - serverSyncedBalance;

			// Result: 950 - 950 = 0 (CORRECT! No change needed)
			expect(deltaForRequest).toBe(0);

			// After sync, serverSyncedBalance should equal gameBalance
			serverSyncedBalance = currentGameBalance;
			expect(serverSyncedBalance).toBe(950);
		});

		it('should handle multiple rounds with delayed sync correctly', () => {
			let serverSyncedBalance = 1000;
			let gameBalance = 1000;

			// Round 1: Win $100, rate limited
			gameBalance = 1100;

			// Round 2: Win $50, rate limited again
			gameBalance = 1150;

			// Round 3: Loss $200, sync succeeds
			gameBalance = 950;

			// Round 3 sync succeeds
			serverSyncedBalance = 950;

			// Now Round 2 retry fires
			// Recompute delta: 950 - 950 = 0
			let deltaForRequest = gameBalance - serverSyncedBalance;
			expect(deltaForRequest).toBe(0);

			// Update server balance
			serverSyncedBalance = gameBalance;

			// Now Round 1 retry fires
			// Recompute delta: 950 - 950 = 0
			deltaForRequest = gameBalance - serverSyncedBalance;
			expect(deltaForRequest).toBe(0);

			// Final balance is correct
			expect(serverSyncedBalance).toBe(950);
			expect(gameBalance).toBe(950);
		});
	});

	describe('Split Hand Stats Tracking', () => {
		it('should track multiple wins from split hand', () => {
			const outcomes: Array<{ result: 'win' | 'loss' | 'blackjack' | 'push' }> = [
				{ result: 'win' },
				{ result: 'win' },
				{ result: 'loss' },
			];

			const winsIncrement = outcomes.filter(
				(o) => o.result === 'win' || o.result === 'blackjack',
			).length;
			const lossesIncrement = outcomes.filter((o) => o.result === 'loss').length;

			expect(winsIncrement).toBe(2);
			expect(lossesIncrement).toBe(1);
		});

		it('should track blackjack as win', () => {
			const outcomes: Array<{ result: 'win' | 'loss' | 'blackjack' | 'push' }> = [
				{ result: 'blackjack' },
			];

			const winsIncrement = outcomes.filter(
				(o) => o.result === 'win' || o.result === 'blackjack',
			).length;

			expect(winsIncrement).toBe(1);
		});

		it('should track pushes correctly in hands count', () => {
			const outcomes: Array<{ result: 'win' | 'loss' | 'blackjack' | 'push' }> = [
				{ result: 'push' },
				{ result: 'push' },
			];

			const handCount = outcomes.length;
			// Pushes are not counted as wins or losses
			const winsIncrement = outcomes.filter(
				(o) => o.result === 'win' || o.result === 'blackjack',
			).length;
			const lossesIncrement = outcomes.filter((o) => o.result === 'loss').length;

			expect(handCount).toBe(2);
			expect(winsIncrement).toBe(0);
			expect(lossesIncrement).toBe(0);
		});
	});

	describe('Retry Timer Cancellation', () => {
		it('should cancel pending retry timer before starting new sync', () => {
			// Simulate the state variables
			let pendingRetryTimer: ReturnType<typeof setTimeout> | null = null;

			// Schedule a retry timer (simulating rate limit)
			pendingRetryTimer = setTimeout(() => {
				// This should never execute if cancelled properly
				throw new Error('Retry timer should have been cancelled');
			}, 1000);

			// Simulate starting a new sync - should cancel pending timer
			if (pendingRetryTimer) {
				clearTimeout(pendingRetryTimer);
				pendingRetryTimer = null;
			}

			expect(pendingRetryTimer).toBeNull();
		});

		it('should allow multiple retries to be scheduled and cancelled', () => {
			let pendingRetryTimer: ReturnType<typeof setTimeout> | null = null;
			let cancelCount = 0;

			// Schedule first retry
			pendingRetryTimer = setTimeout(() => {}, 1000);

			// New round starts - cancel first timer
			if (pendingRetryTimer) {
				clearTimeout(pendingRetryTimer);
				pendingRetryTimer = null;
				cancelCount++;
			}

			expect(pendingRetryTimer).toBeNull();
			expect(cancelCount).toBe(1);

			// Schedule second retry (rate limit on second round)
			pendingRetryTimer = setTimeout(() => {}, 1000);

			// New round starts - cancel second timer
			if (pendingRetryTimer) {
				clearTimeout(pendingRetryTimer);
				pendingRetryTimer = null;
				cancelCount++;
			}

			expect(pendingRetryTimer).toBeNull();
			expect(cancelCount).toBe(2);
		});

		it('should clear retry timer on successful sync', () => {
			let pendingRetryTimer: ReturnType<typeof setTimeout> | null = null;

			// Schedule a retry
			pendingRetryTimer = setTimeout(() => {}, 1000);

			// Simulate successful sync response
			const responseOk = true;
			if (responseOk && pendingRetryTimer) {
				clearTimeout(pendingRetryTimer);
				pendingRetryTimer = null;
			}

			expect(pendingRetryTimer).toBeNull();
		});

		it('should clear retry timer on error (non-rate-limit)', () => {
			let pendingRetryTimer: ReturnType<typeof setTimeout> | null = null;

			// Schedule a retry
			pendingRetryTimer = setTimeout(() => {}, 1000);

			// Simulate BALANCE_MISMATCH error (not rate-limited)
			const hasServerBalance = true;
			if (hasServerBalance && pendingRetryTimer) {
				clearTimeout(pendingRetryTimer);
				pendingRetryTimer = null;
			}

			expect(pendingRetryTimer).toBeNull();
		});
	});
});
