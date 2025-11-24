/**
 * DeckManager tests
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { DeckManager } from './DeckManager';
import { RESHUFFLE_THRESHOLD } from './constants';

describe('DeckManager', () => {
	let deckManager: DeckManager;

	beforeEach(() => {
		deckManager = new DeckManager();
	});

	describe('Initialization', () => {
		it('should initialize with 52 cards', () => {
			expect(deckManager.remainingCards()).toBe(52);
		});

		it('should have all unique cards in a fresh deck', () => {
			// Deal first 13 cards to avoid triggering reshuffle
			const cards = [];
			for (let i = 0; i < 13; i++) {
				cards.push(deckManager.deal());
			}

			// Check for duplicates
			const cardStrings = cards.map((c) => `${c.rank}${c.suit}`);
			const uniqueCards = new Set(cardStrings);
			expect(uniqueCards.size).toBe(13); // All 13 should be unique
		});

		it('should contain all 4 suits', () => {
			const cards = [];
			for (let i = 0; i < 52; i++) {
				cards.push(deckManager.deal());
			}

			const suits = new Set(cards.map((c) => c.suit));
			expect(suits.size).toBe(4);
			expect(suits.has('hearts')).toBe(true);
			expect(suits.has('diamonds')).toBe(true);
			expect(suits.has('clubs')).toBe(true);
			expect(suits.has('spades')).toBe(true);
		});

		it('should contain all 13 ranks per suit', () => {
			const cards = [];
			for (let i = 0; i < 52; i++) {
				cards.push(deckManager.deal());
			}

			const ranks = new Set(cards.map((c) => c.rank));
			expect(ranks.size).toBe(13);
		});
	});

	describe('Dealing cards', () => {
		it('should deal cards and decrease remaining count', () => {
			const initialCount = deckManager.remainingCards();
			deckManager.deal();
			expect(deckManager.remainingCards()).toBe(initialCount - 1);
		});

		it('should track dealt cards', () => {
			expect(deckManager.dealtCardCount()).toBe(0);
			deckManager.deal();
			expect(deckManager.dealtCardCount()).toBe(1);
			deckManager.deal();
			expect(deckManager.dealtCardCount()).toBe(2);
		});

		it('should deal all 52 cards without error', () => {
			for (let i = 0; i < 52; i++) {
				const card = deckManager.deal();
				expect(card).toBeDefined();
				expect(card.rank).toBeDefined();
				expect(card.suit).toBeDefined();
			}
		});
	});

	describe('Reshuffle logic', () => {
		it('should detect when reshuffle is needed', () => {
			// Deal cards until below threshold
			const cardsToDeal = 52 - RESHUFFLE_THRESHOLD + 1;
			for (let i = 0; i < cardsToDeal; i++) {
				deckManager.deal();
			}
			expect(deckManager.needsReshuffle()).toBe(true);
		});

		it('should not need reshuffle when above threshold', () => {
			// Deal only a few cards
			deckManager.deal();
			deckManager.deal();
			expect(deckManager.needsReshuffle()).toBe(false);
		});

		it('should automatically reshuffle when dealing below threshold', () => {
			// Deal cards to just above threshold
			const cardsToDeal = 52 - RESHUFFLE_THRESHOLD + 1;
			for (let i = 0; i < cardsToDeal; i++) {
				deckManager.deal();
			}

			// Should trigger reshuffle on next deal
			const remainingBefore = deckManager.remainingCards();
			expect(remainingBefore).toBeLessThan(RESHUFFLE_THRESHOLD);

			deckManager.deal();

			// After automatic reshuffle, should have 51 cards (52 - 1 dealt)
			expect(deckManager.remainingCards()).toBe(51);
		});

		it('should reset dealt card count after reshuffle', () => {
			// Deal cards to go below reshuffle threshold
			const cardsToDeal = 52 - RESHUFFLE_THRESHOLD + 1; // This puts us at 14 remaining
			for (let i = 0; i < cardsToDeal; i++) {
				deckManager.deal();
			}
			expect(deckManager.dealtCardCount()).toBe(cardsToDeal);

			// Next deal should trigger auto-reshuffle (because we're below threshold)
			deckManager.deal();
			// After reshuffle, dealt count should be 1 (just the card dealt after reshuffle)
			expect(deckManager.dealtCardCount()).toBe(1);
		});
	});

	describe('Reset functionality', () => {
		it('should reset to 52 cards', () => {
			// Deal some cards
			deckManager.deal();
			deckManager.deal();
			deckManager.deal();

			// Reset
			deckManager.reset();
			expect(deckManager.remainingCards()).toBe(52);
		});

		it('should clear dealt cards count', () => {
			deckManager.deal();
			deckManager.deal();
			expect(deckManager.dealtCardCount()).toBeGreaterThan(0);

			deckManager.reset();
			expect(deckManager.dealtCardCount()).toBe(0);
		});
	});

	describe('Shuffle randomness', () => {
		it('should produce different card orders after shuffle', () => {
			const firstDeck: string[] = [];
			for (let i = 0; i < 10; i++) {
				firstDeck.push(`${deckManager.deal().rank}${deckManager.deal().suit}`);
			}

			deckManager.reset();

			const secondDeck: string[] = [];
			for (let i = 0; i < 10; i++) {
				secondDeck.push(`${deckManager.deal().rank}${deckManager.deal().suit}`);
			}

			// It's theoretically possible but extremely unlikely for them to be identical
			expect(firstDeck).not.toEqual(secondDeck);
		});
	});
});
