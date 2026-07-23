// src/lib/keno/constants.ts

import type { AnimationSpeed, KenoSettings } from './types';

export const MIN_SPOTS = 1;
export const MAX_SPOTS = 10;
export const KENO_POOL = 80; // numbers 1..80
export const KENO_DRAW_SIZE = 20;

export const MIN_BET = 1;
export const MAX_BET = 5;
export const MAX_HISTORY = 20;

export const BET_INCREMENTS = [1, 2, 3, 5] as const;

export const PAYTABLE_VERSION = '2026-07-standard-v1';

// PAYTABLE[spots][catch] = multiplier (per 1-unit bet; payout = multiplier × bet).
// RTP verified by payoutCalculator.test.ts (computeRtp) — see spec §Paytable.
// 10-spot: 5→5, 6→25, 7→120, 8→500, 9→4000, 10→50000  (RTP 83.53%, no catch-0 bonus).
export const PAYTABLE: Readonly<Record<number, Readonly<Record<number, number>>>> = {
	1: { 1: 3 },
	2: { 2: 12 },
	3: { 3: 45, 2: 2 },
	4: { 4: 130, 3: 5, 2: 1 },
	5: { 5: 500, 4: 20, 3: 2 },
	6: { 6: 1500, 5: 50, 4: 7, 3: 1 },
	7: { 7: 5000, 6: 150, 5: 15, 4: 2, 3: 1 },
	8: { 8: 15000, 7: 400, 6: 50, 5: 10, 4: 2 },
	9: { 9: 25000, 8: 2000, 7: 200, 6: 30, 5: 8, 4: 2 },
	10: { 10: 50000, 9: 4000, 8: 500, 7: 120, 6: 25, 5: 5 },
};

export const ANIMATION_DELAY_MS: Record<AnimationSpeed, number> = {
	slow: 2000,
	normal: 1500,
	fast: 800,
};

// Per-cell reveal stagger. Scaled to animationSpeed so the full reveal
// (20 cells × stagger) fits within ANIMATION_DELAY_MS for each speed tier.
// 19 × stagger < ANIMATION_DELAY_MS: slow 90→1710<2000, normal 70→1330<1500, fast 35→665<800.
export const REVEAL_STAGGER_MS: Record<AnimationSpeed, number> = {
	slow: 90,
	normal: 70,
	fast: 35,
};

export const DEFAULT_SETTINGS: KenoSettings = {
	animationSpeed: 'normal',
};
