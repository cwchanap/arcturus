/**
 * Shared card-formatting helpers.
 *
 * Maps card suits to their display glyphs / colors. Used by both the
 * DOM renderers and the (pure) hand-evaluation and LLM-prompt modules.
 */

export const SUIT_SYMBOLS: Record<string, string> = {
	hearts: '♥',
	diamonds: '♦',
	clubs: '♣',
	spades: '♠',
};

const RED_SUITS = new Set(['hearts', 'diamonds']);

/** Map a suit name to its display glyph, falling back to the raw suit. */
export function getSuitSymbol(suit: string): string {
	return SUIT_SYMBOLS[suit] ?? suit;
}

/**
 * Map a suit name to its display glyph, returning `'?'` for unknown suits.
 *
 * Use this (rather than `getSuitSymbol`) at render sites that previously
 * rendered a literal `'?'` placeholder for unrecognized suits, so that
 * contract is preserved in a single testable place instead of being
 * re-derived inline at each call site.
 */
export function getSuitGlyph(suit: string): string {
	return SUIT_SYMBOLS[suit] === undefined ? '?' : SUIT_SYMBOLS[suit];
}

/** Whether a suit renders in red (hearts / diamonds). */
export function isRedSuit(suit: string): boolean {
	return RED_SUITS.has(suit);
}
