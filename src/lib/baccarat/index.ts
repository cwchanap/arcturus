/**
 * Baccarat game module exports
 */

// Types
export type {
	AnimationSpeed,
	BaccaratError,
	BaccaratErrorCode,
	BaccaratGameConfig,
	BaccaratGameEvents,
	BaccaratGameState,
	BaccaratSettings,
	Bet,
	BetOutcome,
	BetResult,
	BetType,
	Card,
	DeckState,
	GamePhase,
	Hand,
	LLMBaccaratContext,
	LLMBaccaratResponse,
	LLMConfidence,
	Rank,
	RoundOutcome,
	Suit,
	Winner,
} from './types';

// Constants
export {
	ANIMATION_SPEED_FAST,
	ANIMATION_SPEED_NORMAL,
	ANIMATION_SPEED_SLOW,
	BACCARAT_CONSTANTS,
	BANKER_STAND_THRESHOLD,
	CARD_VALUES,
	CARDS_PER_DECK,
	DECK_COUNT,
	DEFAULT_MAX_BET,
	DEFAULT_MIN_BET,
	DEFAULT_SETTINGS,
	DEFAULT_STARTING_CHIPS,
	MAX_HISTORY_LENGTH,
	NATURAL_THRESHOLD,
	PAYOUTS,
	PLAYER_DRAW_THRESHOLD,
	RANKS,
	RESHUFFLE_THRESHOLD,
	SUITS,
	TOTAL_CARDS,
} from './constants';

// Core game modules
export { DeckManager, createShoe, shuffleDeck, dealCard, needsReshuffle } from './DeckManager';

export {
	getCardValue,
	getHandValue,
	isNatural,
	isPair,
	getRankValue,
	determineWinner,
	hasNatural,
	describeHand,
} from './handEvaluator';

export {
	shouldPlayerDraw,
	shouldBankerDraw,
	shouldBankerDrawAfterPlayerDrew,
	getBankerRulesDescription,
	explainBankerDecision,
} from './thirdCardRules';

export {
	calculatePayout,
	calculateTotalPayout,
	calculateAllPayouts,
	getPayoutMultiplier,
	getPayoutDescription,
	calculatePotentialWinnings,
	validatePayout,
} from './payoutCalculator';

// Main game class
export { BaccaratGame } from './BaccaratGame';

// UI modules
export { BaccaratUIRenderer } from './BaccaratUIRenderer';
export { BaccaratClient } from './baccaratClient';
export type { BaccaratClientConfig } from './baccaratClient';

// LLM integration
export { getBaccaratAdvice, buildAdviceContext } from './llmBaccaratStrategy';
export type { LLMSettings, BaccaratAdviceContext, BaccaratAdvice } from './llmBaccaratStrategy';

// Settings management
export { GameSettingsManager } from './GameSettingsManager';
