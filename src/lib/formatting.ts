/**
 * Formatting Utilities
 *
 * Utility functions for formatting values like currency, chip balances, etc.
 * Numeric presentation is locale-aware; the `Locale` type comes from the i18n
 * locale model and defaults to English.
 */

import type { Locale } from './i18n/locale';

/**
 * Formats a number for the given locale (grouping separators, decimals)
 * @param value - The number to format
 * @param locale - Locale used for number formatting (default: 'en')
 * @returns Formatted string (e.g., "1,234.56")
 */
export function formatChipBalance(value: number, locale: Locale = 'en'): string {
	return new Intl.NumberFormat(locale).format(value);
}

function requireFinite(value: number): number {
	if (!Number.isFinite(value)) throw new RangeError('Value must be finite');
	return value;
}

export function formatWholeNumber(value: number, locale: Locale = 'en'): string {
	if (!Number.isSafeInteger(value)) throw new RangeError('Value must be a safe integer');
	return new Intl.NumberFormat(locale).format(value);
}

/**
 * Formats a finite number (including decimals) for the given locale. Unlike
 * {@link formatWholeNumber}, this accepts fractional values such as 12.5
 * without throwing, while still rejecting NaN/Infinity.
 */
export function formatDecimal(value: number, locale: Locale = 'en'): string {
	return new Intl.NumberFormat(locale).format(requireFinite(value));
}

export function formatPercentage(value: number, locale: Locale = 'en'): string {
	return `${new Intl.NumberFormat(locale, {
		minimumFractionDigits: 1,
		maximumFractionDigits: 1,
	}).format(requireFinite(value))}%`;
}

const MAX_FRACTION_DIGITS = 100;

/**
 * Formats a number with decimal places
 * @param value - The number to format
 * @param minimumFractionDigits - Minimum decimal places (default: 2)
 * @param maximumFractionDigits - Maximum decimal places (default: 2)
 * @param locale - Locale used for number formatting (default: 'en')
 * @returns Formatted string (e.g., "1,234.50")
 */
export function formatChipBalanceWithDecimals(
	value: number,
	minimumFractionDigits = 2,
	maximumFractionDigits = 2,
	locale: Locale = 'en',
): string {
	// Sanitize inputs to handle NaN values
	const sanitizedMin = Number.isNaN(minimumFractionDigits) ? 0 : minimumFractionDigits;
	const sanitizedMax = Number.isNaN(maximumFractionDigits) ? 0 : maximumFractionDigits;

	// Clamp values to valid range [0, MAX_FRACTION_DIGITS]
	const minDigits = Math.min(MAX_FRACTION_DIGITS, Math.max(0, Math.floor(sanitizedMin)));
	const maxDigits = Math.min(MAX_FRACTION_DIGITS, Math.max(0, Math.floor(sanitizedMax)));

	// Ensure minimumFractionDigits <= maximumFractionDigits
	const finalMinDigits = Math.min(minDigits, maxDigits);

	return new Intl.NumberFormat(locale, {
		minimumFractionDigits: finalMinDigits,
		maximumFractionDigits: maxDigits,
	}).format(value);
}

/** Locale-aware short date, e.g. "Jan 5, 2026" (en). */
export function formatShortDate(value: Date, locale: Locale = 'en'): string {
	return new Intl.DateTimeFormat(locale, {
		month: 'short',
		day: 'numeric',
		year: 'numeric',
	}).format(value);
}
