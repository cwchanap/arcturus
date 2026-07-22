// src/lib/keno/payoutCalculator.test.ts
import { describe, expect, test } from 'bun:test';
import { PAYTABLE } from './constants';
import { computeRtp, evaluateDraw } from './payoutCalculator';

describe('evaluateDraw', () => {
	test('returns hits, hitCount, multiplier, payout', () => {
		const picks = [1, 2, 3, 4];
		const drawn = [1, 2, 3, 5, 6, 7]; // 3 of 4 caught
		const r = evaluateDraw(picks, drawn, 5);
		expect(r.hitCount).toBe(3);
		expect(r.hits).toEqual([1, 2, 3]);
		expect(r.multiplier).toBe(PAYTABLE[4][3]); // 5
		expect(r.payout).toBe(5 * 5); // 25
	});
	test('payout scales linearly with bet', () => {
		const picks = [1, 2, 3, 4, 5];
		const drawn = [1, 2, 3, 4, 5, 6]; // catch-5 of 5
		expect(evaluateDraw(picks, drawn, 1).payout).toBe(500);
		expect(evaluateDraw(picks, drawn, 5).payout).toBe(2500);
	});
	test('no payout for a non-paying tier (multiplier 0)', () => {
		const picks = [1, 2, 3, 4];
		const drawn = [5, 6, 7, 8]; // catch-0 of 4 → no tier
		const r = evaluateDraw(picks, drawn, 5);
		expect(r.multiplier).toBe(0);
		expect(r.payout).toBe(0);
	});
	test('strictly monotonic within a spot count', () => {
		for (const spots of Object.keys(PAYTABLE)) {
			const tiers = PAYTABLE[Number(spots)];
			const entries = Object.entries(tiers)
				.map(([k, v]) => [Number(k), v] as const)
				.sort((a, b) => a[0] - b[0]);
			for (let i = 1; i < entries.length; i++) {
				expect(entries[i][1]).toBeGreaterThan(entries[i - 1][1]);
			}
		}
	});
});

describe('computeRtp (RTP audit)', () => {
	test('every spot count lands in [0.55, 0.95] (house-favorable)', () => {
		for (let spots = 1; spots <= 10; spots++) {
			const rtp = computeRtp(spots);
			expect(rtp).toBeGreaterThanOrEqual(0.55);
			expect(rtp).toBeLessThanOrEqual(0.95);
		}
	});
	test('10-spot RTP ≈ 0.8353 (regression net for the 104.84% bug)', () => {
		expect(Math.abs(computeRtp(10) - 0.8353)).toBeLessThan(0.001);
	});
	test('spot RTPs match the spec audit column', () => {
		const expected: Record<number, number> = {
			1: 0.75,
			2: 0.7215,
			3: 0.9019,
			4: 0.8271,
			5: 0.7322,
			6: 0.6778,
			7: 0.6408,
			8: 0.5937,
			9: 0.8622,
			10: 0.8353,
		};
		for (let s = 1; s <= 10; s++) {
			expect(Math.abs(computeRtp(s) - expected[s])).toBeLessThan(0.001);
		}
	});
});
