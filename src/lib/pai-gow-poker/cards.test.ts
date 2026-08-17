import { describe, expect, test } from 'bun:test';
import { createPaiGowDeck, createShuffledPaiGowDeck, isPaiGowJoker } from './cards';
import type { PaiGowCard } from './types';

const cardId = (card: PaiGowCard) => (isPaiGowJoker(card) ? 'joker' : `${card.rank}-${card.suit}`);

describe('Pai Gow deck', () => {
	test('contains 52 unique standard cards and one Joker', () => {
		const deck = createPaiGowDeck();
		const standardCards = deck.filter((card) => !isPaiGowJoker(card));

		expect(deck).toHaveLength(53);
		expect(standardCards).toHaveLength(52);
		expect(new Set(standardCards.map(cardId)).size).toBe(52);
		expect(deck.filter(isPaiGowJoker)).toHaveLength(1);
	});

	test('constant-zero shuffle pins the player and dealer deal order', () => {
		const dealt = createShuffledPaiGowDeck(() => 0).slice(0, 14);

		expect(dealt).toEqual([
			{ rank: 3, suit: 'hearts' },
			{ rank: 4, suit: 'hearts' },
			{ rank: 5, suit: 'hearts' },
			{ rank: 6, suit: 'hearts' },
			{ rank: 7, suit: 'hearts' },
			{ rank: 8, suit: 'hearts' },
			{ rank: 9, suit: 'hearts' },
			{ rank: 10, suit: 'hearts' },
			{ rank: 11, suit: 'hearts' },
			{ rank: 12, suit: 'hearts' },
			{ rank: 13, suit: 'hearts' },
			{ rank: 14, suit: 'hearts' },
			{ rank: 2, suit: 'diamonds' },
			{ rank: 3, suit: 'diamonds' },
		]);
	});
});
