import { z } from 'zod';
import type { RankedJson } from './canonical';

export const requestIdSchema = z.string().regex(/^[A-Za-z0-9_-]{16,128}$/);
export const sessionIdSchema = z.string().regex(/^[A-Za-z0-9_-]{22}$/);
export const rankedActionSchema = z.enum(['hit', 'stand', 'double-down', 'split']);
export const safeIntegerSchema = z
	.number()
	.refine((value) => Number.isSafeInteger(value) && !Object.is(value, -0));
export const rankedBalanceSchema = safeIntegerSchema.min(0);

export const startRequestSchema = z
	.object({
		requestId: requestIdSchema,
		gameType: z.literal('blackjack'),
		rulesetVersion: z.literal('blackjack-ranked-v1'),
		wager: safeIntegerSchema.min(10).max(1000),
	})
	.strict();

export const actionRequestSchema = z
	.object({
		sequence: safeIntegerSchema.refine((value) => value >= 0),
		action: rankedActionSchema,
	})
	.strict();

export const actionLogSchema = z.array(actionRequestSchema);

const zeroOrOneSchema = z.union([z.literal(0), z.literal(1)]);

export const rankedStatsEffectsV1Schema = z
	.object({
		sessionsPlayed: z.literal(1),
		totalWins: zeroOrOneSchema,
		totalLosses: zeroOrOneSchema,
		totalPushes: zeroOrOneSchema,
		totalForfeits: zeroOrOneSchema,
		netProfit: safeIntegerSchema,
		biggestWin: safeIntegerSchema.min(0),
	})
	.strict()
	.superRefine((effects, context) => {
		if (effects.totalWins + effects.totalLosses + effects.totalPushes !== 1) {
			context.addIssue({
				code: 'custom',
				message: 'Exactly one ranked terminal classification is required',
			});
		}
		if (effects.totalForfeits > effects.totalLosses) {
			context.addIssue({
				code: 'custom',
				message: 'A ranked forfeit must also be a loss',
			});
		}
	});

export const rankedAchievementEffectsV1Schema = z.array(z.literal('ranked_debut')).max(1);

export const rankedRewardEffectsV1Schema = z
	.array(
		z
			.object({
				rewardId: z.literal('ranked_debut_100'),
				chipAmount: z.literal(100),
			})
			.strict(),
	)
	.max(1);

export type RankedStartRequest = z.infer<typeof startRequestSchema>;
export type RankedBlackjackAction = z.infer<typeof rankedActionSchema>;
export type RankedBlackjackActionLogEntryV1 = z.infer<typeof actionRequestSchema>;
export type RankedBlackjackActionLogV1 = z.infer<typeof actionLogSchema>;
export type RankedStatsEffectsV1 = z.infer<typeof rankedStatsEffectsV1Schema>;
export type RankedAchievementEffectsV1 = z.infer<typeof rankedAchievementEffectsV1Schema>;
export type RankedRewardEffectsV1 = z.infer<typeof rankedRewardEffectsV1Schema>;
export type RankedSessionStatus = 'active' | 'settled' | 'expired';

export type RankedReceiptV1<TOutcome extends RankedJson = RankedJson> = {
	sessionId: string;
	gameType: 'blackjack';
	rulesetVersion: 'blackjack-ranked-v1';
	seedCommitment: string;
	configHash: string;
	actionLogHash: string;
	outcome: TOutcome;
	initialWager: number;
	committedWager: number;
	payout: number;
	gameNetDelta: number;
	rewardDelta: number;
	balanceAfter: number;
	statsEffects: RankedStatsEffectsV1;
	achievementEffects: RankedAchievementEffectsV1;
	rewardEffects: RankedRewardEffectsV1;
	settledAt: number;
	receiptHash: string;
};

export interface RankedPublicStateV1<TState> {
	sessionId: string;
	status: RankedSessionStatus;
	gameType: 'blackjack';
	rulesetVersion: 'blackjack-ranked-v1';
	seedCommitment: string;
	expiresAt: number;
	nextSequence: number;
	balance: z.infer<typeof rankedBalanceSchema>;
	state: TState;
	receipt: RankedReceiptV1 | null;
}

export function createRankedPublicStateV1Schema<
	TStateSchema extends z.ZodType,
	TReceiptSchema extends z.ZodType,
>(stateSchema: TStateSchema, receiptSchema: TReceiptSchema) {
	return z
		.object({
			sessionId: sessionIdSchema,
			status: z.enum(['active', 'settled', 'expired']),
			gameType: z.literal('blackjack'),
			rulesetVersion: z.literal('blackjack-ranked-v1'),
			seedCommitment: z.string(),
			expiresAt: safeIntegerSchema.min(0),
			nextSequence: safeIntegerSchema.min(0),
			balance: rankedBalanceSchema,
			state: stateSchema,
			receipt: receiptSchema.nullable(),
		})
		.strict();
}

export const RANKED_ERROR_STATUS = {
	INVALID_REQUEST: 400,
	INVALID_WAGER: 400,
	INVALID_ACTION: 400,
	UNAUTHORIZED: 401,
	SESSION_NOT_FOUND: 404,
	ACTIVE_SESSION_EXISTS: 409,
	IDENTIFIER_REUSE_MISMATCH: 409,
	SEQUENCE_MISMATCH: 409,
	INSUFFICIENT_BALANCE: 409,
	ACCOUNT_BALANCE_CHANGED: 409,
	MULTIPLAYER_CONFLICT: 409,
	MULTIPLAYER_ESCROW_ORPHANED: 409,
	RATE_LIMITED: 429,
	INTERNAL_ERROR: 500,
} as const;

export type RankedErrorCode = keyof typeof RANKED_ERROR_STATUS;

export interface RankedServiceErrorOptions {
	expectedSequence?: number;
	retryAfter?: number;
	message?: string;
}

export class RankedServiceError extends Error {
	readonly code: RankedErrorCode;
	readonly expectedSequence?: number;
	readonly retryAfter?: number;

	constructor(code: RankedErrorCode, options: RankedServiceErrorOptions = {}) {
		super(options.message ?? code);
		this.name = 'RankedServiceError';
		this.code = code;
		this.expectedSequence = options.expectedSequence;
		this.retryAfter = options.retryAfter;
	}
}
