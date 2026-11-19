import { describe, expect, test } from 'bun:test';
import { WIN_TIER_MULTIPLES, winTier } from './tier';

describe('WIN_TIER_MULTIPLES', () => {
	test('keeps the one threshold source for stake and Poker big blinds', () => {
		expect(WIN_TIER_MULTIPLES.stake).toEqual({ big: 5, huge: 20 });
		expect(WIN_TIER_MULTIPLES.bigBlind).toEqual({ big: 20, huge: 50 });
	});
});

describe('winTier', () => {
	test('classifies stake wins inclusively, huge checked first', () => {
		expect(winTier(25, 5)).toBe('big');
		expect(winTier(24.9999, 5)).toBeNull();
		expect(winTier(100, 5)).toBe('huge');
		expect(winTier(99, 5)).toBe('big');
	});

	test('classifies big-blind wins with the Poker thresholds', () => {
		expect(winTier(20, 1, WIN_TIER_MULTIPLES.bigBlind)).toBe('big');
		expect(winTier(19.5, 1, WIN_TIER_MULTIPLES.bigBlind)).toBeNull();
		expect(winTier(50, 1, WIN_TIER_MULTIPLES.bigBlind)).toBe('huge');
		expect(winTier(49, 1, WIN_TIER_MULTIPLES.bigBlind)).toBe('big');
	});

	test('rejects zero and negative measures and units (losses, pushes)', () => {
		for (const invalid of [0, -1, -100]) {
			expect(winTier(invalid, 5)).toBeNull();
			expect(winTier(100, invalid)).toBeNull();
		}
	});

	test('rejects nonfinite measures and units', () => {
		for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
			expect(winTier(invalid, 5)).toBeNull();
			expect(winTier(100, invalid)).toBeNull();
		}
	});
});
