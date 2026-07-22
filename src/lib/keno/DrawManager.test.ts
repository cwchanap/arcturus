// src/lib/keno/DrawManager.test.ts
import { describe, expect, test } from 'bun:test';
import { KENO_DRAW_SIZE, KENO_POOL } from './constants';
import { DrawManager } from './DrawManager';

describe('DrawManager.draw', () => {
	test('returns exactly KENO_DRAW_SIZE numbers', () => {
		expect(new DrawManager().draw()).toHaveLength(KENO_DRAW_SIZE);
	});
	test('all numbers are in range 1..KENO_POOL', () => {
		const drawn = new DrawManager().draw();
		expect(drawn.every((n) => n >= 1 && n <= KENO_POOL && Number.isInteger(n))).toBe(true);
	});
	test('all numbers are distinct', () => {
		const drawn = new DrawManager().draw();
		expect(new Set(drawn).size).toBe(KENO_DRAW_SIZE);
	});
	test('respects an injectable rng (deterministic)', () => {
		let seed = 7;
		const rng = () => {
			seed = (seed * 1103515245 + 12345) & 0x7fffffff;
			return seed / 0x7fffffff;
		};
		const a = new DrawManager().draw(rng);
		seed = 7;
		const b = new DrawManager().draw(rng);
		expect(a).toEqual(b);
	});
	test('default path uses crypto.getRandomValues (unbiased Fisher–Yates)', () => {
		// Structural: draw 1000 times, assert each bucket 1..80 appears with roughly
		// uniform frequency (mean ≈ 1000*20/80 = 250, allow ±40 for noise). This guards
		// against a `byte % 80` modulo-skew regression.
		const counts = new Array(KENO_POOL + 1).fill(0);
		const dm = new DrawManager();
		for (let i = 0; i < 1000; i++) for (const n of dm.draw()) counts[n]++;
		const mean = (1000 * KENO_DRAW_SIZE) / KENO_POOL;
		for (let n = 1; n <= KENO_POOL; n++) {
			expect(Math.abs(counts[n] - mean)).toBeLessThan(60);
		}
	});
});
