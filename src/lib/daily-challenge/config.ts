import { getDailyPeriodKey } from '../missions/periods';

export const BLACKJACK_DAILY_V1_CONFIG = Object.freeze({
	challengeKind: 'blackjack-daily',
	challengeRulesetVersion: 'blackjack-daily-v1',
	gameType: 'blackjack',
	gameRulesetVersion: 'blackjack-ranked-v1',
	scoreVersion: 'blackjack-daily-score-v1',
	startingBankroll: 1000,
	roundCount: 10,
	minimumWager: 10,
	maximumWager: 1000,
	attemptTtlSeconds: 1800,
	rankedEntryCloseOffsetSeconds: 1800,
} as const);

export function getDailyChallengeWindow(nowSeconds: number) {
	if (!Number.isSafeInteger(nowSeconds) || nowSeconds < 0) {
		throw new TypeError('Daily Challenge time must be a non-negative safe integer');
	}
	const date = new Date(nowSeconds * 1000);
	const periodKey = getDailyPeriodKey(date);
	const startsAt = Math.trunc(Date.parse(`${periodKey}T00:00:00.000Z`) / 1000);
	const endsAt = startsAt + 24 * 60 * 60;
	return {
		periodKey,
		startsAt,
		rankedEntryClosesAt: endsAt - BLACKJACK_DAILY_V1_CONFIG.rankedEntryCloseOffsetSeconds,
		endsAt,
	};
}
