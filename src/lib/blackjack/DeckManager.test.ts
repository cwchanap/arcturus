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

		it('should not auto-reshuffle mid-hand when below threshold', () => {
			// Deal cards to go below reshuffle threshold
			const cardsToDeal = 52 - RESHUFFLE_THRESHOLD + 1;
			for (let i = 0; i < cardsToDeal; i++) {
				deckManager.deal();
			}

			// We're below threshold now
			expect(deckManager.needsReshuffle()).toBe(true);
			const remainingBefore = deckManager.remainingCards();

			// Deal one more card - should NOT auto-reshuffle
			deckManager.deal();

			// Deck should have one less card, not have been reset
			expect(deckManager.remainingCards()).toBe(remainingBefore - 1);
		});

		it('should provide reshuffleIfNeeded for explicit reshuffle control', () => {
			// Deal cards to go below reshuffle threshold
			const cardsToDeal = 52 - RESHUFFLE_THRESHOLD + 1;
			for (let i = 0; i < cardsToDeal; i++) {
				deckManager.deal();
			}
			expect(deckManager.needsReshuffle()).toBe(true);

			// Caller should check needsReshuffle() and call reshuffleIfNeeded() between rounds
			const didReshuffle = deckManager.reshuffleIfNeeded();
			expect(didReshuffle).toBe(true);
			expect(deckManager.needsReshuffle()).toBe(false);
			expect(deckManager.remainingCards()).toBe(52);
		});

		it('should handle edge case of dealing from completely empty deck', () => {
			// Deal all 52 cards
			for (let i = 0; i < 52; i++) {
				deckManager.deal();
			}

			// Deck is now empty - deal should fallback to reset (safety net)
			const card = deckManager.deal();
			expect(card).toBeDefined();
			expect(card.rank).toBeDefined();
			expect(deckManager.remainingCards()).toBe(51); // Reset happened, then dealt 1
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
				const card = deckManager.deal();
				firstDeck.push(`${card.rank}${card.suit}`);
			}

			deckManager.reset();

			const secondDeck: string[] = [];
			for (let i = 0; i < 10; i++) {
				const card = deckManager.deal();
				secondDeck.push(`${card.rank}${card.suit}`);
			}

			// It's theoretically possible but extremely unlikely for them to be identical
			expect(firstDeck).not.toEqual(secondDeck);
		});
	});
});
