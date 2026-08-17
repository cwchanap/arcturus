/**
 * Hand evaluation utilities for poker
 * Evaluates hand strength for AI decision making (not full hand ranking yet)
 */

import {
	compareFiveCardRankings,
	rankFiveCardHand,
	type FiveCardRanking,
} from '../five-card-poker';
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
 * Returns true if the given ranks contain a 5-card straight (including the
 * A-2-3-4-5 wheel where the ace plays low). Used both for the overall hand
 * and for verifying that a flush suit's cards actually form a straight flush.
 */
function ranksHaveStraight(ranks: number[]): boolean {
	if (ranks.length < 5) return false;
	const sorted = [...new Set(ranks)].sort((a, b) => b - a);
	for (let i = 0; i <= sorted.length - 5; i++) {
		if (sorted[i] - sorted[i + 4] === 4) return true;
	}
	// Wheel: A-2-3-4-5. Ace (14) plus 5-4-3-2.
	const rankSet = new Set(sorted);
	if (rankSet.has(14) && rankSet.has(5) && rankSet.has(4) && rankSet.has(3) && rankSet.has(2)) {
		return true;
	}
	return false;
}

/**
 * Evaluates postflop hand strength (0-1 scale)
 * Detects flushes, straights, straight flushes, and pair/trips/quads counts.
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

	// Check for straight across all ranks.
	const sortedValues = Object.keys(valueCounts).map(Number);
	const hasStraight = ranksHaveStraight(sortedValues);

	// A straight flush requires the straight to be in the flush suit.
	// hasFlush && hasStraight can both be true when the flush and straight
	// use different cards, so we verify the flush-suit ranks contain a
	// straight before reporting a straight flush.
	let hasStraightFlush = false;
	if (hasFlush && hasStraight) {
		const flushSuit = (Object.entries(suitCounts).find(([, count]) => count >= 5) ?? [
			'',
		])[0] as string;
		const flushRanks = allCards.filter((c) => c.suit === flushSuit).map((c) => c.rank);
		hasStraightFlush = ranksHaveStraight(flushRanks);
	}

	// Evaluate hand (highest to lowest strength)
	if (hasStraightFlush) return 0.99; // Straight flush
	if (counts[0] === 4) return 0.95; // Four of a kind
	if (counts[0] === 3 && counts[1] >= 2) return 0.9; // Full house (incl. two trips)
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

	// Detect an already-made straight so we don't count straight-draw outs
	// behind a completed hand. Shares the same helper as evaluatePostflopHand
	// so the two code paths stay consistent.
	const sortedValues = Object.keys(valueCounts)
		.map(Number)
		.sort((a, b) => b - a);
	const hasStraight = ranksHaveStraight(sortedValues);

	// Flush draw (4 of same suit). A made flush (5+) is naturally excluded
	// since maxSuitCount would be >= 5, not === 4.
	const maxSuitCount = Math.max(...Object.values(suitCounts));
	if (maxSuitCount === 4) {
		outs += 9; // 9 cards to complete flush
	}

	// Open-ended straight draw (simplified). Skip when a straight is already
	// made — the draw is irrelevant behind the completed hand.
	if (!hasStraight) {
		for (let i = 0; i <= sortedValues.length - 4; i++) {
			if (sortedValues[i] - sortedValues[i + 3] === 3) {
				outs += 8; // 8 cards to complete straight
				break;
			}
		}

		// Wheel draw: A-2-3-4 (ace plays low) needs a 5 to complete A-2-3-4-5.
		// This is a one-ended draw (4 outs), not an open-ender, and is missed by
		// the consecutive-rank check above because the ace sits at rank 14.
		// !hasStraight already implies no 5 is present (A-2-3-4-5 would be a made
		// wheel straight), so no extra guard is needed.
		if (valueCounts[14] && valueCounts[4] && valueCounts[3] && valueCounts[2]) {
			outs += 4; // 4 fives to complete the wheel
		}
	}

	// Pair-to-trips draw: only count when the player has a single pair and no
	// trips/quads already made (otherwise the pair is either the made hand being
	// double-counted or irrelevant behind a stronger made hand).
	const counts = Object.values(valueCounts);
	const pairCount = counts.filter((c) => c === 2).length;
	const hasTripsOrBetter = counts.some((c) => c >= 3);
	if (pairCount === 1 && !hasTripsOrBetter) {
		outs += 2; // 2 cards to improve the pair to trips
	}

	return outs;
}

/**
 * Finds best 5-card hand from 7 cards (2 hole + 5 community)
 */
function findBestHand(cards: Card[]): FiveCardRanking {
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
		if (compareFiveCardRankings(ranking, bestRanking) > 0) {
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
		if (compareFiveCardRankings(playerHands[i].ranking, bestRanking) > 0) {
			bestRanking = playerHands[i].ranking;
		}
	}

	// Return all players with the best ranking (handles perfect ties)
	return playerHands
		.filter((ph) => compareFiveCardRankings(ph.ranking, bestRanking) === 0)
		.map((ph) => ph.player);
}
