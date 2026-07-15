import type { BetType } from './types';

export const WHEEL_ORDER = [
	0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14,
	31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26,
] as const;

export const RED_NUMBERS = new Set([
	1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36,
]);

export const BLACK_NUMBERS = new Set([
	2, 4, 6, 8, 10, 11, 13, 15, 17, 20, 22, 24, 26, 28, 29, 31, 33, 35,
]);

export const PAYOUT_MULTIPLIERS: Record<BetType, number> = {
	straight: 35,
	red: 1,
	black: 1,
	odd: 1,
	even: 1,
	low: 1,
	high: 1,
	dozen: 2,
	column: 2,
};

export const CHIP_DENOMINATIONS = [1, 5, 10, 25, 50, 100];

export const MIN_BET = 1;
export const MAX_BET_PER_POSITION = 500;
export const MAX_TOTAL_BET = 5000;
export const MAX_ROUND_HISTORY = 20;
export const MAX_BETS = 64;

// Audit safety limits for net delta per spin. These are unreachable under
// normal play (MAX_TOTAL_BET=5000 caps actual loss; max straight payout is
// 17500) but act as a backstop against logic bugs or tampering.
export const ROULETTE_MAX_WIN = 50000;
export const ROULETTE_MAX_LOSS = 10000;

// Wheel spin animation duration in milliseconds. Must match the CSS
// transition duration in src/pages/games/roulette.astro (SPIN_ANIMATION_MS / 1000).
export const SPIN_ANIMATION_MS = 4000;
