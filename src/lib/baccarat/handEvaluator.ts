/**
 * Hand evaluation functions for Baccarat
 * Implements Punto Banco hand value calculation
 */

import type { Card, Hand, Rank } from './types';
import { CARD_VALUES, NATURAL_THRESHOLD } from './constants';

/**
 * Get the baccarat value of a single card
 * Face cards (10, J, Q, K) = 0
 * Ace = 1
 * 2-9 = face value
 */
export function getCardValue(card: Card): number {
	return CARD_VALUES[card.rank];
}

/**
 * Get the baccarat value of a hand
 * Returns the last digit of the sum (0-9)
 */
export function getHandValue(hand: Hand): number {
	const sum = hand.cards.reduce((total, card) => total + getCardValue(card), 0);
	return sum % 10;
}

/**
 * Check if a hand is a natural (8 or 9 on initial two cards)
 * Only valid for hands with exactly 2 cards
 */
export function isNatural(hand: Hand): boolean {
	if (hand.cards.length !== 2) {
		return false;
	}
	const value = getHandValue(hand);
	return value >= NATURAL_THRESHOLD;
}

/**
 * Check if the first two cards of a hand form a pair (same rank)
 */
export function isPair(hand: Hand): boolean {
	if (hand.cards.length < 2) {
		return false;
	}
	return hand.cards[0].rank === hand.cards[1].rank;
}

/**
 * Get the baccarat value of a single rank (for testing/display)
 */
export function getRankValue(rank: Rank): number {
	return CARD_VALUES[rank];
}

/**
 * Determine the winner based on hand values
 */
export function determineWinner(
	playerValue: number,
	bankerValue: number,
): 'player' | 'banker' | 'tie' {
	if (playerValue > bankerValue) {
		return 'player';
	}
	if (bankerValue > playerValue) {
		return 'banker';
	}
	return 'tie';
}

/**
 * Check if either hand has a natural
 */
export function hasNatural(playerHand: Hand, bankerHand: Hand): boolean {
	return isNatural(playerHand) || isNatural(bankerHand);
}

/**
 * Get a human-readable description of the hand
 */
export function describeHand(hand: Hand): string {
	const value = getHandValue(hand);
	const cardStr = hand.cards.map((c) => `${c.rank}${getSuitSymbol(c.suit)}`).join(' ');
	const natural = isNatural(hand) ? ' (Natural!)' : '';
	return `${cardStr} = ${value}${natural}`;
}

/**
 * Get suit symbol for display
 */
function getSuitSymbol(suit: Card['suit']): string {
	const symbols: Record<Card['suit'], string> = {
		hearts: '♥',
		diamonds: '♦',
		clubs: '♣',
		spades: '♠',
	};
	return symbols[suit];
}
