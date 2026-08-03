import { describe, expect, test } from 'bun:test';
import { encodeBase64Url } from '../ranked/canonical';
import {
	DAILY_CHALLENGE_ERROR_STATUS,
	dailyChallengeActiveRoundSchema,
	dailyChallengeAttemptIdSchema,
	dailyChallengeAttemptPublicStateSchema,
	dailyChallengeChallengeResponseSchema,
	dailyChallengeCommandSchema,
	dailyChallengeHistoryResponseSchema,
	dailyChallengeLeaderboardResponseSchema,
	dailyChallengePeriodKeySchema,
	dailyChallengeRequestIdSchema,
	dailyChallengeSequenceSchema,
	dailyChallengeStartRequestSchema,
} from './protocol';

const requestId = 'request_12345678';
const attemptId = 'abcdefghijklmnopqrstuv'; // 22 chars
const practiceSeed = encodeBase64Url(Uint8Array.from({ length: 32 }, (_, index) => 64 + index));

describe('daily challenge identifiers', () => {
	test.each([requestId, 'a'.repeat(16), 'a'.repeat(128)])('accepts requestId %p', (value) => {
		expect(dailyChallengeRequestIdSchema.safeParse(value).success).toBe(true);
	});

	test.each(['short', 'a'.repeat(15), 'a'.repeat(129), 'bad chars!'])(
		'rejects requestId %p',
		(value) => {
			expect(dailyChallengeRequestIdSchema.safeParse(value).success).toBe(false);
		},
	);

	test('accepts a 22-char attempt id', () => {
		expect(dailyChallengeAttemptIdSchema.safeParse(attemptId).success).toBe(true);
	});

	test.each(['short', 'a'.repeat(21), 'a'.repeat(23)])('rejects attempt id %p', (value) => {
		expect(dailyChallengeAttemptIdSchema.safeParse(value).success).toBe(false);
	});

	test.each(['2026-03-14', '2024-02-29', '1999-12-31'])('accepts period key %p', (value) => {
		expect(dailyChallengePeriodKeySchema.safeParse(value).success).toBe(true);
	});

	test.each(['2026-3-14', '20260314', 'abcd-ef-gh'])('rejects period key %p', (value) => {
		expect(dailyChallengePeriodKeySchema.safeParse(value).success).toBe(false);
	});
});

describe('daily challenge sequence', () => {
	test.each([-0, -1, 0.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
		'rejects invalid sequence %p',
		(value) => {
			expect(dailyChallengeSequenceSchema.safeParse(value).success).toBe(false);
		},
	);

	test('Object.is(-0) negative zero is rejected even though 0 is accepted', () => {
		expect(dailyChallengeSequenceSchema.safeParse(0).success).toBe(true);
		expect(dailyChallengeSequenceSchema.safeParse(-0).success).toBe(false);
	});
});

describe('dailyChallengeStartRequestSchema', () => {
	test('accepts a minimal start request', () => {
		expect(dailyChallengeStartRequestSchema.safeParse({ requestId: 'a'.repeat(16) }).success).toBe(
			true,
		);
	});

	test('rejects unknown fields via strict', () => {
		expect(
			dailyChallengeStartRequestSchema.safeParse({
				requestId: 'a'.repeat(16),
				score: 5000,
			}).success,
		).toBe(false);
	});

	test('rejects a missing or malformed requestId', () => {
		expect(dailyChallengeStartRequestSchema.safeParse({}).success).toBe(false);
		expect(dailyChallengeStartRequestSchema.safeParse({ requestId: 'short' }).success).toBe(false);
	});
});

describe('dailyChallengeCommandSchema', () => {
	test('accepts a start-round command with wager', () => {
		expect(
			dailyChallengeCommandSchema.parse({
				sequence: 0,
				command: 'start-round',
				wager: 10,
			}),
		).toEqual({ sequence: 0, command: 'start-round', wager: 10 });
	});

	test('accepts a non-start command without wager', () => {
		expect(dailyChallengeCommandSchema.parse({ sequence: 1, command: 'hit' })).toEqual({
			sequence: 1,
			command: 'hit',
		});
	});

	test('rejects a start-round command missing wager', () => {
		expect(() =>
			dailyChallengeCommandSchema.parse({ sequence: 0, command: 'start-round' }),
		).toThrow();
	});

	test('rejects a non-start command carrying wager', () => {
		expect(() =>
			dailyChallengeCommandSchema.parse({
				sequence: 1,
				command: 'hit',
				wager: 10,
			}),
		).toThrow();
	});

	test('rejects start-round with a non-integer or negative-zero wager', () => {
		expect(() =>
			dailyChallengeCommandSchema.parse({
				sequence: 0,
				command: 'start-round',
				wager: 10.5,
			}),
		).toThrow();
		expect(() =>
			dailyChallengeCommandSchema.parse({
				sequence: 0,
				command: 'start-round',
				wager: -0,
			}),
		).toThrow();
	});

	test('rejects unknown command discriminant', () => {
		expect(() =>
			dailyChallengeCommandSchema.parse({ sequence: 0, command: 'fold', wager: 10 }),
		).toThrow();
	});

	test('rejects unknown fields on a start-round command via strict', () => {
		expect(() =>
			dailyChallengeCommandSchema.parse({
				sequence: 0,
				command: 'start-round',
				wager: 10,
				extra: true,
			}),
		).toThrow();
	});
});

describe('DAILY_CHALLENGE_ERROR_STATUS', () => {
	test('pins the stable error status map verbatim', () => {
		expect(DAILY_CHALLENGE_ERROR_STATUS).toEqual({
			INVALID_REQUEST: 400,
			INVALID_WAGER: 400,
			INVALID_COMMAND: 400,
			UNAUTHORIZED: 401,
			CHALLENGE_NOT_FOUND: 404,
			ATTEMPT_NOT_FOUND: 404,
			RANKED_ENTRY_CLOSED: 409,
			ATTEMPT_COMPLETE: 409,
			IDENTIFIER_REUSE_MISMATCH: 409,
			SEQUENCE_MISMATCH: 409,
			INSUFFICIENT_CHALLENGE_BANKROLL: 409,
			RATE_LIMITED: 429,
			INTERNAL_ERROR: 500,
		});
	});

	test('is frozen immutable', () => {
		expect(Object.isFrozen(DAILY_CHALLENGE_ERROR_STATUS)).toBe(true);
	});
});

const completeActiveRound = {
	phase: 'player-turn',
	playerHands: [
		{
			cards: [{ rank: 'A', suit: 'hearts' }],
			wager: 10,
			value: { value: 11, isSoft: true, isBust: false },
		},
	],
	activeHandIndex: 0,
	dealer: {
		cards: [{ rank: '10', suit: 'clubs' }],
		value: { value: 10, isSoft: false, isBust: false },
	},
	committedWager: 10,
	availableActions: ['hit', 'stand'],
	outcome: null,
};

describe('dailyChallengeActiveRoundSchema', () => {
	test('accepts a projected active round', () => {
		expect(dailyChallengeActiveRoundSchema.safeParse(completeActiveRound).success).toBe(true);
	});

	test('rejects a nested nextSequence field (browser-safe strip)', () => {
		expect(
			dailyChallengeActiveRoundSchema.safeParse({
				...completeActiveRound,
				nextSequence: 1,
			}).success,
		).toBe(false);
	});

	test('accepts a terminal (complete) round with an outcome', () => {
		const terminal = {
			...completeActiveRound,
			phase: 'complete',
			availableActions: [],
			outcome: {
				result: 'win',
				hands: [{ handIndex: 0, result: 'win', wager: 10, payout: 20 }],
				committedWager: 10,
				payout: 20,
				gameNetDelta: 10,
			},
		};
		expect(dailyChallengeActiveRoundSchema.safeParse(terminal).success).toBe(true);
	});
});

function buildReceipt() {
	return {
		attemptId,
		challengeId: 'challenge_12345678',
		periodKey: '2026-03-14',
		challengeRulesetVersion: 'blackjack-daily-v1',
		gameRulesetVersion: 'blackjack-ranked-v1',
		scoreVersion: 'blackjack-daily-score-v1',
		configHash: 'a'.repeat(64),
		rankedSeedCommitment: 'b'.repeat(64),
		actionLogHash: 'c'.repeat(64),
		endingBankroll: 1200,
		roundsCompleted: 10,
		eligible: true,
		terminalReason: 'completed',
		durationSeconds: 600,
		settledAt: 1742000000,
		receiptHash: 'd'.repeat(64),
	};
}

describe('dailyChallengeAttemptPublicStateSchema', () => {
	test('accepts an active attempt with no receipt and null active round', () => {
		const active = {
			attemptId,
			challengeId: 'challenge_12345678',
			startRequestId: requestId,
			status: 'active',
			nextCommandSequence: 5,
			availableBankroll: 980,
			roundsCompleted: 3,
			activeRound: completeActiveRound,
			rank: null,
			percentile: null,
			receipt: null,
			expiresAt: 1742000000,
		};
		expect(dailyChallengeAttemptPublicStateSchema.safeParse(active).success).toBe(true);
	});

	test('rejects an active attempt that leaks a nested activeRound.nextSequence', () => {
		const active = {
			attemptId,
			challengeId: 'challenge_12345678',
			startRequestId: requestId,
			status: 'active',
			nextCommandSequence: 5,
			availableBankroll: 980,
			roundsCompleted: 3,
			activeRound: { ...completeActiveRound, nextSequence: 1 },
			rank: null,
			percentile: null,
			receipt: null,
			expiresAt: 1742000000,
		};
		expect(dailyChallengeAttemptPublicStateSchema.safeParse(active).success).toBe(false);
	});

	test('accepts a terminal attempt with a receipt and null active round', () => {
		const terminal = {
			attemptId,
			challengeId: 'challenge_12345678',
			startRequestId: requestId,
			status: 'completed',
			nextCommandSequence: 40,
			availableBankroll: 1200,
			roundsCompleted: 10,
			activeRound: null,
			rank: 3,
			percentile: 95.5,
			receipt: buildReceipt(),
			expiresAt: 1742000000,
		};
		expect(dailyChallengeAttemptPublicStateSchema.safeParse(terminal).success).toBe(true);
	});

	test('rejects unknown fields via strict', () => {
		const active = {
			attemptId,
			challengeId: 'challenge_12345678',
			startRequestId: requestId,
			status: 'active',
			nextCommandSequence: 0,
			availableBankroll: 1000,
			roundsCompleted: 0,
			activeRound: null,
			rank: null,
			percentile: null,
			receipt: null,
			expiresAt: 1742000000,
			extra: true,
		};
		expect(dailyChallengeAttemptPublicStateSchema.safeParse(active).success).toBe(false);
	});
});

describe('dailyChallengeChallengeResponseSchema', () => {
	test('accepts a challenge catalog response with no active attempt', () => {
		const challenge = {
			periodKey: '2026-03-14',
			challengeKind: 'blackjack-daily',
			challengeRulesetVersion: 'blackjack-daily-v1',
			gameRulesetVersion: 'blackjack-ranked-v1',
			scoreVersion: 'blackjack-daily-score-v1',
			startsAt: 1742000000,
			rankedEntryClosesAt: 1742000000 + 24 * 60 * 60 - 1800,
			endsAt: 1742000000 + 24 * 60 * 60,
			configHash: 'a'.repeat(64),
			rankedSeedCommitment: 'b'.repeat(64),
			practiceSeed,
			attempt: null,
		};
		expect(dailyChallengeChallengeResponseSchema.safeParse(challenge).success).toBe(true);
	});

	test('accepts a live challenge response with a null revealed seed', () => {
		const challenge = {
			periodKey: '2026-03-14',
			challengeKind: 'blackjack-daily',
			challengeRulesetVersion: 'blackjack-daily-v1',
			gameRulesetVersion: 'blackjack-ranked-v1',
			scoreVersion: 'blackjack-daily-score-v1',
			startsAt: 1742000000,
			rankedEntryClosesAt: 1742000000 + 24 * 60 * 60 - 1800,
			endsAt: 1742000000 + 24 * 60 * 60,
			configHash: 'a'.repeat(64),
			rankedSeedCommitment: 'b'.repeat(64),
			practiceSeed,
			revealedRankedSeed: null,
			attempt: null,
		};
		expect(dailyChallengeChallengeResponseSchema.safeParse(challenge).success).toBe(true);
	});

	test('accepts a closed challenge response with a canonical base64url revealed seed', () => {
		const challenge = {
			periodKey: '2026-03-14',
			challengeKind: 'blackjack-daily',
			challengeRulesetVersion: 'blackjack-daily-v1',
			gameRulesetVersion: 'blackjack-ranked-v1',
			scoreVersion: 'blackjack-daily-score-v1',
			startsAt: 1742000000,
			rankedEntryClosesAt: 1742000000 + 24 * 60 * 60 - 1800,
			endsAt: 1742000000 + 24 * 60 * 60,
			configHash: 'a'.repeat(64),
			rankedSeedCommitment: 'b'.repeat(64),
			practiceSeed,
			revealedRankedSeed: encodeBase64Url(Uint8Array.from({ length: 32 }, (_, index) => index)),
			attempt: null,
		};
		expect(dailyChallengeChallengeResponseSchema.safeParse(challenge).success).toBe(true);
	});

	test('rejects a malformed non-canonical revealed seed', () => {
		const challenge = {
			periodKey: '2026-03-14',
			challengeKind: 'blackjack-daily',
			challengeRulesetVersion: 'blackjack-daily-v1',
			gameRulesetVersion: 'blackjack-ranked-v1',
			scoreVersion: 'blackjack-daily-score-v1',
			startsAt: 1742000000,
			rankedEntryClosesAt: 1742000000 + 24 * 60 * 60 - 1800,
			endsAt: 1742000000 + 24 * 60 * 60,
			configHash: 'a'.repeat(64),
			rankedSeedCommitment: 'b'.repeat(64),
			practiceSeed,
			revealedRankedSeed: 'not-canonical!!',
			attempt: null,
		};
		expect(dailyChallengeChallengeResponseSchema.safeParse(challenge).success).toBe(false);
	});

	test('rejects a malformed non-canonical practice seed', () => {
		const challenge = {
			periodKey: '2026-03-14',
			challengeKind: 'blackjack-daily',
			challengeRulesetVersion: 'blackjack-daily-v1',
			gameRulesetVersion: 'blackjack-ranked-v1',
			scoreVersion: 'blackjack-daily-score-v1',
			startsAt: 1742000000,
			rankedEntryClosesAt: 1742000000 + 24 * 60 * 60 - 1800,
			endsAt: 1742000000 + 24 * 60 * 60,
			configHash: 'a'.repeat(64),
			rankedSeedCommitment: 'b'.repeat(64),
			practiceSeed: 'not-canonical!!',
			attempt: null,
		};
		expect(dailyChallengeChallengeResponseSchema.safeParse(challenge).success).toBe(false);
	});

	test('rejects unknown challenge response fields', () => {
		expect(
			dailyChallengeChallengeResponseSchema.safeParse({
				periodKey: '2026-03-14',
				challengeKind: 'blackjack-daily',
				challengeRulesetVersion: 'blackjack-daily-v1',
				gameRulesetVersion: 'blackjack-ranked-v1',
				scoreVersion: 'blackjack-daily-score-v1',
				startsAt: 1742000000,
				rankedEntryClosesAt: 1742000000,
				endsAt: 1742000000,
				configHash: 'a'.repeat(64),
				rankedSeedCommitment: 'b'.repeat(64),
				practiceSeed,
				attempt: null,
				rankedSeed: 'must-not-leak',
			}).success,
		).toBe(false);
	});
});

describe('dailyChallengeLeaderboardResponseSchema', () => {
	test('accepts a leaderboard with top entries and current-user standing', () => {
		const leaderboard = {
			periodKey: '2026-03-14',
			entries: [
				{
					rank: 1,
					playerName: 'Alice',
					endingBankroll: 2000,
					roundsCompleted: 10,
					durationSeconds: 300,
					settledAt: 1742000000,
					isCurrentUser: true,
				},
			],
			currentUser: { rank: 1, totalEligible: 50, percentile: 100 },
		};
		expect(dailyChallengeLeaderboardResponseSchema.safeParse(leaderboard).success).toBe(true);
	});

	test('accepts a leaderboard with no current user', () => {
		const leaderboard = {
			periodKey: '2026-03-14',
			entries: [],
			currentUser: null,
		};
		expect(dailyChallengeLeaderboardResponseSchema.safeParse(leaderboard).success).toBe(true);
	});

	test('rejects tied entries sharing the same rank only via competition ranking', () => {
		// competition ranking: equal scores -> equal rank, next rank skipped
		const leaderboard = {
			periodKey: '2026-03-14',
			entries: [
				{
					rank: 1,
					playerName: 'Alice',
					endingBankroll: 2000,
					roundsCompleted: 10,
					durationSeconds: 300,
					settledAt: 1742000000,
				},
				{
					rank: 1,
					playerName: 'Bob',
					endingBankroll: 2000,
					roundsCompleted: 10,
					durationSeconds: 350,
					settledAt: 1742000001,
				},
			],
			currentUser: null,
		};
		expect(dailyChallengeLeaderboardResponseSchema.safeParse(leaderboard).success).toBe(true);
	});

	test('rejects a public leaderboard entry exposing a raw userId', () => {
		const leaderboard = {
			periodKey: '2026-03-14',
			entries: [
				{
					rank: 1,
					userId: 'user-1',
					playerName: 'Alice',
					endingBankroll: 2000,
					roundsCompleted: 10,
					durationSeconds: 300,
					settledAt: 1742000000,
				},
			],
			currentUser: null,
		};
		expect(dailyChallengeLeaderboardResponseSchema.safeParse(leaderboard).success).toBe(false);
	});
});

describe('dailyChallengeHistoryResponseSchema', () => {
	test('accepts a history response with terminal entries', () => {
		const history = {
			entries: [
				{
					periodKey: '2026-03-14',
					challengeRulesetVersion: 'blackjack-daily-v1',
					endingBankroll: 1200,
					roundsCompleted: 10,
					terminalReason: 'completed',
					eligible: true,
					settledAt: 1742000000,
				},
			],
		};
		expect(dailyChallengeHistoryResponseSchema.safeParse(history).success).toBe(true);
	});

	test('rejects unknown history fields', () => {
		expect(
			dailyChallengeHistoryResponseSchema.safeParse({
				entries: [
					{
						periodKey: '2026-03-14',
						challengeRulesetVersion: 'blackjack-daily-v1',
						endingBankroll: 1200,
						roundsCompleted: 10,
						terminalReason: 'completed',
						eligible: true,
						settledAt: 1742000000,
						extra: true,
					},
				],
			}).success,
		).toBe(false);
	});
});
