import { describe, expect, test } from 'bun:test';
import { encodeBase64Url } from '../ranked/canonical';
import {
	parseDailyChallengeAttemptResponse,
	parseDailyChallengeChallengeResponse,
	parseDailyChallengeHistoryResponse,
	parseDailyChallengeLeaderboardResponse,
} from './payload';

const ATTEMPT_ID = 'abcdefghijklmnopqrstuv';
const CHALLENGE_ID = 'challenge_12345678';
const REQUEST_ID = 'request_1234567890';
const PERIOD_KEY = '2026-03-14';
const HEX_64_A = 'a'.repeat(64);
const HEX_64_B = 'b'.repeat(64);
const HEX_64_C = 'c'.repeat(64);
const HEX_64_D = 'd'.repeat(64);
const PRACTICE_SEED = encodeBase64Url(Uint8Array.from({ length: 32 }, (_, index) => 64 + index));

const activeRoundFixture = {
	phase: 'player-turn',
	playerHands: [
		{
			cards: [
				{ rank: 'A', suit: 'hearts' },
				{ rank: '9', suit: 'diamonds' },
			],
			wager: 100,
			value: { value: 20, isSoft: true, isBust: false },
		},
	],
	activeHandIndex: 0,
	dealer: {
		cards: [{ rank: '7', suit: 'spades' }],
		value: { value: 7, isSoft: false, isBust: false },
	},
	committedWager: 100,
	availableActions: ['hit', 'stand'],
	outcome: null,
};

function activeAttempt(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		attemptId: ATTEMPT_ID,
		challengeId: CHALLENGE_ID,
		startRequestId: REQUEST_ID,
		status: 'active',
		nextCommandSequence: 0,
		availableBankroll: 1000,
		roundsCompleted: 0,
		activeRound: activeRoundFixture,
		rank: null,
		percentile: null,
		receipt: null,
		expiresAt: 1_742_000_000,
		...overrides,
	};
}

function buildReceipt(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		attemptId: ATTEMPT_ID,
		challengeId: CHALLENGE_ID,
		periodKey: PERIOD_KEY,
		challengeRulesetVersion: 'blackjack-daily-v1',
		gameRulesetVersion: 'blackjack-ranked-v1',
		scoreVersion: 'blackjack-daily-score-v1',
		configHash: HEX_64_A,
		rankedSeedCommitment: HEX_64_B,
		actionLogHash: HEX_64_C,
		endingBankroll: 1200,
		roundsCompleted: 10,
		eligible: true,
		terminalReason: 'completed',
		durationSeconds: 600,
		settledAt: 1_742_001_000,
		receiptHash: HEX_64_D,
		...overrides,
	};
}

function terminalAttempt(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		...activeAttempt(),
		status: 'completed',
		nextCommandSequence: 40,
		availableBankroll: 1200,
		roundsCompleted: 10,
		activeRound: null,
		rank: 3,
		percentile: 95.5,
		receipt: buildReceipt(),
		...overrides,
	};
}

describe('parseDailyChallengeAttemptResponse — happy paths', () => {
	test('accepts an active attempt with a live round and no receipt', () => {
		expect(parseDailyChallengeAttemptResponse(activeAttempt())).toEqual(activeAttempt());
	});

	test('accepts an active attempt between rounds (null activeRound)', () => {
		const between = activeAttempt({ activeRound: null });
		expect(parseDailyChallengeAttemptResponse(between)).toEqual(between);
	});

	test('accepts a terminal completed attempt with receipt and null active round', () => {
		expect(parseDailyChallengeAttemptResponse(terminalAttempt())).toEqual(terminalAttempt());
	});

	test('accepts a terminal bankroll-below-minimum attempt mapped to status completed', () => {
		const value = terminalAttempt({
			receipt: buildReceipt({ terminalReason: 'bankroll-below-minimum', eligible: true }),
		});
		expect(parseDailyChallengeAttemptResponse(value)).toEqual(value);
	});

	test('accepts a forfeited attempt with matching reason and status', () => {
		const value = terminalAttempt({
			status: 'forfeited',
			rank: null,
			percentile: null,
			receipt: buildReceipt({ terminalReason: 'forfeited', eligible: false }),
		});
		expect(parseDailyChallengeAttemptResponse(value)).toEqual(value);
	});

	test('accepts an expired attempt with matching reason and status', () => {
		const value = terminalAttempt({
			status: 'expired',
			rank: null,
			percentile: null,
			receipt: buildReceipt({ terminalReason: 'expired', eligible: false }),
		});
		expect(parseDailyChallengeAttemptResponse(value)).toEqual(value);
	});
});

describe('parseDailyChallengeAttemptResponse — status/receipt consistency', () => {
	test('rejects an active attempt that carries a receipt', () => {
		expect(() =>
			parseDailyChallengeAttemptResponse(activeAttempt({ receipt: buildReceipt() })),
		).toThrow(/receipt/i);
	});

	test('rejects a terminal attempt missing a receipt', () => {
		expect(() =>
			parseDailyChallengeAttemptResponse(
				terminalAttempt({ status: 'completed', receipt: null, activeRound: null }),
			),
		).toThrow(/receipt/i);
	});

	test('rejects a terminal attempt that still exposes an active round', () => {
		expect(() =>
			parseDailyChallengeAttemptResponse(terminalAttempt({ activeRound: activeRoundFixture })),
		).toThrow(/active round/i);
	});

	test('rejects a completed status with a forfeited receipt reason', () => {
		expect(() =>
			parseDailyChallengeAttemptResponse(
				terminalAttempt({
					receipt: buildReceipt({ terminalReason: 'forfeited' }),
				}),
			),
		).toThrow(/reason/i);
	});

	test('rejects a forfeited status with a completed receipt reason', () => {
		expect(() =>
			parseDailyChallengeAttemptResponse(
				terminalAttempt({
					status: 'forfeited',
					rank: null,
					percentile: null,
					receipt: buildReceipt({ terminalReason: 'completed' }),
				}),
			),
		).toThrow(/reason/i);
	});

	test('rejects an expired status with a bankroll-below-minimum receipt reason', () => {
		expect(() =>
			parseDailyChallengeAttemptResponse(
				terminalAttempt({
					status: 'expired',
					rank: null,
					percentile: null,
					receipt: buildReceipt({ terminalReason: 'bankroll-below-minimum' }),
				}),
			),
		).toThrow(/reason/i);
	});
});

describe('parseDailyChallengeAttemptResponse — terminal-state field combinations', () => {
	test('rejects a completed attempt whose receipt is marked ineligible', () => {
		expect(() =>
			parseDailyChallengeAttemptResponse(
				terminalAttempt({ receipt: buildReceipt({ eligible: false }) }),
			),
		).toThrow(/eligible/i);
	});

	test('rejects a forfeited attempt whose receipt is marked eligible', () => {
		expect(() =>
			parseDailyChallengeAttemptResponse(
				terminalAttempt({
					status: 'forfeited',
					rank: null,
					percentile: null,
					receipt: buildReceipt({ terminalReason: 'forfeited', eligible: true }),
				}),
			),
		).toThrow(/eligible/i);
	});

	test('rejects a forfeited attempt that exposes a rank', () => {
		expect(() =>
			parseDailyChallengeAttemptResponse(
				terminalAttempt({
					status: 'forfeited',
					rank: 4,
					percentile: null,
					receipt: buildReceipt({ terminalReason: 'forfeited', eligible: false }),
				}),
			),
		).toThrow(/rank/i);
	});

	test('rejects a forfeited attempt that exposes a percentile', () => {
		expect(() =>
			parseDailyChallengeAttemptResponse(
				terminalAttempt({
					status: 'forfeited',
					rank: null,
					percentile: 50,
					receipt: buildReceipt({ terminalReason: 'forfeited', eligible: false }),
				}),
			),
		).toThrow(/percentile/i);
	});

	test('rejects an expired attempt whose receipt is marked eligible', () => {
		expect(() =>
			parseDailyChallengeAttemptResponse(
				terminalAttempt({
					status: 'expired',
					rank: null,
					percentile: null,
					receipt: buildReceipt({ terminalReason: 'expired', eligible: true }),
				}),
			),
		).toThrow(/eligible/i);
	});

	test('rejects an expired attempt that exposes a rank', () => {
		expect(() =>
			parseDailyChallengeAttemptResponse(
				terminalAttempt({
					status: 'expired',
					rank: 7,
					percentile: null,
					receipt: buildReceipt({ terminalReason: 'expired', eligible: false }),
				}),
			),
		).toThrow(/rank/i);
	});

	test('rejects an expired attempt that exposes a percentile', () => {
		expect(() =>
			parseDailyChallengeAttemptResponse(
				terminalAttempt({
					status: 'expired',
					rank: null,
					percentile: 12.5,
					receipt: buildReceipt({ terminalReason: 'expired', eligible: false }),
				}),
			),
		).toThrow(/percentile/i);
	});
});

describe('parseDailyChallengeAttemptResponse — nested nextSequence rejection', () => {
	test('rejects an attempt whose activeRound exposes nextSequence', () => {
		const leaking = activeAttempt({
			activeRound: { ...activeRoundFixture, nextSequence: 1 },
		});
		expect(() => parseDailyChallengeAttemptResponse(leaking)).toThrow(/nextSequence/i);
	});
});

describe('parseDailyChallengeAttemptResponse — live ranked seed rejection', () => {
	test('rejects an attempt response that leaks a top-level rankedSeed', () => {
		const leaking = { ...activeAttempt(), rankedSeed: 'never-leak-the-seed' };
		expect(() => parseDailyChallengeAttemptResponse(leaking)).toThrow(/ranked seed/i);
	});
});

describe('parseDailyChallengeAttemptResponse — missing and extra fields', () => {
	test('rejects an attempt missing attemptId', () => {
		const { attemptId: _omit, ...rest } = activeAttempt();
		expect(() => parseDailyChallengeAttemptResponse(rest)).toThrow();
	});

	test('rejects an attempt with an extra unknown field', () => {
		expect(() => parseDailyChallengeAttemptResponse({ ...activeAttempt(), extra: true })).toThrow();
	});

	test('rejects an attempt missing status', () => {
		const { status: _omit, ...rest } = activeAttempt();
		expect(() => parseDailyChallengeAttemptResponse(rest)).toThrow();
	});
});

describe('parseDailyChallengeAttemptResponse — malformed identifiers', () => {
	test('rejects a malformed attemptId', () => {
		expect(() =>
			parseDailyChallengeAttemptResponse(activeAttempt({ attemptId: 'too-short' })),
		).toThrow();
	});

	test('rejects a malformed challengeId', () => {
		expect(() =>
			parseDailyChallengeAttemptResponse(activeAttempt({ challengeId: 'short' })),
		).toThrow();
	});

	test('rejects a malformed startRequestId', () => {
		expect(() =>
			parseDailyChallengeAttemptResponse(activeAttempt({ startRequestId: 'short' })),
		).toThrow();
	});
});

describe('parseDailyChallengeAttemptResponse — negative and unsafe numerics', () => {
	test('rejects a negative availableBankroll', () => {
		expect(() =>
			parseDailyChallengeAttemptResponse(activeAttempt({ availableBankroll: -1 })),
		).toThrow();
	});

	test('rejects a negative-zero availableBankroll', () => {
		expect(() =>
			parseDailyChallengeAttemptResponse(activeAttempt({ availableBankroll: -0 })),
		).toThrow();
	});

	test('rejects a non-integer availableBankroll', () => {
		expect(() =>
			parseDailyChallengeAttemptResponse(activeAttempt({ availableBankroll: 10.5 })),
		).toThrow();
	});

	test('rejects a negative nextCommandSequence', () => {
		expect(() =>
			parseDailyChallengeAttemptResponse(activeAttempt({ nextCommandSequence: -1 })),
		).toThrow();
	});

	test('rejects an unsafe-integer nextCommandSequence', () => {
		expect(() =>
			parseDailyChallengeAttemptResponse({
				...activeAttempt(),
				nextCommandSequence: Number.MAX_SAFE_INTEGER + 1,
			}),
		).toThrow();
	});

	test('rejects an unsafe-integer receipt endingBankroll', () => {
		expect(() =>
			parseDailyChallengeAttemptResponse(
				terminalAttempt({
					receipt: buildReceipt({
						endingBankroll: Number.MAX_SAFE_INTEGER + 1,
					}),
				}),
			),
		).toThrow();
	});
});

describe('parseDailyChallengeChallengeResponse — happy paths', () => {
	function challengeResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
		return {
			periodKey: PERIOD_KEY,
			challengeKind: 'blackjack-daily',
			challengeRulesetVersion: 'blackjack-daily-v1',
			gameRulesetVersion: 'blackjack-ranked-v1',
			scoreVersion: 'blackjack-daily-score-v1',
			startsAt: 1_742_000_000,
			rankedEntryClosesAt: 1_742_000_000 + 86_400 - 1800,
			endsAt: 1_742_000_000 + 86_400,
			configHash: HEX_64_A,
			rankedSeedCommitment: HEX_64_B,
			practiceSeed: PRACTICE_SEED,
			revealedRankedSeed: null,
			attempt: null,
			...overrides,
		};
	}

	test('accepts a catalog response with no attempt (unauthenticated summary)', () => {
		expect(parseDailyChallengeChallengeResponse(challengeResponse())).toEqual(challengeResponse());
	});

	test('accepts a response embedding an active attempt', () => {
		const value = challengeResponse({ attempt: activeAttempt() });
		expect(parseDailyChallengeChallengeResponse(value)).toEqual(value);
	});

	test('accepts a response embedding a terminal attempt', () => {
		const value = challengeResponse({ attempt: terminalAttempt() });
		expect(parseDailyChallengeChallengeResponse(value)).toEqual(value);
	});

	test('accepts a live challenge response with a null revealed seed', () => {
		const value = challengeResponse({ revealedRankedSeed: null });
		expect(parseDailyChallengeChallengeResponse(value)).toEqual(value);
	});

	test('accepts a closed challenge response with the canonical revealed seed', () => {
		const seed = encodeBase64Url(Uint8Array.from({ length: 32 }, (_, index) => index));
		const value = challengeResponse({ revealedRankedSeed: seed });
		expect(parseDailyChallengeChallengeResponse(value)).toEqual(value);
	});
});

describe('parseDailyChallengeChallengeResponse — defense-in-depth', () => {
	function liveChallengeResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
		return {
			periodKey: PERIOD_KEY,
			challengeKind: 'blackjack-daily',
			challengeRulesetVersion: 'blackjack-daily-v1',
			gameRulesetVersion: 'blackjack-ranked-v1',
			scoreVersion: 'blackjack-daily-score-v1',
			startsAt: 1_742_000_000,
			rankedEntryClosesAt: 1_742_000_000 + 86_400 - 1800,
			endsAt: 1_742_000_000 + 86_400,
			configHash: HEX_64_A,
			rankedSeedCommitment: HEX_64_B,
			practiceSeed: PRACTICE_SEED,
			revealedRankedSeed: null,
			attempt: null,
			...overrides,
		};
	}

	test('rejects a challenge response leaking a live rankedSeed', () => {
		expect(() =>
			parseDailyChallengeChallengeResponse({ ...liveChallengeResponse(), rankedSeed: 'leak' }),
		).toThrow(/ranked seed/i);
	});

	test('accepts a server-authorized revealed seed regardless of the browser clock (server is the disclosure boundary)', () => {
		// The parser no longer gates seed disclosure on Date.now() or endsAt.
		// The server is the authoritative boundary for when to reveal; the
		// client trusts the server's decision and only validates the format.
		// This test pins that contract: a response with a revealed seed is
		// accepted even when endsAt is far in the future.
		const seed = encodeBase64Url(Uint8Array.from({ length: 32 }, (_, index) => index));
		const value = {
			...liveChallengeResponse(),
			endsAt: Number.MAX_SAFE_INTEGER,
			revealedRankedSeed: seed,
		};
		expect(parseDailyChallengeChallengeResponse(value)).toEqual(value);
	});

	test('rejects a challenge response whose embedded attempt leaks activeRound.nextSequence', () => {
		expect(() =>
			parseDailyChallengeChallengeResponse({
				...liveChallengeResponse(),
				attempt: activeAttempt({
					activeRound: { ...activeRoundFixture, nextSequence: 1 },
				}),
			}),
		).toThrow(/nextSequence/i);
	});

	test('rejects a challenge response whose embedded attempt carries an inconsistent receipt', () => {
		expect(() =>
			parseDailyChallengeChallengeResponse({
				...liveChallengeResponse(),
				attempt: activeAttempt({ receipt: buildReceipt() }),
			}),
		).toThrow(/receipt/i);
	});

	test('rejects an unknown challenge response field', () => {
		expect(() =>
			parseDailyChallengeChallengeResponse({ ...liveChallengeResponse(), unknown: true }),
		).toThrow();
	});

	test('rejects a closed challenge response carrying a malformed revealed seed', () => {
		let caught: unknown;
		try {
			parseDailyChallengeChallengeResponse({
				...liveChallengeResponse(),
				revealedRankedSeed: 'not-canonical!!',
			});
		} catch (error) {
			caught = error;
		}
		const issues = (caught as { issues: { path: PropertyKey[] }[] }).issues;
		expect(Array.isArray(issues)).toBe(true);
		expect(issues.some((issue) => issue.path.includes('revealedRankedSeed'))).toBe(true);
	});

	test('rejects a challenge response carrying a malformed practice seed', () => {
		let caught: unknown;
		try {
			parseDailyChallengeChallengeResponse({
				...liveChallengeResponse(),
				practiceSeed: 'not-canonical!!',
			});
		} catch (error) {
			caught = error;
		}
		const issues = (caught as { issues: { path: PropertyKey[] }[] }).issues;
		expect(Array.isArray(issues)).toBe(true);
		expect(issues.some((issue) => issue.path.includes('practiceSeed'))).toBe(true);
	});
});

describe('parseDailyChallengeLeaderboardResponse', () => {
	function leaderboardResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
		return {
			periodKey: PERIOD_KEY,
			entries: [
				{
					rank: 1,
					playerName: 'Alice',
					endingBankroll: 2000,
					roundsCompleted: 10,
					durationSeconds: 300,
					settledAt: 1_742_000_500,
				},
			],
			currentUser: { rank: 1, totalEligible: 50, percentile: 100 },
			...overrides,
		};
	}

	test('accepts a leaderboard with current-user standing (authenticated summary)', () => {
		expect(parseDailyChallengeLeaderboardResponse(leaderboardResponse())).toEqual(
			leaderboardResponse(),
		);
	});

	test('accepts a leaderboard with no current user (unauthenticated summary optionality)', () => {
		const value = leaderboardResponse({ currentUser: null });
		expect(parseDailyChallengeLeaderboardResponse(value)).toEqual(value);
	});

	test('accepts tied entries sharing the same rank (competition ranking)', () => {
		const value = leaderboardResponse({
			entries: [
				{
					rank: 1,
					playerName: 'Alice',
					endingBankroll: 2000,
					roundsCompleted: 10,
					durationSeconds: 300,
					settledAt: 1_742_000_500,
				},
				{
					rank: 1,
					playerName: 'Bob',
					endingBankroll: 2000,
					roundsCompleted: 10,
					durationSeconds: 350,
					settledAt: 1_742_000_501,
				},
			],
		});
		expect(parseDailyChallengeLeaderboardResponse(value)).toEqual(value);
	});

	test('accepts a current-user marker on exactly one entry', () => {
		const value = leaderboardResponse({
			entries: [
				{
					rank: 1,
					playerName: 'Alice',
					endingBankroll: 2000,
					roundsCompleted: 10,
					durationSeconds: 300,
					settledAt: 1_742_000_500,
					isCurrentUser: true,
				},
			],
		});
		expect(parseDailyChallengeLeaderboardResponse(value)).toEqual(value);
	});

	test('rejects an entry with rank below 1', () => {
		expect(() =>
			parseDailyChallengeLeaderboardResponse(
				leaderboardResponse({
					entries: [
						{
							rank: 0,
							playerName: 'Alice',
							endingBankroll: 2000,
							roundsCompleted: 10,
							durationSeconds: 300,
							settledAt: 1_742_000_500,
						},
					],
				}),
			),
		).toThrow();
	});

	test('rejects a public leaderboard entry exposing a raw userId', () => {
		expect(() =>
			parseDailyChallengeLeaderboardResponse(
				leaderboardResponse({
					entries: [
						{
							rank: 1,
							userId: 'user-1',
							playerName: 'Alice',
							endingBankroll: 2000,
							roundsCompleted: 10,
							durationSeconds: 300,
							settledAt: 1_742_000_500,
						},
					],
				}),
			),
		).toThrow(/unrecognized/i);
	});

	test('rejects a leaderboard response leaking a live rankedSeed', () => {
		expect(() =>
			parseDailyChallengeLeaderboardResponse({ ...leaderboardResponse(), rankedSeed: 'leak' }),
		).toThrow(/ranked seed/i);
	});

	test('rejects a leaderboard with an extra top-level field', () => {
		expect(() =>
			parseDailyChallengeLeaderboardResponse({ ...leaderboardResponse(), extra: true }),
		).toThrow();
	});
});

describe('parseDailyChallengeHistoryResponse', () => {
	function historyResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
		return {
			entries: [
				{
					periodKey: PERIOD_KEY,
					challengeRulesetVersion: 'blackjack-daily-v1',
					topEndingBankroll: 1200,
					participantCount: 42,
					userResult: {
						endingBankroll: 900,
						roundsCompleted: 10,
						terminalReason: 'completed',
						eligible: true,
						settledAt: 1_742_001_000,
					},
				},
			],
			...overrides,
		};
	}

	test('accepts a history response with terminal entries', () => {
		expect(parseDailyChallengeHistoryResponse(historyResponse())).toEqual(historyResponse());
	});

	test('accepts an empty history (unauthenticated summary optionality)', () => {
		const value = historyResponse({ entries: [] });
		expect(parseDailyChallengeHistoryResponse(value)).toEqual(value);
	});

	test('accepts a challenge day with no user result and no top score', () => {
		const value = historyResponse({
			entries: [
				{
					periodKey: PERIOD_KEY,
					challengeRulesetVersion: 'blackjack-daily-v1',
					topEndingBankroll: null,
					participantCount: 0,
					userResult: null,
				},
			],
		});
		expect(parseDailyChallengeHistoryResponse(value)).toEqual(value);
	});

	test('rejects a history user result with an unknown terminalReason', () => {
		expect(() =>
			parseDailyChallengeHistoryResponse(
				historyResponse({
					entries: [
						{
							periodKey: PERIOD_KEY,
							challengeRulesetVersion: 'blackjack-daily-v1',
							topEndingBankroll: 1200,
							participantCount: 42,
							userResult: {
								endingBankroll: 900,
								roundsCompleted: 10,
								terminalReason: 'mystery',
								eligible: true,
								settledAt: 1_742_001_000,
							},
						},
					],
				}),
			),
		).toThrow();
	});

	test('rejects a history response with an extra field', () => {
		expect(() =>
			parseDailyChallengeHistoryResponse({ ...historyResponse(), extra: true }),
		).toThrow();
	});

	test('rejects a history response leaking a live rankedSeed', () => {
		expect(() =>
			parseDailyChallengeHistoryResponse({ ...historyResponse(), rankedSeed: 'leak' }),
		).toThrow(/ranked seed/i);
	});
});
