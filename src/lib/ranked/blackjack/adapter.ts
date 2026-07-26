import { calculateHandValue } from '../../blackjack/handEvaluator';
import type { Card, HandValue } from '../../blackjack/types';
import { canonicalizeRanked, hashCanonical } from '../canonical';
import type { RankedGameAdapter } from '../registry';
import { shuffleRankedDeck } from '../random';
import type { RankedBlackjackActionLogEntryV1 } from '../protocol';
import { replayRankedBlackjack } from './engine';
import type {
	RankedBlackjackConfigV1,
	RankedBlackjackOutcomeV1,
	RankedBlackjackReplay,
} from './types';

export const BLACKJACK_RANKED_V1_CONFIG = Object.freeze({
	gameType: 'blackjack',
	rulesetVersion: 'blackjack-ranked-v1',
	deckCount: 1,
	minimumWager: 10,
	maximumWager: 1000,
	maximumHands: 4,
	dealerHitsSoft17: false,
	blackjackProfitNumerator: 3,
	blackjackProfitDenominator: 2,
	normalWinProfitNumerator: 1,
	normalWinProfitDenominator: 1,
} as const);

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
	readonly availableActions: readonly ('hit' | 'stand' | 'double-down' | 'split')[];
	readonly outcome: RankedBlackjackOutcomeV1 | null;
}

function isValidInitialWager(wager: number): boolean {
	return (
		Number.isSafeInteger(wager) &&
		wager >= BLACKJACK_RANKED_V1_CONFIG.minimumWager &&
		wager <= BLACKJACK_RANKED_V1_CONFIG.maximumWager
	);
}

export function issueBlackjackConfig(wager: number): RankedBlackjackConfigV1 {
	if (!isValidInitialWager(wager)) {
		throw new RangeError('Initial wager is outside blackjack-ranked-v1 limits');
	}
	return Object.freeze({ ...BLACKJACK_RANKED_V1_CONFIG, initialWager: wager });
}

function projectHand(cards: readonly Card[], wager: number): RankedBlackjackPublicHandV1 {
	const visibleCards = cards.map((card) => ({ ...card }));
	return {
		cards: visibleCards,
		wager,
		value: calculateHandValue(visibleCards),
	};
}

function projectDealer(cards: readonly Card[]): RankedBlackjackPublicDealerV1 {
	const visibleCards = cards.map((card) => ({ ...card }));
	return {
		cards: visibleCards,
		value: calculateHandValue(visibleCards),
	};
}

/**
 * Projects a replay into a public state. When `forceTerminal` is true the
 * dealer hole card is revealed and `phase` is forced to `'complete'` even
 * if the replay's underlying state is still in `'player-turn'` (e.g. an
 * expired/forfeited session where the player abandoned mid-hand).
 *
 * Contract caveat: `outcome` is forwarded verbatim from the replay, so
 * when `forceTerminal` is applied to a non-complete replay the returned
 * state has `phase: 'complete'` with `outcome: null`. The engine only
 * computes an outcome for replays that reached `'complete'` naturally,
 * so a forced-terminal projection of an incomplete session does NOT
 * carry a settlement outcome. Callers rendering an expired/forfeited
 * session MUST supply the authoritative outcome externally (the
 * coordinator's `render` path overrides `outcome` with the stored
 * `result.outcome` and clears `availableActions`). Do not interpret a
 * forced-terminal projection's `outcome` field as the settlement result.
 */
function projectReplay(
	replay: RankedBlackjackReplay,
	accountBalance: number,
	forceTerminal = false,
): RankedBlackjackPublicStateV1 {
	const isTerminal = forceTerminal || replay.state.phase === 'complete';
	const dealerCards = isTerminal
		? replay.state.dealerHand.cards
		: replay.state.dealerHand.cards.slice(0, 1);
	const availableBalance =
		Number.isSafeInteger(accountBalance) && accountBalance >= 0 ? accountBalance : 0;
	const availableActions = isTerminal
		? []
		: replay.legalActions
				.filter(
					({ additionalWager }) => additionalWager === 0 || availableBalance >= additionalWager,
				)
				.map(({ action }) => action);

	return {
		phase: isTerminal ? 'complete' : replay.state.phase,
		playerHands: replay.state.playerHands.map(({ cards, wager }) => projectHand(cards, wager)),
		activeHandIndex: replay.state.activeHandIndex,
		dealer: projectDealer(dealerCards),
		committedWager: replay.state.committedWager,
		nextSequence: replay.nextSequence,
		availableActions,
		outcome: replay.outcome,
	};
}

export const blackjackRankedV1Adapter: RankedGameAdapter<
	RankedBlackjackConfigV1,
	RankedBlackjackActionLogEntryV1,
	RankedBlackjackReplay,
	RankedBlackjackPublicStateV1,
	RankedBlackjackOutcomeV1
> = {
	gameType: 'blackjack',
	rulesetVersion: 'blackjack-ranked-v1',
	async issue({ wager }) {
		const config = issueBlackjackConfig(wager);
		return {
			config,
			configJson: canonicalizeRanked(config),
			configHash: hashCanonical(config),
		};
	},
	async replay(seed, config, actions) {
		return replayRankedBlackjack(config, shuffleRankedDeck(seed), actions);
	},
	project(replay, accountBalance) {
		return projectReplay(replay, accountBalance);
	},
	projectTerminal(replay, accountBalance) {
		return projectReplay(replay, accountBalance, true);
	},
	terminalOutcome(replay) {
		return replay.outcome;
	},
};
