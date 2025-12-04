/**
 * Blackjack game type definitions
 */

export type Rank = 'A' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '10' | 'J' | 'Q' | 'K';
export type Suit = 'hearts' | 'diamonds' | 'clubs' | 'spades';

export interface Card {
	rank: Rank;
	suit: Suit;
}

export interface Hand {
	cards: Card[];
	bet: number;
	isDealer: boolean;
}

export type GamePhase = 'betting' | 'dealing' | 'player-turn' | 'dealer-turn' | 'complete';

export type BlackjackAction = 'hit' | 'stand' | 'double-down' | 'split' | 'ask-ai';

export type RoundResult = 'win' | 'loss' | 'push' | 'blackjack';

export interface BlackjackGameState {
	phase: GamePhase;
	playerHands: Hand[];
	activeHandIndex: number;
	dealerHand: Hand;
	playerBalance: number;
	pot: number;
}

export interface RoundOutcome {
	handIndex: number;
	result: RoundResult;
	payout: number;
}

export type DealerSpeed = 'slow' | 'normal' | 'fast';

export interface BlackjackSettings {
	startingChips: number;
	minBet: number;
	maxBet: number;
	dealerSpeed: DealerSpeed;
	useLLM: boolean;
}

export interface HandValue {
	value: number;
	isSoft: boolean;
	isBust: boolean;
}

/**
 * Detailed availability info for an action, including reason if unavailable
 */
export interface ActionAvailability {
	available: boolean;
	reason?: string;
}
