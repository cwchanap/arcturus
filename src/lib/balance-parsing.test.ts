/**
 * Balance Parsing Logic Unit Tests
 *
 * Tests for parsing balance strings with commas and currency symbols.
 */

import { describe, expect, test } from 'bun:test';
import { parseBalance } from './balance-parsing';

describe('Balance Parsing Logic', () => {
	test('parses simple numbers without formatting', () => {
		expect(parseBalance('100')).toBe(100);
		expect(parseBalance('1000')).toBe(1000);
		expect(parseBalance('0')).toBe(0);
	});

	test('parses numbers with commas', () => {
		expect(parseBalance('1,000')).toBe(1000);
		expect(parseBalance('10,000')).toBe(10000);
		expect(parseBalance('100,000')).toBe(100000);
		expect(parseBalance('1,000,000')).toBe(1000000);
	});

	test('parses mixed format numbers', () => {
		expect(parseBalance('12,345')).toBe(12345);
		expect(parseBalance('123,456')).toBe(123456);
		expect(parseBalance('1,234,567')).toBe(1234567);
	});

	test('parses numbers with dollar signs', () => {
		expect(parseBalance('$100')).toBe(100);
		expect(parseBalance('$1,000')).toBe(1000);
		expect(parseBalance('$12,345')).toBe(12345);
	});

	test('parses numbers with decimals', () => {
		expect(parseBalance('100.50')).toBe(100.5);
		expect(parseBalance('1,000.99')).toBe(1000.99);
		expect(parseBalance('$1,234.56')).toBe(1234.56);
	});

	test('parses negative numbers', () => {
		expect(parseBalance('-100')).toBe(-100);
		expect(parseBalance('-1,000')).toBe(-1000);
		expect(parseBalance('-$500')).toBe(-500);
	});

	test('parses accounting-style negative numbers with parentheses', () => {
		expect(parseBalance('($100)')).toBe(-100);
		expect(parseBalance('($1,000)')).toBe(-1000);
		expect(parseBalance('($12,345.67)')).toBe(-12345.67);
		expect(parseBalance('(100)')).toBe(-100);
	});

	test('handles invalid input gracefully', () => {
		expect(parseBalance('')).toBeNull();
		expect(parseBalance('abc')).toBeNull();
		expect(parseBalance('$')).toBeNull();
		expect(parseBalance(',')).toBeNull();
	});

	test('extracts first number from text', () => {
		expect(parseBalance('Balance: $1,000')).toBe(1000);
		expect(parseBalance('Your chips: 5,000')).toBe(5000);
		expect(parseBalance('$100 available')).toBe(100);
	});
});
