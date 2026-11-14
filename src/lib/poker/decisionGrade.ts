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

// Grade thresholds as fractions, kept together; not user settings.
const CALL_SHARP_MARGIN = 0.05;
const CALL_OK_MARGIN = 0.05;
const FOLD_MISS_MARGIN = 0.1;
const RAISE_SHARP = 0.55;
const RAISE_OK = 0.35;

export function gradeDecision({
	action,
	equity,
	potOdds,
	callAmount,
}: DecisionInput): DecisionGrade {
	if (action === 'fold') {
		// Free-fold guard first: checking is free, so folding away is a miss
		// before any odds comparison (callers may pass a fallback potOdds here).
		if (callAmount === 0) return 'miss';
		if (equity < potOdds) return 'sharp';
		if (equity <= potOdds + FOLD_MISS_MARGIN) return 'ok';
		return 'miss';
	}
	if (action === 'raise') {
		if (equity >= RAISE_SHARP) return 'sharp';
		if (equity >= RAISE_OK) return 'ok';
		return 'miss';
	}
	if (equity >= potOdds + CALL_SHARP_MARGIN) return 'sharp';
	if (equity >= potOdds - CALL_OK_MARGIN) return 'ok';
	return 'miss';
}
