/**
 * Grades one manual human poker decision for the hand recap: sharp, ok or miss.
 * Pure policy only — the caller supplies the numbers. `equity` comes from
 * `estimateVisibleEquity`, which is an approximation of what is visible, not
 * solved equity; grades are review feedback, not coaching.
 *
 * Checks never reach the grader: a check is free, so the caller simply does
 * not record a decision for one (no runtime null path here).
 */

import type { RecapAction } from './handRecap';

/** Feedback tier for one manual decision. */
export type DecisionGrade = 'sharp' | 'ok' | 'miss';

export interface DecisionInput {
	/** Checks are excluded at compile time; they are the caller's concern. */
	action: Exclude<RecapAction, 'check'>;
	/** Estimated visible equity, 0..1. */
	equity: number;
	/** Pot odds as calculated by the HUD-equivalent caller. */
	potOdds: number;
	/** Chips needed to call; 0 means folding was free (always miss). */
	callAmount: number;
}

// Grade thresholds in basis points (1 bp = 1/100 of a percent), kept
// together; not user settings. Whole basis points keep the inclusive edges
// exact — summed fractional margins like `potOdds + 0.05` would leave the
// boundary grades to binary rounding noise.
const CALL_SHARP_MARGIN_BPS = 500;
const CALL_OK_MARGIN_BPS = 500;
const FOLD_MISS_MARGIN_BPS = 1000;
const RAISE_SHARP_BPS = 5500;
const RAISE_OK_BPS = 3500;

const toBasisPoints = (fraction: number) => Math.round(fraction * 10_000);

export function gradeDecision({
	action,
	equity,
	potOdds,
	callAmount,
}: DecisionInput): DecisionGrade {
	const equityBps = toBasisPoints(equity);
	const potOddsBps = toBasisPoints(potOdds);
	if (action === 'fold') {
		// Free-fold guard first: checking is free, so folding away is a miss
		// before any odds comparison (callers may pass a fallback potOdds here).
		if (callAmount === 0) return 'miss';
		if (equityBps < potOddsBps) return 'sharp';
		if (equityBps <= potOddsBps + FOLD_MISS_MARGIN_BPS) return 'ok';
		return 'miss';
	}
	if (action === 'raise') {
		if (equityBps >= RAISE_SHARP_BPS) return 'sharp';
		if (equityBps >= RAISE_OK_BPS) return 'ok';
		return 'miss';
	}
	if (equityBps >= potOddsBps + CALL_SHARP_MARGIN_BPS) return 'sharp';
	if (equityBps >= potOddsBps - CALL_OK_MARGIN_BPS) return 'ok';
	return 'miss';
}
