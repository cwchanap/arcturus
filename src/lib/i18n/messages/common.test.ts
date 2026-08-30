import { describe, expect, test } from 'bun:test';
import { formatChips } from './common';
import { SUPPORTED_LOCALES } from '../locale';

describe('formatChips', () => {
	test('English uses the real singular only for 1', () => {
		expect(formatChips(1, 'en')).toBe('1 chip');
		expect(formatChips(2, 'en')).toBe('2 chips');
		expect(formatChips(10000, 'en')).toBe('10,000 chips');
		expect(formatChips(0, 'en')).toBe('0 chips');
	});

	test('Traditional Chinese uses its invariant noun', () => {
		expect(formatChips(1, 'zh-Hant')).toBe('1 籌碼');
		expect(formatChips(10000, 'zh-Hant')).toBe('10,000 籌碼');
	});

	test('Simplified Chinese uses its invariant noun', () => {
		expect(formatChips(1, 'zh-Hans')).toBe('1 筹码');
		expect(formatChips(10000, 'zh-Hans')).toBe('10,000 筹码');
	});

	test('Japanese uses its invariant noun', () => {
		expect(formatChips(1, 'ja')).toBe('1 チップ');
		expect(formatChips(10000, 'ja')).toBe('10,000 チップ');
	});

	test('every supported locale produces a non-empty phrase', () => {
		for (const locale of SUPPORTED_LOCALES) {
			for (const value of [0, 1, 5, 1000, 12500]) {
				expect(formatChips(value, locale).length).toBeGreaterThan(0);
			}
		}
	});
});
