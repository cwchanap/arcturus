/**
 * Baccarat game type definitions
 * Based on data-model.md specification
 */

export type Rank = 'A' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '10' | 'J' | 'Q' | 'K';
export type Suit = 'hearts' | 'diamonds' | 'clubs' | 'spades';

export interface Card {
	rank: Rank;
	suit: Suit;
}

export interface Hand {
	cards: Card[];
}

export type BetType = 'player' | 'banker' | 'tie' | 'playerPair' | 'bankerPair';

export interface Bet {
	type: BetType;
	amount: number;
}

export type BetOutcome = 'win' | 'lose' | 'push';

export interface BetResult {
	bet: Bet;
	outcome: BetOutcome;
	payout: number; // Amount won (positive) or lost (negative)
}

export type Winner = 'player' | 'banker' | 'tie';

export interface RoundOutcome {
	winner: Winner;
	playerHand: Hand;
	bankerHand: Hand;
	playerValue: number;
	bankerValue: number;
	playerPair: boolean;
	bankerPair: boolean;
	isNatural: boolean;
	betResults: BetResult[];
	timestamp: number;
}

export type GamePhase =
	| 'betting' // Accepting bets
	| 'dealing' // Initial 4 cards being dealt
	| 'playerThird' // Player third card (if applicable)
	| 'bankerThird' // Banker third card (if applicable)
	| 'resolution'; // Determining winner, processing payouts

export type AnimationSpeed = 'slow' | 'normal' | 'fast';

export interface BaccaratSettings {
	startingChips: number;
	minBet: number;
	maxBet: number;
	animationSpeed: AnimationSpeed;
	llmEnabled: boolean;
	soundEnabled: boolean;
}

export interface BaccaratGameState {
	phase: GamePhase;
	playerHand: Hand;
	bankerHand: Hand;
	activeBets: Bet[];
	chipBalance: number;
	roundHistory: RoundOutcome[]; // Last 20 rounds
	shoeCardsRemaining: number;
	settings: BaccaratSettings;
}

export interface DeckState {
	cards: Card[];
	deckCount: number;
	reshuffleThreshold: number;
}

export interface LLMBaccaratContext {
	roundHistory: RoundOutcome[];
	currentBets: Bet[];
	chipBalance: number;
	shoeCardsRemaining: number;
	query?: string;
}

export type LLMConfidence = 'low' | 'medium' | 'high';

export interface LLMBaccaratResponse {
	advice: string;
	confidence?: LLMConfidence;
	suggestedBets?: BetType[];
}

/**
 * Baccarat error types for validation
 */
export type BaccaratErrorCode =
	| 'BET_BELOW_MIN'
	| 'BET_ABOVE_MAX'
	| 'INSUFFICIENT_BALANCE'
	| 'INVALID_PHASE'
	| 'NO_BETS_PLACED'
	| 'DUPLICATE_BET';

export interface BaccaratError {
	code: BaccaratErrorCode;
	message: string;
	details?: Record<string, unknown>;
}

/**
 * Game event handlers for UI integration
 */
export interface BaccaratGameEvents {
	onBetPlaced: (bet: Bet) => void;
	onBetRemoved: (type: BetType) => void;
	onDealStart: () => void;
	onCardDealt: (card: Card, target: 'player' | 'banker', position: number) => void;
	onNatural: (hand: 'player' | 'banker', value: number) => void;
	onThirdCard: (target: 'player' | 'banker', card: Card) => void;
	onRoundComplete: (outcome: RoundOutcome) => void;
	onBalanceUpdate: (newBalance: number) => void;
	onShoeReshuffle: () => void;
	onError: (error: BaccaratError) => void;
}

/**
 * Configuration for BaccaratGame initialization
 */
export interface BaccaratGameConfig {
	initialBalance: number;
	settings?: Partial<BaccaratSettings>;
	events?: Partial<BaccaratGameEvents>;
}
