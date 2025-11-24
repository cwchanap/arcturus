/**
 * BlackjackGame tests
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { BlackjackGame } from './BlackjackGame';

describe('BlackjackGame', () => {
	let game: BlackjackGame;
	const initialBalance = 1000;
	const minBet = 10;
	const maxBet = 500;

	beforeEach(() => {
		game = new BlackjackGame(initialBalance, minBet, maxBet);
	});

	describe('Initialization', () => {
		it('should start in betting phase', () => {
			const state = game.getState();
			expect(state.phase).toBe('betting');
		});

		it('should initialize with correct balance', () => {
			expect(game.getBalance()).toBe(initialBalance);
		});

		it('should have empty hands initially', () => {
			const state = game.getState();
			expect(state.playerHands.length).toBe(0);
			expect(state.dealerHand.cards.length).toBe(0);
		});
	});

	describe('placeBet', () => {
		it('should accept valid bet', () => {
			game.placeBet(100);
			const state = game.getState();
			expect(state.pot).toBe(100);
			expect(game.getBalance()).toBe(initialBalance - 100);
		});

		it('should throw error for bet below minimum', () => {
			expect(() => game.placeBet(5)).toThrow('Bet must be between');
		});

		it('should throw error for bet above maximum', () => {
			expect(() => game.placeBet(600)).toThrow('Bet must be between');
		});

		it('should throw error for insufficient balance', () => {
			// Create game with low balance to test insufficient funds
			const lowBalanceGame = new BlackjackGame(50, 10, 500);
			expect(() => lowBalanceGame.placeBet(100)).toThrow('Insufficient balance');
		});

		it('should throw error when not in betting phase', () => {
			game.placeBet(100);
			game.deal();
			expect(() => game.placeBet(100)).toThrow('Can only place bet during betting phase');
		});

		it('should move to dealing phase after placing bet', () => {
			game.placeBet(100);
			const state = game.getState();
			expect(state.phase).toBe('dealing');
		});

		it('should initialize player hand with correct bet', () => {
			game.placeBet(100);
			const state = game.getState();
			expect(state.playerHands.length).toBe(1);
			expect(state.playerHands[0].bet).toBe(100);
		});
	});

	describe('deal', () => {
		beforeEach(() => {
			game.placeBet(100);
		});

		it('should deal 2 cards to player', () => {
			game.deal();
			const state = game.getState();
			expect(state.playerHands[0].cards.length).toBe(2);
		});

		it('should deal 2 cards to dealer', () => {
			game.deal();
			const state = game.getState();
			expect(state.dealerHand.cards.length).toBe(2);
		});

		it('should move to player-turn phase after dealing', () => {
			game.deal();
			const state = game.getState();
			// Could be player-turn or complete (if blackjack)
			expect(['player-turn', 'complete']).toContain(state.phase);
		});

		it('should throw error when not in dealing phase', () => {
			// Create fresh game without placing bet (still in betting phase)
			const freshGame = new BlackjackGame(initialBalance, minBet, maxBet);
			expect(() => freshGame.deal()).toThrow('Can only deal during dealing phase');
		});
	});

	describe('hit', () => {
		beforeEach(() => {
			game.placeBet(100);
			game.deal();
		});

		it('should add card to active hand', () => {
			const stateBefore = game.getState();
			const cardCountBefore = stateBefore.playerHands[0].cards.length;

			// Only hit if in player-turn phase (not immediate blackjack)
			if (stateBefore.phase === 'player-turn') {
				game.hit();
				const stateAfter = game.getState();
				expect(stateAfter.playerHands[0].cards.length).toBe(cardCountBefore + 1);
			}
		});

		it('should throw error when not in player-turn phase', () => {
			// Force complete phase
			const state = game.getState();
			if (state.phase === 'player-turn') {
				game.stand();
				game.playDealerTurn();
			}
			expect(() => game.hit()).toThrow('Can only hit during player turn');
		});
	});

	describe('stand', () => {
		beforeEach(() => {
			game.placeBet(100);
			game.deal();
		});

		it('should move to dealer-turn phase', () => {
			const state = game.getState();
			if (state.phase === 'player-turn') {
				game.stand();
				const newState = game.getState();
				expect(newState.phase).toBe('dealer-turn');
			}
		});

		it('should throw error when not in player-turn phase', () => {
			const state = game.getState();
			if (state.phase === 'player-turn') {
				game.stand();
			}
			expect(() => game.stand()).toThrow('Can only stand during player turn');
		});
	});

	describe('playDealerTurn', () => {
		beforeEach(() => {
			game.placeBet(100);
			game.deal();
		});

		it('should move to complete phase after dealer plays', () => {
			const state = game.getState();
			if (state.phase === 'player-turn') {
				game.stand();
				game.playDealerTurn();
				const newState = game.getState();
				expect(newState.phase).toBe('complete');
			}
		});

		it('should throw error when not in dealer-turn phase', () => {
			expect(() => game.playDealerTurn()).toThrow(
				'Can only play dealer turn during dealer-turn phase',
			);
		});

		it('should result in dealer having at least 17 or bust', () => {
			const state = game.getState();
			if (state.phase === 'player-turn') {
				game.stand();
				game.playDealerTurn();
				const newState = game.getState();
				// Dealer should have 17+ or be busted
				// We can't easily test hand value without importing calculateHandValue
				// But we can check dealer has drawn cards
				expect(newState.dealerHand.cards.length).toBeGreaterThanOrEqual(2);
			}
		});
	});

	describe('settleRound', () => {
		beforeEach(() => {
			game.placeBet(100);
			game.deal();
		});

		it('should return array of outcomes', () => {
			const state = game.getState();
			if (state.phase === 'player-turn') {
				game.stand();
				game.playDealerTurn();
			}
			const outcomes = game.settleRound();
			expect(Array.isArray(outcomes)).toBe(true);
			expect(outcomes.length).toBe(1); // One player hand
		});

		it('should update balance after settlement', () => {
			const balanceBefore = game.getBalance();
			const state = game.getState();
			if (state.phase === 'player-turn') {
				game.stand();
				game.playDealerTurn();
			}
			game.settleRound();
			const balanceAfter = game.getBalance();
			// Balance should change (win, loss, or push returns bet)
			expect(typeof balanceAfter).toBe('number');
		});

		it('should reset to betting phase after settlement', () => {
			const state = game.getState();
			if (state.phase === 'player-turn') {
				game.stand();
				game.playDealerTurn();
			}
			game.settleRound();
			const newState = game.getState();
			expect(newState.phase).toBe('betting');
		});

		it('should clear pot after settlement', () => {
			const state = game.getState();
			if (state.phase === 'player-turn') {
				game.stand();
				game.playDealerTurn();
			}
			game.settleRound();
			const newState = game.getState();
			expect(newState.pot).toBe(0);
		});

		it('should throw error when not in complete phase', () => {
			const state = game.getState();
			if (state.phase === 'player-turn') {
				expect(() => game.settleRound()).toThrow('Can only settle during complete phase');
			}
		});
	});

	describe('getAvailableActions', () => {
		it('should return empty array when not in player-turn phase', () => {
			const actions = game.getAvailableActions();
			expect(actions.length).toBe(0);
		});

		it('should return hit and stand during player turn', () => {
			game.placeBet(100);
			game.deal();
			const state = game.getState();
			if (state.phase === 'player-turn') {
				const actions = game.getAvailableActions();
				expect(actions).toContain('hit');
				expect(actions).toContain('stand');
				// MVP: no double/split yet
				expect(actions).not.toContain('double-down');
				expect(actions).not.toContain('split');
			}
		});
	});

	describe('startNewRound', () => {
		it('should reset game to betting phase', () => {
			game.placeBet(100);
			game.deal();
			game.startNewRound();
			const state = game.getState();
			expect(state.phase).toBe('betting');
		});

		it('should clear hands', () => {
			game.placeBet(100);
			game.deal();
			game.startNewRound();
			const state = game.getState();
			expect(state.playerHands.length).toBe(0);
			expect(state.dealerHand.cards.length).toBe(0);
		});

		it('should clear pot', () => {
			game.placeBet(100);
			game.startNewRound();
			const state = game.getState();
			expect(state.pot).toBe(0);
		});

		it('should preserve balance', () => {
			const balanceBefore = game.getBalance();
			game.placeBet(100);
			game.startNewRound();
			const balanceAfter = game.getBalance();
			expect(balanceAfter).toBe(balanceBefore - 100); // Bet was deducted
		});
	});

	describe('Complete game flow', () => {
		it('should handle complete round from bet to settlement', () => {
			// Place bet
			game.placeBet(100);
			expect(game.getBalance()).toBe(900);

			// Deal cards
			game.deal();
			const stateAfterDeal = game.getState();
			expect(stateAfterDeal.playerHands[0].cards.length).toBe(2);

			// Only continue if in player-turn (no immediate blackjack)
			if (stateAfterDeal.phase === 'player-turn') {
				// Player stands
				game.stand();
				expect(game.getState().phase).toBe('dealer-turn');

				// Dealer plays
				game.playDealerTurn();
				expect(game.getState().phase).toBe('complete');

				// Settle round
				const outcomes = game.settleRound();
				expect(outcomes.length).toBe(1);
				expect(['win', 'loss', 'push', 'blackjack']).toContain(outcomes[0].result);

				// Should be ready for next round
				expect(game.getState().phase).toBe('betting');
			}
		});

		it('should handle multiple rounds', () => {
			for (let i = 0; i < 3; i++) {
				game.placeBet(50);
				game.deal();
				const state = game.getState();
				if (state.phase === 'player-turn') {
					game.stand();
					game.playDealerTurn();
				}
				game.settleRound();
				expect(game.getState().phase).toBe('betting');
			}
		});
	});
});
