// src/lib/keno/DrawManager.test.ts
import { describe, expect, spyOn, test } from 'bun:test';
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
	test('default path retries rejected crypto bytes before using accepted values', () => {
		const values = [255, ...Array.from({ length: KENO_DRAW_SIZE }, (_, i) => i)];
		let readIndex = 0;
		const cryptoSpy = spyOn(globalThis.crypto, 'getRandomValues').mockImplementation((array) => {
			const bytes = array as Uint8Array;
			bytes[0] = values[readIndex++];
			return array;
		});

		try {
			const drawn = new DrawManager().draw();
			expect(drawn).toEqual(Array.from({ length: KENO_DRAW_SIZE }, (_, i) => i + 1));
			expect(cryptoSpy).toHaveBeenCalledTimes(KENO_DRAW_SIZE + 1);
		} finally {
			cryptoSpy.mockRestore();
		}
	});
	test('falls back to Math.random when crypto.getRandomValues is unavailable', () => {
		const originalCrypto = globalThis.crypto;
		// Temporarily remove crypto to exercise the Math.random fallback branch.
		Object.defineProperty(globalThis, 'crypto', {
			value: undefined,
			configurable: true,
		});
		const randomSpy = spyOn(Math, 'random').mockReturnValue(0);
		try {
			const drawn = new DrawManager().draw();
			expect(drawn).toHaveLength(KENO_DRAW_SIZE);
			expect(new Set(drawn).size).toBe(KENO_DRAW_SIZE);
			expect(randomSpy).toHaveBeenCalled();
		} finally {
			randomSpy.mockRestore();
			Object.defineProperty(globalThis, 'crypto', {
				value: originalCrypto,
				configurable: true,
			});
		}
	});
});
