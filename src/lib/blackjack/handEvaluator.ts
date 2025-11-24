/**
 * Hand evaluation logic for Blackjack
 * Handles Ace soft/hard value calculation, bust detection, and special action eligibility
 */

import type { Card, Hand, HandValue } from './types';
import { BLACKJACK_VALUE, ACE_HIGH_VALUE, ACE_LOW_VALUE, CARD_VALUES } from './constants';

/**
 * Calculate the value of a hand, handling Ace soft/hard logic
 * Ace can be 1 or 11 - tries to use 11 if it doesn't bust
 */
export function calculateHandValue(cards: Card[]): HandValue {
	let total = 0;
	let aceCount = 0;

	// First pass: count all cards with Aces as 11
	for (const card of cards) {
		if (card.rank === 'A') {
			aceCount++;
			total += ACE_HIGH_VALUE;
		} else {
			total += CARD_VALUES[card.rank];
		}
	}

	// Second pass: downgrade Aces from 11 to 1 if busted
	while (total > BLACKJACK_VALUE && aceCount > 0) {
		total -= ACE_HIGH_VALUE - ACE_LOW_VALUE; // Convert one Ace from 11 to 1
		aceCount--;
	}

	const isBust = total > BLACKJACK_VALUE;
	const isSoft = aceCount > 0 && total <= BLACKJACK_VALUE; // Hand has Ace counted as 11

	return {
		value: total,
		isSoft,
		isBust,
	};
}

/**
 * Check if hand is a natural Blackjack (21 with 2 cards: Ace + 10-value)
 */
export function isBlackjack(hand: Hand): boolean {
	if (hand.cards.length !== 2) {
		return false;
	}

	const handValue = calculateHandValue(hand.cards);
	return handValue.value === BLACKJACK_VALUE;
}

/**
 * Check if hand is busted (over 21)
 */
export function isBust(hand: Hand): boolean {
	const handValue = calculateHandValue(hand.cards);
	return handValue.isBust;
}

/**
 * Check if hand can be split (2 cards with same rank)
 */
export function canSplit(hand: Hand): boolean {
	if (hand.cards.length !== 2) {
		return false;
	}

	return hand.cards[0].rank === hand.cards[1].rank;
}

/**
 * Check if hand can double down (2 cards with total of 9, 10, or 11)
 */
export function canDoubleDown(hand: Hand): boolean {
	if (hand.cards.length !== 2) {
		return false;
	}

	const handValue = calculateHandValue(hand.cards);
	return handValue.value >= 9 && handValue.value <= 11;
}

/**
 * Compare two hands to determine winner
 * Returns: 1 if hand1 wins, -1 if hand2 wins, 0 if push
 */
export function compareHands(hand1: Hand, hand2: Hand): number {
	const value1 = calculateHandValue(hand1.cards);
	const value2 = calculateHandValue(hand2.cards);

	// Both bust - dealer wins (shouldn't happen in normal play)
	if (value1.isBust && value2.isBust) {
		return -1;
	}

	// Hand1 bust - hand2 wins
	if (value1.isBust) {
		return -1;
	}

	// Hand2 bust - hand1 wins
	if (value2.isBust) {
		return 1;
	}

	// Neither bust - compare values
	if (value1.value > value2.value) {
		return 1;
	} else if (value1.value < value2.value) {
		return -1;
	}

	// Same value - push
	return 0;
}

/**
 * Get displayable hand value string (e.g., "17", "Soft 18", "Bust")
 */
export function getHandValueDisplay(cards: Card[]): string {
	const handValue = calculateHandValue(cards);

	if (handValue.isBust) {
		return 'Bust';
	}

	if (handValue.isSoft) {
		return `Soft ${handValue.value}`;
	}

	return handValue.value.toString();
}
