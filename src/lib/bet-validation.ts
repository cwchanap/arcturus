/**
 * Bet Validation Logic
 *
 * Pure function for validating bet amounts against min/max limits.
 * Used across game modules for consistent bet validation.
 */

/**
 * Validates a bet amount against minimum and maximum limits.
 *
 * @param amount - The bet amount to validate
 * @param minBet - The minimum allowed bet
 * @param maxBet - The maximum allowed bet
 * @returns Error message if invalid, null if valid
 */
export function validateBet(amount: number, minBet: number, maxBet: number): string | null {
	// Validate minBet and maxBet are valid numbers
	if (
		Number.isNaN(minBet) ||
		Number.isNaN(maxBet) ||
		!Number.isFinite(minBet) ||
		!Number.isFinite(maxBet)
	) {
		return 'Invalid bet limits';
	}
	// Validate minBet <= maxBet
	if (minBet > maxBet) {
		return 'Invalid bet range';
	}
	// Validate amount is within range
	if (Number.isNaN(amount) || amount < minBet || amount > maxBet) {
		return 'Bet must be between ' + minBet + ' and ' + maxBet + ' chips';
	}
	return null;
}
