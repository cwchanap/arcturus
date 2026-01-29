import { describe, expect, it } from 'bun:test';
import { getRowsAffected, determineBiggestWinCandidate } from '../pages/api/chips/update';

describe('getRowsAffected', () => {
	it('prefers meta changes when present', () => {
		const result = { meta: { changes: 2 }, rowsAffected: 5 };
		expect(getRowsAffected(result)).toBe(2);
	});

	it('falls back to rowsAffected when meta is missing', () => {
		const result = { rowsAffected: 3 };
		expect(getRowsAffected(result)).toBe(3);
	});

	it('returns 0 for nullish results', () => {
		expect(getRowsAffected(null)).toBe(0);
		expect(getRowsAffected(undefined)).toBe(0);
	});
});

/**
 * Test suite for biggestWinCandidate logic in split-hand rounds
 *
 * These tests verify the logic that determines when to use client-provided
 * biggestWinCandidate for stats tracking in split-hand scenarios.
 */
describe('Biggest Win Candidate Logic', () => {
	describe('Split-hand rounds', () => {
		it('should return null for mixed outcomes and not use biggestWinCandidate (wins=1, losses=1)', () => {
			// Scenario: Blackjack split, hand 1 wins $150, hand 2 loses $100
			// Total delta = +$50, but biggest single hand win = $150
			const delta = 50;
			const biggestWinCandidate = 150;
			const handCount = 2;
			const winsIncrement = 1;
			const lossesIncrement = 1;

			// Wait, this is mixed outcome - should NOT use biggestWinCandidate
			const result = determineBiggestWinCandidate({
				delta,
				biggestWinCandidate,
				winsIncrement,
				lossesIncrement,
				handCount,
			});

			// Mixed outcome (wins=1, losses=1) -> should return null
			expect(result).toBeNull();
		});

		it('should use client-provided biggestWinCandidate for exactly one win, no losses', () => {
			// Scenario: Blackjack split, hand 1 wins $150, hand 2 pushes
			// Total delta = +$150, biggest single hand win = $150
			const delta = 150;
			const biggestWinCandidate = 150;
			const handCount = 2;
			const winsIncrement = 1;
			const lossesIncrement = 0;

			const result = determineBiggestWinCandidate({
				delta,
				biggestWinCandidate,
				winsIncrement,
				lossesIncrement,
				handCount,
			});

			// Clean single-hand win in split round -> should use biggestWinCandidate
			expect(result).toBe(150);
		});

		it('should use biggestWinCandidate for multiple wins in split round with no losses', () => {
			// Scenario: Blackjack split, both hands win ($100 and $150)
			// Total delta = +$250, biggest single hand win = $150
			const delta = 250;
			const biggestWinCandidate = 150;
			const handCount = 2;
			const winsIncrement = 2;
			const lossesIncrement = 0;

			const result = determineBiggestWinCandidate({
				delta,
				biggestWinCandidate,
				winsIncrement,
				lossesIncrement,
				handCount,
			});

			// Multiple wins with no losses -> should use biggestWinCandidate
			expect(result).toBe(150);
		});

		it('should reject biggestWinCandidate for split round with no wins', () => {
			// Scenario: Blackjack split, both hands lose
			const delta = -200;
			const biggestWinCandidate = 0; // Client might send this
			const handCount = 2;
			const winsIncrement = 0;
			const lossesIncrement = 2;

			const result = determineBiggestWinCandidate({
				delta,
				biggestWinCandidate,
				winsIncrement,
				lossesIncrement,
				handCount,
			});

			// No wins -> should return null
			expect(result).toBeNull();
		});
	});

	describe('Single-hand rounds', () => {
		it('should use delta directly for single-hand win', () => {
			// Traditional single-hand blackjack win
			const delta = 100;
			const biggestWinCandidate = undefined;
			const handCount = 1;
			const winsIncrement = undefined;
			const lossesIncrement = undefined;

			const result = determineBiggestWinCandidate({
				delta,
				biggestWinCandidate,
				winsIncrement,
				lossesIncrement,
				handCount,
			});

			// Single-hand win -> should use delta
			expect(result).toBe(100);
		});

		it('should return null for single-hand loss', () => {
			// Traditional single-hand blackjack loss
			const delta = -50;
			const biggestWinCandidate = undefined;
			const handCount = 1;
			const winsIncrement = undefined;
			const lossesIncrement = undefined;

			const result = determineBiggestWinCandidate({
				delta,
				biggestWinCandidate,
				winsIncrement,
				lossesIncrement,
				handCount,
			});

			// Loss -> should return null
			expect(result).toBeNull();
		});

		it('should return null for single-hand push', () => {
			// Traditional single-hand blackjack push
			const delta = 0;
			const biggestWinCandidate = undefined;
			const handCount = 1;
			const winsIncrement = undefined;
			const lossesIncrement = undefined;

			const result = determineBiggestWinCandidate({
				delta,
				biggestWinCandidate,
				winsIncrement,
				lossesIncrement,
				handCount,
			});

			// Push -> should return null
			expect(result).toBeNull();
		});
	});

	describe('Aggregated multi-round syncs', () => {
		it('should reject biggestWinCandidate for aggregated syncs', () => {
			// Scenario: Rate-limited sync of multiple rounds
			// handCount=5 means this batches 5 separate rounds together
			const delta = 300; // Net win from multiple rounds
			const biggestWinCandidate = 100; // Client might try to send this
			const handCount = 5;
			const winsIncrement = 3;
			const lossesIncrement = 2;

			const result = determineBiggestWinCandidate({
				delta,
				biggestWinCandidate,
				winsIncrement,
				lossesIncrement,
				handCount,
			});

			// Aggregated sync -> should return null to avoid inflation
			expect(result).toBeNull();
		});
	});

	describe('Edge cases', () => {
		it('should handle undefined biggestWinCandidate for split rounds', () => {
			// Client might not send biggestWinCandidate for split rounds
			const delta = 100;
			const biggestWinCandidate = undefined;
			const handCount = 2;
			const winsIncrement = 1;
			const lossesIncrement = 0;

			const result = determineBiggestWinCandidate({
				delta,
				biggestWinCandidate,
				winsIncrement,
				lossesIncrement,
				handCount,
			});

			// No biggestWinCandidate provided -> should return null
			expect(result).toBeNull();
		});

		it('should handle negative delta with biggestWinCandidate', () => {
			// Client might incorrectly send biggestWinCandidate for net loss
			const delta = -50;
			const biggestWinCandidate = 100;
			const handCount = 2;
			const winsIncrement = 1;
			const lossesIncrement = 1;

			const result = determineBiggestWinCandidate({
				delta,
				biggestWinCandidate,
				winsIncrement,
				lossesIncrement,
				handCount,
			});

			// Delta <= 0 -> should return null regardless of biggestWinCandidate
			expect(result).toBeNull();
		});
	});
});
