/**
 * Blackjack game constants
 */

import type { BlackjackSettings } from './types';

// Betting limits
export const DEFAULT_MIN_BET = 10;
export const DEFAULT_MAX_BET = 1000;
export const DEFAULT_STARTING_CHIPS = 1000;

// Absolute maximum bet (enforced by server API payout caps)
// This cap ensures legitimate payouts (split + double + blackjack = 6x bet max)
// never exceed the server's GAME_LIMITS.blackjack.maxWin limit.
// Changing this requires updating /api/chips/update.ts limits as well.
export const ABSOLUTE_MAX_BET = 10000;

// Maximum positive chip delta allowed per API request
// Must match GAME_LIMITS.blackjack.maxWin in /api/chips/update.ts
// Used to validate starting chip changes before sending to server
export const MAX_CHIP_SYNC_DELTA = 60000;

// Payout multipliers
export const BLACKJACK_PAYOUT = 1.5; // 3:2 payout
export const WIN_PAYOUT = 1.0; // 1:1 payout
export const PUSH_PAYOUT = 0; // Return original bet

// Deck management
export const RESHUFFLE_THRESHOLD = 15; // Reshuffle when fewer than 15 cards remain

// Dealer rules
export const DEALER_HIT_THRESHOLD = 16; // Dealer hits on 16 or less
export const DEALER_STAND_THRESHOLD = 17; // Dealer stands on 17 or more

// Hand values
export const BLACKJACK_VALUE = 21;
export const ACE_HIGH_VALUE = 11;
export const ACE_LOW_VALUE = 1;
export const FACE_CARD_VALUE = 10;

// Animation speeds (milliseconds)
export const DEALER_SPEED_SLOW = 1500;
export const DEALER_SPEED_NORMAL = 1000;
export const DEALER_SPEED_FAST = 500;

// Default settings
export const DEFAULT_SETTINGS: BlackjackSettings = {
	startingChips: DEFAULT_STARTING_CHIPS,
	minBet: DEFAULT_MIN_BET,
	maxBet: DEFAULT_MAX_BET,
	dealerSpeed: 'normal',
	useLLM: false,
};

// Card values for quick lookup
export const CARD_VALUES: Record<string, number> = {
	'2': 2,
	'3': 3,
	'4': 4,
	'5': 5,
	'6': 6,
	'7': 7,
	'8': 8,
	'9': 9,
	'10': 10,
	J: 10,
	Q: 10,
	K: 10,
	A: 11, // Default to high value, adjusted in hand evaluation
};
