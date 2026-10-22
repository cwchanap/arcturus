/**
 * Sit & Go tournament pure rules (HPA-176)
 * Constants and minimal helpers shared by PokerGame's SNG mode.
 */

import type { Player } from './types';

export type PokerMode = 'cash' | 'sng';

export const SNG_START_STACK = 500;
export const SNG_BLINDS = [
	{ small: 5, big: 10 },
	{ small: 10, big: 20 },
	{ small: 20, big: 40 },
	{ small: 40, big: 80 },
	{ small: 80, big: 160 },
] as const;
export const SNG_HANDS_PER_LEVEL = 5;

/**
 * Blind level derived from the existing 1-based handNumber.
 * Levels change on hands 1, 6, 11, 16, 21 and cap at the last level.
 */
export function levelFor(handNumber: number): number {
	return Math.min(SNG_BLINDS.length - 1, Math.floor((handNumber - 1) / SNG_HANDS_PER_LEVEL));
}

export interface SeatSelection {
	buttonIndex: number;
	smallBlindIndex: number;
	bigBlindIndex: number;
}

/** Next funded seat clockwise from seatIndex (wraps; seatIndex itself may be busted). */
function nextFundedAfter(funded: number[], seatIndex: number): number {
	const position = funded.indexOf(seatIndex);
	if (position !== -1) {
		return funded[(position + 1) % funded.length];
	}
	return funded.find((seat) => seat > seatIndex) ?? funded[0];
}

/**
 * Rotates button/SB/BB among seats with chips > 0, skipping gaps and wrapping.
 * Heads-up (exactly 2 funded seats): the button is the small blind.
 */
export function nextFundedSeats(players: Player[], currentDealerIndex: number): SeatSelection {
	const funded: number[] = [];
	for (let i = 0; i < players.length; i++) {
		if (players[i].chips > 0) {
			funded.push(i);
		}
	}
	if (funded.length < 2) {
		const only = funded[0] ?? currentDealerIndex;
		return { buttonIndex: only, smallBlindIndex: only, bigBlindIndex: only };
	}
	const buttonIndex = nextFundedAfter(funded, currentDealerIndex);
	const smallBlindIndex = funded.length === 2 ? buttonIndex : nextFundedAfter(funded, buttonIndex);
	const bigBlindIndex = nextFundedAfter(funded, smallBlindIndex);
	return { buttonIndex, smallBlindIndex, bigBlindIndex };
}

/**
 * Human's finish place after busting this hand: seats still funded + 1, plus
 * simultaneous busts that had a larger start-of-hand stack (equal stacks tie).
 */
export function humanPlace(
	fundedSeatsAfterHand: number,
	humanStartStack: number,
	bustedOpponentStartStacks: number[],
): number {
	return (
		fundedSeatsAfterHand +
		1 +
		bustedOpponentStartStacks.filter((stack) => stack > humanStartStack).length
	);
}
