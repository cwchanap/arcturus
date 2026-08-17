import type { Card } from '../cards';

export interface PaiGowJoker {
	rank: 'joker';
	suit: 'joker';
}
export type PaiGowCard = Card | PaiGowJoker;

export type PaiGowCategory =
	| 'five-aces'
	| 'royal-flush'
	| 'straight-flush'
	| 'four-of-kind'
	| 'full-house'
	| 'flush'
	| 'straight'
	| 'three-of-kind'
	| 'two-pair'
	| 'pair'
	| 'high-card';

export interface PaiGowHandRanking {
	category: PaiGowCategory;
	tieBreakers: number[];
}

export type LowHandIndexes = readonly [number, number];

export interface PaiGowArrangement {
	lowIndexes: LowHandIndexes;
	high: PaiGowCard[];
	low: PaiGowCard[];
	highRanking: PaiGowHandRanking;
	lowRanking: PaiGowHandRanking;
}

export type PaiGowRoundOutcome = 'win' | 'push' | 'loss';

export interface PaiGowRoundResult {
	outcome: PaiGowRoundOutcome;
	wager: number;
	commission: number;
	grossPayout: number;
	netDelta: number;
	player: PaiGowArrangement;
	dealer: PaiGowArrangement;
}

export type PaiGowPhase = 'betting' | 'arranging' | 'complete';

export interface PaiGowPokerState {
	phase: PaiGowPhase;
	balance: number;
	wager: number;
	playerCards: PaiGowCard[];
	dealerCards: PaiGowCard[];
	lowIndexes: number[];
	result: PaiGowRoundResult | null;
}
