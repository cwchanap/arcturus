import { describe, expect, it } from 'bun:test';
import { RouletteGame } from './RouletteGame';
import { MIN_BET, MAX_BET_PER_POSITION, MAX_TOTAL_BET } from './constants';

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
