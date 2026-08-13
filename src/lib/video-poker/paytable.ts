import type { HandCategory, PayingHandCategory } from './types';

export const MIN_WAGER = 1;
export const MAX_WAGER = 5;
export const WAGER_OPTIONS = [1, 2, 3, 4, 5] as const;

const PAYOUT_PER_CHIP: Readonly<Record<PayingHandCategory, number>> = {
	'royal-flush': 250,
	'straight-flush': 50,
	'four-of-kind': 25,
	'full-house': 9,
	flush: 6,
	straight: 4,
	'three-of-kind': 3,
	'two-pair': 2,
	'jacks-or-better': 1,
};

export const PAYTABLE_ROWS = [
	['Royal Flush', '250× / 4,000 at 5 chips'],
	['Straight Flush', '50×'],
	['Four of a Kind', '25×'],
	['Full House', '9×'],
	['Flush', '6×'],
	['Straight', '4×'],
	['Three of a Kind', '3×'],
	['Two Pair', '2×'],
	['Jacks or Better', '1×'],
] as const;

export function calculatePayout(category: HandCategory, wager: number): number {
	if (!Number.isInteger(wager) || wager < MIN_WAGER || wager > MAX_WAGER) {
		throw new RangeError('Wager must be a whole number from 1 through 5 chips');
	}
	if (category === 'nothing') return 0;
	if (category === 'royal-flush' && wager === 5) return 4000;
	return PAYOUT_PER_CHIP[category] * wager;
}
