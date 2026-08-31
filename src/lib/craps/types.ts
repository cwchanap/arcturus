/**
 * Craps game type definitions
 */

import type { Locale } from '../i18n/locale';

export type DieFace = 1 | 2 | 3 | 4 | 5 | 6;
export type DiceTotal = 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12;
export type PointNumber = 4 | 5 | 6 | 8 | 9 | 10;

export interface DiceRoll {
	die1: DieFace;
	die2: DieFace;
	total: DiceTotal;
}

export type GamePhase = 'come-out' | 'point';

/**
 * The complete runtime key source for Craps bet identity. `BetType` is
 * derived from this list; the handwritten union is gone. These neutral keys
 * are also the persisted-state vocabulary, so restored bets validate against
 * this list/set rather than any display labels.
 */
export const BET_TYPES = [
	'passLine',
	'dontPass',
	'passLineOdds',
	'dontPassOdds',
	'come',
	'dontCome',
	'place4',
	'place5',
	'place6',
	'place8',
	'place9',
	'place10',
	'field',
	'big6',
	'big8',
	'buy4',
	'buy5',
	'buy6',
	'buy8',
	'buy9',
	'buy10',
	'lay4',
	'lay5',
	'lay6',
	'lay8',
	'lay9',
	'lay10',
	'hard4',
	'hard6',
	'hard8',
	'hard10',
	'any7',
	'anyCraps',
	'aceDeuce',
	'aces',
	'boxcars',
	'yo',
	'ce',
] as const;

export type BetType = (typeof BET_TYPES)[number];

/** Neutral membership set used to validate restored bet types. */
export const BET_TYPE_SET: ReadonlySet<string> = new Set(BET_TYPES);

export interface CrapsBet {
	id: string;
	type: BetType;
	amount: number;
	point?: PointNumber; // For come/dontCome: the established come point
	odds?: number; // Odds amount behind passLine/dontPass/come/dontCome
}

export type BetOutcome = 'win' | 'lose' | 'push' | 'continue';

export interface BetEvaluation {
	bet: CrapsBet;
	outcome: BetOutcome;
	payout: number; // Profit earned on win (positive), 0 for lose/push/continue
	updatedBet?: CrapsBet; // For come/dontCome when establishing a point
	persistent?: boolean; // Optional hint that this bet should remain active after resolution
}

export interface RollResult {
	roll: DiceRoll;
	phase: GamePhase; // Phase AFTER this roll
	point: PointNumber | null; // Game point AFTER this roll
	evaluations: BetEvaluation[];
	netDelta: number; // Total chips won (+) or lost (-) from resolved bets this roll
	message: string; // Human-readable description of what happened
}

export interface CrapsSettings {
	minBet: number;
	maxBet: number;
	maxOddsMultiplier: number;
	animationSpeed: 'slow' | 'normal' | 'fast';
	llmEnabled: boolean;
	soundEnabled: boolean;
}

export interface CrapsGameState {
	phase: GamePhase;
	point: PointNumber | null;
	lastRoll: DiceRoll | null;
	rollHistory: DiceRoll[];
	activeBets: CrapsBet[];
	chipBalance: number;
	rollCount: number;
	settings: CrapsSettings;
}

export type CrapsErrorCode =
	| 'INVALID_PHASE'
	| 'BET_BELOW_MIN'
	| 'BET_ABOVE_MAX'
	| 'INSUFFICIENT_BALANCE'
	| 'BET_NOT_ALLOWED_IN_PHASE'
	| 'ODDS_BET_REQUIRES_LINE_BET'
	| 'ODDS_EXCEEDS_LIMIT';

/**
 * Language-neutral bet placement failure codes. The presentation boundary
 * translates these; numeric/structured context travels separately in
 * `CrapsBetContext` (min/max/remaining/multiplier/betType) instead of being
 * embedded in English sentences.
 */
export type CrapsBetErrorCode =
	| 'invalid-amount'
	| 'come-out-only'
	| 'point-only'
	| 'missing-pass-line'
	| 'missing-dont-pass'
	| 'duplicate-pass-line'
	| 'duplicate-dont-pass'
	| 'below-minimum'
	| 'above-maximum'
	| 'above-max-odds'
	| 'insufficient-balance';

/** Structured, locale-neutral context for a bet placement failure. */
export interface CrapsBetContext {
	min?: number;
	max?: number;
	remaining?: number;
	multiplier?: number;
	betType?: BetType;
}

/** Closed result of {@link CrapsGame.canPlaceBet}. */
export type CrapsBetCheckResult =
	| { ok: true }
	| { ok: false; error: CrapsBetErrorCode; context?: CrapsBetContext };

/** Table-operation failures (add come odds / remove bet), beyond placement. */
export type CrapsTableErrorCode =
	| 'bet-not-found'
	| 'not-come-bet'
	| 'no-come-point'
	| 'line-bet-locked'
	| 'come-bet-locked';

export interface CrapsError {
	code: CrapsErrorCode;
	message: string;
}

// LLM types
export interface CrapsAdviceContext {
	phase: GamePhase;
	point: PointNumber | null;
	activeBets: CrapsBet[];
	rollHistory: DiceRoll[];
	chipBalance: number;
	query?: string;
	/** Locale for the explanation prose; the recommendation stays language-neutral. */
	locale?: Locale;
}

export interface CrapsAdvice {
	advice: string;
	suggestedBets: BetType[];
	confidence: 'low' | 'medium' | 'high';
	raw: string;
}
