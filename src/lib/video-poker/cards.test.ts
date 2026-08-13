import { describe, expect, test } from 'bun:test';
import { createDeck, shuffleDeck } from './cards';
import type { Card } from './types';

const id = (card: Card) => `${card.rank}-${card.suit}`;

describe('video poker cards', () => {
	test('creates exactly 52 unique cards', () => {
		const deck = createDeck();
		expect(deck).toHaveLength(52);
		expect(new Set(deck.map(id)).size).toBe(52);
		expect(new Set(deck.map((card) => card.suit))).toEqual(
			new Set(['hearts', 'diamonds', 'clubs', 'spades']),
		);
	});

	test('shuffles a copy with injectable random', () => {
		const deck: Card[] = [
			{ rank: 2, suit: 'hearts' },
			{ rank: 3, suit: 'hearts' },
			{ rank: 4, suit: 'hearts' },
		];
		const shuffled = shuffleDeck(deck, () => 0);
		expect(shuffled.map(id)).toEqual(['3-hearts', '4-hearts', '2-hearts']);
		expect(deck.map(id)).toEqual(['2-hearts', '3-hearts', '4-hearts']);
	});
});
