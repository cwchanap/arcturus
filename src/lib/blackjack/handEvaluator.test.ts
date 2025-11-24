/**
 * Hand evaluator tests
 */

import { describe, it, expect } from 'bun:test';
import {
	calculateHandValue,
	isBlackjack,
	isBust,
	canSplit,
	canDoubleDown,
	compareHands,
	getHandValueDisplay,
} from './handEvaluator';
import type { Card, Hand } from './types';

describe('handEvaluator', () => {
	describe('calculateHandValue', () => {
		it('should calculate simple hand values correctly', () => {
			const cards: Card[] = [
				{ rank: '7', suit: 'hearts' },
				{ rank: '8', suit: 'diamonds' },
			];
			const result = calculateHandValue(cards);
			expect(result.value).toBe(15);
			expect(result.isSoft).toBe(false);
			expect(result.isBust).toBe(false);
		});

		it('should count face cards as 10', () => {
			const cards: Card[] = [
				{ rank: 'K', suit: 'hearts' },
				{ rank: 'Q', suit: 'diamonds' },
			];
			const result = calculateHandValue(cards);
			expect(result.value).toBe(20);
		});

		it('should handle Ace as 11 when not busting (soft hand)', () => {
			const cards: Card[] = [
				{ rank: 'A', suit: 'hearts' },
				{ rank: '6', suit: 'diamonds' },
			];
			const result = calculateHandValue(cards);
			expect(result.value).toBe(17);
			expect(result.isSoft).toBe(true);
			expect(result.isBust).toBe(false);
		});

		it('should downgrade Ace to 1 when 11 would bust (hard hand)', () => {
			const cards: Card[] = [
				{ rank: 'A', suit: 'hearts' },
				{ rank: '6', suit: 'diamonds' },
				{ rank: '10', suit: 'clubs' },
			];
			const result = calculateHandValue(cards);
			expect(result.value).toBe(17); // A=1, 6, 10
			expect(result.isSoft).toBe(false); // No longer soft
			expect(result.isBust).toBe(false);
		});

		it('should handle multiple Aces correctly', () => {
			const cards: Card[] = [
				{ rank: 'A', suit: 'hearts' },
				{ rank: 'A', suit: 'diamonds' },
			];
			const result = calculateHandValue(cards);
			expect(result.value).toBe(12); // One Ace as 11, one as 1
			expect(result.isSoft).toBe(true);
		});

		it('should handle three Aces correctly', () => {
			const cards: Card[] = [
				{ rank: 'A', suit: 'hearts' },
				{ rank: 'A', suit: 'diamonds' },
				{ rank: 'A', suit: 'clubs' },
			];
			const result = calculateHandValue(cards);
			expect(result.value).toBe(13); // One as 11, two as 1
			expect(result.isSoft).toBe(true);
		});

		it('should detect bust', () => {
			const cards: Card[] = [
				{ rank: 'K', suit: 'hearts' },
				{ rank: 'Q', suit: 'diamonds' },
				{ rank: '5', suit: 'clubs' },
			];
			const result = calculateHandValue(cards);
			expect(result.value).toBe(25);
			expect(result.isBust).toBe(true);
		});

		it('should calculate Blackjack (21 with 2 cards)', () => {
			const cards: Card[] = [
				{ rank: 'A', suit: 'hearts' },
				{ rank: 'K', suit: 'diamonds' },
			];
			const result = calculateHandValue(cards);
			expect(result.value).toBe(21);
			expect(result.isSoft).toBe(true);
			expect(result.isBust).toBe(false);
		});
	});

	describe('isBlackjack', () => {
		it('should return true for Ace + 10-value card', () => {
			const hand: Hand = {
				cards: [
					{ rank: 'A', suit: 'hearts' },
					{ rank: 'K', suit: 'diamonds' },
				],
				bet: 100,
				isDealer: false,
			};
			expect(isBlackjack(hand)).toBe(true);
		});

		it('should return false for 21 with more than 2 cards', () => {
			const hand: Hand = {
				cards: [
					{ rank: '7', suit: 'hearts' },
					{ rank: '7', suit: 'diamonds' },
					{ rank: '7', suit: 'clubs' },
				],
				bet: 100,
				isDealer: false,
			};
			expect(isBlackjack(hand)).toBe(false);
		});

		it('should return false for non-21 hand', () => {
			const hand: Hand = {
				cards: [
					{ rank: 'K', suit: 'hearts' },
					{ rank: 'Q', suit: 'diamonds' },
				],
				bet: 100,
				isDealer: false,
			};
			expect(isBlackjack(hand)).toBe(false);
		});
	});

	describe('isBust', () => {
		it('should return true when hand over 21', () => {
			const hand: Hand = {
				cards: [
					{ rank: 'K', suit: 'hearts' },
					{ rank: 'Q', suit: 'diamonds' },
					{ rank: '5', suit: 'clubs' },
				],
				bet: 100,
				isDealer: false,
			};
			expect(isBust(hand)).toBe(true);
		});

		it('should return false when hand under 21', () => {
			const hand: Hand = {
				cards: [
					{ rank: 'K', suit: 'hearts' },
					{ rank: '10', suit: 'diamonds' },
				],
				bet: 100,
				isDealer: false,
			};
			expect(isBust(hand)).toBe(false);
		});
	});

	describe('canSplit', () => {
		it('should return true for pair of same rank', () => {
			const hand: Hand = {
				cards: [
					{ rank: '8', suit: 'hearts' },
					{ rank: '8', suit: 'diamonds' },
				],
				bet: 100,
				isDealer: false,
			};
			expect(canSplit(hand)).toBe(true);
		});

		it('should return true for pair of face cards', () => {
			const hand: Hand = {
				cards: [
					{ rank: 'K', suit: 'hearts' },
					{ rank: 'K', suit: 'diamonds' },
				],
				bet: 100,
				isDealer: false,
			};
			expect(canSplit(hand)).toBe(true);
		});

		it('should return false for different ranks', () => {
			const hand: Hand = {
				cards: [
					{ rank: 'K', suit: 'hearts' },
					{ rank: 'Q', suit: 'diamonds' },
				],
				bet: 100,
				isDealer: false,
			};
			expect(canSplit(hand)).toBe(false);
		});

		it('should return false when more than 2 cards', () => {
			const hand: Hand = {
				cards: [
					{ rank: '8', suit: 'hearts' },
					{ rank: '8', suit: 'diamonds' },
					{ rank: '5', suit: 'clubs' },
				],
				bet: 100,
				isDealer: false,
			};
			expect(canSplit(hand)).toBe(false);
		});
	});

	describe('canDoubleDown', () => {
		it('should return true for hand totaling 9', () => {
			const hand: Hand = {
				cards: [
					{ rank: '5', suit: 'hearts' },
					{ rank: '4', suit: 'diamonds' },
				],
				bet: 100,
				isDealer: false,
			};
			expect(canDoubleDown(hand)).toBe(true);
		});

		it('should return true for hand totaling 10', () => {
			const hand: Hand = {
				cards: [
					{ rank: '6', suit: 'hearts' },
					{ rank: '4', suit: 'diamonds' },
				],
				bet: 100,
				isDealer: false,
			};
			expect(canDoubleDown(hand)).toBe(true);
		});

		it('should return true for hand totaling 11', () => {
			const hand: Hand = {
				cards: [
					{ rank: '6', suit: 'hearts' },
					{ rank: '5', suit: 'diamonds' },
				],
				bet: 100,
				isDealer: false,
			};
			expect(canDoubleDown(hand)).toBe(true);
		});

		it('should return false for hand totaling 8', () => {
			const hand: Hand = {
				cards: [
					{ rank: '5', suit: 'hearts' },
					{ rank: '3', suit: 'diamonds' },
				],
				bet: 100,
				isDealer: false,
			};
			expect(canDoubleDown(hand)).toBe(false);
		});

		it('should return false for hand totaling 12', () => {
			const hand: Hand = {
				cards: [
					{ rank: '7', suit: 'hearts' },
					{ rank: '5', suit: 'diamonds' },
				],
				bet: 100,
				isDealer: false,
			};
			expect(canDoubleDown(hand)).toBe(false);
		});

		it('should return false when more than 2 cards', () => {
			const hand: Hand = {
				cards: [
					{ rank: '3', suit: 'hearts' },
					{ rank: '3', suit: 'diamonds' },
					{ rank: '3', suit: 'clubs' },
				],
				bet: 100,
				isDealer: false,
			};
			expect(canDoubleDown(hand)).toBe(false);
		});
	});

	describe('compareHands', () => {
		it('should return 1 when hand1 wins', () => {
			const hand1: Hand = {
				cards: [
					{ rank: 'K', suit: 'hearts' },
					{ rank: '9', suit: 'diamonds' },
				],
				bet: 100,
				isDealer: false,
			};
			const hand2: Hand = {
				cards: [
					{ rank: '10', suit: 'hearts' },
					{ rank: '8', suit: 'diamonds' },
				],
				bet: 0,
				isDealer: true,
			};
			expect(compareHands(hand1, hand2)).toBe(1);
		});

		it('should return -1 when hand2 wins', () => {
			const hand1: Hand = {
				cards: [
					{ rank: '10', suit: 'hearts' },
					{ rank: '8', suit: 'diamonds' },
				],
				bet: 100,
				isDealer: false,
			};
			const hand2: Hand = {
				cards: [
					{ rank: 'K', suit: 'hearts' },
					{ rank: '9', suit: 'diamonds' },
				],
				bet: 0,
				isDealer: true,
			};
			expect(compareHands(hand1, hand2)).toBe(-1);
		});

		it('should return 0 for push (tie)', () => {
			const hand1: Hand = {
				cards: [
					{ rank: 'K', suit: 'hearts' },
					{ rank: '8', suit: 'diamonds' },
				],
				bet: 100,
				isDealer: false,
			};
			const hand2: Hand = {
				cards: [
					{ rank: 'Q', suit: 'hearts' },
					{ rank: '8', suit: 'clubs' },
				],
				bet: 0,
				isDealer: true,
			};
			expect(compareHands(hand1, hand2)).toBe(0);
		});

		it('should return -1 when hand1 busts', () => {
			const hand1: Hand = {
				cards: [
					{ rank: 'K', suit: 'hearts' },
					{ rank: 'Q', suit: 'diamonds' },
					{ rank: '5', suit: 'clubs' },
				],
				bet: 100,
				isDealer: false,
			};
			const hand2: Hand = {
				cards: [
					{ rank: '10', suit: 'hearts' },
					{ rank: '8', suit: 'diamonds' },
				],
				bet: 0,
				isDealer: true,
			};
			expect(compareHands(hand1, hand2)).toBe(-1);
		});

		it('should return 1 when hand2 busts', () => {
			const hand1: Hand = {
				cards: [
					{ rank: '10', suit: 'hearts' },
					{ rank: '8', suit: 'diamonds' },
				],
				bet: 100,
				isDealer: false,
			};
			const hand2: Hand = {
				cards: [
					{ rank: 'K', suit: 'hearts' },
					{ rank: 'Q', suit: 'diamonds' },
					{ rank: '5', suit: 'clubs' },
				],
				bet: 0,
				isDealer: true,
			};
			expect(compareHands(hand1, hand2)).toBe(1);
		});
	});

	describe('getHandValueDisplay', () => {
		it('should return value as string for hard hand', () => {
			const cards: Card[] = [
				{ rank: 'K', suit: 'hearts' },
				{ rank: '7', suit: 'diamonds' },
			];
			expect(getHandValueDisplay(cards)).toBe('17');
		});

		it('should return "Soft X" for soft hand', () => {
			const cards: Card[] = [
				{ rank: 'A', suit: 'hearts' },
				{ rank: '6', suit: 'diamonds' },
			];
			expect(getHandValueDisplay(cards)).toBe('Soft 17');
		});

		it('should return "Bust" for busted hand', () => {
			const cards: Card[] = [
				{ rank: 'K', suit: 'hearts' },
				{ rank: 'Q', suit: 'diamonds' },
				{ rank: '5', suit: 'clubs' },
			];
			expect(getHandValueDisplay(cards)).toBe('Bust');
		});
	});
});
