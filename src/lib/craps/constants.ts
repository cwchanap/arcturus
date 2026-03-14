/**
 * Craps game constants
 */

import type { BetType, CrapsSettings, PointNumber } from './types';

export const DEFAULT_MIN_BET = 5;
export const DEFAULT_MAX_BET = 500;
export const DEFAULT_MAX_ODDS_MULTIPLIER = 2; // 2x odds on line bets

export const MAX_ROLL_HISTORY = 30;

// Dice total groupings
export const NATURALS = new Set([7, 11]);
export const CRAPS_NUMBERS = new Set([2, 3, 12]);
export const POINT_NUMBERS = new Set<number>([4, 5, 6, 8, 9, 10]);

// Place bet payout ratios [numerator, denominator]
export const PLACE_PAYOUTS: Record<number, [number, number]> = {
	4: [9, 5],
	5: [7, 5],
	6: [7, 6],
	8: [7, 6],
	9: [7, 5],
	10: [9, 5],
};

// Pass Line Odds payout ratios (true odds)
export const PASS_ODDS_RATIOS: Record<PointNumber, [number, number]> = {
	4: [2, 1],
	5: [3, 2],
	6: [6, 5],
	8: [6, 5],
	9: [3, 2],
	10: [2, 1],
};

// Don't Pass Odds payout ratios (lay odds — paying true odds)
export const DONT_PASS_ODDS_RATIOS: Record<PointNumber, [number, number]> = {
	4: [1, 2],
	5: [2, 3],
	6: [5, 6],
	8: [5, 6],
	9: [2, 3],
	10: [1, 2],
};

// Buy/Lay vig (5%)
export const VIG = 0.05;

// Buy bet payouts (true odds × (1 - vig))
export const BUY_PAYOUTS: Record<number, [number, number]> = {
	4: [19, 10], // 2:1 * 0.95 ≈ 1.9:1
	5: [57, 40], // 1.5 * 0.95 = 1.425
	6: [57, 50], // 1.2 * 0.95 = 1.14
	8: [57, 50],
	9: [57, 40],
	10: [19, 10],
};

// Lay bet payouts (lay true odds × (1 - vig))
export const LAY_PAYOUTS: Record<number, [number, number]> = {
	4: [19, 40], // 0.5 * 0.95 = 0.475
	5: [19, 30], // (2/3) * 0.95 ≈ 0.633
	6: [19, 24], // (5/6) * 0.95 ≈ 0.792
	8: [19, 24],
	9: [19, 30],
	10: [19, 40],
};

// Hardway payouts
export const HARDWAY_PAYOUTS: Record<number, number> = {
	4: 7,
	6: 9,
	8: 9,
	10: 7,
};

// Prop bet payouts
export const PROP_PAYOUTS = {
	any7: 4,
	anyCraps: 7,
	aceDeuce: 15, // 3
	aces: 30, // 2
	boxcars: 30, // 12
	yo: 15, // 11
	ceCraps: 3, // C&E craps portion
	ceYo: 7, // C&E yo portion
} as const;

// Field bet payouts
export const FIELD_WIN_NUMBERS = new Set([3, 4, 9, 10, 11]);
export const FIELD_DOUBLE_NUMBERS = new Set([2]);
export const FIELD_TRIPLE_NUMBERS = new Set([12]);

// Bets that are turned off during come-out phase
export const OFF_DURING_COME_OUT = new Set([
	'place4',
	'place5',
	'place6',
	'place8',
	'place9',
	'place10',
	'buy4',
	'buy5',
	'buy6',
	'buy8',
	'buy9',
	'buy10',
	'lay4',
	'lay5',
	'lay6',
	'lay8',
	'lay9',
	'lay10',
	'hard4',
	'hard6',
	'hard8',
	'hard10',
]);

// Bets only allowed during come-out phase
export const COME_OUT_ONLY_BETS = new Set(['passLine', 'dontPass']);

// Bets only allowed during point phase
export const POINT_PHASE_ONLY_BETS = new Set(['come', 'dontCome', 'passLineOdds', 'dontPassOdds']);

// Persisted bets may only carry embedded odds on line and established come bets.
export const ODDS_ELIGIBLE_BET_TYPES = new Set<BetType>([
	'passLine',
	'dontPass',
	'come',
	'dontCome',
]);

// Display labels for all bet types
export const BET_LABELS: Record<string, string> = {
	passLine: 'Pass Line',
	dontPass: "Don't Pass",
	passLineOdds: 'Pass Odds',
	dontPassOdds: "Don't Pass Odds",
	come: 'Come',
	dontCome: "Don't Come",
	place4: 'Place 4',
	place5: 'Place 5',
	place6: 'Place 6',
	place8: 'Place 8',
	place9: 'Place 9',
	place10: 'Place 10',
	field: 'Field',
	big6: 'Big 6',
	big8: 'Big 8',
	buy4: 'Buy 4',
	buy5: 'Buy 5',
	buy6: 'Buy 6',
	buy8: 'Buy 8',
	buy9: 'Buy 9',
	buy10: 'Buy 10',
	lay4: 'Lay 4',
	lay5: 'Lay 5',
	lay6: 'Lay 6',
	lay8: 'Lay 8',
	lay9: 'Lay 9',
	lay10: 'Lay 10',
	hard4: 'Hard 4',
	hard6: 'Hard 6',
	hard8: 'Hard 8',
	hard10: 'Hard 10',
	any7: 'Any 7',
	anyCraps: 'Any Craps',
	aceDeuce: 'Ace Deuce (3)',
	aces: 'Aces (2)',
	boxcars: 'Boxcars (12)',
	yo: 'Yo (11)',
	ce: 'C & E',
};

export const DEFAULT_SETTINGS: CrapsSettings = {
	minBet: DEFAULT_MIN_BET,
	maxBet: DEFAULT_MAX_BET,
	maxOddsMultiplier: DEFAULT_MAX_ODDS_MULTIPLIER,
	animationSpeed: 'normal',
	llmEnabled: false,
	soundEnabled: true,
};
