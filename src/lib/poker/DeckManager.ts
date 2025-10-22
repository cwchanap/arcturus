/**
 * DeckManager - Handles deck initialization, shuffling, and card drawing
 */

import type { Card, Suit } from './types';

export class DeckManager {
	private deck: Card[] = [];

	constructor() {
		this.initDeck();
		this.shuffle();
	}

	private initDeck() {
		const suits: Suit[] = ['hearts', 'diamonds', 'clubs', 'spades'];
		const values = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

		this.deck = [];
		for (const suit of suits) {
			for (let i = 0; i < values.length; i++) {
				this.deck.push({ value: values[i], suit, rank: i + 2 });
			}
		}
	}

	public shuffle() {
		for (let i = this.deck.length - 1; i > 0; i--) {
			const j = Math.floor(Math.random() * (i + 1));
			[this.deck[i], this.deck[j]] = [this.deck[j], this.deck[i]];
		}
	}

	public drawCard(): Card {
		const card = this.deck.pop();
		if (!card) {
			throw new Error('Deck is empty!');
		}
		return card;
	}

	public reset() {
		this.initDeck();
		this.shuffle();
	}

	public remainingCards(): number {
		return this.deck.length;
	}
}
