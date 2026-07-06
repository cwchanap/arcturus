import { describe, expect, test } from 'bun:test';
import { ReelManager } from './ReelManager';
import { NUM_REELS, NUM_ROWS, SYMBOL_ORDER, SYMBOLS } from './constants';
import type { SymbolId } from './types';

function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

describe('ReelManager', () => {
	test('produces a 5x3 grid of valid symbols', () => {
		const reels = new ReelManager();
		const grid = reels.spin();
		expect(grid).toHaveLength(NUM_REELS);
		const valid = new Set<SymbolId>(SYMBOL_ORDER);
		for (const column of grid) {
			expect(column).toHaveLength(NUM_ROWS);
			for (const sym of column) {
				expect(valid.has(sym)).toBe(true);
			}
		}
	});

	test('is deterministic with a seeded RNG', () => {
		const reels = new ReelManager();
		const a = reels.spin(mulberry32(42));
		const b = reels.spin(mulberry32(42));
		expect(b).toEqual(a);
	});

	test('distribution matches weights within tolerance over 50k spins', () => {
		const reels = new ReelManager();
		const rng = mulberry32(7);
		const counts: Record<string, number> = {};
		let total = 0;
		for (let i = 0; i < 50_000; i++) {
			const grid = reels.spin(rng);
			for (const column of grid) {
				for (const sym of column) {
					counts[sym] = (counts[sym] ?? 0) + 1;
					total++;
				}
			}
		}
		for (const id of SYMBOL_ORDER) {
			const expected = SYMBOLS[id].weight / 100;
			const actual = counts[id] / total;
			expect(Math.abs(actual - expected)).toBeLessThan(0.01);
		}
	});
});
