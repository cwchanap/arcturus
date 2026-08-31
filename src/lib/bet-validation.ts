/**
 * Bet Validation Logic
 *
 * Pure function for validating bet amounts against min/max limits.
 * Used across game modules for consistent bet validation.
 */

/**
 * Language-neutral bet validation result. Games translate these codes at
 * their presentation boundary; no English copy lives in shared validation.
 */
export type BetValidationCode = 'invalid-limits' | 'invalid-range' | 'out-of-range';

/**
 * Validates a bet amount against minimum and maximum limits.
 *
 * @param amount - The bet amount to validate
 * @param minBet - The minimum allowed bet
 * @param maxBet - The maximum allowed bet
 * @returns A language-neutral failure code, or null if valid
 */
export function validateBetCode(
	amount: number,
	minBet: number,
	maxBet: number,
): BetValidationCode | null {
	// Validate minBet and maxBet are valid numbers
	if (
		Number.isNaN(minBet) ||
		Number.isNaN(maxBet) ||
		!Number.isFinite(minBet) ||
		!Number.isFinite(maxBet)
	) {
		return 'invalid-limits';
	}
	// Validate minBet <= maxBet
	if (minBet > maxBet) {
		return 'invalid-range';
	}
	// Validate amount is within range
	if (!Number.isFinite(amount) || Number.isNaN(amount) || amount < minBet || amount > maxBet) {
		return 'out-of-range';
	}
	return null;
}

/**
 * Legacy English wrapper kept only for unmigrated callers. Migrated games use
 * {@link validateBetCode} and translate the code themselves; delete this
 * function once every caller has migrated.
 *
 * @param amount - The bet amount to validate
 * @param minBet - The minimum allowed bet
 * @param maxBet - The maximum allowed bet
 * @returns Error message if invalid, null if valid
 */
export function validateBet(amount: number, minBet: number, maxBet: number): string | null {
	const code = validateBetCode(amount, minBet, maxBet);
	if (code === 'invalid-limits') return 'Invalid bet limits';
	if (code === 'invalid-range') return 'Invalid bet range';
	if (code === 'out-of-range') return `Bet must be between ${minBet} and ${maxBet} chips`;
	return null;
}
