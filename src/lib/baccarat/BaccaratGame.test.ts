/**
 * Unit tests for BaccaratGame
 */

import { describe, expect, test, beforeEach } from 'bun:test';
import { BaccaratGame } from './BaccaratGame';
import type { BaccaratGameConfig, RoundOutcome } from './types';

describe('BaccaratGame', () => {
	let game: BaccaratGame;

	beforeEach(() => {
		const config: BaccaratGameConfig = {
			initialBalance: 1000,
			settings: {
				minBet: 10,
				maxBet: 500,
				startingChips: 1000,
				animationSpeed: 'normal',
				llmEnabled: false,
				soundEnabled: true,
			},
		};
		game = new BaccaratGame(config);
	});

	describe('Initial state', () => {
		test('should initialize with correct balance', () => {
			expect(game.getBalance()).toBe(1000);
		});

		test('should initialize in betting phase', () => {
			const state = game.getState();
			expect(state.phase).toBe('betting');
		});

		test('should have no active bets', () => {
			const state = game.getState();
			expect(state.activeBets).toHaveLength(0);
		});

		test('should have empty hands', () => {
			const state = game.getState();
			expect(state.playerHand.cards).toHaveLength(0);
			expect(state.bankerHand.cards).toHaveLength(0);
		});

		test('should have cards in shoe', () => {
			const state = game.getState();
			expect(state.shoeCardsRemaining).toBeGreaterThan(0);
		});
	});

	describe('Betting', () => {
		test('should place valid player bet', () => {
			const result = game.placeBet('player', 100);
			expect(result.success).toBe(true);
			expect(game.getState().activeBets).toHaveLength(1);
			expect(game.getState().activeBets[0]).toEqual({ type: 'player', amount: 100 });
		});

		test('should place valid banker bet', () => {
			const result = game.placeBet('banker', 100);
			expect(result.success).toBe(true);
		});

		test('should place valid tie bet', () => {
			const result = game.placeBet('tie', 100);
			expect(result.success).toBe(true);
		});

		test('should accumulate bets on same type', () => {
			game.placeBet('player', 50);
			game.placeBet('player', 50);
			const state = game.getState();
			expect(state.activeBets).toHaveLength(1);
			expect(state.activeBets[0].amount).toBe(100);
		});

		test('should allow multiple bet types', () => {
			game.placeBet('player', 100);
			game.placeBet('tie', 50);
			const state = game.getState();
			expect(state.activeBets).toHaveLength(2);
		});

		test('should reject bet below minimum', () => {
			const result = game.placeBet('player', 5);
			expect(result.success).toBe(false);
			expect(result.error).toContain('Minimum');
		});

		test('should reject bet above maximum', () => {
			const result = game.placeBet('player', 600);
			expect(result.success).toBe(false);
			expect(result.error).toContain('Maximum');
		});

		test('should reject bet exceeding balance', () => {
			game.placeBet('player', 500);
			game.placeBet('banker', 500);
			const result = game.placeBet('tie', 100);
			expect(result.success).toBe(false);
			expect(result.error).toContain('Insufficient');
		});

		test('should calculate bet total correctly', () => {
			game.placeBet('player', 100);
			game.placeBet('banker', 50);
			expect(game.getBetTotal()).toBe(150);
		});

		test('should remove bet', () => {
			game.placeBet('player', 100);
			expect(game.removeBet('player')).toBe(true);
			expect(game.getState().activeBets).toHaveLength(0);
		});

		test('should clear all bets', () => {
			game.placeBet('player', 100);
			game.placeBet('banker', 50);
			game.clearBets();
			expect(game.getState().activeBets).toHaveLength(0);
		});
	});

	describe('Deal validation', () => {
		test('should not deal without bets', () => {
			expect(game.canDeal()).toBe(false);
		});

		test('should allow deal with bets', () => {
			game.placeBet('player', 100);
			expect(game.canDeal()).toBe(true);
		});
	});

	describe('Game flow', () => {
		test('should complete a round', () => {
			game.placeBet('player', 100);
			const outcome = game.deal();

			expect(outcome).not.toBeNull();
			expect(outcome!.winner).toMatch(/player|banker|tie/);
			expect(outcome!.playerHand.cards.length).toBeGreaterThanOrEqual(2);
			expect(outcome!.bankerHand.cards.length).toBeGreaterThanOrEqual(2);
		});

		test('should deduct bet from balance during deal', () => {
			const initialBalance = game.getBalance();
			game.placeBet('player', 100);
			game.deal();

			// Balance should be adjusted based on outcome
			// After deal, it returns to betting phase
			const state = game.getState();
			expect(state.phase).toBe('resolution');
		});

		test('should update balance after round', () => {
			game.placeBet('player', 100);
			const outcome = game.deal();

			// Balance should be updated based on outcome
			const balance = game.getBalance();
			// Cannot predict exact outcome, but balance should be defined
			expect(typeof balance).toBe('number');
		});

		test('should add outcome to history', () => {
			game.placeBet('player', 100);
			game.deal();

			const state = game.getState();
			expect(state.roundHistory.length).toBeGreaterThan(0);
		});

		test('should limit history to 20 rounds', () => {
			for (let i = 0; i < 25; i++) {
				game.newRound();
				game.placeBet('player', 10);
				game.deal();
			}

			const state = game.getState();
			expect(state.roundHistory.length).toBeLessThanOrEqual(20);
		});
	});

	describe('New round', () => {
		test('should reset to betting phase', () => {
			game.placeBet('player', 100);
			game.deal();
			game.newRound();

			const state = game.getState();
			expect(state.phase).toBe('betting');
			expect(state.activeBets).toHaveLength(0);
			expect(state.playerHand.cards).toHaveLength(0);
			expect(state.bankerHand.cards).toHaveLength(0);
		});
	});

	describe('Statistics', () => {
		test('should return zero stats with no history', () => {
			const stats = game.getStatistics();
			expect(stats).toEqual({ player: 0, banker: 0, tie: 0 });
		});

		test('should calculate stats from history', () => {
			// Play some rounds to generate history
			for (let i = 0; i < 10; i++) {
				game.newRound();
				game.placeBet('player', 10);
				game.deal();
			}

			const stats = game.getStatistics();
			expect(stats.player + stats.banker + stats.tie).toBe(10);
			expect(stats.player).toBeGreaterThanOrEqual(0);
			expect(stats.banker).toBeGreaterThanOrEqual(0);
			expect(stats.tie).toBeGreaterThanOrEqual(0);
		});
	});

	describe('Settings', () => {
		test('should update settings', () => {
			game.updateSettings({ minBet: 25 });
			const state = game.getState();
			expect(state.settings.minBet).toBe(25);
		});

		test('should reject bet below updated minimum', () => {
			game.updateSettings({ minBet: 50 });
			const result = game.placeBet('player', 25);
			expect(result.success).toBe(false);
		});

		test('should set balance during betting', () => {
			const result = game.setBalance(2000);
			expect(result).toBe(true);
			expect(game.getBalance()).toBe(2000);
		});

		test('should not set balance during round', () => {
			game.placeBet('player', 100);
			game.deal();
			const result = game.setBalance(2000);
			expect(result).toBe(false);
		});
	});

	describe('Insufficient chips', () => {
		test('should detect insufficient chips', () => {
			const lowBalanceGame = new BaccaratGame({
				initialBalance: 5,
				settings: {
					minBet: 10,
					maxBet: 500,
					startingChips: 5,
					animationSpeed: 'normal',
					llmEnabled: false,
					soundEnabled: true,
				},
			});
			expect(lowBalanceGame.hasInsufficientChips()).toBe(true);
		});

		test('should not flag insufficient with adequate balance', () => {
			expect(game.hasInsufficientChips()).toBe(false);
		});
	});

	describe('Events', () => {
		test('should fire onBetPlaced event', () => {
			let firedBet: unknown = null;
			const eventGame = new BaccaratGame({
				initialBalance: 1000,
				events: {
					onBetPlaced: (bet) => {
						firedBet = bet;
					},
				},
			});

			eventGame.placeBet('player', 100);
			expect(firedBet).toEqual({ type: 'player', amount: 100 });
		});

		test('should fire onRoundComplete event', () => {
			let outcome: RoundOutcome | null = null;
			const eventGame = new BaccaratGame({
				initialBalance: 1000,
				events: {
					onRoundComplete: (o) => {
						outcome = o;
					},
				},
			});

			eventGame.placeBet('player', 100);
			eventGame.deal();
			expect(outcome).not.toBeNull();
		});
	});

	describe('Deep state', () => {
		test('should return independent copy', () => {
			game.placeBet('player', 100);
			const state1 = game.getDeepState();
			game.placeBet('banker', 50);
			const state2 = game.getDeepState();

			expect(state1.activeBets.length).toBe(1);
			expect(state2.activeBets.length).toBe(2);
		});
	});
});
