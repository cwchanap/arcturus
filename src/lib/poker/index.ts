/**
 * Poker game utilities - barrel exports
 */

// Types
export type {
	Suit,
	Card,
	GamePhase,
	PlayerAction,
	BettingRound,
	Player,
	GameState,
	HandEvaluation,
	AIDecision,
	GameContext,
	AIStrategy,
	AIDecisionLog,
} from './types';

// Constants
export {
	STARTING_CHIPS,
	SMALL_BLIND,
	BIG_BLIND,
	MIN_BET,
	MAX_BET,
	NUM_PLAYERS,
	HAND_RANKINGS,
	HAND_NAMES,
	CARD_VALUES,
	SUITS,
	AI_DECISION_DELAY_MIN,
} from './constants';

// Player management utilities
export {
	createPlayer,
	createAIPlayer,
	placeBet,
	postBlind,
	foldPlayer,
	resetPlayerForNewHand,
	resetCurrentBets,
	dealCardsToPlayer,
	awardChips,
	canPlayerAct,
	getActivePlayers,
	getPlayersWhoCanAct,
	getNextPlayerIndex,
	isBettingRoundComplete,
	getHighestBet,
	getCallAmount,
} from './player';

// Pot calculator utilities
export {
	calculatePot,
	calculateRoundPot,
	distributePot,
	calculateSidePots,
	getMinimumBet,
} from './potCalculator';

// Hand evaluator utilities
export {
	evaluatePreflopHand,
	evaluatePostflopHand,
	calculatePotOdds,
	estimateDrawingOuts,
	determineShowdownWinners,
} from './handEvaluator';

// AI strategy
export type { AIPersonality, AIConfig } from './aiStrategy';
export { createAIConfig, makeAIDecision } from './aiStrategy';
