import type { Card } from '../cards';
import type { BetValidationCode } from '../bet-validation';

export type PayingHandCategory =
	| 'royal-flush'
	| 'straight-flush'
	| 'four-of-kind'
	| 'full-house'
	| 'flush'
	| 'straight'
	| 'three-of-kind'
	| 'two-pair'
	| 'jacks-or-better';

export type HandCategory = PayingHandCategory | 'nothing';

export interface HandEvaluation {
	category: HandCategory;
	label: string;
}

export type RoundPhase = 'ready' | 'holding' | 'complete';

export interface VideoPokerRoundResult {
	evaluation: HandEvaluation;
	wager: number;
	payout: number;
	netDelta: number;
	finalHand: readonly Card[];
}

export interface VideoPokerState {
	phase: RoundPhase;
	balance: number;
	wager: number;
	hand: readonly Card[];
	heldIndexes: readonly number[];
	result: VideoPokerRoundResult | null;
}

/**
 * Language-neutral wager validation result, translated at the presentation
 * boundary. The client maps the code through the game message catalog.
 */
export type VideoPokerWagerErrorCode =
	| BetValidationCode
	| 'whole-number-required'
	| 'insufficient-balance';
