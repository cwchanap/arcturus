/**
 * Formatting Utilities Unit Tests
 *
 * Tests for formatting functions like currency, chip balances, etc.
 */

import { describe, expect, test } from 'bun:test';
import { SUPPORTED_LOCALES } from './i18n/locale';
import {
	formatChipBalance,
	formatChipBalanceWithDecimals,
	formatPercentage,
	formatWholeNumber,
} from './formatting';

describe('Chip Balance Formatting', () => {
	test('formats small balances without commas', () => {
		expect(formatChipBalance(100)).toBe('100');
		expect(formatChipBalance(999)).toBe('999');
		expect(formatChipBalance(0)).toBe('0');
		expect(formatChipBalance(1)).toBe('1');
	});

	test('formats balances with commas for thousands', () => {
		expect(formatChipBalance(1000)).toBe('1,000');
		expect(formatChipBalance(10000)).toBe('10,000');
		expect(formatChipBalance(100000)).toBe('100,000');
		expect(formatChipBalance(1000000)).toBe('1,000,000');
	});

	test('formats balances with commas for mixed values', () => {
		expect(formatChipBalance(1234)).toBe('1,234');
		expect(formatChipBalance(12345)).toBe('12,345');
		expect(formatChipBalance(123456)).toBe('123,456');
		expect(formatChipBalance(1234567)).toBe('1,234,567');
		expect(formatChipBalance(12345678)).toBe('12,345,678');
	});

	test('formats balances with decimals', () => {
		expect(formatChipBalanceWithDecimals(1000.5)).toBe('1,000.50');
		expect(formatChipBalanceWithDecimals(12345.67)).toBe('12,345.67');
		expect(formatChipBalanceWithDecimals(0.99)).toBe('0.99');
	});

	test('handles negative balances', () => {
		expect(formatChipBalance(-100)).toBe('-100');
		expect(formatChipBalance(-1000)).toBe('-1,000');
		expect(formatChipBalance(-12345)).toBe('-12,345');
	});
});

describe('Player statistics formatting', () => {
	test('formats whole numbers', () => {
		expect(formatWholeNumber(12345)).toBe('12,345');
	});

	test('rejects non-integer values for whole-number formatting', () => {
		expect(() => formatWholeNumber(1.5)).toThrow(RangeError);
	});

	test('formats percentages to one decimal place', () => {
		expect(formatPercentage(50.83333333333333)).toBe('50.8%');
	});

	test('rejects non-finite percentages', () => {
		expect(() => formatPercentage(Number.NaN)).toThrow(RangeError);
	});

	test('accepts every supported locale while keeping grouping and decimals', () => {
		for (const locale of SUPPORTED_LOCALES) {
			expect(formatChipBalance(10000, locale)).toBe('10,000');
			expect(formatWholeNumber(12345, locale)).toBe('12,345');
			expect(formatChipBalanceWithDecimals(12345.67, 2, 2, locale)).toBe('12,345.67');
			expect(formatPercentage(50.83333333333333, locale)).toBe('50.8%');
		}
	});

	test('locale arguments default to English', () => {
		expect(formatChipBalance(10000)).toBe('10,000');
		expect(formatWholeNumber(12345)).toBe('12,345');
		expect(formatChipBalanceWithDecimals(12345.67)).toBe('12,345.67');
	});
});
