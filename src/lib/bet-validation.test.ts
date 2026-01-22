/**
 * Bet Validation Logic Unit Tests
 *
 * Tests for validating bet amounts against min/max limits.
 */

import { describe, expect, test } from 'bun:test';

describe('Bet Validation Logic', () => {
	const validateBet = (amount: number, minBet: number, maxBet: number): string | null => {
		if (Number.isNaN(amount) || amount < minBet || amount > maxBet) {
			return `Bet must be between $${minBet} and $${maxBet}`;
		}
		return null;
	};

	test('allows bets within min and max limits', () => {
		expect(validateBet(50, 10, 1000)).toBeNull();
		expect(validateBet(100, 10, 1000)).toBeNull();
		expect(validateBet(500, 10, 1000)).toBeNull();
		expect(validateBet(1000, 10, 1000)).toBeNull();
	});

	test('rejects bets below minimum', () => {
		expect(validateBet(5, 10, 1000)).toBe('Bet must be between $10 and $1000');
		expect(validateBet(9, 10, 1000)).toBe('Bet must be between $10 and $1000');
		expect(validateBet(0, 10, 1000)).toBe('Bet must be between $10 and $1000');
	});

	test('rejects bets above maximum', () => {
		expect(validateBet(1001, 10, 1000)).toBe('Bet must be between $10 and $1000');
		expect(validateBet(2000, 10, 1000)).toBe('Bet must be between $10 and $1000');
		expect(validateBet(5000, 10, 1000)).toBe('Bet must be between $10 and $1000');
	});

	test('rejects NaN bet amounts', () => {
		expect(validateBet(NaN, 10, 1000)).toBe('Bet must be between $10 and $1000');
	});

	test('handles edge cases with equal min and max', () => {
		expect(validateBet(100, 100, 100)).toBeNull();
		expect(validateBet(99, 100, 100)).toBe('Bet must be between $100 and $100');
		expect(validateBet(101, 100, 100)).toBe('Bet must be between $100 and $100');
	});

	test('validates with different min/max ranges', () => {
		expect(validateBet(25, 20, 200)).toBeNull();
		expect(validateBet(19, 20, 200)).toBe('Bet must be between $20 and $200');
		expect(validateBet(201, 20, 200)).toBe('Bet must be between $20 and $200');
	});
});
