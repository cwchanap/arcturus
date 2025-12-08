/**
 * Unit tests for DeckManager
 */

import { describe, expect, test, beforeEach } from 'bun:test';
import { DeckManager, createShoe, shuffleDeck, dealCard, needsReshuffle } from './DeckManager';
import { DECK_COUNT, TOTAL_CARDS, RESHUFFLE_THRESHOLD } from './constants';

describe('DeckManager', () => {
	let deckManager: DeckManager;

	beforeEach(() => {
		deckManager = new DeckManager();
	});

	function createSeededRng(seed: number): () => number {
		let x = seed >>> 0;
		return () => {
			x ^= x << 13;
			x ^= x >>> 17;
			x ^= x << 5;
			return (x >>> 0) / 0x100000000;
		};
	}

	test('should initialize with correct number of cards', () => {
		expect(deckManager.remainingCards()).toBe(TOTAL_CARDS);
	});

	test('should deal cards reducing remaining count', () => {
		const initialCount = deckManager.remainingCards();
		const card = deckManager.deal();

		expect(card).toBeDefined();
		expect(card.rank).toBeDefined();
		expect(card.suit).toBeDefined();
		expect(deckManager.remainingCards()).toBe(initialCount - 1);
	});

	test('should deal 416 cards (8 decks)', () => {
		const cards = [];
		for (let i = 0; i < TOTAL_CARDS; i++) {
			cards.push(deckManager.deal());
		}

		expect(cards.length).toBe(TOTAL_CARDS);
		expect(deckManager.remainingCards()).toBe(0);
	});

	test('should reshuffle automatically if deck becomes empty', () => {
		// Deal all cards
		for (let i = 0; i < TOTAL_CARDS; i++) {
			deckManager.deal();
		}

		expect(deckManager.remainingCards()).toBe(0);

		// Deal one more - should trigger automatic reset
		const card = deckManager.deal();
		expect(card).toBeDefined();
		expect(deckManager.remainingCards()).toBe(TOTAL_CARDS - 1);
	});

	test('should report needs reshuffle when below threshold', () => {
		// Deal until just above threshold
		const cardsToRemove = TOTAL_CARDS - RESHUFFLE_THRESHOLD;
		for (let i = 0; i < cardsToRemove; i++) {
			deckManager.deal();
		}

		expect(deckManager.needsReshuffle()).toBe(false);

		// Deal one more to go below threshold
		deckManager.deal();
		expect(deckManager.needsReshuffle()).toBe(true);
	});

	test('reshuffleIfNeeded should reshuffle when needed', () => {
		// Deal until below threshold
		const cardsToRemove = TOTAL_CARDS - RESHUFFLE_THRESHOLD + 1;
		for (let i = 0; i < cardsToRemove; i++) {
			deckManager.deal();
		}

		expect(deckManager.needsReshuffle()).toBe(true);

		const didReshuffle = deckManager.reshuffleIfNeeded();
		expect(didReshuffle).toBe(true);
		expect(deckManager.remainingCards()).toBe(TOTAL_CARDS);
		expect(deckManager.needsReshuffle()).toBe(false);
	});

	test('reshuffleIfNeeded should not reshuffle when not needed', () => {
		const didReshuffle = deckManager.reshuffleIfNeeded();
		expect(didReshuffle).toBe(false);
		expect(deckManager.remainingCards()).toBe(TOTAL_CARDS);
	});

	test('reset should restore full deck count', () => {
		// Deal some cards
		for (let i = 0; i < 100; i++) {
			deckManager.deal();
		}

		deckManager.reset();
		expect(deckManager.remainingCards()).toBe(TOTAL_CARDS);
	});

	test('shuffle should be deterministic with seeded rng', () => {
		const rngA = createSeededRng(42);
		const rngB = createSeededRng(42);
		const manager1 = new DeckManager(DECK_COUNT, RESHUFFLE_THRESHOLD, rngA);
		const manager2 = new DeckManager(DECK_COUNT, RESHUFFLE_THRESHOLD, rngB);

		const cards1: ReturnType<typeof manager1.deal>[] = [];
		const cards2: ReturnType<typeof manager2.deal>[] = [];

		for (let i = 0; i < 20; i++) {
			cards1.push(manager1.deal());
			cards2.push(manager2.deal());
		}

		const sameOrder = cards1.every(
			(card, i) => card.rank === cards2[i].rank && card.suit === cards2[i].suit,
		);
		expect(sameOrder).toBe(true);
	});

	test('shuffle should differ with different seeds while preserving card multiset', () => {
		const manager1 = new DeckManager(DECK_COUNT, RESHUFFLE_THRESHOLD, createSeededRng(1));
		const manager2 = new DeckManager(DECK_COUNT, RESHUFFLE_THRESHOLD, createSeededRng(2));

		const cards1: ReturnType<typeof manager1.deal>[] = [];
		const cards2: ReturnType<typeof manager2.deal>[] = [];

		for (let i = 0; i < TOTAL_CARDS; i++) {
			cards1.push(manager1.deal());
			cards2.push(manager2.deal());
		}

		// Same multiset (permutation)
		const sortKey = (c: { rank: string; suit: string }) => `${c.rank}-${c.suit}`;
		const sorted1 = cards1.map(sortKey).sort();
		const sorted2 = cards2.map(sortKey).sort();
		expect(sorted1).toEqual(sorted2);

		// At least one position differs deterministically
		const identicalOrder = cards1.every(
			(card, i) => card.rank === cards2[i].rank && card.suit === cards2[i].suit,
		);
		expect(identicalOrder).toBe(false);
	});

	test('getState should return current deck state', () => {
		const state = deckManager.getState();

		expect(state.deckCount).toBe(DECK_COUNT);
		expect(state.reshuffleThreshold).toBe(RESHUFFLE_THRESHOLD);
		expect(state.cards.length).toBe(TOTAL_CARDS);
	});

	test('should support custom deck count', () => {
		const customDeckManager = new DeckManager(6);
		expect(customDeckManager.remainingCards()).toBe(6 * 52);
	});

	test('should support custom reshuffle threshold', () => {
		const customDeckManager = new DeckManager(8, 30);
		const state = customDeckManager.getState();
		expect(state.reshuffleThreshold).toBe(30);
	});
});

describe('Pure functions', () => {
	test('createShoe should create correct number of cards', () => {
		const shoe = createShoe(8);
		expect(shoe.length).toBe(416);

		const smallShoe = createShoe(1);
		expect(smallShoe.length).toBe(52);
	});

	test('createShoe should contain all ranks and suits', () => {
		const shoe = createShoe(1);
		const ranks = new Set(shoe.map((c) => c.rank));
		const suits = new Set(shoe.map((c) => c.suit));

		expect(ranks.size).toBe(13);
		expect(suits.size).toBe(4);
	});

	test('shuffleDeck should return new array', () => {
		const original = createShoe(1);
		const shuffled = shuffleDeck(original);

		expect(shuffled).not.toBe(original);
		expect(shuffled.length).toBe(original.length);
	});

	test('shuffleDeck should randomize order', () => {
		const original = createShoe(1);
		const shuffled = shuffleDeck(original);

		// Check that order is different (extremely unlikely to be the same)
		const sameOrder = original.every(
			(card, i) => card.rank === shuffled[i].rank && card.suit === shuffled[i].suit,
		);
		expect(sameOrder).toBe(false);
	});

	test('dealCard should return card and remaining deck', () => {
		const deck = createShoe(1);
		const [card, remaining] = dealCard(deck);

		expect(card).toBeDefined();
		expect(remaining.length).toBe(deck.length - 1);
	});

	test('dealCard should not modify original array', () => {
		const deck = createShoe(1);
		const originalLength = deck.length;
		dealCard(deck);

		expect(deck.length).toBe(originalLength);
	});

	test('dealCard should throw on empty deck', () => {
		expect(() => dealCard([])).toThrow('Cannot deal from empty deck');
	});

	test('needsReshuffle should return correct value', () => {
		const largeDeck = createShoe(8);
		expect(needsReshuffle(largeDeck)).toBe(false);

		const smallDeck = largeDeck.slice(0, 10);
		expect(needsReshuffle(smallDeck)).toBe(true);
	});

	test('needsReshuffle should respect custom threshold', () => {
		const deck = createShoe(1).slice(0, 25);
		expect(needsReshuffle(deck, 20)).toBe(false);
		expect(needsReshuffle(deck, 30)).toBe(true);
	});
});
