/**
 * Sic Bo payout rules
 */

import type { SicBoBet, SicBoBetKey, SicBoBetResult, SicBoRoll } from './types';

/** The only chip denominations players may bet in. */
export const SIC_BO_CHIP_DENOMINATIONS = [1, 5, 10, 25, 50, 100] as const;

/** Exact-total odds (Paytable A). Symmetric: 4/17, 5/16, 6/15, 7/14, 8/13, 9-12. */
export const TOTAL_ODDS = {
	4: 50,
	5: 18,
	6: 14,
	7: 12,
	8: 8,
	9: 6,
	10: 6,
	11: 6,
	12: 6,
	13: 8,
	14: 12,
	15: 14,
	16: 18,
	17: 50,
} as const;

const PRIMARY_BET_KEYS = new Set(['big', 'small', 'odd', 'even', 'any-triple']);
/**
 * Canonical `total:N` bet keys derived from `TOTAL_ODDS`. Membership is checked
 * as exact strings so non-canonical suffixes (`total:04`, `total:4.0`,
 * `total:4e0`, `total:0x4`, `total: 4 `) are rejected rather than coerced by
 * `Number()` into a supported total.
 */
const SUPPORTED_TOTAL_KEYS = new Set<string>(
	Object.keys(TOTAL_ODDS).map((total) => `total:${total}`),
);

/**
 * Runtime guard for Sic Bo bet keys. The `SicBoBetKey` type is a closed template
 * literal, but TypeScript types are erased at runtime and the client casts DOM
 * attributes with `as SicBoBetKey`. Forged keys such as `total:3` or `total:18`
 * would otherwise index `TOTAL_ODDS` out of bounds and produce `NaN` odds.
 */
export function isSupportedBetKey(key: string): key is SicBoBetKey {
	if (PRIMARY_BET_KEYS.has(key)) return true;
	return SUPPORTED_TOTAL_KEYS.has(key);
}

/** Odds for a bet key. Big/Small/Odd/Even pay even money. */
export function getBetOdds(key: SicBoBetKey): number {
	if (!isSupportedBetKey(key)) throw new Error(`Unsupported Sic Bo bet key: ${key}`);
	switch (key) {
		case 'big':
		case 'small':
		case 'odd':
		case 'even':
			return 1;
		case 'any-triple':
			return 24;
		default:
			return TOTAL_ODDS[Number(key.slice('total:'.length)) as keyof typeof TOTAL_ODDS];
	}
}

/** Whether a bet wins on a given roll. Big/Small/Odd/Even lose on every triple. */
export function isWinningBet(key: SicBoBetKey, roll: SicBoRoll): boolean {
	if (!isSupportedBetKey(key)) throw new Error(`Unsupported Sic Bo bet key: ${key}`);
	const [a, b, c] = roll;
	const sum = a + b + c;
	const isTriple = a === b && b === c;
	switch (key) {
		case 'big':
			return !isTriple && sum >= 11;
		case 'small':
			return !isTriple && sum <= 10;
		case 'odd':
			return !isTriple && sum % 2 === 1;
		case 'even':
			return !isTriple && sum % 2 === 0;
		case 'any-triple':
			return isTriple;
		default:
			return sum === Number(key.slice('total:'.length));
	}
}

/** Resolve a bet: gross return is amount * (odds + 1) on a win, 0 on a loss. */
export function resolveBet(bet: SicBoBet, roll: SicBoRoll): SicBoBetResult {
	const odds = getBetOdds(bet.key);
	const won = isWinningBet(bet.key, roll);
	return {
		key: bet.key,
		amount: bet.amount,
		odds,
		won,
		grossReturn: won ? bet.amount * (odds + 1) : 0,
	};
}
