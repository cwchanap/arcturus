/**
 * Poker game type definitions
 */

export type Suit = 'hearts' | 'diamonds' | 'clubs' | 'spades';

export type Card = {
	value: string;
	suit: Suit;
	rank: number; // 2-14 (2-10, J=11, Q=12, K=13, A=14)
};

export type GamePhase =
	| 'idle'
	| 'dealing'
	| 'preflop'
	| 'flop'
	| 'turn'
	| 'river'
	| 'showdown'
	| 'complete';

export type PlayerAction = 'fold' | 'check' | 'call' | 'raise';

export type BettingRound = 'preflop' | 'flop' | 'turn' | 'river';

/**
 * Game settings for poker configuration
 */
export interface GameSettings {
	startingChips: number;
	smallBlind: number;
	bigBlind: number;
	aiSpeed: 'slow' | 'normal' | 'fast';
	aiPersonality1: 'tight-aggressive' | 'loose-aggressive' | 'tight-passive' | 'loose-passive';
	aiPersonality2: 'tight-aggressive' | 'loose-aggressive' | 'tight-passive' | 'loose-passive';
	useLLMAI: boolean; // Enable LLM-powered AI opponents
}

export const DEFAULT_SETTINGS: GameSettings = {
	startingChips: 500,
	smallBlind: 5,
	bigBlind: 10,
	aiSpeed: 'normal',
	aiPersonality1: 'tight-aggressive',
	aiPersonality2: 'loose-aggressive',
	useLLMAI: false, // Default to rule-based AI
};

export interface Player {
	id: number;
	name: string;
	chips: number;
	hand: Card[];
	currentBet: number; // Current bet in this round
	totalBet: number; // Total bet in this hand
	folded: boolean;
	isAllIn: boolean;
	isDealer: boolean;
	isAI: boolean;
	hasActed: boolean; // Whether player has acted in current betting round
}

export interface GameState {
	players: Player[];
	communityCards: Card[];
	pot: number;
	phase: GamePhase;
	bettingRound: BettingRound | null;
	currentPlayerIndex: number;
	dealerIndex: number;
	smallBlindIndex: number;
	bigBlindIndex: number;
	minimumBet: number;
	lastRaiseAmount: number;
}

export interface HandEvaluation {
	rank: number; // 0-9 (High Card to Royal Flush)
	name: string;
	cards: Card[]; // The 5 cards that make up the hand
	tieBreakers: number[]; // Ranks for breaking ties (e.g., kickers)
}

export interface AIDecision {
	action: PlayerAction;
	amount?: number;
	confidence?: number; // 0-1 scale
	reasoning?: string; // For debug/telemetry
}

export interface GameContext {
	player: Player;
	players: Player[];
	communityCards: Card[];
	pot: number;
	minimumBet: number;
	phase: GamePhase;
	bettingRound: BettingRound | null;
	position: 'early' | 'middle' | 'late';
}

export interface AIStrategy {
	makeDecision(context: GameContext): Promise<AIDecision> | AIDecision;
}

export interface AIDecisionLog {
	player: Player;
	hand: Card[];
	communityCards: Card[];
	handStrength: number;
	potOdds: number;
	decision: AIDecision;
	timestamp: number;
}
