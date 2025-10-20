/**
 * Hand evaluation utilities for poker
 * Evaluates hand strength for AI decision making (not full hand ranking yet)
 */

import type { Card } from './types';

/**
 * Evaluates preflop hand strength (0-1 scale)
 */
export function evaluatePreflopHand(card1: Card, card2: Card): number {
	const value1 = card1.rank;
	const value2 = card2.rank;
	const suited = card1.suit === card2.suit;
	const isPair = value1 === value2;

	// Premium pairs (AA, KK, QQ, JJ)
	if (isPair && value1 >= 11) {
		return 0.9 + (value1 - 11) * 0.025; // 0.9-0.975
	}

	// Medium pairs (TT down to 22)
	if (isPair) {
		return 0.6 + (value1 - 2) * 0.03; // 0.6-0.87
	}

	// High cards (AK, AQ, AJ, KQ)
	const high = Math.max(value1, value2);
	const low = Math.min(value1, value2);
	const gap = high - low;

	if (high === 14) {
		// Ace-X hands
		if (low >= 13) return suited ? 0.85 : 0.75; // AK
		if (low >= 12) return suited ? 0.75 : 0.65; // AQ
		if (low >= 11) return suited ? 0.7 : 0.6; // AJ
		if (low >= 10) return suited ? 0.65 : 0.55; // AT
		return suited ? 0.45 : 0.35; // A-low
	}

	if (high === 13) {
		// King-X hands
		if (low >= 12) return suited ? 0.7 : 0.6; // KQ
		if (low >= 11) return suited ? 0.65 : 0.55; // KJ
		if (low >= 10) return suited ? 0.6 : 0.5; // KT
		return suited ? 0.4 : 0.3;
	}

	// Suited connectors
	if (suited && gap <= 1 && low >= 7) {
		return 0.55; // 9-8 suited and better
	}

	if (suited && gap <= 2 && low >= 6) {
		return 0.45; // One-gap suited connectors
	}

	// Default: weak hand
	if (suited) return 0.35;
	return 0.25;
}

/**
 * Evaluates postflop hand strength (0-1 scale)
 * Simplified evaluation - just counts pairs, trips, etc.
 */
export function evaluatePostflopHand(hand: Card[], communityCards: Card[]): number {
	const allCards = [...hand, ...communityCards];
	if (allCards.length < 5) {
		// Not enough cards, use preflop evaluation
		return hand.length >= 2 ? evaluatePreflopHand(hand[0], hand[1]) : 0.25;
	}

	// Count value frequencies
	const valueCounts: Record<number, number> = {};
	const suitCounts: Record<string, number> = {};

	for (const card of allCards) {
		valueCounts[card.rank] = (valueCounts[card.rank] || 0) + 1;
		suitCounts[card.suit] = (suitCounts[card.suit] || 0) + 1;
	}

	const counts = Object.values(valueCounts).sort((a, b) => b - a);
	const maxSuitCount = Math.max(...Object.values(suitCounts));

	// Check for flush
	const hasFlush = maxSuitCount >= 5;

	// Check for straight (simplified - doesn't handle A-5)
	const sortedValues = Object.keys(valueCounts)
		.map(Number)
		.sort((a, b) => b - a);
	let hasStraight = false;
	for (let i = 0; i <= sortedValues.length - 5; i++) {
		if (sortedValues[i] - sortedValues[i + 4] === 4) {
			hasStraight = true;
			break;
		}
	}

	// Evaluate hand
	if (counts[0] === 4) return 0.95; // Four of a kind
	if (counts[0] === 3 && counts[1] === 2) return 0.9; // Full house
	if (hasFlush && hasStraight) return 0.99; // Straight flush
	if (hasFlush) return 0.85; // Flush
	if (hasStraight) return 0.8; // Straight
	if (counts[0] === 3) return 0.7; // Three of a kind
	if (counts[0] === 2 && counts[1] === 2) return 0.6; // Two pair
	if (counts[0] === 2) return 0.45; // Pair

	// High card - check if we have high cards
	const maxValue = Math.max(...allCards.map((c) => c.rank));
	if (maxValue >= 14) return 0.35; // Ace high
	if (maxValue >= 13) return 0.3; // King high
	return 0.25; // Low cards
}

/**
 * Calculates pot odds for decision making
 */
export function calculatePotOdds(callAmount: number, potSize: number): number {
	if (callAmount === 0) return 1.0; // Free card
	return callAmount / (potSize + callAmount);
}

/**
 * Estimates outs and equity (simplified)
 */
export function estimateDrawingOuts(hand: Card[], communityCards: Card[]): number {
	const allCards = [...hand, ...communityCards];

	// Count suits and values
	const suitCounts: Record<string, number> = {};
	const valueCounts: Record<number, number> = {};

	for (const card of allCards) {
		suitCounts[card.suit] = (suitCounts[card.suit] || 0) + 1;
		valueCounts[card.rank] = (valueCounts[card.rank] || 0) + 1;
	}

	let outs = 0;

	// Flush draw (4 of same suit)
	const maxSuitCount = Math.max(...Object.values(suitCounts));
	if (maxSuitCount === 4) {
		outs += 9; // 9 cards to complete flush
	}

	// Open-ended straight draw (simplified)
	const sortedValues = Object.keys(valueCounts)
		.map(Number)
		.sort((a, b) => b - a);
	for (let i = 0; i <= sortedValues.length - 4; i++) {
		if (sortedValues[i] - sortedValues[i + 3] === 3) {
			outs += 8; // 8 cards to complete straight
			break;
		}
	}

	// Pair with overcard
	const counts = Object.values(valueCounts);
	if (counts.includes(2)) {
		outs += 2; // 2 cards to improve pair
	}

	return outs;
}
