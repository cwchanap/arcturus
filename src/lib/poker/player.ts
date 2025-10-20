/**
 * Player management utilities
 */

import type { Player, Card } from './types';
import { STARTING_CHIPS } from './constants';

/**
 * Creates a new player
 */
export function createPlayer(
	id: number,
	name: string,
	chips: number = STARTING_CHIPS,
	isAI: boolean = false,
): Player {
	return {
		id,
		name,
		chips,
		hand: [],
		currentBet: 0,
		totalBet: 0,
		folded: false,
		isAllIn: false,
		isDealer: false,
		isAI,
		hasActed: false,
	};
}

/**
 * Creates an AI player with personality
 */
export function createAIPlayer(id: number, name: string, chips: number = STARTING_CHIPS): Player {
	return createPlayer(id, name, chips, true);
}

/**
 * Checks if a player can act (not folded, not all-in)
 */
export function canPlayerAct(player: Player): boolean {
	return !player.folded && !player.isAllIn;
}

/**
 * Places a bet for a player
 */
export function placeBet(player: Player, amount: number): Player {
	const actualAmount = Math.min(amount, player.chips);
	const isAllIn = actualAmount === player.chips;

	return {
		...player,
		chips: player.chips - actualAmount,
		currentBet: player.currentBet + actualAmount,
		totalBet: player.totalBet + actualAmount,
		isAllIn,
		hasActed: true,
	};
}

/**
 * Posts a blind (forced bet) - doesn't set hasActed since it's automatic
 */
export function postBlind(player: Player, amount: number): Player {
	const actualAmount = Math.min(amount, player.chips);
	const isAllIn = actualAmount === player.chips;

	return {
		...player,
		chips: player.chips - actualAmount,
		currentBet: player.currentBet + actualAmount,
		totalBet: player.totalBet + actualAmount,
		isAllIn,
		hasActed: false, // Blinds don't count as voluntary action
	};
}

/**
 * Folds a player
 */
export function foldPlayer(player: Player): Player {
	return {
		...player,
		folded: true,
		hasActed: true,
	};
}

/**
 * Resets a player's hand and betting state for a new round
 */
export function resetPlayerForNewHand(player: Player): Player {
	return {
		...player,
		hand: [],
		currentBet: 0,
		totalBet: 0,
		folded: false,
		isAllIn: false,
		hasActed: false,
	};
}

/**
 * Resets current bets for a new betting round (but keeps totalBet)
 */
export function resetCurrentBets(player: Player): Player {
	return {
		...player,
		currentBet: 0,
		hasActed: false,
	};
}

/**
 * Deals cards to a player
 */
export function dealCardsToPlayer(player: Player, cards: Card[]): Player {
	return {
		...player,
		hand: [...player.hand, ...cards],
	};
}

/**
 * Awards chips to a player
 */
export function awardChips(player: Player, amount: number): Player {
	return {
		...player,
		chips: player.chips + amount,
	};
}

/**
 * Gets active players (not folded)
 */
export function getActivePlayers(players: Player[]): Player[] {
	return players.filter((p) => !p.folded);
}

/**
 * Gets players who can act (not folded, not all-in)
 */
export function getPlayersWhoCanAct(players: Player[]): Player[] {
	return players.filter(canPlayerAct);
}

/**
 * Finds the next player who can act
 */
export function getNextPlayerIndex(players: Player[], currentIndex: number): number {
	let index = (currentIndex + 1) % players.length;

	// Loop until we find a player who can act or we've checked everyone
	let checked = 0;
	while (checked < players.length) {
		if (canPlayerAct(players[index])) {
			return index;
		}
		index = (index + 1) % players.length;
		checked++;
	}

	// If no one can act, return current index
	return currentIndex;
}

/**
 * Checks if betting round is complete
 * (all active players have matched the current bet or are all-in)
 */
export function isBettingRoundComplete(players: Player[]): boolean {
	const activePlayers = getActivePlayers(players);

	if (activePlayers.length === 0) {
		return true;
	}

	const playersWhoCanAct = getPlayersWhoCanAct(players);

	// If no one can act, round is complete
	if (playersWhoCanAct.length === 0) {
		return true;
	}

	// Find the highest current bet
	const highestBet = Math.max(...activePlayers.map((p) => p.currentBet));

	// Check if all players who can act have:
	// 1. Acted in this betting round
	// 2. Matched the highest bet (or are all-in)
	return playersWhoCanAct.every((p) => p.hasActed && p.currentBet === highestBet);
}

/**
 * Gets the current highest bet
 */
export function getHighestBet(players: Player[]): number {
	return Math.max(0, ...players.map((p) => p.currentBet));
}

/**
 * Gets the amount a player needs to call
 */
export function getCallAmount(player: Player, highestBet: number): number {
	return Math.max(0, highestBet - player.currentBet);
}
