import { describe, expect, it } from 'bun:test';
import { RouletteGame } from './RouletteGame';
import { MIN_BET, MAX_BET_PER_POSITION, MAX_BETS, MAX_TOTAL_BET } from './constants';
import type { SpinResult } from './types';

describe('RouletteGame — betting', () => {
	function newGame(balance = 1000) {
		return new RouletteGame({ initialBalance: balance });
	}

	describe('canPlaceBet', () => {
		it('rejects amount below MIN_BET', () => {
			const game = newGame();
			expect(game.canPlaceBet('straight', 0, 5).ok).toBe(false);
		});

		it('rejects negative amount', () => {
			const game = newGame();
			expect(game.canPlaceBet('red', -5).ok).toBe(false);
		});

		it('rejects amount above balance', () => {
			const game = newGame(100);
			expect(game.canPlaceBet('red', 101).ok).toBe(false);
		});

		it('accepts amount equal to balance', () => {
			const game = newGame(100);
			expect(game.canPlaceBet('red', 100).ok).toBe(true);
		});

		it('rejects when cumulative position total exceeds MAX_BET_PER_POSITION', () => {
			const game = newGame(10000);
			game.placeBet('straight', MAX_BET_PER_POSITION, 17);
			expect(game.canPlaceBet('straight', 1, 17).ok).toBe(false);
		});

		it('rejects when total bets exceed MAX_TOTAL_BET', () => {
			const game = newGame(100000);
			for (let i = 0; i < 10; i++) {
				game.placeBet('straight', 500, i + 1);
			}
			expect(game.canPlaceBet('straight', 1, 20).ok).toBe(false);
		});

		it('rejects new position when active bet count reaches MAX_BETS', () => {
			const game = newGame(100000);
			// Pre-populate MAX_BETS distinct positions via restoreState,
			// since the client merges same-position bets (max 49 distinct
			// positions exist, less than MAX_BETS=64).
			const bets = Array.from({ length: MAX_BETS }, (_, i) => ({
				id: `pre-bet-${i}`,
				type: 'straight' as const,
				amount: 1,
				target: i % 37,
			}));
			game.restoreState({
				phase: 'betting',
				activeBets: bets,
				chipBalance: 100000 - MAX_BETS,
				selectedChipAmount: 1,
				lastSpin: null,
				roundHistory: [],
			});
			// Same position — should still be allowed (merge, not new entry)
			expect(game.canPlaceBet('straight', 1, 0).ok).toBe(true);
			// New position — should be rejected
			const result = game.canPlaceBet('red', 1);
			expect(result.ok).toBe(false);
			expect(result.error).toContain('Max');
		});
	});

	describe('placeBet', () => {
		it('creates a bet with a valid id', () => {
			const game = newGame();
			const result = game.placeBet('red', 50);
			expect(result.success).toBe(true);
			expect(result.bet).toBeDefined();
			expect(result.bet!.id).toBeTruthy();
			expect(result.bet!.type).toBe('red');
			expect(result.bet!.amount).toBe(50);
		});

		it('deducts the amount from chipBalance', () => {
			const game = newGame(1000);
			game.placeBet('red', 50);
			expect(game.getBalance()).toBe(950);
		});

		it('accumulates amount when placing on same position', () => {
			const game = newGame(1000);
			game.placeBet('straight', 25, 17);
			game.placeBet('straight', 25, 17);
			expect(game.getBalance()).toBe(950);
			const state = game.getState();
			expect(state.activeBets).toHaveLength(1);
			expect(state.activeBets[0].amount).toBe(50);
		});

		it('creates separate bets for different positions', () => {
			const game = newGame(1000);
			game.placeBet('straight', 25, 17);
			game.placeBet('straight', 25, 18);
			expect(game.getBalance()).toBe(950);
			expect(game.getState().activeBets).toHaveLength(2);
		});

		it('returns error on invalid bet', () => {
			const game = newGame(10);
			const result = game.placeBet('red', 500);
			expect(result.success).toBe(false);
			expect(result.error).toBeTruthy();
		});
	});

	describe('removeBet', () => {
		it('removes the bet and refunds the amount', () => {
			const game = newGame(1000);
			const result = game.placeBet('red', 50);
			const betId = result.bet!.id;
			game.removeBet(betId);
			expect(game.getBalance()).toBe(1000);
			expect(game.getState().activeBets).toHaveLength(0);
		});

		it('returns error for non-existent bet', () => {
			const game = newGame();
			const result = game.removeBet('nonexistent');
			expect(result.success).toBe(false);
		});

		it('rejects removal during spinning phase', () => {
			const game = newGame(1000);
			const result = game.placeBet('red', 50);
			const betId = result.bet!.id;
			game.beginSpin();
			const balanceBefore = game.getBalance();
			const removeResult = game.removeBet(betId);
			expect(removeResult.success).toBe(false);
			expect(game.getBalance()).toBe(balanceBefore);
			expect(game.getState().activeBets).toHaveLength(1);
		});
	});

	describe('clearBets', () => {
		it('removes all bets and refunds total', () => {
			const game = newGame(1000);
			game.placeBet('red', 50);
			game.placeBet('straight', 25, 17);
			game.placeBet('dozen', 100, 0);
			game.clearBets();
			expect(game.getBalance()).toBe(1000);
			expect(game.getState().activeBets).toHaveLength(0);
		});

		it('does nothing outside the betting phase', () => {
			const game = newGame(1000);
			game.placeBet('red', 50);
			game.beginSpin();
			const balanceBefore = game.getBalance();
			const betsBefore = game.getState().activeBets.length;
			game.clearBets();
			expect(game.getBalance()).toBe(balanceBefore);
			expect(game.getState().activeBets).toHaveLength(betsBefore);
		});
	});

	describe('balance invariant', () => {
		it('balance never goes negative from multiple bets', () => {
			const game = newGame(100);
			game.placeBet('red', 40);
			expect(game.getBalance()).toBe(60);
			game.placeBet('black', 40);
			expect(game.getBalance()).toBe(20);
			const result = game.placeBet('odd', 50);
			expect(result.success).toBe(false);
			expect(game.getBalance()).toBe(20);
		});
	});
});

describe('RouletteGame — spin & settle (guest mode)', () => {
	function newGame(balance = 1000) {
		return new RouletteGame({ initialBalance: balance });
	}

	describe('spin (guest mode — local settlement)', () => {
		it('rejects spin with no bets', () => {
			const game = newGame();
			expect(() => game.spinGuest(17)).toThrow();
		});

		it('rejects spin during spinning phase', () => {
			const game = newGame();
			game.placeBet('red', 50);
			game.spinGuest(17);
			expect(() => game.spinGuest(17)).toThrow();
		});

		it('deducts total bet and credits payout on settle', () => {
			const game = newGame(1000);
			game.placeBet('straight', 10, 17);
			const result = game.spinGuest(17);
			expect(result.winningNumber).toBe(17);
			expect(result.totalBet).toBe(10);
			expect(result.totalPayout).toBe(360);
			expect(result.netDelta).toBe(350);
			expect(game.getBalance()).toBe(1350); // 1000 - 10 (placeBet) + 360 (settle)
		});

		it('sets phase to settled after spin', () => {
			const game = newGame();
			game.placeBet('red', 10);
			game.spinGuest(1);
			expect(game.getState().phase).toBe('settled');
		});

		it('clears active bets after spin', () => {
			const game = newGame();
			game.placeBet('red', 10);
			game.placeBet('straight', 5, 17);
			game.spinGuest(1);
			expect(game.getState().activeBets).toHaveLength(0);
		});

		it('records spin in roundHistory', () => {
			const game = newGame();
			game.placeBet('red', 10);
			game.spinGuest(1);
			expect(game.getState().roundHistory).toHaveLength(1);
			expect(game.getState().lastSpin).toBeTruthy();
		});

		it('caps roundHistory at MAX_ROUND_HISTORY', () => {
			const game = newGame(100000);
			for (let i = 0; i < 25; i++) {
				game.placeBet('red', 10);
				game.spinGuest(1);
				game.newRound();
			}
			expect(game.getState().roundHistory.length).toBeLessThanOrEqual(20);
		});
	});

	describe('newRound', () => {
		it('resets phase to betting', () => {
			const game = newGame();
			game.placeBet('red', 10);
			game.spinGuest(1);
			game.newRound();
			expect(game.getState().phase).toBe('betting');
		});

		it('refunds active bets into chipBalance before clearing', () => {
			const game = newGame(1000);
			game.placeBet('red', 50);
			game.placeBet('straight', 25, 17);
			expect(game.getBalance()).toBe(925);
			game.newRound();
			expect(game.getBalance()).toBe(1000);
			expect(game.getState().activeBets).toHaveLength(0);
			expect(game.getState().phase).toBe('betting');
		});
	});

	describe('discardActiveBets', () => {
		it('clears active bets and resets phase WITHOUT refunding', () => {
			const game = newGame(1000);
			game.placeBet('red', 500);
			expect(game.getBalance()).toBe(500);
			game.beginSpin();
			expect(game.getState().phase).toBe('spinning');
			game.discardActiveBets();
			expect(game.getState().activeBets).toHaveLength(0);
			expect(game.getState().phase).toBe('betting');
			// Balance must NOT include the refunded 500 — the caller is
			// expected to have set an authoritative balance already.
			expect(game.getBalance()).toBe(500);
		});

		it('does not inflate balance when caller adopts server balance first (C1 regression)', () => {
			// Repro: balance 1000 -> bet 500 -> spin fails with uncertain
			// outcome -> server balance re-fetched as 999 -> must NOT
			// refund the 500 on top of the adopted 999.
			const game = newGame(1000);
			game.placeBet('red', 500);
			expect(game.getBalance()).toBe(500);
			game.beginSpin();
			// Caller adopts authoritative server balance.
			game.setBalance(999);
			// Caller discards (not refunds) the bets.
			game.discardActiveBets();
			expect(game.getBalance()).toBe(999);
			expect(game.getState().activeBets).toHaveLength(0);
			expect(game.getState().phase).toBe('betting');
		});
	});

	describe('abortSpin', () => {
		it('returns to betting with bets preserved for re-spin (429 / escrow path)', () => {
			const game = newGame(1000);
			game.placeBet('red', 500);
			expect(game.getBalance()).toBe(500);
			game.beginSpin();
			game.setPendingSyncId('rate-limited-sync');
			expect(game.getState().phase).toBe('spinning');
			expect(game.getPendingSyncId()).toBe('rate-limited-sync');

			game.abortSpin();

			expect(game.getState().phase).toBe('betting');
			expect(game.getState().activeBets).toHaveLength(1);
			expect(game.getState().activeBets[0].amount).toBe(500);
			expect(game.getBalance()).toBe(500);
			expect(game.getPendingSyncId()).toBeUndefined();
		});

		it('is a no-op outside spinning phase', () => {
			const game = newGame(1000);
			game.placeBet('red', 100);
			game.abortSpin();
			expect(game.getState().phase).toBe('betting');
			expect(game.getState().activeBets).toHaveLength(1);
		});
	});

	describe('applySettlement', () => {
		it('sets chipBalance to server-provided newBalance', () => {
			const game = newGame(1000);
			game.placeBet('red', 50);
			game.beginSpin();
			const spinResult: SpinResult = {
				winningNumber: 1,
				bets: [],
				totalBet: 50,
				totalPayout: 100,
				netDelta: 50,
				results: [],
				timestamp: Date.now(),
				syncId: 'test-sync',
				newBalance: 1050,
			};
			game.applySettlement(spinResult);
			expect(game.getBalance()).toBe(1050);
			expect(game.getState().phase).toBe('settled');
			expect(game.getState().activeBets).toHaveLength(0);
		});

		it('throws when newBalance is undefined', () => {
			const game = newGame(1000);
			game.placeBet('red', 50);
			game.beginSpin();
			const spinResult: SpinResult = {
				winningNumber: 1,
				bets: [],
				totalBet: 50,
				totalPayout: 100,
				netDelta: 50,
				results: [],
				timestamp: Date.now(),
				syncId: 'test-sync',
			};
			expect(() => game.applySettlement(spinResult)).toThrow(
				'applySettlement requires server-provided newBalance',
			);
		});

		it('records spin in roundHistory and lastSpin', () => {
			const game = newGame(1000);
			game.placeBet('red', 50);
			game.beginSpin();
			const spinResult: SpinResult = {
				winningNumber: 1,
				bets: [],
				totalBet: 50,
				totalPayout: 100,
				netDelta: 50,
				results: [],
				timestamp: Date.now(),
				syncId: 'test-sync',
				newBalance: 1050,
			};
			game.applySettlement(spinResult);
			expect(game.getState().lastSpin).toBe(spinResult);
			expect(game.getState().roundHistory).toHaveLength(1);
		});
	});

	describe('restoreState', () => {
		it('round-trips state through serialization', () => {
			const game = newGame(1000);
			game.placeBet('red', 50);
			game.placeBet('straight', 25, 17);
			const snapshot = game.getState();
			const json = JSON.parse(JSON.stringify(snapshot));

			const game2 = newGame(0);
			expect(game2.restoreState(json)).toBe(true);
			expect(game2.getBalance()).toBe(925);
			expect(game2.getState().activeBets).toHaveLength(2);
			expect(game2.getState().phase).toBe('betting');
		});

		it('rejects corrupted data', () => {
			const game = newGame();
			expect(game.restoreState(null)).toBe(false);
			expect(game.restoreState({})).toBe(false);
			expect(game.restoreState({ phase: 'invalid' })).toBe(false);
		});

		it('discards corrupt lastSpin instead of replaying it', () => {
			const game = newGame(1000);
			// A syntactically valid but empty lastSpin object must not
			// reach showResult — it would pass undefined to renderBetResults.
			expect(
				game.restoreState({
					phase: 'settled',
					chipBalance: 1000,
					activeBets: [],
					lastSpin: {},
				}),
			).toBe(true);
			expect(game.getState().lastSpin).toBeNull();
		});

		it('discards lastSpin with invalid winningNumber', () => {
			const game = newGame(1000);
			expect(
				game.restoreState({
					phase: 'settled',
					chipBalance: 1000,
					activeBets: [],
					lastSpin: {
						winningNumber: 99,
						bets: [],
						totalBet: 0,
						totalPayout: 0,
						netDelta: 0,
						results: [],
						timestamp: Date.now(),
						syncId: 's1',
					},
				}),
			).toBe(true);
			expect(game.getState().lastSpin).toBeNull();
		});

		it('preserves valid lastSpin through restoreState', () => {
			const game = newGame(1000);
			const validSpin: SpinResult = {
				winningNumber: 17,
				bets: [{ id: 'b1', type: 'straight', amount: 50, target: 17 }],
				totalBet: 50,
				totalPayout: 1750,
				netDelta: 1700,
				results: [
					{ bet: { id: 'b1', type: 'straight', amount: 50, target: 17 }, won: true, payout: 1750 },
				],
				timestamp: Date.now(),
				syncId: 'sync-1',
			};
			expect(
				game.restoreState({
					phase: 'settled',
					chipBalance: 2700,
					activeBets: [],
					lastSpin: validSpin,
				}),
			).toBe(true);
			expect(game.getState().lastSpin).not.toBeNull();
			expect(game.getState().lastSpin?.winningNumber).toBe(17);
		});

		it('preserves pendingSyncId when restoring spinning phase', () => {
			const game = newGame(1000);
			const bets = [
				{ id: 'b1', type: 'red' as const, amount: 50 },
				{ id: 'b2', type: 'straight' as const, amount: 25, target: 17 },
			];
			expect(
				game.restoreState({
					phase: 'spinning',
					chipBalance: 925,
					activeBets: bets,
					selectedChipAmount: 25,
					lastSpin: null,
					roundHistory: [],
					pendingSyncId: 'abc-123-def',
				}),
			).toBe(true);
			expect(game.getState().phase).toBe('spinning');
			expect(game.getPendingSyncId()).toBe('abc-123-def');
			expect(game.getState().activeBets).toHaveLength(2);
		});

		it('drops pendingSyncId when restoring non-spinning phase', () => {
			const game = newGame(1000);
			// A settled snapshot with a stale pendingSyncId (e.g. from an
			// older buggy persistence) must not carry it into the restored
			// state — applySettlement/newRound already clear it.
			expect(
				game.restoreState({
					phase: 'settled',
					chipBalance: 1000,
					activeBets: [],
					pendingSyncId: 'stale-id',
				}),
			).toBe(true);
			expect(game.getPendingSyncId()).toBeUndefined();
		});

		it('drops invalid pendingSyncId when restoring spinning phase', () => {
			const game = newGame(1000);
			expect(
				game.restoreState({
					phase: 'spinning',
					chipBalance: 950,
					activeBets: [{ id: 'b1', type: 'red' as const, amount: 50 }],
					pendingSyncId: '',
				}),
			).toBe(true);
			expect(game.getPendingSyncId()).toBeUndefined();
		});

		it('round-trips pendingSyncId through JSON serialization', () => {
			const game = newGame(1000);
			game.placeBet('red', 50);
			game.beginSpin();
			game.setPendingSyncId('roundtrip-sync-id');
			const snapshot = JSON.parse(JSON.stringify(game.getState()));

			const game2 = newGame(0);
			expect(game2.restoreState(snapshot)).toBe(true);
			expect(game2.getState().phase).toBe('spinning');
			expect(game2.getPendingSyncId()).toBe('roundtrip-sync-id');
		});

		it('setPendingSyncId records pendingSyncCreatedAt', () => {
			const game = newGame(1000);
			game.placeBet('red', 50);
			game.beginSpin();
			const before = Date.now();
			game.setPendingSyncId('sync-with-timestamp');
			const after = Date.now();
			expect(game.getState().pendingSyncCreatedAt).toBeGreaterThanOrEqual(before);
			expect(game.getState().pendingSyncCreatedAt).toBeLessThanOrEqual(after);
		});

		it('preserves pendingSyncCreatedAt when restoring spinning phase', () => {
			const game = newGame(1000);
			const createdAt = Date.now() - 1000;
			expect(
				game.restoreState({
					phase: 'spinning',
					chipBalance: 925,
					activeBets: [{ id: 'b1', type: 'red' as const, amount: 50 }],
					pendingSyncId: 'abc-123-def',
					pendingSyncCreatedAt: createdAt,
				}),
			).toBe(true);
			expect(game.getState().pendingSyncCreatedAt).toBe(createdAt);
		});

		it('drops pendingSyncCreatedAt when restoring non-spinning phase', () => {
			const game = newGame(1000);
			expect(
				game.restoreState({
					phase: 'settled',
					chipBalance: 1000,
					activeBets: [],
					pendingSyncId: 'stale-id',
					pendingSyncCreatedAt: Date.now(),
				}),
			).toBe(true);
			expect(game.getState().pendingSyncCreatedAt).toBeUndefined();
		});

		it('drops invalid pendingSyncCreatedAt when restoring spinning phase', () => {
			const game = newGame(1000);
			expect(
				game.restoreState({
					phase: 'spinning',
					chipBalance: 950,
					activeBets: [{ id: 'b1', type: 'red' as const, amount: 50 }],
					pendingSyncId: 'valid-id',
					pendingSyncCreatedAt: 'not-a-number',
				}),
			).toBe(true);
			expect(game.getState().pendingSyncCreatedAt).toBeUndefined();
		});

		it('round-trips pendingSyncCreatedAt through JSON serialization', () => {
			const game = newGame(1000);
			game.placeBet('red', 50);
			game.beginSpin();
			game.setPendingSyncId('roundtrip-ts-id');
			const createdAt = game.getState().pendingSyncCreatedAt;
			const snapshot = JSON.parse(JSON.stringify(game.getState()));

			const game2 = newGame(0);
			expect(game2.restoreState(snapshot)).toBe(true);
			expect(game2.getState().phase).toBe('spinning');
			expect(game2.getState().pendingSyncCreatedAt).toBe(createdAt);
		});
	});
});
