/**
 * DeckManager - Handles 8-deck shoe initialization, shuffling, and card dealing for Baccarat
 */

import type { Card, DeckState } from './types';
import { DECK_COUNT, RANKS, RESHUFFLE_THRESHOLD, SUITS } from './constants';

export class DeckManager {
	private deck: Card[] = [];
	private readonly deckCount: number;
	private readonly reshuffleThreshold: number;
	private readonly rng: () => number;

	constructor(
		deckCount: number = DECK_COUNT,
		reshuffleThreshold: number = RESHUFFLE_THRESHOLD,
		rng: () => number = Math.random,
	) {
		this.deckCount = deckCount;
		this.reshuffleThreshold = reshuffleThreshold;
		this.rng = rng;
		this.reset();
	}

	/**
	 * Initialize the shoe with multiple decks
	 */
	private initShoe(): void {
		this.deck = [];
		for (let d = 0; d < this.deckCount; d++) {
			for (const suit of SUITS) {
				for (const rank of RANKS) {
					this.deck.push({ rank, suit });
				}
			}
		}
	}

	/**
	 * Fisher-Yates shuffle algorithm
	 */
	public shuffle(): void {
		for (let i = this.deck.length - 1; i > 0; i--) {
			const j = Math.floor(this.rng() * (i + 1));
			[this.deck[i], this.deck[j]] = [this.deck[j], this.deck[i]];
		}
	}

	/**
	 * Deal a card from the shoe
	 * Does NOT auto-reshuffle to avoid reshuffling mid-round
	 * Call reshuffleIfNeeded() at the start of each round instead
	 */
	public deal(): Card {
		const card = this.deck.pop();
		if (!card) {
			// This should never happen if reshuffleIfNeeded() is called at round start
			// But handle gracefully by forcing a reshuffle
			this.reset();
			const newCard = this.deck.pop();
			if (!newCard) {
				throw new Error('Failed to deal card after reshuffle');
			}
			return newCard;
		}
		return card;
	}

	/**
	 * Reshuffle shoe if below threshold
	 * Should be called at the START of each round, never mid-hand
	 * @returns true if a reshuffle occurred
	 */
	public reshuffleIfNeeded(): boolean {
		if (this.needsReshuffle()) {
			this.reset();
			return true;
		}
		return false;
	}

	/**
	 * Reset shoe to full card count and shuffle
	 */
	public reset(): void {
		this.initShoe();
		this.shuffle();
	}

	/**
	 * Check if shoe needs reshuffling
	 */
	public needsReshuffle(): boolean {
		return this.deck.length < this.reshuffleThreshold;
	}

	/**
	 * Get remaining card count
	 */
	public remainingCards(): number {
		return this.deck.length;
	}

	/**
	 * Get the current state of the deck (for serialization/testing)
	 */
	public getState(): DeckState {
		return {
			cards: [...this.deck],
			deckCount: this.deckCount,
			reshuffleThreshold: this.reshuffleThreshold,
		};
	}
}

// Pure function exports for functional usage

/**
 * Create a new shoe with specified number of decks
 */
export function createShoe(deckCount: number = DECK_COUNT): Card[] {
	const shoe: Card[] = [];
	for (let d = 0; d < deckCount; d++) {
		for (const suit of SUITS) {
			for (const rank of RANKS) {
				shoe.push({ rank, suit });
			}
		}
	}
	return shoe;
}

/**
 * Fisher-Yates shuffle (pure function - returns new array)
 */
export function shuffleDeck(cards: Card[]): Card[] {
	const shuffled = [...cards];
	for (let i = shuffled.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
	}
	return shuffled;
}

/**
 * Deal a card from the deck (pure function)
 * @returns tuple of [dealt card, remaining deck]
 */
export function dealCard(deck: Card[]): [Card, Card[]] {
	if (deck.length === 0) {
		throw new Error('Cannot deal from empty deck');
	}
	const remaining = [...deck];
	const card = remaining.pop()!;
	return [card, remaining];
}

/**
 * Check if deck needs reshuffle
 */
export function needsReshuffle(deck: Card[], threshold: number = RESHUFFLE_THRESHOLD): boolean {
	return deck.length < threshold;
}
