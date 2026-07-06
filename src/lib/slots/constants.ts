import type { SymbolDef, SymbolId, SlotSettings, SpinSpeed } from './types';

export const NUM_REELS = 5;
export const NUM_ROWS = 3;
export const NUM_PAYLINES = 5;

export const SYMBOLS: Record<SymbolId, SymbolDef> = {
	seven: { id: 'seven', label: 'Seven', glyph: '7️⃣', weight: 3 },
	bell: { id: 'bell', label: 'Bell', glyph: '🔔', weight: 6 },
	bar: { id: 'bar', label: 'BAR', glyph: 'BAR', weight: 9 },
	melon: { id: 'melon', label: 'Watermelon', glyph: '🍉', weight: 12 },
	grapes: { id: 'grapes', label: 'Grapes', glyph: '🍇', weight: 18 },
	lemon: { id: 'lemon', label: 'Lemon', glyph: '🍋', weight: 24 },
	cherry: { id: 'cherry', label: 'Cherry', glyph: '🍒', weight: 28 },
};

export const SYMBOL_ORDER: readonly SymbolId[] = [
	'seven',
	'bell',
	'bar',
	'melon',
	'grapes',
	'lemon',
	'cherry',
];

/** One row index (0=top, 1=middle, 2=bottom) per reel. */
export const PAYLINES: readonly (readonly number[])[] = [
	[1, 1, 1, 1, 1],
	[0, 0, 0, 0, 0],
	[2, 2, 2, 2, 2],
	[0, 1, 2, 1, 0],
	[2, 1, 0, 1, 2],
];

/** Per-line multipliers. Every value is a multiple of NUM_PAYLINES so payouts stay integral. */
export const PAYTABLE: Record<SymbolId, { 3: number; 4: number; 5: number }> = {
	seven: { 3: 60, 4: 300, 5: 1000 },
	bell: { 3: 40, 4: 120, 5: 400 },
	bar: { 3: 30, 4: 90, 5: 300 },
	melon: { 3: 25, 4: 60, 5: 200 },
	grapes: { 3: 20, 4: 50, 5: 150 },
	lemon: { 3: 10, 4: 30, 5: 100 },
	cherry: { 3: 10, 4: 30, 5: 80 },
};

export const MIN_BET = 1;
export const MAX_BET = 100;
export const BET_INCREMENTS: readonly number[] = [1, 5, 10, 25, 50, 100];
export const MAX_HISTORY = 20;

export const DEFAULT_SETTINGS: SlotSettings = {
	spinSpeed: 'normal',
	soundEnabled: true,
	quickSpin: false,
};

export function getSpinDurationMs(speed: SpinSpeed): number {
	switch (speed) {
		case 'slow':
			return 1800;
		case 'fast':
			return 600;
		default:
			return 1100;
	}
}
