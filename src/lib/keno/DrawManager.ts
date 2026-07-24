// src/lib/keno/DrawManager.ts
import { KENO_DRAW_SIZE, KENO_POOL } from './constants';
import type { Rng } from './selection';

// Default RNG: unbiased uniform integers in [0, n) from crypto.getRandomValues.
// Uses rejection sampling on the 8-bit byte to avoid modulo skew (byte % n is biased
// for n not a power of 2). Falls back to Math.random only if crypto is unavailable.
function cryptoUniformInt(n: number): number {
	const max = Math.floor(0x100 / n) * n; // largest multiple of n <= 256 (byte range is 0–255)
	const buf = new Uint8Array(1);
	const cryptoObj = globalThis.crypto;
	if (!cryptoObj?.getRandomValues) return Math.floor(Math.random() * n);
	let byte: number;
	do {
		cryptoObj.getRandomValues(buf);
		byte = buf[0];
	} while (byte >= max);
	return byte % n;
}

export class DrawManager {
	// Fisher–Yates partial shuffle over 1..KENO_POOL; return first KENO_DRAW_SIZE sorted.
	draw(rng: Rng | null = null): number[] {
		const pool = Array.from({ length: KENO_POOL }, (_, i) => i + 1);
		const pick = (i: number) => (rng ? Math.floor(rng() * (i + 1)) : cryptoUniformInt(i + 1));
		for (let i = pool.length - 1; i > pool.length - 1 - KENO_DRAW_SIZE; i--) {
			const j = pick(i);
			[pool[i], pool[j]] = [pool[j], pool[i]];
		}
		const drawn = pool.slice(pool.length - KENO_DRAW_SIZE);
		return drawn.sort((a, b) => a - b);
	}
}
