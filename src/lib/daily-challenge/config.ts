import { dailyChallengePeriodKeySchema } from './protocol';
import { getDailyPeriodKey } from '../missions/periods';
import type { DailyChallengeConfigV1 } from './replay';

// The ranked-entry cutoff must be at least the attempt TTL so an attempt started just before
// the cutoff cannot outlive the ranked-entry window. Deriving the offset from the TTL keeps
// that invariant pinned to a single source of truth.
const attemptTtlSeconds = 1800 as const;

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
	attemptTtlSeconds,
	rankedEntryCloseOffsetSeconds: attemptTtlSeconds,
} as const satisfies DailyChallengeConfigV1);

export interface DailyChallengeWindow {
	readonly periodKey: string;
	readonly startsAt: number;
	readonly rankedEntryClosesAt: number;
	readonly endsAt: number;
}

// Derives the canonical UTC window for a persisted periodKey. Calendar-validates
// the key so a malformed migration or corrupted row (e.g. "2025-13-45") cannot
// masquerade as a real day, then recomputes startsAt / rankedEntryClosesAt /
// endsAt from the validated key. This is the fail-closed boundary used when
// rehydrating persisted challenge rows: callers must require exact equality
// against the persisted timestamps.
export function getDailyChallengeWindowForPeriodKey(periodKey: string): DailyChallengeWindow {
	if (!dailyChallengePeriodKeySchema.safeParse(periodKey).success) {
		throw new TypeError('Daily Challenge period key must be a YYYY-MM-DD string');
	}
	const startsAtMs = Date.parse(`${periodKey}T00:00:00.000Z`);
	if (Number.isNaN(startsAtMs)) {
		throw new RangeError('Daily Challenge period key must resolve to a valid UTC date');
	}
	// Round-trip through Date to reject non-existent calendar dates (e.g.
	// 2025-02-30 normalizes to 2025-03-02 in V8). The re-formatted key must
	// match the input exactly.
	const roundTripped = new Date(startsAtMs).toISOString().slice(0, 10);
	if (roundTripped !== periodKey) {
		throw new RangeError('Daily Challenge period key is not a real calendar date');
	}
	const startsAt = Math.trunc(startsAtMs / 1000);
	const endsAt = startsAt + 24 * 60 * 60;
	return {
		periodKey,
		startsAt,
		rankedEntryClosesAt: endsAt - BLACKJACK_DAILY_V1_CONFIG.rankedEntryCloseOffsetSeconds,
		endsAt,
	};
}

export function getDailyChallengeWindow(nowSeconds: number): DailyChallengeWindow {
	if (!Number.isSafeInteger(nowSeconds) || nowSeconds < 0) {
		throw new TypeError('Daily Challenge time must be a non-negative safe integer');
	}
	const date = new Date(nowSeconds * 1000);
	if (Number.isNaN(date.getTime())) {
		throw new RangeError('Daily Challenge time must resolve to a valid date');
	}
	const periodKey = getDailyPeriodKey(date);
	return getDailyChallengeWindowForPeriodKey(periodKey);
}
