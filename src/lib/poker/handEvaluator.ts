/**
 * Hand evaluation utilities for poker
 * Evaluates hand strength for AI decision making (not full hand ranking yet)
 */

import type { Card, Player } from './types';

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

/**
 * Hand ranking values (higher is better)
 */
const HandRank = {
	HIGH_CARD: 1,
	PAIR: 2,
	TWO_PAIR: 3,
	THREE_OF_KIND: 4,
	STRAIGHT: 5,
	FLUSH: 6,
	FULL_HOUSE: 7,
	FOUR_OF_KIND: 8,
	STRAIGHT_FLUSH: 9,
	ROYAL_FLUSH: 10,
} as const;

/**
 * Represents a ranked poker hand with kickers for tie-breaking
 */
interface HandRanking {
	rank: number; // Hand rank (1-10)
	primaryValues: number[]; // Main card values (e.g., trip value for trips)
	kickers: number[]; // Remaining cards for tie-breaking, sorted descending
}

/**
 * Evaluates a 5-card hand and returns its ranking with kickers
 */
function rankFiveCardHand(cards: Card[]): HandRanking {
	if (cards.length !== 5) {
		throw new Error('rankFiveCardHand requires exactly 5 cards');
	}

	// Count values and suits
	const valueCounts: Map<number, number> = new Map();
	const suitCounts: Map<string, number> = new Map();

	for (const card of cards) {
		valueCounts.set(card.rank, (valueCounts.get(card.rank) || 0) + 1);
		suitCounts.set(card.suit, (suitCounts.get(card.suit) || 0) + 1);
	}

	const isFlush = Math.max(...suitCounts.values()) === 5;

	// Check for straight
	const sortedValues = [...valueCounts.keys()].sort((a, b) => b - a);
	let isStraight = false;
	let straightHigh = 0;

	// Check regular straight
	if (sortedValues.length === 5 && sortedValues[0] - sortedValues[4] === 4) {
		isStraight = true;
		straightHigh = sortedValues[0];
	}
	// Check A-2-3-4-5 (wheel) straight
	else if (
		sortedValues.length === 5 &&
		sortedValues[0] === 14 &&
		sortedValues[1] === 5 &&
		sortedValues[2] === 4 &&
		sortedValues[3] === 3 &&
		sortedValues[4] === 2
	) {
		isStraight = true;
		straightHigh = 5; // Ace is low in wheel
	}

	// Straight Flush / Royal Flush
	if (isFlush && isStraight) {
		if (straightHigh === 14) {
			return { rank: HandRank.ROYAL_FLUSH, primaryValues: [14], kickers: [] };
		}
		return { rank: HandRank.STRAIGHT_FLUSH, primaryValues: [straightHigh], kickers: [] };
	}

	// Group by count
	const countGroups: Map<number, number[]> = new Map();
	for (const [value, count] of valueCounts.entries()) {
		if (!countGroups.has(count)) {
			countGroups.set(count, []);
		}
		countGroups.get(count)!.push(value);
	}

	// Sort each group descending
	for (const values of countGroups.values()) {
		values.sort((a, b) => b - a);
	}

	// Four of a Kind
	if (countGroups.has(4)) {
		const quadValue = countGroups.get(4)![0];
		const kicker = countGroups.get(1)![0];
		return { rank: HandRank.FOUR_OF_KIND, primaryValues: [quadValue], kickers: [kicker] };
	}

	// Full House
	if (countGroups.has(3) && countGroups.has(2)) {
		const tripValue = countGroups.get(3)![0];
		const pairValue = countGroups.get(2)![0];
		return { rank: HandRank.FULL_HOUSE, primaryValues: [tripValue, pairValue], kickers: [] };
	}

	// Flush
	if (isFlush) {
		const kickers = sortedValues.slice();
		return { rank: HandRank.FLUSH, primaryValues: [], kickers };
	}

	// Straight
	if (isStraight) {
		return { rank: HandRank.STRAIGHT, primaryValues: [straightHigh], kickers: [] };
	}

	// Three of a Kind
	if (countGroups.has(3)) {
		const tripValue = countGroups.get(3)![0];
		const kickers = (countGroups.get(1) || []).sort((a, b) => b - a);
		return { rank: HandRank.THREE_OF_KIND, primaryValues: [tripValue], kickers };
	}

	// Two Pair
	if (countGroups.has(2) && countGroups.get(2)!.length === 2) {
		const pairs = countGroups.get(2)!.sort((a, b) => b - a);
		const kicker = countGroups.get(1)![0];
		return { rank: HandRank.TWO_PAIR, primaryValues: pairs, kickers: [kicker] };
	}

	// One Pair
	if (countGroups.has(2)) {
		const pairValue = countGroups.get(2)![0];
		const kickers = (countGroups.get(1) || []).sort((a, b) => b - a);
		return { rank: HandRank.PAIR, primaryValues: [pairValue], kickers };
	}

	// High Card
	const kickers = sortedValues.slice();
	return { rank: HandRank.HIGH_CARD, primaryValues: [], kickers };
}

/**
 * Compares two hand rankings. Returns:
 * - Positive if hand1 > hand2
 * - Negative if hand1 < hand2
 * - Zero if tie
 */
function compareHandRankings(hand1: HandRanking, hand2: HandRanking): number {
	// Compare ranks first
	if (hand1.rank !== hand2.rank) {
		return hand1.rank - hand2.rank;
	}

	// Compare primary values
	for (let i = 0; i < Math.max(hand1.primaryValues.length, hand2.primaryValues.length); i++) {
		const val1 = hand1.primaryValues[i] || 0;
		const val2 = hand2.primaryValues[i] || 0;
		if (val1 !== val2) {
			return val1 - val2;
		}
	}

	// Compare kickers
	for (let i = 0; i < Math.max(hand1.kickers.length, hand2.kickers.length); i++) {
		const kick1 = hand1.kickers[i] || 0;
		const kick2 = hand2.kickers[i] || 0;
		if (kick1 !== kick2) {
			return kick1 - kick2;
		}
	}

	return 0; // Perfect tie
}

/**
 * Finds best 5-card hand from 7 cards (2 hole + 5 community)
 */
function findBestHand(cards: Card[]): HandRanking {
	if (cards.length < 5) {
		throw new Error('Need at least 5 cards to evaluate hand');
	}

	if (cards.length === 5) {
		return rankFiveCardHand(cards);
	}

	// Generate all 5-card combinations
	const combinations: Card[][] = [];
	function generateCombos(start: number, combo: Card[]) {
		if (combo.length === 5) {
			combinations.push([...combo]);
			return;
		}
		for (let i = start; i < cards.length; i++) {
			combo.push(cards[i]);
			generateCombos(i + 1, combo);
			combo.pop();
		}
	}
	generateCombos(0, []);

	// Find best combination
	let bestRanking = rankFiveCardHand(combinations[0]);
	for (let i = 1; i < combinations.length; i++) {
		const ranking = rankFiveCardHand(combinations[i]);
		if (compareHandRankings(ranking, bestRanking) > 0) {
			bestRanking = ranking;
		}
	}

	return bestRanking;
}

/**
 * Compares hands and determines winner(s) at showdown using proper hand ranking
 * Returns array of winning players (multiple if perfect tie)
 */
export function determineShowdownWinners(
	activePlayers: Player[],
	communityCards: Card[],
): Player[] {
	if (activePlayers.length === 0) return [];
	if (activePlayers.length === 1) return [activePlayers[0]];

	// Evaluate each player's best hand
	const playerHands = activePlayers.map((player) => {
		const allCards = [...player.hand, ...communityCards];
		return {
			player,
			ranking: findBestHand(allCards),
		};
	});

	// Find the best ranking
	let bestRanking = playerHands[0].ranking;
	for (let i = 1; i < playerHands.length; i++) {
		if (compareHandRankings(playerHands[i].ranking, bestRanking) > 0) {
			bestRanking = playerHands[i].ranking;
		}
	}

	// Return all players with the best ranking (handles perfect ties)
	return playerHands
		.filter((ph) => compareHandRankings(ph.ranking, bestRanking) === 0)
		.map((ph) => ph.player);
}
