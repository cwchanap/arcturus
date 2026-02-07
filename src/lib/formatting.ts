/**
 * Formatting Utilities
 *
 * Utility functions for formatting values like currency, chip balances, etc.
 */

/**
 * Formats a number as US locale (with commas for thousands)
 * @param value - The number to format
 * @returns Formatted string (e.g., "1,234.56")
 */
export function formatChipBalance(value: number): string {
	return new Intl.NumberFormat('en-US').format(value);
}

const MAX_FRACTION_DIGITS = 100;

/**
 * Formats a number with decimal places
 * @param value - The number to format
 * @param minimumFractionDigits - Minimum decimal places (default: 2)
 * @param maximumFractionDigits - Maximum decimal places (default: 2)
 * @returns Formatted string (e.g., "1,234.50")
 */
export function formatChipBalanceWithDecimals(
	value: number,
	minimumFractionDigits = 2,
	maximumFractionDigits = 2,
): string {
	// Sanitize inputs to handle NaN values
	const sanitizedMin = Number.isNaN(minimumFractionDigits) ? 0 : minimumFractionDigits;
	const sanitizedMax = Number.isNaN(maximumFractionDigits) ? 0 : maximumFractionDigits;

	// Clamp values to valid range [0, MAX_FRACTION_DIGITS]
	const minDigits = Math.min(MAX_FRACTION_DIGITS, Math.max(0, Math.floor(sanitizedMin)));
	const maxDigits = Math.min(MAX_FRACTION_DIGITS, Math.max(0, Math.floor(sanitizedMax)));

	// Ensure minimumFractionDigits <= maximumFractionDigits
	const finalMinDigits = Math.min(minDigits, maxDigits);

	return new Intl.NumberFormat('en-US', {
		minimumFractionDigits: finalMinDigits,
		maximumFractionDigits: maxDigits,
	}).format(value);
}
