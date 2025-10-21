/**
 * Pot calculation utilities
 */

import type { Player } from './types';

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
