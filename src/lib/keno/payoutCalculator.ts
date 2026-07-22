// src/lib/keno/payoutCalculator.ts
import { KENO_DRAW_SIZE, KENO_POOL, PAYTABLE } from './constants';
import { countHits } from './selection';
import type { DrawEvaluation } from './types';

function binomial(n: number, k: number): number {
	if (k < 0 || k > n) return 0;
	let r = 1;
	for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1);
	return r;
}

export function evaluateDraw(
	picks: readonly number[],
	drawn: readonly number[],
	bet: number,
): DrawEvaluation {
	const hits = countHits(picks, drawn);
	const hitCount = hits.length;
	const spots = picks.length;
	const multiplier = PAYTABLE[spots]?.[hitCount] ?? 0;
	const payout = multiplier * bet;
	return { hits, hitCount, multiplier, payout };
}

// RTP = Σ_k P(catch k of `spots` | 20 drawn from 80) × multiplier(k).
// P(catch k) = C(20,k)·C(60,spots−k) / C(80,spots). Computed with floats; the magnitude
// is small enough that float error is negligible vs the [0.55,0.95] bounds.
export function computeRtp(spots: number): number {
	const denom = binomial(KENO_POOL, spots);
	const tiers = PAYTABLE[spots] ?? {};
	let rtp = 0;
	for (let k = 0; k <= spots; k++) {
		const p =
			(binomial(KENO_DRAW_SIZE, k) * binomial(KENO_POOL - KENO_DRAW_SIZE, spots - k)) / denom;
		rtp += p * (tiers[k] ?? 0);
	}
	return rtp;
}
