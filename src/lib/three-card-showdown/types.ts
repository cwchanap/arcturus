import type { Card } from '../cards';

export type ThreeCardHandCategory =
	| 'straight-flush'
	| 'three-of-kind'
	| 'straight'
	| 'flush'
	| 'pair'
	| 'high-card';

export interface ThreeCardHandEvaluation {
	category: ThreeCardHandCategory;
	label: string;
	tieBreakers: readonly number[];
}

export interface ThreeCardShowdownRoundResult {
	outcome: 'fold' | 'dealer-not-qualified' | 'player-win' | 'tie' | 'dealer-win';
	ante: number;
	totalWager: number;
	grossPayout: number;
	netDelta: number;
	dealerQualified: boolean;
	playerHand: readonly Card[];
	dealerHand: readonly Card[];
	playerEvaluation: ThreeCardHandEvaluation;
	dealerEvaluation: ThreeCardHandEvaluation;
}

export interface ThreeCardShowdownState {
	phase: 'betting' | 'decision' | 'complete';
	balance: number;
	ante: number;
	playerHand: readonly Card[];
	dealerHand: readonly Card[];
	result: ThreeCardShowdownRoundResult | null;
}
