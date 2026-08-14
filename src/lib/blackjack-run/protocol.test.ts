import { describe, expect, test } from 'bun:test';
import {
	blackjackActionSchema,
	blackjackActiveRoundSchema,
	blackjackRunCommandSchema,
	blackjackRunPublicStateSchema,
	blackjackRunStartSchema,
	periodKeySchema,
	requestIdSchema,
	runIdSchema,
	safeIntegerSchema,
	sequenceSchema,
} from './protocol';

const requestId = 'request_12345678';
const runId = 'abcdefghijklmnopqrstuv'; // 22 chars

describe('schema primitives', () => {
	test.each([requestId, 'a'.repeat(16), 'a'.repeat(128)])('accepts requestId %p', (value) => {
		expect(requestIdSchema.safeParse(value).success).toBe(true);
	});

	test.each(['short', 'a'.repeat(15), 'a'.repeat(129), 'bad chars!'])(
		'rejects requestId %p',
		(value) => {
			expect(requestIdSchema.safeParse(value).success).toBe(false);
		},
	);

	test('accepts a 22-char run id', () => {
		expect(runIdSchema.safeParse(runId).success).toBe(true);
	});

	test.each(['short', 'a'.repeat(21), 'a'.repeat(23)])('rejects run id %p', (value) => {
		expect(runIdSchema.safeParse(value).success).toBe(false);
	});

	test.each(['2026-03-14', '2024-02-29', '1999-12-31'])('accepts period key %p', (value) => {
		expect(periodKeySchema.safeParse(value).success).toBe(true);
	});

	test.each(['2026-3-14', '20260314', 'abcd-ef-gh'])('rejects period key %p', (value) => {
		expect(periodKeySchema.safeParse(value).success).toBe(false);
	});

	// The schema is intentionally opaque: it only validates the YYYY-MM-DD shape and does
	// not parse the value as a calendar date. Calendar validity is enforced separately by
	// getDailyWindowForPeriodKey. Assert a format-valid but calendar-impossible key is
	// accepted here to pin the opaque-format contract.
	test('accepts a format-valid but calendar-impossible period key (opaque format only)', () => {
		expect(periodKeySchema.safeParse('2026-13-40').success).toBe(true);
	});

	test.each([-0, 0.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
		'rejects a non-safe-integer %p',
		(value) => {
			expect(safeIntegerSchema.safeParse(value).success).toBe(false);
		},
	);

	test('accepts safe integers including zero', () => {
		expect(safeIntegerSchema.safeParse(0).success).toBe(true);
		expect(safeIntegerSchema.safeParse(1000).success).toBe(true);
		expect(safeIntegerSchema.safeParse(Number.MAX_SAFE_INTEGER).success).toBe(true);
	});

	test.each([-0, -1, 0.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
		'rejects invalid sequence %p',
		(value) => {
			expect(sequenceSchema.safeParse(value).success).toBe(false);
		},
	);

	test('Object.is(-0) negative zero is rejected for sequences even though 0 is accepted', () => {
		expect(sequenceSchema.safeParse(0).success).toBe(true);
		expect(sequenceSchema.safeParse(-0).success).toBe(false);
	});
});

describe('blackjackRunStartSchema', () => {
	test('accepts a ranked start', () => {
		expect(
			blackjackRunStartSchema.safeParse({
				mode: 'ranked',
				requestId,
				wager: 100,
			}).success,
		).toBe(true);
	});

	test('accepts a daily start', () => {
		expect(
			blackjackRunStartSchema.safeParse({
				mode: 'daily',
				requestId,
				periodKey: '2026-03-14',
			}).success,
		).toBe(true);
	});

	test.each(['casual', 'practice', 42])('rejects a non ranked|daily mode %p', (mode) => {
		expect(
			blackjackRunStartSchema.safeParse({
				mode,
				requestId,
				wager: 100,
			}).success,
		).toBe(false);
	});

	test('rejects a ranked start missing wager', () => {
		expect(blackjackRunStartSchema.safeParse({ mode: 'ranked', requestId }).success).toBe(false);
	});

	test('rejects a ranked start with an out-of-bounds wager', () => {
		expect(
			blackjackRunStartSchema.safeParse({
				mode: 'ranked',
				requestId,
				wager: 5,
			}).success,
		).toBe(false);
		expect(
			blackjackRunStartSchema.safeParse({
				mode: 'ranked',
				requestId,
				wager: 1001,
			}).success,
		).toBe(false);
	});

	test('rejects a daily start missing periodKey', () => {
		expect(blackjackRunStartSchema.safeParse({ mode: 'daily', requestId }).success).toBe(false);
	});

	test('rejects a daily start with a malformed periodKey', () => {
		expect(
			blackjackRunStartSchema.safeParse({
				mode: 'daily',
				requestId,
				periodKey: '2026-3-14',
			}).success,
		).toBe(false);
	});

	test.each([
		{ mode: 'ranked', requestId, wager: 100, seedCommitment: 'a'.repeat(64) },
		{ mode: 'ranked', requestId, wager: 100, rulesetVersion: 'blackjack-ranked-v1' },
		{ mode: 'daily', requestId, periodKey: '2026-03-14', scoreVersion: 'blackjack-daily-score-v1' },
		{ mode: 'daily', requestId, periodKey: '2026-03-14', extra: true },
	])('rejects unknown fields on a start member via strict %#', (start) => {
		expect(blackjackRunStartSchema.safeParse(start).success).toBe(false);
	});
});

describe('blackjackRunCommandSchema', () => {
	test('accepts a start-round command with wager', () => {
		expect(
			blackjackRunCommandSchema.parse({
				sequence: 0,
				command: 'start-round',
				wager: 10,
			}),
		).toEqual({ sequence: 0, command: 'start-round', wager: 10 });
	});

	test.each(['hit', 'stand', 'double-down', 'split'])(
		'accepts an action command %p without wager',
		(command) => {
			expect(blackjackRunCommandSchema.parse({ sequence: 1, command })).toEqual({
				sequence: 1,
				command,
			});
		},
	);

	test('accepts a forfeit command without wager', () => {
		expect(blackjackRunCommandSchema.parse({ sequence: 2, command: 'forfeit' })).toEqual({
			sequence: 2,
			command: 'forfeit',
		});
	});

	test('rejects a start-round command missing wager (action-only fields)', () => {
		expect(() =>
			blackjackRunCommandSchema.parse({ sequence: 0, command: 'start-round' }),
		).toThrow();
		expect(() =>
			blackjackRunCommandSchema.parse({
				sequence: 0,
				command: 'start-round',
				action: 'hit',
			}),
		).toThrow();
	});

	test('rejects a start-round command with a non-safe-integer wager', () => {
		expect(() =>
			blackjackRunCommandSchema.parse({
				sequence: 0,
				command: 'start-round',
				wager: 10.5,
			}),
		).toThrow();
		expect(() =>
			blackjackRunCommandSchema.parse({
				sequence: 0,
				command: 'start-round',
				wager: -0,
			}),
		).toThrow();
	});

	test.each(['hit', 'stand', 'double-down', 'split'])(
		'rejects an action command %p carrying wager and other extras',
		(command) => {
			expect(() =>
				blackjackRunCommandSchema.parse({
					sequence: 1,
					command,
					wager: 10,
				}),
			).toThrow();
			expect(() =>
				blackjackRunCommandSchema.parse({
					sequence: 1,
					command,
					extra: true,
				}),
			).toThrow();
		},
	);

	test.each([
		{ sequence: 2, command: 'forfeit', wager: 10 },
		{ sequence: 2, command: 'forfeit', extra: true },
	])('rejects forfeit carrying wager and other extras %#', (command) => {
		expect(() => blackjackRunCommandSchema.parse(command)).toThrow();
	});

	test('rejects an unknown command discriminant', () => {
		expect(() =>
			blackjackRunCommandSchema.parse({ sequence: 0, command: 'fold', wager: 10 }),
		).toThrow();
	});

	test('rejects a missing or negative sequence', () => {
		expect(() => blackjackRunCommandSchema.parse({ command: 'forfeit' })).toThrow();
		expect(() => blackjackRunCommandSchema.parse({ sequence: -1, command: 'forfeit' })).toThrow();
	});

	test('action schema is exactly the four gameplay actions', () => {
		expect(blackjackActionSchema.options).toEqual(['hit', 'stand', 'double-down', 'split']);
	});
});

const rankedPublicSample = {
	mode: 'ranked',
	runId,
	status: 'active',
	expiresAt: 1742000000,
	balance: 900,
	nextSequence: 1,
	phase: 'player-turn',
	playerHands: [
		{
			cards: [{ rank: 'A', suit: 'hearts' }],
			wager: 100,
			value: { value: 11, isSoft: true, isBust: false },
		},
	],
	activeHandIndex: 0,
	dealer: {
		cards: [{ rank: '10', suit: 'clubs' }],
		value: { value: 10, isSoft: false, isBust: false },
	},
	committedWager: 100,
	availableActions: ['hit', 'stand'],
	outcome: null,
};

const dailyPublicSample = {
	mode: 'daily',
	runId,
	status: 'completed',
	terminalReason: 'completed',
	eligible: true,
	expiresAt: 1742000000,
	nextCommandSequence: 20,
	availableBankroll: 1200,
	roundsCompleted: 10,
	activeRound: null,
	rank: 3,
	percentile: 95,
};

describe('blackjackRunPublicStateSchema', () => {
	test('accepts an active ranked public state', () => {
		expect(blackjackRunPublicStateSchema.safeParse(rankedPublicSample).success).toBe(true);
	});

	test('accepts a terminal daily public state', () => {
		expect(blackjackRunPublicStateSchema.safeParse(dailyPublicSample).success).toBe(true);
	});

	test.each([
		'seedCommitment',
		'rulesetVersion',
		'configHash',
		'actionLogHash',
		'receiptHash',
		'receipt',
	])('rejects a ranked public branch carrying %s', (field) => {
		expect(
			blackjackRunPublicStateSchema.safeParse({
				...rankedPublicSample,
				[field]: field === 'receipt' ? null : 'x'.repeat(64),
			}).success,
		).toBe(false);
	});

	test.each([
		'seedCommitment',
		'rulesetVersion',
		'scoreVersion',
		'configHash',
		'actionLogHash',
		'receiptHash',
		'receipt',
	])('rejects a daily public branch carrying %s', (field) => {
		expect(
			blackjackRunPublicStateSchema.safeParse({
				...dailyPublicSample,
				[field]: field === 'receipt' ? null : 'x'.repeat(64),
			}).success,
		).toBe(false);
	});

	test('rejects a daily active round leaking nextSequence', () => {
		const leaked = {
			...rankedPublicSample,
			mode: 'daily',
			status: 'active',
			terminalReason: null,
			eligible: null,
			nextCommandSequence: 1,
			availableBankroll: 900,
			roundsCompleted: 0,
			rank: null,
			percentile: null,
			activeRound: {
				phase: 'player-turn',
				playerHands: [
					{
						cards: [{ rank: 'A', suit: 'hearts' }],
						wager: 100,
						value: { value: 11, isSoft: true, isBust: false },
					},
				],
				activeHandIndex: 0,
				dealer: {
					cards: [{ rank: '10', suit: 'clubs' }],
					value: { value: 10, isSoft: false, isBust: false },
				},
				committedWager: 100,
				availableActions: ['hit', 'stand'],
				outcome: null,
				nextSequence: 1,
			},
		};
		expect(blackjackRunPublicStateSchema.safeParse(leaked).success).toBe(false);
	});

	test('accepts a daily active round through blackjackActiveRoundSchema', () => {
		const activeRound = {
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
		expect(blackjackActiveRoundSchema.safeParse(activeRound).success).toBe(true);
		expect(blackjackActiveRoundSchema.safeParse({ ...activeRound, nextSequence: 1 }).success).toBe(
			false,
		);
	});
});
