import { calculateHandValue } from '../../blackjack/handEvaluator';
import type { RankedBlackjackPublicStateV1, RankedBlackjackReplay } from './types';

export function projectRankedBlackjackReplay(
	replay: RankedBlackjackReplay,
	availableBalance: number,
	forceTerminal = false,
): RankedBlackjackPublicStateV1 {
	const isTerminal = forceTerminal || replay.state.phase === 'complete';
	const safeAvailableBalance =
		Number.isSafeInteger(availableBalance) && availableBalance >= 0 ? availableBalance : 0;
	const dealerCards = isTerminal
		? replay.state.dealerHand.cards
		: replay.state.dealerHand.cards.slice(0, 1);
	const visibleDealerCards = dealerCards.map((card) => ({ ...card }));
	const availableActions = isTerminal
		? []
		: replay.legalActions
				.filter(
					({ additionalWager }) => additionalWager === 0 || safeAvailableBalance >= additionalWager,
				)
				.map(({ action }) => action);

	return {
		phase: isTerminal ? 'complete' : replay.state.phase,
		playerHands: replay.state.playerHands.map(({ cards, wager }) => {
			const visibleCards = cards.map((card) => ({ ...card }));
			return {
				cards: visibleCards,
				wager,
				value: calculateHandValue(visibleCards),
			};
		}),
		activeHandIndex: replay.state.activeHandIndex,
		dealer: {
			cards: visibleDealerCards,
			value: calculateHandValue(visibleDealerCards),
		},
		committedWager: replay.state.committedWager,
		nextSequence: replay.nextSequence,
		availableActions,
		outcome: replay.outcome,
	};
}
