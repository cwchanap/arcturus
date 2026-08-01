import { canonicalizeRanked, hashCanonical } from '../canonical';
import type { RankedGameAdapter } from '../registry';
import { shuffleRankedDeck } from '../random';
import type { RankedBlackjackActionLogEntryV1 } from '../protocol';
import { replayRankedBlackjack } from './engine';
import { projectRankedBlackjackReplay } from './projection';
import type {
	RankedBlackjackConfigV1,
	RankedBlackjackOutcomeV1,
	RankedBlackjackPublicStateV1,
	RankedBlackjackReplay,
} from './types';

export type {
	RankedBlackjackPublicDealerV1,
	RankedBlackjackPublicHandV1,
	RankedBlackjackPublicStateV1,
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
		return projectRankedBlackjackReplay(replay, accountBalance);
	},
	projectTerminal(replay, accountBalance) {
		return projectRankedBlackjackReplay(replay, accountBalance, true);
	},
	terminalOutcome(replay) {
		return replay.outcome;
	},
};
