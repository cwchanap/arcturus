import { z } from 'zod';
import { decodeCanonicalBase64Url } from '../ranked/canonical';
import type { RankedBlackjackPublicStateV1 } from '../ranked/blackjack/types';

export const dailyChallengeRequestIdSchema = z.string().regex(/^[A-Za-z0-9_-]{16,128}$/);
export const dailyChallengeAttemptIdSchema = z.string().regex(/^[A-Za-z0-9_-]{22}$/);
export const dailyChallengeChallengeIdSchema = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/);
export const dailyChallengePeriodKeySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const dailyChallengeSafeIntegerSchema = z
	.number()
	.refine((value) => Number.isSafeInteger(value) && !Object.is(value, -0));
export const dailyChallengeSequenceSchema = z
	.number()
	.refine((value) => Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0));
export const dailyChallengeBankrollSchema = dailyChallengeSafeIntegerSchema.min(0);
export const dailyChallengeHex64Schema = z.string().regex(/^[0-9a-f]{64}$/);

const dailyChallengeCanonicalSeedSchema = z.string().refine((value) => {
	try {
		decodeCanonicalBase64Url(value);
		return true;
	} catch {
		return false;
	}
}, 'Invalid canonical base64url daily challenge seed');

export const dailyChallengeStartRequestSchema = z
	.object({ requestId: dailyChallengeRequestIdSchema })
	.strict();

export const dailyChallengeCommandSchema = z.discriminatedUnion('command', [
	z
		.object({
			sequence: dailyChallengeSequenceSchema,
			command: z.literal('start-round'),
			wager: dailyChallengeSafeIntegerSchema,
		})
		.strict(),
	z
		.object({
			sequence: dailyChallengeSequenceSchema,
			command: z.enum(['hit', 'stand', 'double-down', 'split', 'forfeit']),
		})
		.strict(),
]);

export const dailyChallengeCommandLogSchema = z.array(dailyChallengeCommandSchema);

export type DailyChallengeStartRequest = z.infer<typeof dailyChallengeStartRequestSchema>;
export type DailyChallengeCommandV1 = z.infer<typeof dailyChallengeCommandSchema>;
export type DailyChallengeCommandLogV1 = z.infer<typeof dailyChallengeCommandLogSchema>;
export type DailyChallengeAttemptStatus = 'active' | 'completed' | 'forfeited' | 'expired';
export type DailyChallengeTerminalReason =
	| 'completed'
	| 'bankroll-below-minimum'
	| 'forfeited'
	| 'expired';

const dailyChallengeCardSchema = z
	.object({
		rank: z.enum(['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K']),
		suit: z.enum(['hearts', 'diamonds', 'clubs', 'spades']),
	})
	.strict();

const dailyChallengeHandValueSchema = z
	.object({
		value: z.number(),
		isSoft: z.boolean(),
		isBust: z.boolean(),
	})
	.strict();

const dailyChallengeRoundActionSchema = z.enum(['hit', 'stand', 'double-down', 'split']);

const dailyChallengeHandOutcomeSchema = z
	.object({
		handIndex: dailyChallengeSafeIntegerSchema.min(0),
		result: z.enum(['win', 'loss', 'push', 'blackjack']),
		wager: dailyChallengeSafeIntegerSchema,
		payout: dailyChallengeSafeIntegerSchema,
	})
	.strict();

const dailyChallengeOutcomeSchema = z
	.object({
		result: z.enum(['win', 'loss', 'push']),
		hands: z.array(dailyChallengeHandOutcomeSchema),
		committedWager: dailyChallengeSafeIntegerSchema,
		payout: dailyChallengeSafeIntegerSchema,
		gameNetDelta: dailyChallengeSafeIntegerSchema,
	})
	.strict();

export const dailyChallengeActiveRoundSchema = z
	.object({
		phase: z.enum(['player-turn', 'complete']),
		playerHands: z.array(
			z
				.object({
					cards: z.array(dailyChallengeCardSchema),
					wager: dailyChallengeSafeIntegerSchema,
					value: dailyChallengeHandValueSchema,
				})
				.strict(),
		),
		activeHandIndex: dailyChallengeSafeIntegerSchema.min(0),
		dealer: z
			.object({
				cards: z.array(dailyChallengeCardSchema),
				value: dailyChallengeHandValueSchema,
			})
			.strict(),
		committedWager: dailyChallengeSafeIntegerSchema,
		availableActions: z.array(dailyChallengeRoundActionSchema),
		outcome: dailyChallengeOutcomeSchema.nullable(),
	})
	.strict();

export type DailyChallengeActiveRoundV1 = z.infer<typeof dailyChallengeActiveRoundSchema>;

const _activeRoundCompat: Omit<RankedBlackjackPublicStateV1, 'nextSequence'> =
	{} as DailyChallengeActiveRoundV1;
void _activeRoundCompat;

export const dailyChallengeReceiptSchema = z
	.object({
		attemptId: dailyChallengeAttemptIdSchema,
		challengeId: dailyChallengeChallengeIdSchema,
		periodKey: dailyChallengePeriodKeySchema,
		challengeRulesetVersion: z.literal('blackjack-daily-v1'),
		gameRulesetVersion: z.literal('blackjack-ranked-v1'),
		scoreVersion: z.literal('blackjack-daily-score-v1'),
		configHash: dailyChallengeHex64Schema,
		rankedSeedCommitment: dailyChallengeHex64Schema,
		actionLogHash: dailyChallengeHex64Schema,
		endingBankroll: dailyChallengeBankrollSchema,
		roundsCompleted: dailyChallengeSafeIntegerSchema.min(0),
		eligible: z.boolean(),
		terminalReason: z.enum(['completed', 'bankroll-below-minimum', 'forfeited', 'expired']),
		durationSeconds: dailyChallengeSafeIntegerSchema.min(0),
		settledAt: dailyChallengeSafeIntegerSchema.min(0),
		receiptHash: dailyChallengeHex64Schema,
	})
	.strict();

export type DailyChallengeReceiptV1 = z.infer<typeof dailyChallengeReceiptSchema>;

export const dailyChallengeAttemptPublicStateSchema = z
	.object({
		attemptId: dailyChallengeAttemptIdSchema,
		challengeId: dailyChallengeChallengeIdSchema,
		startRequestId: dailyChallengeRequestIdSchema,
		status: z.enum(['active', 'completed', 'forfeited', 'expired']),
		nextCommandSequence: dailyChallengeSequenceSchema,
		availableBankroll: dailyChallengeBankrollSchema,
		roundsCompleted: dailyChallengeSafeIntegerSchema.min(0),
		activeRound: dailyChallengeActiveRoundSchema.nullable(),
		rank: dailyChallengeSafeIntegerSchema.min(1).nullable(),
		percentile: z.number().min(0).max(100).nullable(),
		receipt: dailyChallengeReceiptSchema.nullable(),
		expiresAt: dailyChallengeSafeIntegerSchema.min(0),
	})
	.strict();

export type DailyChallengeAttemptPublicStateV1 = z.infer<
	typeof dailyChallengeAttemptPublicStateSchema
>;

export const dailyChallengeChallengeResponseSchema = z
	.object({
		periodKey: dailyChallengePeriodKeySchema,
		challengeKind: z.literal('blackjack-daily'),
		challengeRulesetVersion: z.literal('blackjack-daily-v1'),
		gameRulesetVersion: z.literal('blackjack-ranked-v1'),
		scoreVersion: z.literal('blackjack-daily-score-v1'),
		startsAt: dailyChallengeSafeIntegerSchema.min(0),
		rankedEntryClosesAt: dailyChallengeSafeIntegerSchema.min(0),
		endsAt: dailyChallengeSafeIntegerSchema.min(0),
		configHash: dailyChallengeHex64Schema,
		rankedSeedCommitment: dailyChallengeHex64Schema,
		practiceSeed: dailyChallengeCanonicalSeedSchema,
		revealedRankedSeed: dailyChallengeCanonicalSeedSchema.nullable().optional(),
		attempt: dailyChallengeAttemptPublicStateSchema.nullable(),
	})
	.strict();

export type DailyChallengePublicResponse = z.infer<typeof dailyChallengeChallengeResponseSchema>;

export const dailyChallengeLeaderboardEntrySchema = z
	.object({
		rank: dailyChallengeSafeIntegerSchema.min(1),
		playerName: z.string().min(1),
		endingBankroll: dailyChallengeBankrollSchema,
		roundsCompleted: dailyChallengeSafeIntegerSchema.min(0),
		durationSeconds: dailyChallengeSafeIntegerSchema.min(0),
		settledAt: dailyChallengeSafeIntegerSchema.min(0),
		isCurrentUser: z.boolean().optional(),
	})
	.strict();

export const dailyChallengeCurrentUserStandingSchema = z
	.object({
		rank: dailyChallengeSafeIntegerSchema.min(1),
		totalEligible: dailyChallengeSafeIntegerSchema.min(1),
		percentile: z.number().min(0).max(100),
	})
	.strict();

export const dailyChallengeLeaderboardResponseSchema = z
	.object({
		periodKey: dailyChallengePeriodKeySchema,
		entries: z.array(dailyChallengeLeaderboardEntrySchema),
		currentUser: dailyChallengeCurrentUserStandingSchema.nullable(),
	})
	.strict();

export type DailyChallengeLeaderboardResponse = z.infer<
	typeof dailyChallengeLeaderboardResponseSchema
>;

export const dailyChallengeHistoryUserResultSchema = z
	.object({
		endingBankroll: dailyChallengeBankrollSchema,
		roundsCompleted: dailyChallengeSafeIntegerSchema.min(0),
		terminalReason: z.enum(['completed', 'bankroll-below-minimum', 'forfeited', 'expired']),
		eligible: z.boolean(),
		settledAt: dailyChallengeSafeIntegerSchema.min(0),
	})
	.strict();

export type DailyChallengeHistoryUserResult = z.infer<typeof dailyChallengeHistoryUserResultSchema>;

export const dailyChallengeHistoryEntrySchema = z
	.object({
		periodKey: dailyChallengePeriodKeySchema,
		challengeRulesetVersion: z.literal('blackjack-daily-v1'),
		topEndingBankroll: dailyChallengeBankrollSchema.nullable(),
		participantCount: dailyChallengeSafeIntegerSchema.min(0),
		userResult: dailyChallengeHistoryUserResultSchema.nullable(),
	})
	.strict();

export const dailyChallengeHistoryResponseSchema = z
	.object({
		entries: z.array(dailyChallengeHistoryEntrySchema),
	})
	.strict();

export type DailyChallengeHistoryResponse = z.infer<typeof dailyChallengeHistoryResponseSchema>;

export const DAILY_CHALLENGE_ERROR_STATUS = Object.freeze({
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
} as const);

export type DailyChallengeErrorCode = keyof typeof DAILY_CHALLENGE_ERROR_STATUS;

export interface DailyChallengeServiceErrorOptions {
	expectedSequence?: number;
	retryAfter?: number;
	message?: string;
}

export class DailyChallengeServiceError extends Error {
	readonly code: DailyChallengeErrorCode;
	readonly expectedSequence?: number;
	readonly retryAfter?: number;

	constructor(code: DailyChallengeErrorCode, options: DailyChallengeServiceErrorOptions = {}) {
		super(options.message ?? code);
		this.name = 'DailyChallengeServiceError';
		this.code = code;
		this.expectedSequence = options.expectedSequence;
		this.retryAfter = options.retryAfter;
	}
}
