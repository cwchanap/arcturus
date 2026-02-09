/**
 * Balance Parsing Logic
 *
 * Parses balance strings with commas and currency symbols into numbers.
 */

export function parseBalance(text: string): number | null {
	const trimmed = text.trim();
	// Detect accounting-style parentheses: ( $1,234.56 ) indicates negative
	const isAccountingNegative = trimmed.startsWith('(') && trimmed.endsWith(')');
	// Strip parentheses if present for further processing
	const normalized = isAccountingNegative
		? trimmed.slice(1, -1).replace(/,/g, '').trim()
		: trimmed.replace(/,/g, '');
	// Match optional minus sign, optional $, then digits and optional decimals
	const match = normalized.match(/-?\$?\d+(?:\.\d+)?/);
	if (!match) return null;
	const numericValue = Number(match[0].replace('$', ''));
	// Apply negative sign for accounting-style parentheses
	return isAccountingNegative ? -numericValue : numericValue;
}
