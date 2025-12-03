/**
 * DeckManager - Handles deck initialization, shuffling, and card drawing for Blackjack
 * Adapted from poker with reshuffle logic
 */

import type { Card, Rank, Suit } from './types';
import { RESHUFFLE_THRESHOLD } from './constants';

export class DeckManager {
	private deck: Card[] = [];
	private dealtCards: Card[] = [];

	constructor() {
		this.reset();
	}

	private initDeck() {
		const suits: Suit[] = ['hearts', 'diamonds', 'clubs', 'spades'];
		const ranks: Rank[] = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

		this.deck = [];
		for (const suit of suits) {
			for (const rank of ranks) {
				this.deck.push({ rank, suit });
			}
		}
	}

	/**
	 * Fisher-Yates shuffle algorithm
	 */
	public shuffle() {
		for (let i = this.deck.length - 1; i > 0; i--) {
			const j = Math.floor(Math.random() * (i + 1));
			[this.deck[i], this.deck[j]] = [this.deck[j], this.deck[i]];
		}
	}

	/**
	 * Draw a card from the deck
	 * Note: Does NOT auto-reshuffle to avoid reshuffling mid-hand
	 * Call reshuffleIfNeeded() at the start of each round instead
	 */
	public deal(): Card {
		const card = this.deck.pop();
		if (!card) {
			// This should never happen if reshuffleIfNeeded() is called at round start
			// But handle gracefully by forcing a reshuffle
			this.reset();
			return this.deal();
		}

		this.dealtCards.push(card);
		return card;
	}

	/**
	 * Reshuffle deck if below threshold
	 * Should be called at the START of each round, never mid-hand
	 */
	public reshuffleIfNeeded(): boolean {
		if (this.needsReshuffle()) {
			this.reset();
			return true;
		}
		return false;
	}

	/**
	 * Reset deck to full 52 cards and shuffle
	 */
	public reset() {
		this.initDeck();
		this.shuffle();
		this.dealtCards = [];
	}

	/**
	 * Check if deck needs reshuffling
	 */
	public needsReshuffle(): boolean {
		return this.deck.length < RESHUFFLE_THRESHOLD;
	}

	/**
	 * Get remaining card count
	 */
	public remainingCards(): number {
		return this.deck.length;
	}

	/**
	 * Get dealt card count
	 */
	public dealtCardCount(): number {
		return this.dealtCards.length;
	}
}
