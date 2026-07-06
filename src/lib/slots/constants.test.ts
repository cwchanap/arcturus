import { describe, expect, test } from 'bun:test';
import {
	BET_INCREMENTS,
	MAX_BET,
	MAX_HISTORY,
	MIN_BET,
	NUM_PAYLINES,
	NUM_REELS,
	NUM_ROWS,
	PAYLINES,
	PAYTABLE,
	SYMBOL_ORDER,
	SYMBOLS,
} from './constants';

describe('slots constants', () => {
	test('reel and payline geometry', () => {
		expect(NUM_REELS).toBe(5);
		expect(NUM_ROWS).toBe(3);
		expect(NUM_PAYLINES).toBe(5);
		expect(PAYLINES).toHaveLength(5);
		for (const line of PAYLINES) {
			expect(line).toHaveLength(NUM_REELS);
			for (const row of line) {
				expect(row).toBeGreaterThanOrEqual(0);
				expect(row).toBeLessThan(NUM_ROWS);
			}
		}
	});

	test('symbol weights sum to 100 and cover SYMBOL_ORDER', () => {
		const total = SYMBOL_ORDER.reduce((sum, id) => sum + SYMBOLS[id].weight, 0);
		expect(total).toBe(100);
		for (const id of SYMBOL_ORDER) {
			expect(SYMBOLS[id].weight).toBeGreaterThan(0);
		}
	});

	test('every paytable value is a multiple of NUM_PAYLINES (integer payout invariant)', () => {
		for (const id of SYMBOL_ORDER) {
			const tier = PAYTABLE[id];
			for (const count of [3, 4, 5] as const) {
				expect(tier[count] % NUM_PAYLINES).toBe(0);
				expect(tier[count]).toBeGreaterThan(0);
			}
		}
	});

	test('paytable is ordered high-to-low across symbol order', () => {
		for (let i = 1; i < SYMBOL_ORDER.length; i++) {
			const prev = PAYTABLE[SYMBOL_ORDER[i - 1]][5];
			const curr = PAYTABLE[SYMBOL_ORDER[i]][5];
			expect(prev).toBeGreaterThan(curr);
		}
	});

	test('bet limits and increments match the spec', () => {
		expect(MIN_BET).toBe(1);
		expect(MAX_BET).toBe(100);
		expect(BET_INCREMENTS).toEqual([1, 5, 10, 25, 50, 100]);
		expect(Math.min(...BET_INCREMENTS)).toBe(MIN_BET);
		expect(Math.max(...BET_INCREMENTS)).toBe(MAX_BET);
	});

	test('history cap is positive', () => {
		expect(MAX_HISTORY).toBeGreaterThan(0);
	});
});
