import {
	dailyChallengeAttemptPublicStateSchema,
	dailyChallengeChallengeResponseSchema,
	dailyChallengeHistoryResponseSchema,
	dailyChallengeLeaderboardResponseSchema,
	type DailyChallengeAttemptPublicStateV1,
	type DailyChallengeHistoryResponse,
	type DailyChallengeLeaderboardResponse,
	type DailyChallengePublicResponse,
} from './protocol';

const TERMINAL_REASONS_BY_STATUS: Record<
	Exclude<DailyChallengeAttemptPublicStateV1['status'], 'active'>,
	ReadonlySet<string>
> = {
	completed: new Set(['completed', 'bankroll-below-minimum']),
	forfeited: new Set(['forfeited']),
	expired: new Set(['expired']),
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertNoLiveRankedSeed(value: unknown): void {
	if (isPlainObject(value) && Object.prototype.hasOwnProperty.call(value, 'rankedSeed')) {
		throw new TypeError('Daily Challenge response must not expose the live ranked seed');
	}
}

function assertNoActiveRoundNextSequence(attempt: unknown): void {
	if (
		isPlainObject(attempt) &&
		isPlainObject(attempt.activeRound) &&
		Object.prototype.hasOwnProperty.call(attempt.activeRound, 'nextSequence')
	) {
		throw new TypeError('Daily Challenge response must not expose activeRound.nextSequence');
	}
}

function assertAttemptCrossField(parsed: DailyChallengeAttemptPublicStateV1): void {
	if (parsed.status === 'active') {
		if (parsed.receipt !== null) {
			throw new TypeError('Active daily challenge attempt cannot carry a receipt');
		}
		return;
	}
	if (parsed.receipt === null) {
		throw new TypeError('Terminal daily challenge attempt requires a receipt');
	}
	if (parsed.activeRound !== null) {
		throw new TypeError('Terminal daily challenge attempt must not expose an active round');
	}
	const allowed = TERMINAL_REASONS_BY_STATUS[parsed.status];
	if (!allowed.has(parsed.receipt.terminalReason)) {
		throw new TypeError('Daily challenge receipt terminal reason disagrees with attempt status');
	}
	// Terminal-state field combinations: eligibility and standing must agree with status.
	// A completed attempt (terminalReason completed or bankroll-below-minimum) is always
	// eligible; forfeited and expired attempts are never eligible and must not expose a
	// leaderboard standing.
	if (parsed.status === 'completed') {
		if (!parsed.receipt.eligible) {
			throw new TypeError('Completed daily challenge attempt must be eligible');
		}
	} else {
		if (parsed.receipt.eligible) {
			throw new TypeError('Forfeited or expired daily challenge attempt must not be eligible');
		}
		if (parsed.rank !== null) {
			throw new TypeError('Forfeited or expired daily challenge attempt must not expose a rank');
		}
		if (parsed.percentile !== null) {
			throw new TypeError(
				'Forfeited or expired daily challenge attempt must not expose a percentile',
			);
		}
	}
}

export function parseDailyChallengeAttemptResponse(
	value: unknown,
): DailyChallengeAttemptPublicStateV1 {
	assertNoLiveRankedSeed(value);
	assertNoActiveRoundNextSequence(value);
	const parsed = dailyChallengeAttemptPublicStateSchema.parse(value);
	assertAttemptCrossField(parsed);
	return parsed;
}

export function parseDailyChallengeChallengeResponse(value: unknown): DailyChallengePublicResponse {
	assertNoLiveRankedSeed(value);
	if (isPlainObject(value)) {
		assertNoActiveRoundNextSequence(value.attempt);
	}
	// The server is the authoritative boundary for seed disclosure timing.
	// The browser clock cannot securely enforce disclosure (clock skew rejects
	// server-authorized post-close reveals, and the response carries its own
	// endsAt which could be tampered with). Trust the server's decision to
	// include revealedRankedSeed and let the schema validate its format.
	const parsed = dailyChallengeChallengeResponseSchema.parse(value);
	if (parsed.attempt !== null) {
		assertAttemptCrossField(parsed.attempt);
	}
	return parsed;
}

export function parseDailyChallengeLeaderboardResponse(
	value: unknown,
): DailyChallengeLeaderboardResponse {
	assertNoLiveRankedSeed(value);
	return dailyChallengeLeaderboardResponseSchema.parse(value);
}

export function parseDailyChallengeHistoryResponse(value: unknown): DailyChallengeHistoryResponse {
	assertNoLiveRankedSeed(value);
	return dailyChallengeHistoryResponseSchema.parse(value);
}
