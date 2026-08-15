import { z } from 'zod';

// Schema primitives. Re-defined here so the blackjack-run module is
// self-contained; no other protocol module is imported.
export const requestIdSchema = z.string().regex(/^[A-Za-z0-9_-]{16,128}$/);
export const safeIntegerSchema = z
	.number()
	.refine((value) => Number.isSafeInteger(value) && !Object.is(value, -0));
export const periodKeySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const sequenceSchema = safeIntegerSchema.refine((value) => value >= 0);
export const balanceSchema = safeIntegerSchema.min(0);
export const runIdSchema = z.string().regex(/^[A-Za-z0-9_-]{22}$/);

export const blackjackActionSchema = z.enum(['hit', 'stand', 'double-down', 'split']);
export type BlackjackAction = z.infer<typeof blackjackActionSchema>;

// --- Start input: closed ranked | daily union, every member strict ---

export const blackjackRunStartSchema = z.discriminatedUnion('mode', [
	z
		.object({
			mode: z.literal('ranked'),
			requestId: requestIdSchema,
			wager: safeIntegerSchema.min(10).max(1000),
		})
		.strict(),
	z
		.object({
			mode: z.literal('daily'),
			requestId: requestIdSchema,
			periodKey: periodKeySchema,
		})
		.strict(),
]);
export type BlackjackRunStart = z.infer<typeof blackjackRunStartSchema>;

// --- Command input: closed union, every member strict ---

export const blackjackRunCommandSchema = z.discriminatedUnion('command', [
	z
		.object({
			sequence: sequenceSchema,
			command: z.literal('start-round'),
			wager: safeIntegerSchema,
		})
		.strict(),
	z
		.object({
			sequence: sequenceSchema,
			command: blackjackActionSchema,
		})
		.strict(),
	z
		.object({
			sequence: sequenceSchema,
			command: z.literal('forfeit'),
		})
		.strict(),
]);
export type BlackjackRunCommand = z.infer<typeof blackjackRunCommandSchema>;

// --- Public state: closed ranked | daily union, every member strict ---

const cardSchema = z
	.object({
		rank: z.enum(['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K']),
		suit: z.enum(['hearts', 'diamonds', 'clubs', 'spades']),
	})
	.strict();

const handValueSchema = z
	.object({
		value: safeIntegerSchema,
		isSoft: z.boolean(),
		isBust: z.boolean(),
	})
	.strict();

const handOutcomeSchema = z
	.object({
		handIndex: safeIntegerSchema.min(0),
		result: z.enum(['win', 'loss', 'push', 'blackjack']),
		wager: safeIntegerSchema,
		payout: safeIntegerSchema,
	})
	.strict();

const outcomeSchema = z
	.object({
		result: z.enum(['win', 'loss', 'push']),
		hands: z.array(handOutcomeSchema),
		committedWager: safeIntegerSchema,
		payout: safeIntegerSchema,
		gameNetDelta: safeIntegerSchema,
	})
	.strict();

const roundFields = {
	phase: z.enum(['player-turn', 'complete']),
	playerHands: z.array(
		z
			.object({
				cards: z.array(cardSchema),
				wager: safeIntegerSchema,
				value: handValueSchema,
			})
			.strict(),
	),
	activeHandIndex: safeIntegerSchema.min(0),
	dealer: z
		.object({
			cards: z.array(cardSchema),
			value: handValueSchema,
		})
		.strict(),
	committedWager: safeIntegerSchema,
	availableActions: z.array(blackjackActionSchema),
	outcome: outcomeSchema.nullable(),
} as const;

export const blackjackActiveRoundSchema = z.object(roundFields).strict();
export type BlackjackActiveRound = z.infer<typeof blackjackActiveRoundSchema>;

export const blackjackRunPublicStateSchema = z.discriminatedUnion('mode', [
	z
		.object({
			mode: z.literal('ranked'),
			runId: runIdSchema,
			status: z.enum(['active', 'settled', 'expired']),
			expiresAt: safeIntegerSchema.min(0),
			balance: balanceSchema,
			nextSequence: sequenceSchema,
			...roundFields,
		})
		.strict(),
	z
		.object({
			mode: z.literal('daily'),
			runId: runIdSchema,
			status: z.enum(['active', 'completed', 'forfeited', 'expired']),
			terminalReason: z
				.enum(['completed', 'bankroll-below-minimum', 'forfeited', 'expired'])
				.nullable(),
			eligible: z.boolean().nullable(),
			expiresAt: safeIntegerSchema.min(0),
			nextCommandSequence: sequenceSchema,
			availableBankroll: balanceSchema,
			roundsCompleted: safeIntegerSchema.min(0),
			activeRound: blackjackActiveRoundSchema.nullable(),
			rank: safeIntegerSchema.min(1).nullable(),
			// calculateDailyPercentile emits integers clamped to 1-100.
			percentile: safeIntegerSchema.min(1).max(100).nullable(),
		})
		.strict(),
]);
export type BlackjackRunPublicState = z.infer<typeof blackjackRunPublicStateSchema>;

// --- Domain errors thrown by the pure core ---

export type BlackjackRunErrorCode =
	| 'INVALID_ACTION'
	| 'SEQUENCE_MISMATCH'
	| 'ATTEMPT_COMPLETE'
	| 'INVALID_COMMAND'
	| 'INVALID_WAGER'
	| 'INSUFFICIENT_CHALLENGE_BANKROLL';

export interface BlackjackRunErrorOptions {
	expectedSequence?: number;
	message?: string;
}

export class BlackjackRunError extends Error {
	readonly code: BlackjackRunErrorCode;
	readonly expectedSequence?: number;

	constructor(code: BlackjackRunErrorCode, options: BlackjackRunErrorOptions = {}) {
		super(options.message ?? code);
		this.name = 'BlackjackRunError';
		this.code = code;
		this.expectedSequence = options.expectedSequence;
	}
}
