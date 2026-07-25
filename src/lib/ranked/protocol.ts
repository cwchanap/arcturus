import { z } from 'zod';
import type { RankedJson } from './canonical';

export const requestIdSchema = z.string().regex(/^[A-Za-z0-9_-]{16,128}$/);
export const sessionIdSchema = z.string().regex(/^[A-Za-z0-9_-]{22}$/);
export const rankedActionSchema = z.enum(['hit', 'stand', 'double-down', 'split']);
export const safeIntegerSchema = z
	.number()
	.refine((value) => Number.isSafeInteger(value) && !Object.is(value, -0));

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

export type RankedStartRequest = z.infer<typeof startRequestSchema>;
export type RankedBlackjackAction = z.infer<typeof rankedActionSchema>;
export type RankedBlackjackActionLogEntryV1 = z.infer<typeof actionRequestSchema>;
export type RankedBlackjackActionLogV1 = z.infer<typeof actionLogSchema>;
export type RankedSessionStatus = 'active' | 'settled' | 'expired';

export interface RankedReceiptV1<TOutcome extends RankedJson = RankedJson> {
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
	statsEffects: RankedJson;
	achievementEffects: RankedJson;
	rewardEffects: RankedJson;
	settledAt: number;
	receiptHash: string;
}

export interface RankedPublicStateV1<TState> {
	sessionId: string;
	status: RankedSessionStatus;
	gameType: 'blackjack';
	rulesetVersion: 'blackjack-ranked-v1';
	seedCommitment: string;
	expiresAt: number;
	nextSequence: number;
	state: TState;
	receipt: RankedReceiptV1 | null;
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
