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
	// Defensive validation: ensure values are non-negative integers
	const minDigits = Math.max(0, Math.floor(minimumFractionDigits));
	const maxDigits = Math.max(0, Math.floor(maximumFractionDigits));

	// Ensure minimumFractionDigits <= maximumFractionDigits
	const finalMinDigits = minDigits > maxDigits ? maxDigits : minDigits;
	const finalMaxDigits = maxDigits;

	return new Intl.NumberFormat('en-US', {
		minimumFractionDigits: finalMinDigits,
		maximumFractionDigits: finalMaxDigits,
	}).format(value);
}
