// src/lib/keno/selection.ts
import { KENO_POOL, MAX_SPOTS } from './constants';
import type { KenoErrorCode } from './types';

export type Rng = () => number;

export type ValidationResult = { ok: true } | { ok: false; code: KenoErrorCode };

// Validates per-pick invariants ONLY. Accepts a 0–10 DRAFT (count bound is enforced
// at draw time as INVALID_DRAW_SELECTION, so Clear can yield an empty draft).
export function validatePicks(picks: unknown): ValidationResult {
	if (!Array.isArray(picks)) return { ok: false, code: 'INVALID_SELECTION' };
	if (picks.length > MAX_SPOTS) return { ok: false, code: 'INVALID_SELECTION' };
	const seen = new Set<number>();
	for (const p of picks) {
		if (typeof p !== 'number' || !Number.isInteger(p) || p < 1 || p > KENO_POOL) {
			return { ok: false, code: 'INVALID_SELECTION' };
		}
		if (seen.has(p)) return { ok: false, code: 'INVALID_SELECTION' };
		seen.add(p);
	}
	return { ok: true };
}

export function quickPick(count: number, rng: Rng = Math.random): number[] {
	if (!Number.isInteger(count) || count < 1 || count > MAX_SPOTS) {
		throw new Error(`quickPick count must be 1..${MAX_SPOTS}`);
	}
	// Fisher–Yates partial shuffle over 1..KENO_POOL; take first `count`.
	const pool = Array.from({ length: KENO_POOL }, (_, i) => i + 1);
	for (let i = pool.length - 1; i > pool.length - 1 - count; i--) {
		const j = Math.floor(rng() * (i + 1));
		[pool[i], pool[j]] = [pool[j], pool[i]];
	}
	const chosen = pool.slice(pool.length - count);
	return chosen.sort((a, b) => a - b);
}

export function countHits(picks: readonly number[], drawn: readonly number[]): number[] {
	const drawnSet = new Set(drawn);
	return picks.filter((p) => drawnSet.has(p));
}
