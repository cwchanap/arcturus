export type Suit = 'hearts' | 'diamonds' | 'clubs' | 'spades';
export type Rank = 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14;

export interface Card {
	rank: Rank;
	suit: Suit;
}

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
