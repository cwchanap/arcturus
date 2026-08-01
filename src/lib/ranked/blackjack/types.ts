import type { Card, HandValue } from '../../blackjack/types';
import type { RankedBlackjackAction } from '../protocol';

export type RankedBlackjackConfigV1 = {
	readonly gameType: 'blackjack';
	readonly rulesetVersion: 'blackjack-ranked-v1';
	readonly deckCount: 1;
	readonly minimumWager: number;
	readonly maximumWager: number;
	readonly maximumHands: number;
	readonly dealerHitsSoft17: boolean;
	readonly blackjackProfitNumerator: number;
	readonly blackjackProfitDenominator: number;
	readonly normalWinProfitNumerator: number;
	readonly normalWinProfitDenominator: number;
	readonly initialWager: number;
};

export interface RankedBlackjackHandV1 {
	readonly cards: readonly Card[];
	readonly wager: number;
}

export interface RankedBlackjackDealerHandV1 {
	readonly cards: readonly Card[];
}

export interface RankedBlackjackStateV1 {
	readonly phase: 'player-turn' | 'complete';
	readonly playerHands: readonly RankedBlackjackHandV1[];
	readonly activeHandIndex: number;
	readonly dealerHand: RankedBlackjackDealerHandV1;
	readonly deckCursor: number;
	readonly committedWager: number;
}

export interface RankedBlackjackLegalActionV1 {
	readonly action: RankedBlackjackAction;
	readonly additionalWager: number;
}

export type RankedBlackjackHandResultV1 = 'win' | 'loss' | 'push' | 'blackjack';
export type RankedBlackjackSessionResultV1 = 'win' | 'loss' | 'push';

export type RankedBlackjackHandOutcomeV1 = {
	readonly handIndex: number;
	readonly result: RankedBlackjackHandResultV1;
	readonly wager: number;
	readonly payout: number;
};

export type RankedBlackjackOutcomeV1 = {
	readonly result: RankedBlackjackSessionResultV1;
	readonly hands: readonly RankedBlackjackHandOutcomeV1[];
	readonly committedWager: number;
	readonly payout: number;
	readonly gameNetDelta: number;
};

export interface RankedBlackjackReplay {
	readonly state: RankedBlackjackStateV1;
	readonly nextSequence: number;
	readonly legalActions: readonly RankedBlackjackLegalActionV1[];
	readonly outcome: RankedBlackjackOutcomeV1 | null;
}

export interface RankedBlackjackPublicHandV1 {
	readonly cards: readonly Card[];
	readonly wager: number;
	readonly value: HandValue;
}

export interface RankedBlackjackPublicDealerV1 {
	readonly cards: readonly Card[];
	readonly value: HandValue;
}

export interface RankedBlackjackPublicStateV1 {
	readonly phase: 'player-turn' | 'complete';
	readonly playerHands: readonly RankedBlackjackPublicHandV1[];
	readonly activeHandIndex: number;
	readonly dealer: RankedBlackjackPublicDealerV1;
	readonly committedWager: number;
	readonly nextSequence: number;
	readonly availableActions: readonly RankedBlackjackAction[];
	readonly outcome: RankedBlackjackOutcomeV1 | null;
}
