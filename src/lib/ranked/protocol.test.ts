import { describe, expect, test } from 'bun:test';
import {
	RANKED_ERROR_STATUS,
	RankedServiceError,
	actionLogSchema,
	actionRequestSchema,
	rankedAchievementEffectsV1Schema,
	rankedRewardEffectsV1Schema,
	rankedStatsEffectsV1Schema,
	requestIdSchema,
	sessionIdSchema,
	startRequestSchema,
} from './protocol';

const requestId = 'request_12345678';

describe('ranked request protocol', () => {
	test('accepts the exact start and action contracts', () => {
		expect(
			startRequestSchema.parse({
				requestId,
				gameType: 'blackjack',
				rulesetVersion: 'blackjack-ranked-v1',
				wager: 100,
			}),
		).toEqual({
			requestId,
			gameType: 'blackjack',
			rulesetVersion: 'blackjack-ranked-v1',
			wager: 100,
		});
		expect(actionRequestSchema.parse({ sequence: 0, action: 'double-down' })).toEqual({
			sequence: 0,
			action: 'double-down',
		});
	});

	test('rejects unknown request and action-log fields', () => {
		expect(
			startRequestSchema.safeParse({
				requestId,
				gameType: 'blackjack',
				rulesetVersion: 'blackjack-ranked-v1',
				wager: 100,
				seed: 'must-never-be-accepted',
			}).success,
		).toBe(false);
		expect(actionRequestSchema.safeParse({ sequence: 0, action: 'hit', extra: true }).success).toBe(
			false,
		);
		expect(actionLogSchema.safeParse([{ sequence: 0, action: 'hit', extra: true }]).success).toBe(
			false,
		);
	});

	test.each([-0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN])(
		'rejects invalid action sequence %p',
		(sequence) => {
			expect(actionRequestSchema.safeParse({ sequence, action: 'hit' }).success).toBe(false);
		},
	);

	test.each(['doubleDown', 'Double-down', 'double_down', 'ask-ai', 'hit-now'])(
		'rejects action outside the canonical kebab-case vocabulary: %s',
		(action) => {
			expect(actionRequestSchema.safeParse({ sequence: 0, action }).success).toBe(false);
		},
	);

	test.each([9, 1001, 10.5, -0])('rejects invalid wager %p', (wager) => {
		expect(
			startRequestSchema.safeParse({
				requestId,
				gameType: 'blackjack',
				rulesetVersion: 'blackjack-ranked-v1',
				wager,
			}).success,
		).toBe(false);
	});

	test('enforces canonical identifier lengths and alphabet', () => {
		expect(requestIdSchema.safeParse('a'.repeat(15)).success).toBe(false);
		expect(requestIdSchema.safeParse('a'.repeat(129)).success).toBe(false);
		expect(requestIdSchema.safeParse('a'.repeat(16)).success).toBe(true);
		expect(requestIdSchema.safeParse('A_-0'.repeat(32)).success).toBe(true);
		expect(requestIdSchema.safeParse('a'.repeat(15) + '.').success).toBe(false);

		expect(sessionIdSchema.safeParse('a'.repeat(21)).success).toBe(false);
		expect(sessionIdSchema.safeParse('a'.repeat(23)).success).toBe(false);
		expect(sessionIdSchema.safeParse('A_-0'.repeat(5) + 'AB').success).toBe(true);
		expect(sessionIdSchema.safeParse('a'.repeat(21) + '.').success).toBe(false);
	});
});

describe('ranked receipt effect protocol', () => {
	test('accepts the exact v1 statistics, achievement, and reward effects', () => {
		expect(
			rankedStatsEffectsV1Schema.parse({
				sessionsPlayed: 1,
				totalWins: 1,
				totalLosses: 0,
				totalPushes: 0,
				totalForfeits: 0,
				netProfit: 100,
				biggestWin: 100,
			}),
		).toEqual({
			sessionsPlayed: 1,
			totalWins: 1,
			totalLosses: 0,
			totalPushes: 0,
			totalForfeits: 0,
			netProfit: 100,
			biggestWin: 100,
		});
		expect(rankedAchievementEffectsV1Schema.parse(['ranked_debut'])).toEqual(['ranked_debut']);
		expect(
			rankedRewardEffectsV1Schema.parse([{ rewardId: 'ranked_debut_100', chipAmount: 100 }]),
		).toEqual([{ rewardId: 'ranked_debut_100', chipAmount: 100 }]);
	});

	test('rejects unknown and structurally invalid v1 receipt effects', () => {
		expect(
			rankedStatsEffectsV1Schema.safeParse({
				sessionsPlayed: 1,
				totalWins: 1,
				totalLosses: 0,
				totalPushes: 0,
				totalForfeits: 0,
				netProfit: 100,
				biggestWin: 100,
				extra: true,
			}).success,
		).toBe(false);
		expect(
			rankedStatsEffectsV1Schema.safeParse({
				sessionsPlayed: 2,
				totalWins: 1,
				totalLosses: 0,
				totalPushes: 0,
				totalForfeits: 0,
				netProfit: 100,
				biggestWin: 100,
			}).success,
		).toBe(false);
		expect(
			rankedStatsEffectsV1Schema.safeParse({
				sessionsPlayed: 1,
				totalWins: 1,
				totalLosses: 1,
				totalPushes: 0,
				totalForfeits: 0,
				netProfit: 0,
				biggestWin: 0,
			}).success,
		).toBe(false);
		expect(
			rankedStatsEffectsV1Schema.safeParse({
				sessionsPlayed: 1,
				totalWins: 0,
				totalLosses: 0,
				totalPushes: 1,
				totalForfeits: 1,
				netProfit: 0,
				biggestWin: 0,
			}).success,
		).toBe(false);
		expect(rankedAchievementEffectsV1Schema.safeParse(['rising_star']).success).toBe(false);
		expect(
			rankedRewardEffectsV1Schema.safeParse([
				{ rewardId: 'ranked_debut_100', chipAmount: 100, extra: true },
			]).success,
		).toBe(false);
		expect(
			rankedRewardEffectsV1Schema.safeParse([{ rewardId: 'ranked_debut_100', chipAmount: 99 }])
				.success,
		).toBe(false);
	});
});

describe('ranked service errors', () => {
	test('pins every stable status mapping', () => {
		expect(RANKED_ERROR_STATUS).toEqual({
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
		});
	});

	test('carries stable error metadata', () => {
		const error = new RankedServiceError('SEQUENCE_MISMATCH', {
			expectedSequence: 3,
			retryAfter: 5,
		});

		expect(error).toBeInstanceOf(Error);
		expect(error.name).toBe('RankedServiceError');
		expect(error.code).toBe('SEQUENCE_MISMATCH');
		expect(error.expectedSequence).toBe(3);
		expect(error.retryAfter).toBe(5);
	});
});
