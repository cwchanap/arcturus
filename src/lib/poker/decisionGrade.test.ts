import { describe, expect, test } from 'bun:test';
import { gradeDecision } from './decisionGrade';
import type { RecapAction } from './handRecap';

// Boundary examples use fractions that survive binary floating point: the
// boundary expressions mirror the grader's own arithmetic (potOdds ± margin),
// so equality at an inclusive edge is exact, not approximate.
const ODDS = 0.25;

describe('gradeDecision calls', () => {
	test('sharp when equity is at least potOdds + 5 points', () => {
		expect(gradeDecision({ action: 'call', equity: 0.31, potOdds: ODDS, callAmount: 20 })).toBe(
			'sharp',
		);
		expect(
			gradeDecision({ action: 'call', equity: ODDS + 0.05, potOdds: ODDS, callAmount: 20 }),
		).toBe('sharp');
	});

	test('ok across the ±5-point band around potOdds, edges inclusive', () => {
		expect(gradeDecision({ action: 'call', equity: 0.22, potOdds: ODDS, callAmount: 20 })).toBe(
			'ok',
		);
		expect(
			gradeDecision({ action: 'call', equity: ODDS - 0.05, potOdds: ODDS, callAmount: 20 }),
		).toBe('ok');
		expect(
			gradeDecision({ action: 'call', equity: ODDS + 0.049, potOdds: ODDS, callAmount: 20 }),
		).toBe('ok');
	});

	test('miss below potOdds - 5 points', () => {
		expect(gradeDecision({ action: 'call', equity: 0.15, potOdds: ODDS, callAmount: 20 })).toBe(
			'miss',
		);
	});
});

describe('gradeDecision folds facing a bet', () => {
	test('sharp when equity is strictly below potOdds', () => {
		expect(gradeDecision({ action: 'fold', equity: 0.2, potOdds: ODDS, callAmount: 20 })).toBe(
			'sharp',
		);
	});

	test('ok from potOdds up through potOdds + 10 points, both edges inclusive', () => {
		expect(gradeDecision({ action: 'fold', equity: ODDS, potOdds: ODDS, callAmount: 20 })).toBe(
			'ok',
		);
		// The 5–10-point gap above odds is explicitly ok, not miss.
		expect(gradeDecision({ action: 'fold', equity: 0.32, potOdds: ODDS, callAmount: 20 })).toBe(
			'ok',
		);
		expect(
			gradeDecision({ action: 'fold', equity: ODDS + 0.1, potOdds: ODDS, callAmount: 20 }),
		).toBe('ok');
	});

	test('miss only above potOdds + 10 points', () => {
		expect(gradeDecision({ action: 'fold', equity: 0.4, potOdds: ODDS, callAmount: 20 })).toBe(
			'miss',
		);
	});
});

describe('gradeDecision free folds', () => {
	test('always miss, before any odds comparison', () => {
		// Grader-only potOdds fallback of 1 (the caller never persists or shows it);
		// without the callAmount === 0 guard this equity would grade sharp.
		expect(gradeDecision({ action: 'fold', equity: 0.9, potOdds: 1, callAmount: 0 })).toBe('miss');
		expect(gradeDecision({ action: 'fold', equity: 0, potOdds: 1, callAmount: 0 })).toBe('miss');
	});
});

describe('gradeDecision raises', () => {
	// Raises ignore potOdds; callers may pass the numeric fallback for open raises.
	const openRaise = (equity: number) =>
		({ action: 'raise', equity, potOdds: 1, callAmount: 0 }) as const;

	test('sharp at 55% equity and above, edge inclusive', () => {
		expect(gradeDecision(openRaise(0.6))).toBe('sharp');
		expect(gradeDecision(openRaise(0.55))).toBe('sharp');
	});

	test('ok from 35% up to just under 55%, edge inclusive', () => {
		expect(gradeDecision(openRaise(0.45))).toBe('ok');
		expect(gradeDecision(openRaise(0.35))).toBe('ok');
	});

	test('miss below 35%', () => {
		expect(gradeDecision(openRaise(0.3))).toBe('miss');
	});
});

describe('gradeDecision check exclusion', () => {
	test('only fold, call and raise are gradeable; checks stay with the caller', () => {
		// Compile-time proof: this assignment must be a type error, because a check
		// is free and never reaches the grader (there is no runtime null path).
		// @ts-expect-error — 'check' is excluded from gradeDecision's action type
		const _checkNeverGrades: Parameters<typeof gradeDecision>[0]['action'] = 'check';
		const gradeable: Array<Exclude<RecapAction, 'check'>> = ['fold', 'call', 'raise'];
		expect(gradeable).toHaveLength(3);
	});
});
