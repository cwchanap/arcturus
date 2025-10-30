import { describe, expect, test, beforeEach } from 'bun:test';
import { DeckManager } from './DeckManager';
import type { Card } from './types';

describe('DeckManager', () => {
	let deckManager: DeckManager;

	beforeEach(() => {
		deckManager = new DeckManager();
	});

	describe('Initialization', () => {
		test('creates a full 52-card deck', () => {
			expect(deckManager.remainingCards()).toBe(52);
		});

		test('deck contains all four suits', () => {
			const cards: Card[] = [];
			while (deckManager.remainingCards() > 0) {
				cards.push(deckManager.drawCard());
			}

			const suits = new Set(cards.map((c) => c.suit));
			expect(suits.size).toBe(4);
			expect(suits.has('hearts')).toBe(true);
			expect(suits.has('diamonds')).toBe(true);
			expect(suits.has('clubs')).toBe(true);
			expect(suits.has('spades')).toBe(true);
		});

		test('deck contains all 13 ranks per suit', () => {
			const cards: Card[] = [];
			while (deckManager.remainingCards() > 0) {
				cards.push(deckManager.drawCard());
			}

			const values = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

			for (const suit of ['hearts', 'diamonds', 'clubs', 'spades'] as const) {
				const suitCards = cards.filter((c) => c.suit === suit);
				expect(suitCards.length).toBe(13);

				const suitValues = suitCards.map((c) => c.value);
				// Check all values are present (order doesn't matter after shuffle)
				for (const value of values) {
					expect(suitValues).toContain(value);
				}
			}
		});

		test('cards have correct rank values', () => {
			const cards: Card[] = [];
			while (deckManager.remainingCards() > 0) {
				cards.push(deckManager.drawCard());
			}

			// Check that '2' has rank 2, '3' has rank 3, ..., 'A' has rank 14
			const twoCard = cards.find((c) => c.value === '2');
			const aceCard = cards.find((c) => c.value === 'A');
			const kingCard = cards.find((c) => c.value === 'K');

			expect(twoCard?.rank).toBe(2);
			expect(kingCard?.rank).toBe(13);
			expect(aceCard?.rank).toBe(14);
		});
	});

	describe('drawCard()', () => {
		test('draws a card and reduces deck size', () => {
			const initialSize = deckManager.remainingCards();
			const card = deckManager.drawCard();

			expect(card).toBeDefined();
			expect(card.value).toBeDefined();
			expect(card.suit).toBeDefined();
			expect(card.rank).toBeGreaterThanOrEqual(2);
			expect(card.rank).toBeLessThanOrEqual(14);
			expect(deckManager.remainingCards()).toBe(initialSize - 1);
		});

		test('draws unique cards each time', () => {
			const drawnCards = new Set<string>();
			const cardCount = 10;

			for (let i = 0; i < cardCount; i++) {
				const card = deckManager.drawCard();
				const cardKey = `${card.value}${card.suit}`;
				expect(drawnCards.has(cardKey)).toBe(false);
				drawnCards.add(cardKey);
			}

			expect(drawnCards.size).toBe(cardCount);
		});

		test('can draw all 52 cards', () => {
			const cards: Card[] = [];

			for (let i = 0; i < 52; i++) {
				cards.push(deckManager.drawCard());
			}

			expect(cards.length).toBe(52);
			expect(deckManager.remainingCards()).toBe(0);
		});

		test('throws error when deck is empty', () => {
			// Draw all cards
			for (let i = 0; i < 52; i++) {
				deckManager.drawCard();
			}

			expect(() => deckManager.drawCard()).toThrow('Deck is empty!');
		});
	});

	describe('shuffle()', () => {
		test('shuffle changes card order', () => {
			// Create two decks and compare order
			const deck1 = new DeckManager();
			const deck2 = new DeckManager();

			// Draw a few cards from each
			const cards1 = [
				deck1.drawCard(),
				deck1.drawCard(),
				deck1.drawCard(),
				deck1.drawCard(),
				deck1.drawCard(),
			];
			const cards2 = [
				deck2.drawCard(),
				deck2.drawCard(),
				deck2.drawCard(),
				deck2.drawCard(),
				deck2.drawCard(),
			];

			// With shuffling, it's statistically very unlikely to have same order
			const sameOrder = cards1.every(
				(card, i) => card.value === cards2[i].value && card.suit === cards2[i].suit,
			);

			// While theoretically possible, probability is 1 in 311,875,200 for 5 cards
			expect(sameOrder).toBe(false);
		});

		test('shuffle maintains deck size', () => {
			const sizeBefore = deckManager.remainingCards();
			deckManager.shuffle();
			expect(deckManager.remainingCards()).toBe(sizeBefore);
		});

		test('shuffle maintains all unique cards', () => {
			// Draw some cards, shuffle, then verify no duplicates
			const drawn: Card[] = [];
			for (let i = 0; i < 20; i++) {
				drawn.push(deckManager.drawCard());
			}

			deckManager.shuffle();

			// Draw remaining cards
			while (deckManager.remainingCards() > 0) {
				drawn.push(deckManager.drawCard());
			}

			// Check all 52 cards are unique
			const cardKeys = drawn.map((c) => `${c.value}${c.suit}`);
			const uniqueKeys = new Set(cardKeys);
			expect(uniqueKeys.size).toBe(52);
		});
	});

	describe('reset()', () => {
		test('resets deck to full 52 cards', () => {
			// Draw some cards
			for (let i = 0; i < 20; i++) {
				deckManager.drawCard();
			}

			expect(deckManager.remainingCards()).toBe(32);

			deckManager.reset();

			expect(deckManager.remainingCards()).toBe(52);
		});

		test('reset after complete depletion works', () => {
			// Draw all cards
			for (let i = 0; i < 52; i++) {
				deckManager.drawCard();
			}

			expect(deckManager.remainingCards()).toBe(0);

			deckManager.reset();

			expect(deckManager.remainingCards()).toBe(52);
			// Should be able to draw cards again
			const card = deckManager.drawCard();
			expect(card).toBeDefined();
		});

		test('reset reshuffles the deck', () => {
			// Draw some cards
			const firstDraw = [deckManager.drawCard(), deckManager.drawCard(), deckManager.drawCard()];

			deckManager.reset();

			// Draw same number of cards
			const secondDraw = [deckManager.drawCard(), deckManager.drawCard(), deckManager.drawCard()];

			// Order should be different (statistically very likely)
			const sameOrder = firstDraw.every(
				(card, i) => card.value === secondDraw[i].value && card.suit === secondDraw[i].suit,
			);

			expect(sameOrder).toBe(false);
		});

		test('reset maintains card integrity', () => {
			deckManager.reset();

			const cards: Card[] = [];
			while (deckManager.remainingCards() > 0) {
				cards.push(deckManager.drawCard());
			}

			// Verify all 52 unique cards
			expect(cards.length).toBe(52);
			const cardKeys = cards.map((c) => `${c.value}${c.suit}`);
			const uniqueKeys = new Set(cardKeys);
			expect(uniqueKeys.size).toBe(52);
		});
	});

	describe('remainingCards()', () => {
		test('returns correct count after draws', () => {
			expect(deckManager.remainingCards()).toBe(52);

			deckManager.drawCard();
			expect(deckManager.remainingCards()).toBe(51);

			deckManager.drawCard();
			deckManager.drawCard();
			expect(deckManager.remainingCards()).toBe(49);
		});

		test('returns 0 when deck is empty', () => {
			for (let i = 0; i < 52; i++) {
				deckManager.drawCard();
			}

			expect(deckManager.remainingCards()).toBe(0);
		});

		test('updates correctly after reset', () => {
			for (let i = 0; i < 30; i++) {
				deckManager.drawCard();
			}

			expect(deckManager.remainingCards()).toBe(22);

			deckManager.reset();

			expect(deckManager.remainingCards()).toBe(52);
		});
	});

	describe('Card distribution', () => {
		test('each suit has exactly 13 cards', () => {
			const cards: Card[] = [];
			while (deckManager.remainingCards() > 0) {
				cards.push(deckManager.drawCard());
			}

			const suitCounts: Record<string, number> = {
				hearts: 0,
				diamonds: 0,
				clubs: 0,
				spades: 0,
			};

			for (const card of cards) {
				suitCounts[card.suit]++;
			}

			expect(suitCounts.hearts).toBe(13);
			expect(suitCounts.diamonds).toBe(13);
			expect(suitCounts.clubs).toBe(13);
			expect(suitCounts.spades).toBe(13);
		});

		test('each value appears exactly 4 times', () => {
			const cards: Card[] = [];
			while (deckManager.remainingCards() > 0) {
				cards.push(deckManager.drawCard());
			}

			const valueCounts: Record<string, number> = {};
			for (const card of cards) {
				valueCounts[card.value] = (valueCounts[card.value] || 0) + 1;
			}

			const values = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
			for (const value of values) {
				expect(valueCounts[value]).toBe(4);
			}
		});

		test('no duplicate cards in deck', () => {
			const cards: Card[] = [];
			while (deckManager.remainingCards() > 0) {
				cards.push(deckManager.drawCard());
			}

			const cardSet = new Set<string>();
			for (const card of cards) {
				const key = `${card.value}-${card.suit}`;
				expect(cardSet.has(key)).toBe(false);
				cardSet.add(key);
			}

			expect(cardSet.size).toBe(52);
		});
	});

	describe('Multiple deck instances', () => {
		test('each instance has independent deck', () => {
			const deck1 = new DeckManager();
			const deck2 = new DeckManager();

			deck1.drawCard();
			deck1.drawCard();

			expect(deck1.remainingCards()).toBe(50);
			expect(deck2.remainingCards()).toBe(52);
		});

		test('shuffles are independent', () => {
			const deck1 = new DeckManager();
			const deck2 = new DeckManager();

			deck1.shuffle();

			const card1 = deck1.drawCard();
			const card2 = deck2.drawCard();

			// Verify both decks produce valid cards
			expect(card1).toBeDefined();
			expect(card2).toBeDefined();
			expect(card1.value).toBeDefined();
			expect(card2.value).toBeDefined();
		});
	});

	describe('Edge cases', () => {
		test('handles rapid successive draws', () => {
			const cards: Card[] = [];
			for (let i = 0; i < 52; i++) {
				cards.push(deckManager.drawCard());
			}

			expect(cards.length).toBe(52);
			expect(new Set(cards.map((c) => `${c.value}${c.suit}`)).size).toBe(52);
		});

		test('handles multiple resets', () => {
			deckManager.reset();
			deckManager.reset();
			deckManager.reset();

			expect(deckManager.remainingCards()).toBe(52);
			const card = deckManager.drawCard();
			expect(card).toBeDefined();
		});

		test('handles shuffle on partial deck', () => {
			for (let i = 0; i < 10; i++) {
				deckManager.drawCard();
			}

			const remainingBefore = deckManager.remainingCards();
			deckManager.shuffle();
			const remainingAfter = deckManager.remainingCards();

			expect(remainingAfter).toBe(remainingBefore);
		});
	});
});
