/**
 * Presentation readout of a player's best hand: the category key, the best
 * five cards, and the "core" cards that actually make the category (the pair
 * itself rather than its kickers). Showdown winners are still decided by
 * `determineShowdownWinners`; this module only explains the result on screen.
 */

import {
	compareFiveCardRankings,
	rankFiveCardHand,
	type FiveCardRanking,
} from '../five-card-poker';
import type { PokerHandNameKey } from './constants';
import type { Card } from './types';

export interface HandReadout {
	key: PokerHandNameKey;
	/** Cards that form the category (e.g. both cards of a pair, all five of a flush). */
	coreCards: Card[];
	/** False when the category's core cards all come from the board. */
	usesHoleCards: boolean;
	/**
	 * True only on a full board when the hole cards don't improve the board's
	 * own best five, kickers included ("the board plays").
	 */
	boardPlays: boolean;
}

const CATEGORY_KEYS: Record<FiveCardRanking['category'], PokerHandNameKey> = {
	'high-card': 'HIGH_CARD',
	pair: 'PAIR',
	'two-pair': 'TWO_PAIR',
	'three-of-kind': 'THREE_OF_A_KIND',
	straight: 'STRAIGHT',
	flush: 'FLUSH',
	'full-house': 'FULL_HOUSE',
	'four-of-kind': 'FOUR_OF_A_KIND',
	'straight-flush': 'STRAIGHT_FLUSH',
};

export function isSameCard(a: Card, b: Card): boolean {
	return a.rank === b.rank && a.suit === b.suit;
}

function fiveCardCombos(cards: Card[], start = 0, combo: Card[] = []): Card[][] {
	if (combo.length === 5) return [[...combo]];
	const combos: Card[][] = [];
	for (let i = start; i < cards.length; i++) {
		combos.push(...fiveCardCombos(cards, i + 1, [...combo, cards[i]]));
	}
	return combos;
}

function bestFive(cards: Card[]): { cards: Card[]; ranking: FiveCardRanking } {
	return fiveCardCombos(cards)
		.map((combo) => ({ cards: combo, ranking: rankFiveCardHand(combo) }))
		.reduce((best, next) =>
			compareFiveCardRankings(next.ranking, best.ranking) > 0 ? next : best,
		);
}

function coreOf(cards: Card[], ranking: FiveCardRanking): Card[] {
	switch (ranking.category) {
		case 'pair':
		case 'two-pair':
		case 'three-of-kind':
		case 'four-of-kind': {
			const counts = new Map<number, number>();
			for (const card of cards) counts.set(card.rank, (counts.get(card.rank) ?? 0) + 1);
			return cards.filter((card) => (counts.get(card.rank) ?? 0) >= 2);
		}
		case 'high-card':
			return [cards.reduce((high, card) => (card.rank > high.rank ? card : high))];
		default:
			return cards;
	}
}

/** Best-hand readout for hole cards plus the visible board; null before two cards are known. */
export function readHand(holeCards: Card[], communityCards: Card[]): HandReadout | null {
	const all = [...holeCards, ...communityCards];
	if (all.length < 2) return null;

	if (all.length < 5) {
		// Preflop (or a partial board in tests): only pairs are possible to show.
		const counts = new Map<number, number>();
		for (const card of all) counts.set(card.rank, (counts.get(card.rank) ?? 0) + 1);
		const paired = all.filter((card) => (counts.get(card.rank) ?? 0) >= 2);
		const coreCards =
			paired.length > 0 ? paired : [all.reduce((h, card) => (card.rank > h.rank ? card : h))];
		return {
			key: paired.length > 0 ? 'PAIR' : 'HIGH_CARD',
			coreCards,
			usesHoleCards: coreCards.some((card) => holeCards.some((hole) => isSameCard(card, hole))),
			boardPlays: false,
		};
	}

	const best = bestFive(all);
	const key =
		best.ranking.category === 'straight-flush' && best.ranking.tieBreakers[0] === 14
			? 'ROYAL_FLUSH'
			: CATEGORY_KEYS[best.ranking.category];
	const coreCards = coreOf(best.cards, best.ranking);
	const boardOnly = communityCards.length === 5 ? bestFive(communityCards) : null;
	return {
		key,
		coreCards,
		usesHoleCards: coreCards.some((card) => holeCards.some((hole) => isSameCard(card, hole))),
		boardPlays:
			boardOnly !== null && compareFiveCardRankings(best.ranking, boardOnly.ranking) === 0,
	};
}
