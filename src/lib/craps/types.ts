/**
 * Craps game type definitions
 */

export type DieFace = 1 | 2 | 3 | 4 | 5 | 6;
export type DiceTotal = 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12;
export type PointNumber = 4 | 5 | 6 | 8 | 9 | 10;

export interface DiceRoll {
	die1: DieFace;
	die2: DieFace;
	total: DiceTotal;
}

export type GamePhase = 'come-out' | 'point';

// All bet types
export type BetType =
	// Line bets (come-out phase only)
	| 'passLine'
	| 'dontPass'
	// Odds bets (point phase only, behind line bets)
	| 'passLineOdds'
	| 'dontPassOdds'
	// Come bets (point phase only)
	| 'come'
	| 'dontCome'
	// Place bets (always available, off during come-out)
	| 'place4'
	| 'place5'
	| 'place6'
	| 'place8'
	| 'place9'
	| 'place10'
	// Field (always working)
	| 'field'
	// Big 6/8 (always working)
	| 'big6'
	| 'big8'
	// Buy bets (off during come-out)
	| 'buy4'
	| 'buy5'
	| 'buy6'
	| 'buy8'
	| 'buy9'
	| 'buy10'
	// Lay bets (off during come-out)
	| 'lay4'
	| 'lay5'
	| 'lay6'
	| 'lay8'
	| 'lay9'
	| 'lay10'
	// Hardways (off during come-out)
	| 'hard4'
	| 'hard6'
	| 'hard8'
	| 'hard10'
	// Proposition bets (one-roll, always working)
	| 'any7'
	| 'anyCraps'
	| 'aceDeuce'
	| 'aces'
	| 'boxcars'
	| 'yo'
	| 'ce';

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
}

export interface CrapsAdvice {
	advice: string;
	suggestedBets: BetType[];
	confidence: 'low' | 'medium' | 'high';
	raw: string;
}
