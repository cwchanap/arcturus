/**
 * Payout calculation for Baccarat bets
 * Implements standard casino payout multipliers
 */

import type { Bet, BetResult, BetType, RoundOutcome, Winner } from './types';
import { PAYOUTS } from './constants';

/**
 * Calculate the payout for a single bet based on round outcome
 * Returns BetResult with outcome and payout amount
 */
export function calculatePayout(bet: Bet, outcome: RoundOutcome): BetResult {
	const { winner, playerPair, bankerPair } = outcome;

	switch (bet.type) {
		case 'player':
			return calculateMainBetPayout(bet, winner, 'player');

		case 'banker':
			return calculateBankerBetPayout(bet, winner);

		case 'tie':
			return calculateTieBetPayout(bet, winner);

		case 'playerPair':
			return calculatePairBetPayout(bet, playerPair);

		case 'bankerPair':
			return calculatePairBetPayout(bet, bankerPair);

		default:
			// TypeScript should prevent this, but handle gracefully
			return { bet, outcome: 'lose', payout: -bet.amount };
	}
}

/**
 * Calculate payout for Player bet
 * Win: 1:1, Tie: Push, Lose: -bet
 */
function calculateMainBetPayout(bet: Bet, winner: Winner, target: 'player'): BetResult {
	if (winner === target) {
		// Win: 1:1 payout
		return { bet, outcome: 'win', payout: Math.trunc(bet.amount * PAYOUTS.player) };
	}
	if (winner === 'tie') {
		// Push: bet returned
		return { bet, outcome: 'push', payout: 0 };
	}
	// Lose
	return { bet, outcome: 'lose', payout: -bet.amount };
}

/**
 * Calculate payout for Banker bet
 * Win: 0.95:1 (5% commission), Tie: Push, Lose: -bet
 */
function calculateBankerBetPayout(bet: Bet, winner: Winner): BetResult {
	if (winner === 'banker') {
		// Win: 0.95:1 (5% commission)
		// Keep chip balances integral: commission can create fractional chip winnings.
		return { bet, outcome: 'win', payout: Math.trunc(bet.amount * PAYOUTS.banker) };
	}
	if (winner === 'tie') {
		// Push: bet returned
		return { bet, outcome: 'push', payout: 0 };
	}
	// Lose
	return { bet, outcome: 'lose', payout: -bet.amount };
}

/**
 * Calculate payout for Tie bet
 * Win: 8:1, Lose: -bet (no push)
 */
function calculateTieBetPayout(bet: Bet, winner: Winner): BetResult {
	if (winner === 'tie') {
		// Win: 8:1 payout
		return { bet, outcome: 'win', payout: Math.trunc(bet.amount * PAYOUTS.tie) };
	}
	// Lose (no push on tie bets)
	return { bet, outcome: 'lose', payout: -bet.amount };
}

/**
 * Calculate payout for Pair bets (Player Pair or Banker Pair)
 * Win: 11:1, Lose: -bet
 */
function calculatePairBetPayout(bet: Bet, isPair: boolean): BetResult {
	if (isPair) {
		// Win: 11:1 payout
		const multiplier = bet.type === 'playerPair' ? PAYOUTS.playerPair : PAYOUTS.bankerPair;
		return { bet, outcome: 'win', payout: Math.trunc(bet.amount * multiplier) };
	}
	// Lose
	return { bet, outcome: 'lose', payout: -bet.amount };
}

/**
 * Calculate total payout for all bets in a round
 * Returns the net change in chip balance
 */
export function calculateTotalPayout(bets: Bet[], outcome: RoundOutcome): number {
	return bets.reduce((total, bet) => {
		const result = calculatePayout(bet, outcome);
		return total + result.payout;
	}, 0);
}

/**
 * Calculate all bet results for a round
 */
export function calculateAllPayouts(bets: Bet[], outcome: RoundOutcome): BetResult[] {
	return bets.map((bet) => calculatePayout(bet, outcome));
}

/**
 * Get the payout multiplier for a bet type
 */
export function getPayoutMultiplier(betType: BetType): number {
	return PAYOUTS[betType];
}

/**
 * Get a human-readable payout description
 */
export function getPayoutDescription(betType: BetType): string {
	switch (betType) {
		case 'player':
			return '1:1';
		case 'banker':
			return '0.95:1 (5% commission)';
		case 'tie':
			return '8:1';
		case 'playerPair':
		case 'bankerPair':
			return '11:1';
	}
}

/**
 * Calculate potential winnings for a bet amount and type
 * Does not include the original bet, just the profit
 */
export function calculatePotentialWinnings(amount: number, betType: BetType): number {
	return Math.trunc(amount * PAYOUTS[betType]);
}

/**
 * Validate bet amount against outcome for auditing
 * Returns true if the payout calculation is correct
 */
export function validatePayout(bet: Bet, outcome: RoundOutcome, expectedPayout: number): boolean {
	const result = calculatePayout(bet, outcome);
	return Math.abs(result.payout - expectedPayout) < 0.01; // Allow for floating point errors
}
