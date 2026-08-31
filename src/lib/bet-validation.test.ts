/**
 * Bet Validation Logic Unit Tests
 *
 * Tests for validating bet amounts against min/max limits.
 */

import { describe, expect, test } from 'bun:test';
import { validateBet, validateBetCode, type BetValidationCode } from './bet-validation';

describe('validateBetCode', () => {
	test('returns null for bets within min and max limits', () => {
		expect(validateBetCode(50, 10, 1000)).toBeNull();
		expect(validateBetCode(10, 10, 1000)).toBeNull();
		expect(validateBetCode(1000, 10, 1000)).toBeNull();
		expect(validateBetCode(100, 100, 100)).toBeNull();
	});

	test('returns out-of-range for amounts below min or above max', () => {
		expect(validateBetCode(5, 10, 1000)).toBe('out-of-range');
		expect(validateBetCode(0, 10, 1000)).toBe('out-of-range');
		expect(validateBetCode(1001, 10, 1000)).toBe('out-of-range');
		expect(validateBetCode(NaN, 10, 1000)).toBe('out-of-range');
		expect(validateBetCode(Infinity, 10, 1000)).toBe('out-of-range');
	});

	test('returns invalid-limits for non-finite min or max', () => {
		expect(validateBetCode(50, NaN, 1000)).toBe('invalid-limits');
		expect(validateBetCode(50, 10, NaN)).toBe('invalid-limits');
		expect(validateBetCode(50, Infinity, 1000)).toBe('invalid-limits');
		expect(validateBetCode(50, 10, -Infinity)).toBe('invalid-limits');
	});

	test('returns invalid-range when min exceeds max', () => {
		expect(validateBetCode(50, 1000, 10)).toBe('invalid-range');
		expect(validateBetCode(50, 500, 100)).toBe('invalid-range');
	});

	test('validateBet wraps validateBetCode with the legacy English strings', () => {
		expect(validateBetCode(5, 10, 1000)).toBe('out-of-range');
		expect(validateBet(5, 10, 1000)).toBe('Bet must be between 10 and 1000 chips');
		expect(validateBet(50, NaN, 1000)).toBe('Invalid bet limits');
		expect(validateBet(50, 1000, 10)).toBe('Invalid bet range');
	});
});

describe('Bet Validation Logic', () => {
	test('allows bets within min and max limits', () => {
		expect(validateBet(50, 10, 1000)).toBeNull();
		expect(validateBet(100, 10, 1000)).toBeNull();
		expect(validateBet(500, 10, 1000)).toBeNull();
		expect(validateBet(1000, 10, 1000)).toBeNull();
	});

	test('rejects bets below minimum', () => {
		expect(validateBet(5, 10, 1000)).toBe('Bet must be between 10 and 1000 chips');
		expect(validateBet(9, 10, 1000)).toBe('Bet must be between 10 and 1000 chips');
		expect(validateBet(0, 10, 1000)).toBe('Bet must be between 10 and 1000 chips');
	});

	test('rejects bets above maximum', () => {
		expect(validateBet(1001, 10, 1000)).toBe('Bet must be between 10 and 1000 chips');
		expect(validateBet(2000, 10, 1000)).toBe('Bet must be between 10 and 1000 chips');
		expect(validateBet(5000, 10, 1000)).toBe('Bet must be between 10 and 1000 chips');
	});

	test('rejects NaN bet amounts', () => {
		expect(validateBet(NaN, 10, 1000)).toBe('Bet must be between 10 and 1000 chips');
	});

	test('rejects invalid bet limits (NaN or Infinity)', () => {
		expect(validateBet(50, NaN, 1000)).toBe('Invalid bet limits');
		expect(validateBet(50, 10, NaN)).toBe('Invalid bet limits');
		expect(validateBet(50, Infinity, 1000)).toBe('Invalid bet limits');
		expect(validateBet(50, 10, Infinity)).toBe('Invalid bet limits');
		expect(validateBet(50, -Infinity, 1000)).toBe('Invalid bet limits');
	});

	test('rejects invalid bet range (min > max)', () => {
		expect(validateBet(50, 1000, 10)).toBe('Invalid bet range');
		expect(validateBet(50, 500, 100)).toBe('Invalid bet range');
	});

	test('handles edge cases with equal min and max', () => {
		expect(validateBet(100, 100, 100)).toBeNull();
		expect(validateBet(99, 100, 100)).toBe('Bet must be between 100 and 100 chips');
		expect(validateBet(101, 100, 100)).toBe('Bet must be between 100 and 100 chips');
	});

	test('validates with different min/max ranges', () => {
		expect(validateBet(25, 20, 200)).toBeNull();
		expect(validateBet(19, 20, 200)).toBe('Bet must be between 20 and 200 chips');
		expect(validateBet(201, 20, 200)).toBe('Bet must be between 20 and 200 chips');
	});
});
