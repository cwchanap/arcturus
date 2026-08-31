/**
 * Bet Validation Logic Unit Tests
 *
 * Tests for validating bet amounts against min/max limits.
 */

import { describe, expect, test } from 'bun:test';
import { validateBetCode } from './bet-validation';

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
});
