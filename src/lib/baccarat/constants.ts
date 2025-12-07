/**
 * Baccarat game constants
 * Based on data-model.md specification
 */

import type { BaccaratSettings, Rank } from './types';

// Deck management
export const DECK_COUNT = 8;
export const RESHUFFLE_THRESHOLD = 20;
export const CARDS_PER_DECK = 52;
export const TOTAL_CARDS = DECK_COUNT * CARDS_PER_DECK; // 416 cards

// Betting limits
export const DEFAULT_MIN_BET = 10;
export const DEFAULT_MAX_BET = 5000;
export const DEFAULT_STARTING_CHIPS = 1000;

// History
export const MAX_HISTORY_LENGTH = 20;

// Payout multipliers
export const PAYOUTS = {
	player: 1.0, // 1:1
	banker: 0.95, // 1:1 minus 5% commission
	tie: 8.0, // 8:1
	playerPair: 11.0, // 11:1
	bankerPair: 11.0, // 11:1
} as const;

// Card values for baccarat (different from blackjack)
export const CARD_VALUES: Record<Rank, number> = {
	A: 1,
	'2': 2,
	'3': 3,
	'4': 4,
	'5': 5,
	'6': 6,
	'7': 7,
	'8': 8,
	'9': 9,
	'10': 0,
	J: 0,
	Q: 0,
	K: 0,
} as const;

// Third card thresholds
export const PLAYER_DRAW_THRESHOLD = 5; // Player draws on 0-5
export const BANKER_STAND_THRESHOLD = 7; // Banker always stands on 7
export const NATURAL_THRESHOLD = 8; // 8 or 9 is natural

// Animation speeds (milliseconds)
export const ANIMATION_SPEED_SLOW = 1500;
export const ANIMATION_SPEED_NORMAL = 1000;
export const ANIMATION_SPEED_FAST = 500;

// Default settings
export const DEFAULT_SETTINGS: BaccaratSettings = {
	startingChips: DEFAULT_STARTING_CHIPS,
	minBet: DEFAULT_MIN_BET,
	maxBet: DEFAULT_MAX_BET,
	animationSpeed: 'normal',
	llmEnabled: false,
	soundEnabled: true,
};

// Suits for deck creation
export const SUITS: readonly ['hearts', 'diamonds', 'clubs', 'spades'] = [
	'hearts',
	'diamonds',
	'clubs',
	'spades',
] as const;

// Ranks for deck creation
export const RANKS: readonly Rank[] = [
	'A',
	'2',
	'3',
	'4',
	'5',
	'6',
	'7',
	'8',
	'9',
	'10',
	'J',
	'Q',
	'K',
] as const;

// All constants grouped for convenience
export const BACCARAT_CONSTANTS = {
	DECK_COUNT,
	RESHUFFLE_THRESHOLD,
	DEFAULT_MIN_BET,
	DEFAULT_MAX_BET,
	DEFAULT_STARTING_CHIPS,
	MAX_HISTORY_LENGTH,
	PAYOUTS,
	CARD_VALUES,
} as const;
