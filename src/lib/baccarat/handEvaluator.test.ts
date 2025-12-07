/**
 * Unit tests for handEvaluator
 */

import { describe, expect, test } from 'bun:test';
import {
	getCardValue,
	getHandValue,
	isNatural,
	isPair,
	getRankValue,
	determineWinner,
	hasNatural,
	describeHand,
} from './handEvaluator';
import type { Card, Hand } from './types';

describe('getCardValue', () => {
	test('should return 1 for Ace', () => {
		const card: Card = { rank: 'A', suit: 'hearts' };
		expect(getCardValue(card)).toBe(1);
	});

	test('should return face value for 2-9', () => {
		expect(getCardValue({ rank: '2', suit: 'hearts' })).toBe(2);
		expect(getCardValue({ rank: '5', suit: 'diamonds' })).toBe(5);
		expect(getCardValue({ rank: '9', suit: 'clubs' })).toBe(9);
	});

	test('should return 0 for 10, J, Q, K', () => {
		expect(getCardValue({ rank: '10', suit: 'spades' })).toBe(0);
		expect(getCardValue({ rank: 'J', suit: 'hearts' })).toBe(0);
		expect(getCardValue({ rank: 'Q', suit: 'diamonds' })).toBe(0);
		expect(getCardValue({ rank: 'K', suit: 'clubs' })).toBe(0);
	});
});

describe('getHandValue', () => {
	test('should return last digit of sum', () => {
		// 7 + 8 = 15 → 5
		const hand: Hand = {
			cards: [
				{ rank: '7', suit: 'hearts' },
				{ rank: '8', suit: 'diamonds' },
			],
		};
		expect(getHandValue(hand)).toBe(5);
	});

	test('should handle single card hand', () => {
		const hand: Hand = { cards: [{ rank: '9', suit: 'hearts' }] };
		expect(getHandValue(hand)).toBe(9);
	});

	test('should handle three card hand', () => {
		// 5 + 6 + 7 = 18 → 8
		const hand: Hand = {
			cards: [
				{ rank: '5', suit: 'hearts' },
				{ rank: '6', suit: 'diamonds' },
				{ rank: '7', suit: 'clubs' },
			],
		};
		expect(getHandValue(hand)).toBe(8);
	});

	test('should handle face cards correctly', () => {
		// K (0) + 8 = 8
		const hand: Hand = {
			cards: [
				{ rank: 'K', suit: 'hearts' },
				{ rank: '8', suit: 'diamonds' },
			],
		};
		expect(getHandValue(hand)).toBe(8);
	});

	test('should return 0 for two face cards', () => {
		// Q (0) + J (0) = 0
		const hand: Hand = {
			cards: [
				{ rank: 'Q', suit: 'hearts' },
				{ rank: 'J', suit: 'diamonds' },
			],
		};
		expect(getHandValue(hand)).toBe(0);
	});

	test('should handle Ace as 1', () => {
		// A (1) + A (1) = 2
		const hand: Hand = {
			cards: [
				{ rank: 'A', suit: 'hearts' },
				{ rank: 'A', suit: 'diamonds' },
			],
		};
		expect(getHandValue(hand)).toBe(2);
	});

	test('should return empty hand as 0', () => {
		const hand: Hand = { cards: [] };
		expect(getHandValue(hand)).toBe(0);
	});
});

describe('isNatural', () => {
	test('should return true for hand value 8 with 2 cards', () => {
		const hand: Hand = {
			cards: [
				{ rank: 'K', suit: 'hearts' },
				{ rank: '8', suit: 'diamonds' },
			],
		};
		expect(isNatural(hand)).toBe(true);
	});

	test('should return true for hand value 9 with 2 cards', () => {
		const hand: Hand = {
			cards: [
				{ rank: '5', suit: 'hearts' },
				{ rank: '4', suit: 'diamonds' },
			],
		};
		expect(isNatural(hand)).toBe(true);
	});

	test('should return false for hand value < 8', () => {
		const hand: Hand = {
			cards: [
				{ rank: '3', suit: 'hearts' },
				{ rank: '4', suit: 'diamonds' },
			],
		};
		expect(isNatural(hand)).toBe(false);
	});

	test('should return false for 3-card hand even if value is 8+', () => {
		const hand: Hand = {
			cards: [
				{ rank: '2', suit: 'hearts' },
				{ rank: '3', suit: 'diamonds' },
				{ rank: '3', suit: 'clubs' },
			],
		};
		expect(getHandValue(hand)).toBe(8);
		expect(isNatural(hand)).toBe(false);
	});

	test('should return false for 1-card hand', () => {
		const hand: Hand = { cards: [{ rank: '9', suit: 'hearts' }] };
		expect(isNatural(hand)).toBe(false);
	});
});

describe('isPair', () => {
	test('should return true for matching ranks', () => {
		const hand: Hand = {
			cards: [
				{ rank: '7', suit: 'hearts' },
				{ rank: '7', suit: 'diamonds' },
			],
		};
		expect(isPair(hand)).toBe(true);
	});

	test('should return false for different ranks', () => {
		const hand: Hand = {
			cards: [
				{ rank: '7', suit: 'hearts' },
				{ rank: '8', suit: 'diamonds' },
			],
		};
		expect(isPair(hand)).toBe(false);
	});

	test('should check only first two cards', () => {
		const hand: Hand = {
			cards: [
				{ rank: '7', suit: 'hearts' },
				{ rank: '7', suit: 'diamonds' },
				{ rank: '9', suit: 'clubs' },
			],
		};
		expect(isPair(hand)).toBe(true);
	});

	test('should return false for single card hand', () => {
		const hand: Hand = { cards: [{ rank: '7', suit: 'hearts' }] };
		expect(isPair(hand)).toBe(false);
	});

	test('should return false for empty hand', () => {
		const hand: Hand = { cards: [] };
		expect(isPair(hand)).toBe(false);
	});
});

describe('getRankValue', () => {
	test('should return correct values for all ranks', () => {
		expect(getRankValue('A')).toBe(1);
		expect(getRankValue('2')).toBe(2);
		expect(getRankValue('9')).toBe(9);
		expect(getRankValue('10')).toBe(0);
		expect(getRankValue('J')).toBe(0);
		expect(getRankValue('Q')).toBe(0);
		expect(getRankValue('K')).toBe(0);
	});
});

describe('determineWinner', () => {
	test('should return player when player value is higher', () => {
		expect(determineWinner(8, 5)).toBe('player');
		expect(determineWinner(9, 0)).toBe('player');
	});

	test('should return banker when banker value is higher', () => {
		expect(determineWinner(5, 8)).toBe('banker');
		expect(determineWinner(0, 9)).toBe('banker');
	});

	test('should return tie when values are equal', () => {
		expect(determineWinner(5, 5)).toBe('tie');
		expect(determineWinner(9, 9)).toBe('tie');
		expect(determineWinner(0, 0)).toBe('tie');
	});
});

describe('hasNatural', () => {
	test('should return true if player has natural', () => {
		const player: Hand = {
			cards: [
				{ rank: '5', suit: 'hearts' },
				{ rank: '4', suit: 'diamonds' },
			],
		};
		const banker: Hand = {
			cards: [
				{ rank: '3', suit: 'hearts' },
				{ rank: '4', suit: 'diamonds' },
			],
		};
		expect(hasNatural(player, banker)).toBe(true);
	});

	test('should return true if banker has natural', () => {
		const player: Hand = {
			cards: [
				{ rank: '3', suit: 'hearts' },
				{ rank: '4', suit: 'diamonds' },
			],
		};
		const banker: Hand = {
			cards: [
				{ rank: 'K', suit: 'hearts' },
				{ rank: '8', suit: 'diamonds' },
			],
		};
		expect(hasNatural(player, banker)).toBe(true);
	});

	test('should return true if both have natural', () => {
		const player: Hand = {
			cards: [
				{ rank: '5', suit: 'hearts' },
				{ rank: '4', suit: 'diamonds' },
			],
		};
		const banker: Hand = {
			cards: [
				{ rank: 'K', suit: 'hearts' },
				{ rank: '8', suit: 'diamonds' },
			],
		};
		expect(hasNatural(player, banker)).toBe(true);
	});

	test('should return false if neither has natural', () => {
		const player: Hand = {
			cards: [
				{ rank: '3', suit: 'hearts' },
				{ rank: '4', suit: 'diamonds' },
			],
		};
		const banker: Hand = {
			cards: [
				{ rank: '2', suit: 'hearts' },
				{ rank: '3', suit: 'diamonds' },
			],
		};
		expect(hasNatural(player, banker)).toBe(false);
	});
});

describe('describeHand', () => {
	test('should describe a natural correctly', () => {
		const hand: Hand = {
			cards: [
				{ rank: 'K', suit: 'hearts' },
				{ rank: '9', suit: 'diamonds' },
			],
		};
		const description = describeHand(hand);
		expect(description).toContain('9');
		expect(description).toContain('Natural');
	});

	test('should describe a non-natural correctly', () => {
		const hand: Hand = {
			cards: [
				{ rank: '3', suit: 'hearts' },
				{ rank: '4', suit: 'diamonds' },
			],
		};
		const description = describeHand(hand);
		expect(description).toContain('7');
		expect(description).not.toContain('Natural');
	});
});
