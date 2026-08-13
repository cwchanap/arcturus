import { describe, expect, test } from 'bun:test';
import { calculatePayout, WAGER_OPTIONS } from './paytable';

describe('Jacks or Better paytable', () => {
	test('offers one through five chips', () => {
		expect(WAGER_OPTIONS).toEqual([1, 2, 3, 4, 5]);
	});

	test('uses the frozen 9/6 payouts', () => {
		expect(calculatePayout('straight-flush', 2)).toBe(100);
		expect(calculatePayout('four-of-kind', 2)).toBe(50);
		expect(calculatePayout('full-house', 2)).toBe(18);
		expect(calculatePayout('flush', 2)).toBe(12);
		expect(calculatePayout('straight', 2)).toBe(8);
		expect(calculatePayout('three-of-kind', 2)).toBe(6);
		expect(calculatePayout('two-pair', 2)).toBe(4);
		expect(calculatePayout('jacks-or-better', 2)).toBe(2);
		expect(calculatePayout('nothing', 2)).toBe(0);
	});

	test('uses the five-chip Royal Flush exception', () => {
		expect(calculatePayout('royal-flush', 4)).toBe(1000);
		expect(calculatePayout('royal-flush', 5)).toBe(4000);
	});

	test('rejects invalid paytable wagers', () => {
		expect(() => calculatePayout('flush', 0)).toThrow(RangeError);
		expect(() => calculatePayout('flush', 2.5)).toThrow(RangeError);
		expect(() => calculatePayout('flush', 6)).toThrow(RangeError);
	});
});
