import { expect } from 'bun:test';
import type { Card, Rank, Suit } from '../blackjack/types';

/**
 * Shared deck fixtures for the blackjack-run test suites
 * (`engine.test.ts`, `ranked.test.ts`).
 */

export const SUITS: readonly Suit[] = ['hearts', 'diamonds', 'clubs', 'spades'];
export const RANKS: readonly Rank[] = [
	'A',
	'2',
	'3',
	'4',
	'5',
	'6',
	'7',
	'8',
	'9',
	'10',
	'J',
	'Q',
	'K',
];

export function card(rank: Rank, suit: Suit): Card {
	return { rank, suit };
}

/**
 * Builds a complete, unique 52-card deck. `draws` is written in human deal
 * order, while the returned deck places those cards in reverse at the array
 * end because Blackjack deals with `pop()` semantics.
 */
export function deckWithDraws(...draws: readonly Card[]): Card[] {
	const canonicalDeck = SUITS.flatMap((suit) => RANKS.map((rank) => card(rank, suit)));
	const drawKeys = new Set(draws.map(({ rank, suit }) => `${rank}:${suit}`));
	expect(drawKeys.size).toBe(draws.length);
	const deck = [
		...canonicalDeck.filter(({ rank, suit }) => !drawKeys.has(`${rank}:${suit}`)),
		...[...draws].reverse(),
	];
	expect(deck).toHaveLength(52);
	return deck;
}

/**
 * Eight-draw fixture that opens with a splittable 8-8 pair and supports the
 * mixed split/double paths exercised by both the engine and ranked suites.
 */
export function splitCapableDeck(): Card[] {
	return deckWithDraws(
		card('8', 'hearts'),
		card('8', 'diamonds'),
		card('6', 'hearts'),
		card('10', 'clubs'),
		card('10', 'hearts'),
		card('9', 'hearts'),
		card('10', 'diamonds'),
		card('2', 'clubs'),
	);
}
