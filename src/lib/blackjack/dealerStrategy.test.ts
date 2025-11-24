/**
 * Dealer strategy tests
 */

import { describe, it, expect } from 'bun:test';
import { shouldDealerHit, shouldDealerStand } from './dealerStrategy';
import type { Hand } from './types';

describe('dealerStrategy', () => {
	describe('shouldDealerHit', () => {
		it('should return true for hand value 16', () => {
			const hand: Hand = {
				cards: [
					{ rank: 'K', suit: 'hearts' },
					{ rank: '6', suit: 'diamonds' },
				],
				bet: 0,
				isDealer: true,
			};
			expect(shouldDealerHit(hand)).toBe(true);
		});

		it('should return true for hand value less than 16', () => {
			const hand: Hand = {
				cards: [
					{ rank: '9', suit: 'hearts' },
					{ rank: '5', suit: 'diamonds' },
				],
				bet: 0,
				isDealer: true,
			};
			expect(shouldDealerHit(hand)).toBe(true);
		});

		it('should return false for hand value 17', () => {
			const hand: Hand = {
				cards: [
					{ rank: 'K', suit: 'hearts' },
					{ rank: '7', suit: 'diamonds' },
				],
				bet: 0,
				isDealer: true,
			};
			expect(shouldDealerHit(hand)).toBe(false);
		});

		it('should return false for hand value greater than 17', () => {
			const hand: Hand = {
				cards: [
					{ rank: 'K', suit: 'hearts' },
					{ rank: '9', suit: 'diamonds' },
				],
				bet: 0,
				isDealer: true,
			};
			expect(shouldDealerHit(hand)).toBe(false);
		});

		it('should return false when busted', () => {
			const hand: Hand = {
				cards: [
					{ rank: 'K', suit: 'hearts' },
					{ rank: 'Q', suit: 'diamonds' },
					{ rank: '5', suit: 'clubs' },
				],
				bet: 0,
				isDealer: true,
			};
			expect(shouldDealerHit(hand)).toBe(false);
		});

		it('should handle soft 17 (Ace + 6) correctly', () => {
			const hand: Hand = {
				cards: [
					{ rank: 'A', suit: 'hearts' },
					{ rank: '6', suit: 'diamonds' },
				],
				bet: 0,
				isDealer: true,
			};
			// Soft 17 = stand (value is 17)
			expect(shouldDealerHit(hand)).toBe(false);
		});

		it('should handle soft 16 (Ace + 5) correctly', () => {
			const hand: Hand = {
				cards: [
					{ rank: 'A', suit: 'hearts' },
					{ rank: '5', suit: 'diamonds' },
				],
				bet: 0,
				isDealer: true,
			};
			// Soft 16 = hit (value is 16)
			expect(shouldDealerHit(hand)).toBe(true);
		});
	});

	describe('shouldDealerStand', () => {
		it('should return false for hand value 16', () => {
			const hand: Hand = {
				cards: [
					{ rank: 'K', suit: 'hearts' },
					{ rank: '6', suit: 'diamonds' },
				],
				bet: 0,
				isDealer: true,
			};
			expect(shouldDealerStand(hand)).toBe(false);
		});

		it('should return false for hand value less than 16', () => {
			const hand: Hand = {
				cards: [
					{ rank: '9', suit: 'hearts' },
					{ rank: '5', suit: 'diamonds' },
				],
				bet: 0,
				isDealer: true,
			};
			expect(shouldDealerStand(hand)).toBe(false);
		});

		it('should return true for hand value 17', () => {
			const hand: Hand = {
				cards: [
					{ rank: 'K', suit: 'hearts' },
					{ rank: '7', suit: 'diamonds' },
				],
				bet: 0,
				isDealer: true,
			};
			expect(shouldDealerStand(hand)).toBe(true);
		});

		it('should return true for hand value greater than 17', () => {
			const hand: Hand = {
				cards: [
					{ rank: 'K', suit: 'hearts' },
					{ rank: '9', suit: 'diamonds' },
				],
				bet: 0,
				isDealer: true,
			};
			expect(shouldDealerStand(hand)).toBe(true);
		});

		it('should return true when busted', () => {
			const hand: Hand = {
				cards: [
					{ rank: 'K', suit: 'hearts' },
					{ rank: 'Q', suit: 'diamonds' },
					{ rank: '5', suit: 'clubs' },
				],
				bet: 0,
				isDealer: true,
			};
			expect(shouldDealerStand(hand)).toBe(true);
		});

		it('should return true for blackjack (21)', () => {
			const hand: Hand = {
				cards: [
					{ rank: 'A', suit: 'hearts' },
					{ rank: 'K', suit: 'diamonds' },
				],
				bet: 0,
				isDealer: true,
			};
			expect(shouldDealerStand(hand)).toBe(true);
		});
	});

	describe('shouldDealerHit and shouldDealerStand complement', () => {
		it('should be opposite for value 16', () => {
			const hand: Hand = {
				cards: [
					{ rank: 'K', suit: 'hearts' },
					{ rank: '6', suit: 'diamonds' },
				],
				bet: 0,
				isDealer: true,
			};
			expect(shouldDealerHit(hand)).toBe(true);
			expect(shouldDealerStand(hand)).toBe(false);
		});

		it('should be opposite for value 17', () => {
			const hand: Hand = {
				cards: [
					{ rank: 'K', suit: 'hearts' },
					{ rank: '7', suit: 'diamonds' },
				],
				bet: 0,
				isDealer: true,
			};
			expect(shouldDealerHit(hand)).toBe(false);
			expect(shouldDealerStand(hand)).toBe(true);
		});

		it('should both be false for bust (edge case)', () => {
			const hand: Hand = {
				cards: [
					{ rank: 'K', suit: 'hearts' },
					{ rank: 'Q', suit: 'diamonds' },
					{ rank: '5', suit: 'clubs' },
				],
				bet: 0,
				isDealer: true,
			};
			// When busted: don't hit, but do stand (game over)
			expect(shouldDealerHit(hand)).toBe(false);
			expect(shouldDealerStand(hand)).toBe(true);
		});
	});
});
