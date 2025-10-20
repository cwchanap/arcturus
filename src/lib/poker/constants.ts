/**
 * Poker game constants
 */

export const STARTING_CHIPS = 1000;
export const SMALL_BLIND = 5;
export const BIG_BLIND = 10;
export const MIN_BET = 10;
export const MAX_BET = 1000;

export const NUM_PLAYERS = 3; // 1 human + 2 AI

export const HAND_RANKINGS = {
	HIGH_CARD: 0,
	PAIR: 1,
	TWO_PAIR: 2,
	THREE_OF_A_KIND: 3,
	STRAIGHT: 4,
	FLUSH: 5,
	FULL_HOUSE: 6,
	FOUR_OF_A_KIND: 7,
	STRAIGHT_FLUSH: 8,
	ROYAL_FLUSH: 9,
} as const;

export const HAND_NAMES = [
	'High Card',
	'Pair',
	'Two Pair',
	'Three of a Kind',
	'Straight',
	'Flush',
	'Full House',
	'Four of a Kind',
	'Straight Flush',
	'Royal Flush',
] as const;

export const CARD_VALUES = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

export const SUITS: Array<'hearts' | 'diamonds' | 'clubs' | 'spades'> = [
	'hearts',
	'diamonds',
	'clubs',
	'spades',
];

// AI delay ranges (milliseconds)
export const AI_DECISION_DELAY_MIN = 800;
export const AI_DECISION_DELAY_MAX = 1500;

// Action animation delay (milliseconds)
export const ACTION_ANIMATION_DELAY = 1000;

// Debounce delay for player actions (milliseconds)
export const ACTION_DEBOUNCE_DELAY = 300;
