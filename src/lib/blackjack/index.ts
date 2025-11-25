/**
 * Blackjack game module - Public API exports
 */

// Type exports
export type {
	Card,
	Rank,
	Suit,
	Hand,
	GamePhase,
	BlackjackAction,
	RoundResult,
	BlackjackGameState,
	RoundOutcome,
	DealerSpeed,
	BlackjackSettings,
	HandValue,
} from './types';

// Constants
export {
	DEFAULT_MIN_BET,
	DEFAULT_MAX_BET,
	DEFAULT_STARTING_CHIPS,
	BLACKJACK_PAYOUT,
	WIN_PAYOUT,
	PUSH_PAYOUT,
	RESHUFFLE_THRESHOLD,
	DEALER_HIT_THRESHOLD,
	DEALER_STAND_THRESHOLD,
	BLACKJACK_VALUE,
	ACE_HIGH_VALUE,
	ACE_LOW_VALUE,
	FACE_CARD_VALUE,
	DEALER_SPEED_SLOW,
	DEALER_SPEED_NORMAL,
	DEALER_SPEED_FAST,
	DEFAULT_SETTINGS,
	CARD_VALUES,
} from './constants';

// Core modules
export { DeckManager } from './DeckManager';
export {
	calculateHandValue,
	isBlackjack,
	isBust,
	canSplit,
	canDoubleDown,
	compareHands,
	getHandValueDisplay,
} from './handEvaluator';
export { shouldDealerHit, shouldDealerStand } from './dealerStrategy';
export { BlackjackGame } from './BlackjackGame';
export { BlackjackUIRenderer } from './BlackjackUIRenderer';

// LLM Strategy
export {
	getBlackjackAdvice,
	getRoundCommentary,
	type LLMSettings,
	type BlackjackAdviceContext,
	type BlackjackAdvice,
} from './llmBlackjackStrategy';
