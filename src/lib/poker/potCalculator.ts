/**
 * Pot calculation utilities
 */

import type { Card, Player } from './types';

/**
 * Calculates the total pot from all player bets
 */
export function calculatePot(players: Player[]): number {
	return players.reduce((total, player) => total + player.totalBet, 0);
}

/**
 * Calculates the current round pot (from currentBet, not totalBet)
 */
export function calculateRoundPot(players: Player[]): number {
	return players.reduce((total, player) => total + player.currentBet, 0);
}

/**
 * Distributes pot to winners, ensuring all chips are awarded
 * Remainder chips go to first winner(s) in array order
 */
export function distributePot(winners: Player[], pot: number): Map<number, number> {
	const distribution = new Map<number, number>();
	const baseShare = Math.floor(pot / winners.length);
	const remainder = pot % winners.length;

	for (let i = 0; i < winners.length; i++) {
		// First 'remainder' winners get an extra chip
		const share = baseShare + (i < remainder ? 1 : 0);
		distribution.set(winners[i].id, share);
	}

	return distribution;
}

/**
 * Handles side pots for all-in scenarios
 * Returns main pot and array of side pots with eligible players
 */
export function calculateSidePots(
	players: Player[],
): Array<{ amount: number; eligiblePlayerIds: number[] }> {
	const pots: Array<{ amount: number; eligiblePlayerIds: number[] }> = [];

	// Get all players sorted by their total bet amount
	const sortedPlayers = [...players].sort((a, b) => a.totalBet - b.totalBet);

	let remainingPlayers = [...players];
	let previousBet = 0;

	for (const player of sortedPlayers) {
		if (remainingPlayers.length === 0) break;

		const betLevel = player.totalBet;
		if (betLevel === previousBet) continue;

		const potAmount = remainingPlayers.reduce((sum, p) => {
			const contribution = Math.min(p.totalBet, betLevel) - previousBet;
			return sum + contribution;
		}, 0);

		if (potAmount > 0) {
			pots.push({
				amount: potAmount,
				eligiblePlayerIds: remainingPlayers.filter((p) => !p.folded).map((p) => p.id),
			});
		}

		previousBet = betLevel;

		// Remove players who are all-in at this level
		remainingPlayers = remainingPlayers.filter((p) => p.totalBet > betLevel);
	}

	return pots;
}

/**
 * Gets the minimum bet required (max of big blind or last raise)
 */
export function getMinimumBet(bigBlind: number, lastRaiseAmount: number): number {
	return Math.max(bigBlind, lastRaiseAmount);
}

/**
 * Winner-determiner callback used by resolveSidePotAwards.
 * Decoupled from handEvaluator so potCalculator stays dependency-free.
 */
export type WinnerDeterminer = (eligiblePlayers: Player[], communityCards: Card[]) => Player[];

/**
 * Per-tier showdown result. `winners` is the list of players who tied for
 * THIS tier (length > 1 means a genuine split of `amount`); different tiers
 * may have disjoint winners when a short all-in wins the main pot and a
 * covering player wins the side pot.
 */
export interface TierResult {
	amount: number;
	winners: Player[];
}

/**
 * Resolves a showdown using side-pot eligibility. Each pot tier is awarded
 * only to the best hand(s) among the non-folded players eligible for that
 * tier, so a short all-in can never win chips from bets it did not cover.
 *
 * Returns:
 *  - `awards`: per-player chip map (playerId -> chips to add)
 *  - `tierWinners`: deduped list of players who won at least one tier
 *    (for hand-reveal UI highlighting)
 *  - `tierResults`: one entry per resolved pot tier with its amount and
 *    winners, so callers can distinguish a genuine split-pot tie (multiple
 *    winners within one tier) from separate winners of different tiers.
 */
export function resolveSidePotAwards(
	players: Player[],
	communityCards: Card[],
	determineWinners: WinnerDeterminer,
): { awards: Map<number, number>; tierWinners: Player[]; tierResults: TierResult[] } {
	const activePlayers = players.filter((p) => !p.folded);
	const pots = calculateSidePots(players);
	const awards = new Map<number, number>();
	const tierWinners: Player[] = [];
	const tierResults: TierResult[] = [];

	for (const pot of pots) {
		const eligible = activePlayers.filter((p) => pot.eligiblePlayerIds.includes(p.id));
		if (eligible.length === 0) continue;
		const winners = determineWinners(eligible, communityCards);
		for (const w of winners) {
			if (!tierWinners.some((p) => p.id === w.id)) tierWinners.push(w);
		}
		tierResults.push({ amount: pot.amount, winners });
		const distribution = distributePot(winners, pot.amount);
		for (const [playerId, amount] of distribution.entries()) {
			awards.set(playerId, (awards.get(playerId) ?? 0) + amount);
		}
	}

	return { awards, tierWinners, tierResults };
}
