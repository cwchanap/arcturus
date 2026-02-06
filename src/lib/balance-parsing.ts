/**
 * Balance Parsing Logic
 *
 * Parses balance strings with commas and currency symbols into numbers.
 */

export function parseBalance(text: string): number | null {
	const normalized = text.replace(/,/g, '');
	// Match optional minus sign, optional $, then digits and optional decimals
	const match = normalized.match(/-?\$?\d+(?:\.\d+)?/);
	if (!match) return null;
	return Number(match[0].replace('$', ''));
}
