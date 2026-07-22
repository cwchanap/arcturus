// src/lib/keno/selection.test.ts
import { describe, expect, test } from 'bun:test';
import { KENO_POOL, MAX_SPOTS } from './constants';
import { countHits, quickPick, validatePicks } from './selection';

describe('validatePicks', () => {
	test('accepts a 0–10 pick draft', () => {
		expect(validatePicks([]).ok).toBe(true);
		expect(validatePicks([1]).ok).toBe(true);
		expect(validatePicks(Array.from({ length: 10 }, (_, i) => i + 1)).ok).toBe(true);
	});
	test('rejects > 10 picks', () => {
		const tooMany = Array.from({ length: 11 }, (_, i) => i + 1);
		expect(validatePicks(tooMany)).toEqual({ ok: false, code: 'INVALID_SELECTION' });
	});
	test('rejects duplicates', () => {
		expect(validatePicks([1, 1])).toEqual({ ok: false, code: 'INVALID_SELECTION' });
	});
	test('rejects out-of-range (0, 81, negative)', () => {
		expect(validatePicks([0])).toEqual({ ok: false, code: 'INVALID_SELECTION' });
		expect(validatePicks([81])).toEqual({ ok: false, code: 'INVALID_SELECTION' });
		expect(validatePicks([-1])).toEqual({ ok: false, code: 'INVALID_SELECTION' });
	});
	test('rejects non-integers', () => {
		expect(validatePicks([1.5])).toEqual({ ok: false, code: 'INVALID_SELECTION' });
	});
	test('rejects non-array / malformed entries', () => {
		expect(validatePicks([1, '2' as unknown as number])).toEqual({
			ok: false,
			code: 'INVALID_SELECTION',
		});
	});
});

describe('quickPick', () => {
	test('produces n unique in-range numbers', () => {
		const picks = quickPick(8);
		expect(picks).toHaveLength(8);
		expect(new Set(picks).size).toBe(8);
		expect(picks.every((n) => n >= 1 && n <= KENO_POOL && Number.isInteger(n))).toBe(true);
		expect(validatePicks(picks).ok).toBe(true);
	});
	test('respects count 1..MAX_SPOTS', () => {
		expect(quickPick(1)).toHaveLength(1);
		expect(quickPick(MAX_SPOTS)).toHaveLength(MAX_SPOTS);
	});
	test('respects count 1..MAX_SPOTS', () => {
		expect(() => quickPick(0)).toThrow();
		expect(() => quickPick(MAX_SPOTS + 1)).toThrow();
	});
	test('is deterministic under a seeded rng', () => {
		let seed = 42;
		const rng = () => {
			seed = (seed * 1103515245 + 12345) & 0x7fffffff;
			return seed / 0x7fffffff;
		};
		const first = quickPick(5, rng);
		seed = 42; // re-seed to reproduce the same sequence
		expect(first).toEqual(quickPick(5, rng));
	});
});

describe('countHits', () => {
	test('returns the intersection of picks and drawn', () => {
		expect(countHits([1, 2, 3], [2, 3, 4])).toEqual([2, 3]);
	});
	test('returns empty array when no overlap', () => {
		expect(countHits([1, 2], [3, 4])).toEqual([]);
	});
});
