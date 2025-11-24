/**
 * Dealer strategy for Blackjack
 * Standard casino rules: Hit on 16 or less, stand on 17 or more
 */

import type { Hand } from './types';
import { calculateHandValue } from './handEvaluator';
import { DEALER_HIT_THRESHOLD, DEALER_STAND_THRESHOLD } from './constants';

/**
 * Determine if dealer should hit based on hand value
 * Standard rule: Dealer hits on 16 or less, stands on 17 or more
 * @param dealerHand - The dealer's hand
 * @returns true if dealer should hit, false if dealer should stand
 */
export function shouldDealerHit(dealerHand: Hand): boolean {
	const handValue = calculateHandValue(dealerHand.cards);

	// If busted, don't hit
	if (handValue.isBust) {
		return false;
	}

	// Hit on 16 or less, stand on 17 or more
	return handValue.value <= DEALER_HIT_THRESHOLD;
}

/**
 * Determine if dealer should stand based on hand value
 * @param dealerHand - The dealer's hand
 * @returns true if dealer should stand, false otherwise
 */
export function shouldDealerStand(dealerHand: Hand): boolean {
	const handValue = calculateHandValue(dealerHand.cards);

	// If busted, stand (game over)
	if (handValue.isBust) {
		return true;
	}

	// Stand on 17 or more
	return handValue.value >= DEALER_STAND_THRESHOLD;
}
