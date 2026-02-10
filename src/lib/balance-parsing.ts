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
	// Normalize the captured string: strip parentheses, dollar sign and commas
	let cleaned = match[0].replace('$', '').replace(/,/g, '');
	// If accounting negative, remove any leading '-' from the cleaned string
	// (so "-$100" inside parentheses becomes "100", then we apply the negative)
	if (isAccountingNegative) {
		cleaned = cleaned.replace(/^-/, '');
	}
	const numericValue = Number(cleaned);
	// Apply negative sign for accounting-style parentheses
	return isAccountingNegative ? -numericValue : numericValue;
}
