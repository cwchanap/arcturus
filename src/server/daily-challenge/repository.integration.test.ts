import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { Miniflare } from 'miniflare';
import {
	BLACKJACK_DAILY_V1_CONFIG,
	getDailyChallengeWindow,
} from '../../lib/daily-challenge/config';
import { type DailyChallengeTerminalReason } from '../../lib/daily-challenge/protocol';
import { createDailyChallengeSeedCommitment } from '../../lib/daily-challenge/random';
import { calculateDailyChallengePercentile } from '../../lib/daily-challenge/scoring';
import type { DailyChallengeCommandV1 } from '../../lib/daily-challenge/protocol';
import {
	canonicalizeRanked,
	encodeBase64Url,
	hashCanonical,
	sha256Hex,
} from '../../lib/ranked/canonical';
import {
	buildRateLimitContinuationStatement,
	buildRateLimitStatement,
	consumeStandaloneRateLimit,
	RANKED_RATE_LIMITS,
} from '../ranked/rate-limit';
import {
	DailyChallengeRepositoryInvariantError,
	createDailyChallengeRepository,
	type DailyChallengeCommandTransitionInput,
	type DailyChallengeExpirationCursor,
	type DailyChallengeStartTransitionInput,
	type DailyChallengeTerminalTransition,
	type NewDailyChallengeAttemptRecord,
	type NewDailyChallengeRecord,
} from './repository';
import {
	createDailyChallengeTestD1,
	insertDailyChallengeAttempt,
	insertDailyChallengeResult,
	insertDailyChallengeTestUser,
} from './test-d1';

const USER_ID = 'daily-challenge-repository-user';
const OTHER_USER_ID = 'daily-challenge-other-user';
const NOW_SECONDS = 1_800_000_000;
const PERIOD_KEY = getDailyChallengeWindow(NOW_SECONDS).periodKey;
const PERIOD_KEY_NEXT = getDailyChallengeWindow(NOW_SECONDS + 86_400).periodKey;
const CHALLENGE_ID = 'daily-challenge-id-0001';
const CHALLENGE_ID_NEXT = 'daily-challenge-id-0002';
const ATTEMPT_ID = 'AAAAAAAAAAAAAAAAAAAAAAAAAA';
const ATTEMPT_ID_B = 'BBBBBBBBBBBBBBBBBBBBBB';
const REQUEST_ID_A = 'request-aaaaaaaaaaaaaaaa';
const REQUEST_ID_B = 'request-bbbbbbbbbbbbbbbb';

let mf: Miniflare;
let db: D1Database;

beforeAll(async () => {
	({ mf, db } = await createDailyChallengeTestD1());
});

afterAll(async () => {
	await mf.dispose();
});

beforeEach(async () => {
	await db.batch([
		db.prepare('DELETE FROM daily_challenge_result'),
		db.prepare('DELETE FROM daily_challenge_attempt'),
		db.prepare('DELETE FROM daily_challenge'),
		db.prepare('DELETE FROM ranked_rate_limit'),
		db.prepare('DELETE FROM user'),
	]);
	await insertDailyChallengeTestUser(db, { id: USER_ID, chipBalance: 10000 });
	await insertDailyChallengeTestUser(db, { id: OTHER_USER_ID, chipBalance: 10000 });
});

function buildSeedPair(): { rankedSeed: string; practiceSeed: string; commitment: string } {
	const rankedBytes = crypto.getRandomValues(new Uint8Array(32));
	const practiceBytes = crypto.getRandomValues(new Uint8Array(32));
	return {
		rankedSeed: encodeBase64Url(rankedBytes),
		practiceSeed: encodeBase64Url(practiceBytes),
		commitment: createDailyChallengeSeedCommitment('blackjack-daily-v1', rankedBytes),
	};
}

function buildChallengeRecord(
	overrides: Partial<NewDailyChallengeRecord> = {},
): NewDailyChallengeRecord {
	const window = getDailyChallengeWindow(NOW_SECONDS);
	const seed = buildSeedPair();
	return {
		id: CHALLENGE_ID,
		challengeKind: 'blackjack-daily',
		periodKey: PERIOD_KEY,
		challengeRulesetVersion: 'blackjack-daily-v1',
		gameRulesetVersion: 'blackjack-ranked-v1',
		scoreVersion: 'blackjack-daily-score-v1',
		configJson: canonicalizeRanked(BLACKJACK_DAILY_V1_CONFIG),
		configHash: hashCanonical(BLACKJACK_DAILY_V1_CONFIG),
		rankedSeed: seed.rankedSeed,
		rankedSeedCommitment: seed.commitment,
		practiceSeed: seed.practiceSeed,
		startsAt: window.startsAt,
		rankedEntryClosesAt: window.rankedEntryClosesAt,
		endsAt: window.endsAt,
		createdAt: NOW_SECONDS,
		...overrides,
	};
}

function buildAttemptRecord(
	overrides: Partial<NewDailyChallengeAttemptRecord> = {},
): NewDailyChallengeAttemptRecord {
	return {
		id: ATTEMPT_ID,
		challengeId: CHALLENGE_ID,
		userId: USER_ID,
		startRequestId: REQUEST_ID_A,
		startPayloadHash: sha256Hex('start-payload-a'),
		status: 'active',
		actionLogJson: canonicalizeRanked([]),
		actionLogHash: hashCanonical([]),
		nextCommandSequence: 0,
		availableBankroll: BLACKJACK_DAILY_V1_CONFIG.startingBankroll,
		roundsCompleted: 0,
		expiresAt: NOW_SECONDS + BLACKJACK_DAILY_V1_CONFIG.attemptTtlSeconds,
		createdAt: NOW_SECONDS,
		updatedAt: NOW_SECONDS,
		settledAt: null,
		...overrides,
	};
}

function startInput(
	overrides: Partial<DailyChallengeStartTransitionInput> = {},
): DailyChallengeStartTransitionInput {
	return {
		userId: USER_ID,
		attempt: buildAttemptRecord(),
		rateLimitStatement: buildRateLimitStatement(db, {
			userId: USER_ID,
			operation: 'ranked_start',
			nowSeconds: NOW_SECONDS,
		}),
		retryAfter: 60,
		...overrides,
	};
}

async function seedChallenge(record = buildChallengeRecord()): Promise<NewDailyChallengeRecord> {
	const repository = createDailyChallengeRepository(db);
	await repository.insertChallengeIfAbsent(record);
	return record;
}

async function readUserBalance(
	userId: string,
): Promise<{ chipBalance: number; heldChips: number }> {
	const row = await db
		.prepare('SELECT chipBalance, heldChips FROM user WHERE id = ?')
		.bind(userId)
		.first<{ chipBalance: number; heldChips: number }>();
	if (!row) throw new Error(`missing test user ${userId}`);
	return row;
}

async function countAttempts(): Promise<number> {
	const row = await db
		.prepare('SELECT COUNT(*) AS count FROM daily_challenge_attempt')
		.first<{ count: number }>();
	return row?.count ?? 0;
}

async function countChallenges(): Promise<number> {
	const row = await db
		.prepare('SELECT COUNT(*) AS count FROM daily_challenge')
		.first<{ count: number }>();
	return row?.count ?? 0;
}

async function readRateCount(operation: 'ranked_start'): Promise<number> {
	const row = await db
		.prepare(
			'SELECT COALESCE(SUM(count), 0) AS count FROM ranked_rate_limit WHERE userId = ? AND operation = ?',
		)
		.bind(USER_ID, operation)
		.first<{ count: number }>();
	return row?.count ?? 0;
}

async function exhaustStartRateLimit(): Promise<void> {
	const limit = RANKED_RATE_LIMITS.ranked_start.limit;
	for (let index = 0; index < limit; index += 1) {
		await buildRateLimitStatement(db, {
			userId: USER_ID,
			operation: 'ranked_start',
			nowSeconds: NOW_SECONDS,
		}).run();
	}
}

describe('daily challenge catalog', () => {
	test('findChallengeByPeriodKey returns null when no row exists', async () => {
		const repository = createDailyChallengeRepository(db);
		expect(await repository.findChallengeByPeriodKey('blackjack-daily', PERIOD_KEY)).toBeNull();
	});

	test('insertChallengeIfAbsent inserts and returns the persisted row with verified config', async () => {
		const repository = createDailyChallengeRepository(db);
		const record = buildChallengeRecord();

		expect(await repository.insertChallengeIfAbsent(record)).toBe('inserted');
		expect(await countChallenges()).toBe(1);

		const persisted = await repository.findChallengeByPeriodKey('blackjack-daily', PERIOD_KEY);
		expect(persisted).not.toBeNull();
		expect(persisted).toMatchObject({
			id: record.id,
			periodKey: record.periodKey,
			configHash: record.configHash,
			rankedSeed: record.rankedSeed,
			rankedSeedCommitment: record.rankedSeedCommitment,
		});
		expect(persisted?.config).toEqual(BLACKJACK_DAILY_V1_CONFIG);
	});

	test('concurrent lazy creation store exactly one seed pair', async () => {
		const repository = createDailyChallengeRepository(db);
		const winner = buildChallengeRecord();
		const loserSeed = buildSeedPair();
		const loser = buildChallengeRecord({
			id: 'daily-challenge-loser-0001',
			rankedSeed: loserSeed.rankedSeed,
			rankedSeedCommitment: loserSeed.commitment,
			practiceSeed: loserSeed.practiceSeed,
		});

		const [winnerResult, loserResult] = await Promise.all([
			repository.insertChallengeIfAbsent(winner),
			repository.insertChallengeIfAbsent(loser),
		]);

		expect([winnerResult, loserResult].sort()).toEqual(['existing', 'inserted']);
		expect(await countChallenges()).toBe(1);

		const persisted = await repository.findChallengeByPeriodKey('blackjack-daily', PERIOD_KEY);
		expect(persisted).not.toBeNull();
		expect(
			persisted?.rankedSeed === winner.rankedSeed || persisted?.rankedSeed === loser.rankedSeed,
		).toBe(true);
	});

	test('a losing creator rereads the winner instead of its own candidate', async () => {
		const repository = createDailyChallengeRepository(db);
		const winner = buildChallengeRecord();
		await repository.insertChallengeIfAbsent(winner);

		const loserSeed = buildSeedPair();
		const loser = buildChallengeRecord({
			id: 'daily-challenge-loser-0002',
			rankedSeed: loserSeed.rankedSeed,
			rankedSeedCommitment: loserSeed.commitment,
			practiceSeed: loserSeed.practiceSeed,
		});
		expect(await repository.insertChallengeIfAbsent(loser)).toBe('existing');

		const reread = await repository.findChallengeByPeriodKey('blackjack-daily', PERIOD_KEY);
		expect(reread).not.toBeNull();
		expect(reread?.id).toBe(winner.id);
		expect(reread?.rankedSeed).toBe(winner.rankedSeed);
		expect(reread?.rankedSeed).not.toBe(loser.rankedSeed);
	});

	test('a corrupt config hash triggers an invariant error on read', async () => {
		const repository = createDailyChallengeRepository(db);
		const record = buildChallengeRecord();
		await repository.insertChallengeIfAbsent(record);
		await db
			.prepare('UPDATE daily_challenge SET configHash = ? WHERE id = ?')
			.bind('0'.repeat(64), record.id)
			.run();
		await expect(
			repository.findChallengeByPeriodKey('blackjack-daily', PERIOD_KEY),
		).rejects.toBeInstanceOf(DailyChallengeRepositoryInvariantError);
	});

	test('a non-canonical config JSON triggers an invariant error on read', async () => {
		const repository = createDailyChallengeRepository(db);
		const record = buildChallengeRecord();
		await repository.insertChallengeIfAbsent(record);
		await db
			.prepare('UPDATE daily_challenge SET configJson = ? WHERE id = ?')
			.bind(JSON.stringify(BLACKJACK_DAILY_V1_CONFIG), record.id)
			.run();
		await expect(
			repository.findChallengeByPeriodKey('blackjack-daily', PERIOD_KEY),
		).rejects.toBeInstanceOf(DailyChallengeRepositoryInvariantError);
	});

	test('a mismatched ranked seed commitment triggers an invariant error on read', async () => {
		const repository = createDailyChallengeRepository(db);
		const record = buildChallengeRecord();
		await repository.insertChallengeIfAbsent(record);
		await db
			.prepare('UPDATE daily_challenge SET rankedSeedCommitment = ? WHERE id = ?')
			.bind('0'.repeat(64), record.id)
			.run();
		await expect(
			repository.findChallengeByPeriodKey('blackjack-daily', PERIOD_KEY),
		).rejects.toBeInstanceOf(DailyChallengeRepositoryInvariantError);
	});

	test('a practice seed matching the ranked seed triggers an invariant error on read', async () => {
		const repository = createDailyChallengeRepository(db);
		const record = buildChallengeRecord();
		await repository.insertChallengeIfAbsent(record);
		await db
			.prepare('UPDATE daily_challenge SET practiceSeed = rankedSeed WHERE id = ?')
			.bind(record.id)
			.run();
		await expect(
			repository.findChallengeByPeriodKey('blackjack-daily', PERIOD_KEY),
		).rejects.toBeInstanceOf(DailyChallengeRepositoryInvariantError);
	});

	test('an unsupported challenge kind returns null without error', async () => {
		const repository = createDailyChallengeRepository(db);
		await repository.insertChallengeIfAbsent(buildChallengeRecord());
		expect(
			await repository.findChallengeByPeriodKey(
				'blackjack-daily-unknown' as 'blackjack-daily',
				PERIOD_KEY,
			),
		).toBeNull();
	});
});

describe('daily challenge start transition', () => {
	test('creates one active attempt and leaves the wallet untouched', async () => {
		await seedChallenge();
		const repository = createDailyChallengeRepository(db);

		const result = await repository.runStartTransition(startInput());

		expect(result).toEqual({ kind: 'created' });
		expect(await countAttempts()).toBe(1);
		expect(await readUserBalance(USER_ID)).toEqual({ chipBalance: 10000, heldChips: 0 });
		expect(await readRateCount('ranked_start')).toBe(1);
	});

	test('exact start request replay returns not-created and the reread matches the winner', async () => {
		await seedChallenge();
		const repository = createDailyChallengeRepository(db);
		const attempt = buildAttemptRecord();

		expect(await repository.runStartTransition(startInput({ attempt }))).toEqual({
			kind: 'created',
		});
		expect(await repository.runStartTransition(startInput({ attempt }))).toEqual({
			kind: 'not-created',
		});
		expect(await countAttempts()).toBe(1);

		const byRequest = await repository.findAttemptByUserAndRequestId(USER_ID, REQUEST_ID_A);
		expect(byRequest).not.toBeNull();
		expect(byRequest?.id).toBe(attempt.id);
		expect(byRequest?.status).toBe('active');
		expect(byRequest?.nextCommandSequence).toBe(0);
		expect(byRequest?.actionLog).toEqual([]);
	});

	test('a different request ID recovers the consumed daily attempt via challenge+user reread', async () => {
		await seedChallenge();
		const repository = createDailyChallengeRepository(db);
		expect(
			await repository.runStartTransition(
				startInput({ attempt: buildAttemptRecord({ startRequestId: REQUEST_ID_A }) }),
			),
		).toEqual({ kind: 'created' });

		const secondResult = await repository.runStartTransition(
			startInput({
				attempt: buildAttemptRecord({
					id: ATTEMPT_ID_B,
					startRequestId: REQUEST_ID_B,
				}),
			}),
		);
		expect(secondResult).toEqual({ kind: 'not-created' });
		expect(await countAttempts()).toBe(1);

		const byChallenge = await repository.findAttemptByChallengeAndUser(CHALLENGE_ID, USER_ID);
		expect(byChallenge).not.toBeNull();
		expect(byChallenge?.startRequestId).toBe(REQUEST_ID_A);
		const byNewRequest = await repository.findAttemptByUserAndRequestId(USER_ID, REQUEST_ID_B);
		expect(byNewRequest).toBeNull();
	});

	test('request ID reuse across periods is blocked and classifiable as mismatch by coordinator', async () => {
		await seedChallenge(buildChallengeRecord());
		await seedChallenge(
			buildChallengeRecord({ id: CHALLENGE_ID_NEXT, periodKey: PERIOD_KEY_NEXT }),
		);
		const repository = createDailyChallengeRepository(db);

		const first = await repository.runStartTransition(
			startInput({
				attempt: buildAttemptRecord({ challengeId: CHALLENGE_ID }),
			}),
		);
		const second = await repository.runStartTransition(
			startInput({
				attempt: buildAttemptRecord({ id: ATTEMPT_ID_B, challengeId: CHALLENGE_ID_NEXT }),
				rateLimitStatement: buildRateLimitStatement(db, {
					userId: USER_ID,
					operation: 'ranked_start',
					nowSeconds: NOW_SECONDS + 60,
				}),
			}),
		);

		expect(first).toEqual({ kind: 'created' });
		expect(second).toEqual({ kind: 'not-created' });
		expect(await countAttempts()).toBe(1);

		const byRequest = await repository.findAttemptByUserAndRequestId(USER_ID, REQUEST_ID_A);
		expect(byRequest).not.toBeNull();
		expect(byRequest?.challengeId).toBe(CHALLENGE_ID);
		expect(byRequest?.challengeId).not.toBe(CHALLENGE_ID_NEXT);
	});

	test('concurrent different request IDs return exactly one winning attempt', async () => {
		await seedChallenge();
		const repository = createDailyChallengeRepository(db);

		const [left, right] = await Promise.all([
			repository.runStartTransition(
				startInput({ attempt: buildAttemptRecord({ startRequestId: REQUEST_ID_A }) }),
			),
			repository.runStartTransition(
				startInput({
					attempt: buildAttemptRecord({
						id: ATTEMPT_ID_B,
						startRequestId: REQUEST_ID_B,
					}),
				}),
			),
		]);

		expect([left.kind, right.kind].sort()).toEqual(['created', 'not-created']);
		expect(await countAttempts()).toBe(1);
	});

	test('no user balance field is read or changed by the transition', async () => {
		await seedChallenge();
		const repository = createDailyChallengeRepository(db);
		const before = await readUserBalance(USER_ID);

		await repository.runStartTransition(startInput());

		expect(await readUserBalance(USER_ID)).toEqual(before);
	});

	test('a denied start rate limit atomically gates attempt creation', async () => {
		await seedChallenge();
		await exhaustStartRateLimit();
		const repository = createDailyChallengeRepository(db);

		const result = await repository.runStartTransition(startInput());

		expect(result).toEqual({ kind: 'rate-limited', retryAfter: 60 });
		expect(await countAttempts()).toBe(0);
	});

	test('a corrupt attempt action-log hash triggers an invariant error on reread', async () => {
		await seedChallenge();
		const repository = createDailyChallengeRepository(db);
		await repository.runStartTransition(startInput());
		await db
			.prepare('UPDATE daily_challenge_attempt SET actionLogHash = ? WHERE id = ?')
			.bind('0'.repeat(64), ATTEMPT_ID)
			.run();
		await expect(
			repository.findAttemptByUserAndRequestId(USER_ID, REQUEST_ID_A),
		).rejects.toBeInstanceOf(DailyChallengeRepositoryInvariantError);
	});

	test('a second user may start an independent attempt on the same challenge', async () => {
		await seedChallenge();
		const repository = createDailyChallengeRepository(db);
		expect(
			await repository.runStartTransition(
				startInput({
					userId: OTHER_USER_ID,
					attempt: buildAttemptRecord({
						id: ATTEMPT_ID_B,
						userId: OTHER_USER_ID,
						startRequestId: REQUEST_ID_B,
					}),
				}),
			),
		).toEqual({ kind: 'created' });
		expect(await countAttempts()).toBe(1);
		const other = await repository.findAttemptByChallengeAndUser(CHALLENGE_ID, OTHER_USER_ID);
		expect(other).not.toBeNull();
		expect(other?.userId).toBe(OTHER_USER_ID);
	});
});

const TERMINAL_SETTLED_AT = NOW_SECONDS + 300;
const RETENTION_CUTOFF = NOW_SECONDS - 90 * 86_400;

interface ActiveProjection {
	sequence: number;
	actionLog: readonly DailyChallengeCommandV1[];
	availableBankroll: number;
	roundsCompleted: number;
}

const INITIAL_PROJECTION: ActiveProjection = {
	sequence: 0,
	actionLog: [],
	availableBankroll: BLACKJACK_DAILY_V1_CONFIG.startingBankroll,
	roundsCompleted: 0,
};

function canonLog(log: readonly DailyChallengeCommandV1[]): string {
	return canonicalizeRanked(log);
}

function hashLog(log: readonly DailyChallengeCommandV1[]): string {
	return hashCanonical(log);
}

async function seedActiveAttempt(
	overrides: { userId?: string; attempt?: Partial<NewDailyChallengeAttemptRecord> } = {},
): Promise<{ challenge: NewDailyChallengeRecord; attempt: NewDailyChallengeAttemptRecord }> {
	const challenge = await seedChallenge();
	const repository = createDailyChallengeRepository(db);
	const userId = overrides.userId ?? USER_ID;
	const attempt = buildAttemptRecord({ ...overrides.attempt, userId });
	const result = await repository.runStartTransition(startInput({ userId, attempt }));
	if (result.kind !== 'created') throw new Error('seedActiveAttempt start failed');
	return { challenge, attempt };
}

function commandTransition(opts: {
	userId?: string;
	attemptId?: string;
	current: ActiveProjection;
	next: ActiveProjection;
	nowSeconds?: number;
	terminal?: DailyChallengeTerminalTransition;
}): DailyChallengeCommandTransitionInput {
	return {
		userId: opts.userId ?? USER_ID,
		attemptId: opts.attemptId ?? ATTEMPT_ID,
		expectedSequence: opts.current.sequence,
		expectedActionLogHash: hashLog(opts.current.actionLog),
		expectedAvailableBankroll: opts.current.availableBankroll,
		expectedRoundsCompleted: opts.current.roundsCompleted,
		nextActionLogJson: canonLog(opts.next.actionLog),
		nextActionLogHash: hashLog(opts.next.actionLog),
		nextCommandSequence: opts.next.sequence,
		availableBankroll: opts.next.availableBankroll,
		roundsCompleted: opts.next.roundsCompleted,
		nowSeconds: opts.nowSeconds ?? TERMINAL_SETTLED_AT,
		terminal: opts.terminal,
	};
}

function terminalBundle(opts: {
	challenge: NewDailyChallengeRecord;
	actionLogHash: string;
	endingBankroll: number;
	roundsCompleted: number;
	eligible?: boolean;
	terminalReason?: DailyChallengeTerminalReason;
	durationSeconds?: number;
	settledAt?: number;
}): DailyChallengeTerminalTransition {
	const eligible = opts.eligible ?? true;
	const terminalReason = opts.terminalReason ?? 'completed';
	const durationSeconds = opts.durationSeconds ?? 300;
	const settledAt = opts.settledAt ?? TERMINAL_SETTLED_AT;
	const source = {
		attemptId: ATTEMPT_ID,
		challengeId: opts.challenge.id,
		periodKey: PERIOD_KEY,
		challengeRulesetVersion: 'blackjack-daily-v1' as const,
		gameRulesetVersion: 'blackjack-ranked-v1' as const,
		scoreVersion: 'blackjack-daily-score-v1' as const,
		configHash: opts.challenge.configHash,
		rankedSeedCommitment: opts.challenge.rankedSeedCommitment,
		actionLogHash: opts.actionLogHash,
		endingBankroll: opts.endingBankroll,
		roundsCompleted: opts.roundsCompleted,
		eligible,
		terminalReason,
		durationSeconds,
		settledAt,
	};
	return {
		challengeId: opts.challenge.id,
		periodKey: PERIOD_KEY,
		challengeRulesetVersion: 'blackjack-daily-v1',
		gameRulesetVersion: 'blackjack-ranked-v1',
		scoreVersion: 'blackjack-daily-score-v1',
		configHash: opts.challenge.configHash,
		rankedSeedCommitment: opts.challenge.rankedSeedCommitment,
		eligible,
		terminalReason,
		durationSeconds,
		receiptHash: hashCanonical(source),
	};
}

async function seedNamedUser(id: string, name: string): Promise<void> {
	await insertDailyChallengeTestUser(db, { id, name, chipBalance: 10000 });
}

async function countResults(): Promise<number> {
	const row = await db
		.prepare('SELECT COUNT(*) AS count FROM daily_challenge_result')
		.first<{ count: number }>();
	return row?.count ?? 0;
}

async function seedLeaderboardResult(opts: {
	userId: string;
	attemptId: string;
	challengeId: string;
	endingBankroll: number;
	roundsCompleted?: number;
	eligible?: boolean;
	terminalReason?: string;
	settledAt: number;
	durationSeconds?: number;
}): Promise<void> {
	await insertDailyChallengeResult(db, {
		attemptId: opts.attemptId,
		challengeId: opts.challengeId,
		userId: opts.userId,
		endingBankroll: opts.endingBankroll,
		roundsCompleted: opts.roundsCompleted ?? 10,
		eligible: opts.eligible === false ? 0 : 1,
		terminalReason: opts.terminalReason ?? 'completed',
		settledAt: opts.settledAt,
	});
}

describe('daily challenge command transition', () => {
	test('applies an active command when the expected projection matches', async () => {
		const { challenge } = await seedActiveAttempt();
		const repository = createDailyChallengeRepository(db);
		const nextLog: DailyChallengeCommandV1[] = [{ sequence: 0, command: 'start-round', wager: 10 }];

		const result = await repository.runCommandTransition(
			commandTransition({
				current: INITIAL_PROJECTION,
				next: {
					sequence: 1,
					actionLog: nextLog,
					availableBankroll: 990,
					roundsCompleted: 0,
				},
			}),
		);

		expect(result).toEqual({ kind: 'applied', result: null });
		expect(await readUserBalance(USER_ID)).toEqual({ chipBalance: 10000, heldChips: 0 });

		const reread = await repository.findAttemptByChallengeAndUser(challenge.id, USER_ID);
		expect(reread?.status).toBe('active');
		expect(reread?.nextCommandSequence).toBe(1);
		expect(reread?.availableBankroll).toBe(990);
		expect(reread?.roundsCompleted).toBe(0);
		expect(reread?.actionLog).toEqual(nextLog);
		expect(reread?.settledAt).toBeNull();
	});

	test('a command with a matched rate continuation applies the guarded transition', async () => {
		await seedActiveAttempt();
		const repository = createDailyChallengeRepository(db);
		const nextLog: DailyChallengeCommandV1[] = [{ sequence: 0, command: 'start-round', wager: 10 }];

		const consume = await consumeStandaloneRateLimit(
			db,
			USER_ID,
			'daily_challenge_command',
			NOW_SECONDS,
		);
		expect(consume.kind).toBe('allowed');

		const result = await repository.runCommandTransition({
			...commandTransition({
				current: INITIAL_PROJECTION,
				next: {
					sequence: 1,
					actionLog: nextLog,
					availableBankroll: 990,
					roundsCompleted: 0,
				},
			}),
			rateLimitStatement: buildRateLimitContinuationStatement(db, {
				userId: USER_ID,
				operation: 'daily_challenge_command',
				nowSeconds: NOW_SECONDS,
			}),
			retryAfter: 60,
		});

		expect(result).toEqual({ kind: 'applied', result: null });
		const reread = await repository.findAttemptByChallengeAndUser(CHALLENGE_ID, USER_ID);
		expect(reread?.nextCommandSequence).toBe(1);
		expect(reread?.availableBankroll).toBe(990);
	});

	test('a command whose rate continuation does not match returns rate-limited without mutating', async () => {
		await seedActiveAttempt();
		const repository = createDailyChallengeRepository(db);
		const nextLog: DailyChallengeCommandV1[] = [{ sequence: 0, command: 'start-round', wager: 10 }];

		const result = await repository.runCommandTransition({
			...commandTransition({
				current: INITIAL_PROJECTION,
				next: {
					sequence: 1,
					actionLog: nextLog,
					availableBankroll: 990,
					roundsCompleted: 0,
				},
			}),
			rateLimitStatement: buildRateLimitContinuationStatement(db, {
				userId: USER_ID,
				operation: 'daily_challenge_command',
				nowSeconds: NOW_SECONDS,
			}),
			retryAfter: 60,
		});

		expect(result.kind).toBe('rate-limited');
		if (result.kind === 'rate-limited') {
			expect(result.retryAfter).toBe(60);
		}
		const reread = await repository.findAttemptByChallengeAndUser(CHALLENGE_ID, USER_ID);
		expect(reread?.nextCommandSequence).toBe(0);
		expect(reread?.availableBankroll).toBe(BLACKJACK_DAILY_V1_CONFIG.startingBankroll);
	});

	test('one winning concurrent command leaves the loser not-applied', async () => {
		await seedActiveAttempt();
		const repository = createDailyChallengeRepository(db);
		const leftLog: DailyChallengeCommandV1[] = [{ sequence: 0, command: 'start-round', wager: 10 }];
		const rightLog: DailyChallengeCommandV1[] = [
			{ sequence: 0, command: 'start-round', wager: 25 },
		];

		const [left, right] = await Promise.all([
			repository.runCommandTransition(
				commandTransition({
					current: INITIAL_PROJECTION,
					next: { sequence: 1, actionLog: leftLog, availableBankroll: 990, roundsCompleted: 0 },
				}),
			),
			repository.runCommandTransition(
				commandTransition({
					current: INITIAL_PROJECTION,
					next: { sequence: 1, actionLog: rightLog, availableBankroll: 975, roundsCompleted: 0 },
				}),
			),
		]);

		expect([left.kind, right.kind].sort()).toEqual(['applied', 'not-applied']);
		const reread = await repository.findAttemptByChallengeAndUser(CHALLENGE_ID, USER_ID);
		expect(reread?.nextCommandSequence).toBe(1);
	});

	test('a stale projection cannot mutate state', async () => {
		await seedActiveAttempt();
		const repository = createDailyChallengeRepository(db);
		const nextLog: DailyChallengeCommandV1[] = [{ sequence: 0, command: 'start-round', wager: 10 }];

		const result = await repository.runCommandTransition(
			commandTransition({
				current: {
					sequence: 0,
					actionLog: [],
					availableBankroll: 700,
					roundsCompleted: 0,
				},
				next: { sequence: 1, actionLog: nextLog, availableBankroll: 690, roundsCompleted: 0 },
			}),
		);

		expect(result).toEqual({ kind: 'not-applied' });
		const reread = await repository.findAttemptByChallengeAndUser(CHALLENGE_ID, USER_ID);
		expect(reread?.nextCommandSequence).toBe(0);
		expect(reread?.availableBankroll).toBe(BLACKJACK_DAILY_V1_CONFIG.startingBankroll);
	});

	test('a stale sequence or hash projection is rejected', async () => {
		await seedActiveAttempt();
		const repository = createDailyChallengeRepository(db);

		const staleSequence = await repository.runCommandTransition(
			commandTransition({
				current: { sequence: 2, actionLog: [], availableBankroll: 1000, roundsCompleted: 0 },
				next: {
					sequence: 3,
					actionLog: [{ sequence: 2, command: 'start-round', wager: 10 }],
					availableBankroll: 990,
					roundsCompleted: 0,
				},
			}),
		);
		expect(staleSequence).toEqual({ kind: 'not-applied' });

		const staleHash = await repository.runCommandTransition(
			commandTransition({
				current: { sequence: 0, actionLog: [], availableBankroll: 990, roundsCompleted: 0 },
				next: {
					sequence: 1,
					actionLog: [{ sequence: 0, command: 'start-round', wager: 10 }],
					availableBankroll: 980,
					roundsCompleted: 0,
				},
			}),
		);
		expect(staleHash).toEqual({ kind: 'not-applied' });
	});
});

describe('daily challenge terminal result persistence', () => {
	test('a completed terminal transition persists status completed, settledAt, and one verified result', async () => {
		const { challenge } = await seedActiveAttempt();
		const repository = createDailyChallengeRepository(db);
		const finalLog: DailyChallengeCommandV1[] = [
			{ sequence: 0, command: 'start-round', wager: 50 },
			{ sequence: 1, command: 'stand' },
		];

		const result = await repository.runCommandTransition(
			commandTransition({
				current: INITIAL_PROJECTION,
				next: { sequence: 1, actionLog: finalLog, availableBankroll: 1500, roundsCompleted: 10 },
				nowSeconds: TERMINAL_SETTLED_AT,
				terminal: terminalBundle({
					challenge,
					actionLogHash: hashLog(finalLog),
					endingBankroll: 1500,
					roundsCompleted: 10,
				}),
			}),
		);

		expect(result.kind).toBe('applied');
		expect(result.result?.terminalReason).toBe('completed');
		expect(result.result?.endingBankroll).toBe(1500);
		expect(result.result?.roundsCompleted).toBe(10);
		expect(result.result?.eligible).toBe(true);
		expect(result.result?.receiptHash).toHaveLength(64);
		expect(await countResults()).toBe(1);

		const reread = await repository.findAttemptByChallengeAndUser(challenge.id, USER_ID);
		expect(reread?.status).toBe('completed');
		expect(reread?.settledAt).toBe(TERMINAL_SETTLED_AT);

		const byAttempt = await repository.findResultByAttempt(ATTEMPT_ID);
		expect(byAttempt?.attemptId).toBe(ATTEMPT_ID);
		expect(byAttempt?.receiptHash).toBe(result.result?.receiptHash);
	});

	test('terminal update and result insert are atomic: a stale guard stores neither', async () => {
		const { challenge } = await seedActiveAttempt();
		const repository = createDailyChallengeRepository(db);
		const finalLog: DailyChallengeCommandV1[] = [{ sequence: 0, command: 'stand' }];

		const result = await repository.runCommandTransition(
			commandTransition({
				current: { sequence: 0, actionLog: [], availableBankroll: 999, roundsCompleted: 0 },
				next: { sequence: 1, actionLog: finalLog, availableBankroll: 1500, roundsCompleted: 10 },
				terminal: terminalBundle({
					challenge,
					actionLogHash: hashLog(finalLog),
					endingBankroll: 1500,
					roundsCompleted: 10,
				}),
			}),
		);

		expect(result).toEqual({ kind: 'not-applied' });
		expect(await countResults()).toBe(0);
		const reread = await repository.findAttemptByChallengeAndUser(challenge.id, USER_ID);
		expect(reread?.status).toBe('active');
		expect(reread?.settledAt).toBeNull();
	});

	test('an exact duplicate terminal leaves exactly one result', async () => {
		const { challenge } = await seedActiveAttempt();
		const repository = createDailyChallengeRepository(db);
		const finalLog: DailyChallengeCommandV1[] = [{ sequence: 0, command: 'stand' }];
		const input = commandTransition({
			current: INITIAL_PROJECTION,
			next: { sequence: 1, actionLog: finalLog, availableBankroll: 1500, roundsCompleted: 10 },
			nowSeconds: TERMINAL_SETTLED_AT,
			terminal: terminalBundle({
				challenge,
				actionLogHash: hashLog(finalLog),
				endingBankroll: 1500,
				roundsCompleted: 10,
			}),
		});

		const first = await repository.runCommandTransition(input);
		const second = await repository.runCommandTransition(input);

		expect(first.kind).toBe('applied');
		expect(second).toEqual({ kind: 'not-applied' });
		expect(await countResults()).toBe(1);
	});

	test('a result survives attempt deletion because it carries no foreign key', async () => {
		const { challenge } = await seedActiveAttempt();
		const repository = createDailyChallengeRepository(db);
		const finalLog: DailyChallengeCommandV1[] = [{ sequence: 0, command: 'stand' }];
		const terminal = await repository.runCommandTransition(
			commandTransition({
				current: INITIAL_PROJECTION,
				next: { sequence: 1, actionLog: finalLog, availableBankroll: 1500, roundsCompleted: 10 },
				nowSeconds: TERMINAL_SETTLED_AT,
				terminal: terminalBundle({
					challenge,
					actionLogHash: hashLog(finalLog),
					endingBankroll: 1500,
					roundsCompleted: 10,
				}),
			}),
		);
		expect(terminal.kind).toBe('applied');
		const receiptHash = terminal.result?.receiptHash;

		await db.prepare('DELETE FROM daily_challenge_attempt WHERE id = ?').bind(ATTEMPT_ID).run();

		expect(await countResults()).toBe(1);
		const byAttempt = await repository.findResultByAttempt(ATTEMPT_ID);
		expect(byAttempt?.receiptHash).toBe(receiptHash);
	});

	test('a bankroll-below-minimum terminal persists status completed with that reason', async () => {
		const { challenge } = await seedActiveAttempt();
		const repository = createDailyChallengeRepository(db);
		const finalLog: DailyChallengeCommandV1[] = [{ sequence: 0, command: 'stand' }];

		const result = await repository.runCommandTransition(
			commandTransition({
				current: INITIAL_PROJECTION,
				next: { sequence: 1, actionLog: finalLog, availableBankroll: 5, roundsCompleted: 3 },
				nowSeconds: TERMINAL_SETTLED_AT,
				terminal: terminalBundle({
					challenge,
					actionLogHash: hashLog(finalLog),
					endingBankroll: 5,
					roundsCompleted: 3,
					terminalReason: 'bankroll-below-minimum',
				}),
			}),
		);

		expect(result.kind).toBe('applied');
		expect(result.result?.terminalReason).toBe('bankroll-below-minimum');
		const reread = await repository.findAttemptByChallengeAndUser(challenge.id, USER_ID);
		expect(reread?.status).toBe('completed');
	});

	test('a forfeit terminal keeps the forfeit command in the log and status forfeited', async () => {
		const { challenge } = await seedActiveAttempt();
		const repository = createDailyChallengeRepository(db);
		const forfeitLog: DailyChallengeCommandV1[] = [{ sequence: 0, command: 'forfeit' }];

		const result = await repository.runCommandTransition(
			commandTransition({
				current: INITIAL_PROJECTION,
				next: {
					sequence: 1,
					actionLog: forfeitLog,
					availableBankroll: 1000,
					roundsCompleted: 0,
				},
				nowSeconds: TERMINAL_SETTLED_AT,
				terminal: terminalBundle({
					challenge,
					actionLogHash: hashLog(forfeitLog),
					endingBankroll: 1000,
					roundsCompleted: 0,
					terminalReason: 'forfeited',
					eligible: false,
				}),
			}),
		);

		expect(result.kind).toBe('applied');
		expect(result.result?.terminalReason).toBe('forfeited');
		expect(result.result?.eligible).toBe(false);
		const reread = await repository.findAttemptByChallengeAndUser(challenge.id, USER_ID);
		expect(reread?.status).toBe('forfeited');
		expect(reread?.actionLog).toEqual(forfeitLog);
	});

	test('an expiry terminal does not append a command and persists status expired', async () => {
		const { challenge } = await seedActiveAttempt();
		const repository = createDailyChallengeRepository(db);

		const result = await repository.runCommandTransition(
			commandTransition({
				current: INITIAL_PROJECTION,
				next: INITIAL_PROJECTION,
				nowSeconds: TERMINAL_SETTLED_AT,
				terminal: terminalBundle({
					challenge,
					actionLogHash: hashLog(INITIAL_PROJECTION.actionLog),
					endingBankroll: BLACKJACK_DAILY_V1_CONFIG.startingBankroll,
					roundsCompleted: 0,
					terminalReason: 'expired',
					eligible: false,
					durationSeconds: BLACKJACK_DAILY_V1_CONFIG.attemptTtlSeconds,
				}),
			}),
		);

		expect(result.kind).toBe('applied');
		expect(result.result?.terminalReason).toBe('expired');
		const reread = await repository.findAttemptByChallengeAndUser(challenge.id, USER_ID);
		expect(reread?.status).toBe('expired');
		expect(reread?.nextCommandSequence).toBe(0);
		expect(reread?.actionLog).toEqual([]);
		expect(result.result?.durationSeconds).toBe(BLACKJACK_DAILY_V1_CONFIG.attemptTtlSeconds);
	});

	test('a corrupt result receipt hash triggers an invariant error on reread', async () => {
		const { challenge } = await seedActiveAttempt();
		const repository = createDailyChallengeRepository(db);
		const finalLog: DailyChallengeCommandV1[] = [{ sequence: 0, command: 'stand' }];
		await repository.runCommandTransition(
			commandTransition({
				current: INITIAL_PROJECTION,
				next: { sequence: 1, actionLog: finalLog, availableBankroll: 1500, roundsCompleted: 10 },
				nowSeconds: TERMINAL_SETTLED_AT,
				terminal: terminalBundle({
					challenge,
					actionLogHash: hashLog(finalLog),
					endingBankroll: 1500,
					roundsCompleted: 10,
				}),
			}),
		);
		await db
			.prepare('UPDATE daily_challenge_result SET receiptHash = ? WHERE attemptId = ?')
			.bind('0'.repeat(64), ATTEMPT_ID)
			.run();
		await expect(repository.findResultByAttempt(ATTEMPT_ID)).rejects.toBeInstanceOf(
			DailyChallengeRepositoryInvariantError,
		);
	});
});

describe('daily challenge leaderboard', () => {
	test('competition rank is 1, 1, 3 for a tied top pair', async () => {
		const challenge = await seedChallenge();
		await seedNamedUser('lb-tie-a', 'Alpha');
		await seedNamedUser('lb-tie-b', 'Bravo');
		await seedNamedUser('lb-tie-c', 'Charlie');
		await seedLeaderboardResult({
			userId: 'lb-tie-a',
			attemptId: 'lb-tie-a-attempt0000000001',
			challengeId: challenge.id,
			endingBankroll: 1100,
			settledAt: NOW_SECONDS + 10,
		});
		await seedLeaderboardResult({
			userId: 'lb-tie-b',
			attemptId: 'lb-tie-b-attempt0000000001',
			challengeId: challenge.id,
			endingBankroll: 1100,
			settledAt: NOW_SECONDS + 20,
		});
		await seedLeaderboardResult({
			userId: 'lb-tie-c',
			attemptId: 'lb-tie-c-attempt0000000001',
			challengeId: challenge.id,
			endingBankroll: 1000,
			settledAt: NOW_SECONDS + 30,
		});

		const board = await createDailyChallengeRepository(db).readLeaderboard(challenge.id, 50);

		expect(board.entries.map((entry) => entry.rank)).toEqual([1, 1, 3]);
	});

	test('ties share rank and percentile, and use settledAt/userId only for row order', async () => {
		const challenge = await seedChallenge();
		await seedNamedUser('lb-tie-a', 'Alpha');
		await seedNamedUser('lb-tie-b', 'Bravo');
		await seedLeaderboardResult({
			userId: 'lb-tie-a',
			attemptId: 'lb-tie-a-attempt0000000002',
			challengeId: challenge.id,
			endingBankroll: 1100,
			settledAt: NOW_SECONDS + 20,
		});
		await seedLeaderboardResult({
			userId: 'lb-tie-b',
			attemptId: 'lb-tie-b-attempt0000000002',
			challengeId: challenge.id,
			endingBankroll: 1100,
			settledAt: NOW_SECONDS + 10,
		});

		const board = await createDailyChallengeRepository(db).readLeaderboard(
			challenge.id,
			50,
			'lb-tie-a',
		);

		expect(board.entries.map((entry) => entry.userId)).toEqual(['lb-tie-b', 'lb-tie-a']);
		expect(board.entries.map((entry) => entry.rank)).toEqual([1, 1]);
		expect(board.currentUser?.rank).toBe(1);
		expect(board.currentUser?.totalEligible).toBe(2);
		expect(board.currentUser?.percentile).toBe(calculateDailyChallengePercentile(2, 0));
	});

	test('top 50 entries plus a current user standing outside the top 50', async () => {
		const challenge = await seedChallenge();
		for (let index = 0; index < 50; index += 1) {
			const userId = `lb-top-${String(index).padStart(2, '0')}`;
			await seedNamedUser(userId, `Top${index}`);
			await seedLeaderboardResult({
				userId,
				attemptId: `${userId}-attempt00000000001`,
				challengeId: challenge.id,
				endingBankroll: 2000 - index,
				settledAt: NOW_SECONDS + index,
			});
		}
		await seedLeaderboardResult({
			userId: USER_ID,
			attemptId: 'lb-current-attempt0000000001',
			challengeId: challenge.id,
			endingBankroll: 100,
			settledAt: NOW_SECONDS + 99,
		});

		const board = await createDailyChallengeRepository(db).readLeaderboard(
			challenge.id,
			50,
			USER_ID,
		);

		expect(board.entries).toHaveLength(50);
		expect(board.currentUser?.rank).toBe(51);
		expect(board.currentUser?.totalEligible).toBe(51);
		expect(board.currentUser?.percentile).toBe(calculateDailyChallengePercentile(51, 50));
	});

	test('ineligible results are excluded from the leaderboard and the count', async () => {
		const challenge = await seedChallenge();
		await seedNamedUser('lb-elig', 'Eligible');
		await seedNamedUser('lb-inelig', 'Ineligible');
		await seedLeaderboardResult({
			userId: 'lb-elig',
			attemptId: 'lb-elig-attempt00000000001',
			challengeId: challenge.id,
			endingBankroll: 1100,
			settledAt: NOW_SECONDS,
		});
		await seedLeaderboardResult({
			userId: 'lb-inelig',
			attemptId: 'lb-inelig-attempt000000001',
			challengeId: challenge.id,
			endingBankroll: 9999,
			settledAt: NOW_SECONDS,
			eligible: false,
		});

		const board = await createDailyChallengeRepository(db).readLeaderboard(
			challenge.id,
			50,
			'lb-inelig',
		);

		expect(board.entries).toHaveLength(1);
		expect(board.entries[0]?.userId).toBe('lb-elig');
		expect(board.currentUser).toBeNull();
	});

	test('a live leaderboard with no results is empty with a null current user', async () => {
		const challenge = await seedChallenge();
		const board = await createDailyChallengeRepository(db).readLeaderboard(
			challenge.id,
			50,
			USER_ID,
		);
		expect(board.entries).toEqual([]);
		expect(board.currentUser).toBeNull();
	});

	test('a bounded leaderboard limit caps the returned entries', async () => {
		const challenge = await seedChallenge();
		for (let index = 0; index < 5; index += 1) {
			const userId = `lb-limit-${String(index).padStart(2, '0')}`;
			await seedNamedUser(userId, `Limit${index}`);
			await seedLeaderboardResult({
				userId,
				attemptId: `${userId}-attempt00000000001`,
				challengeId: challenge.id,
				endingBankroll: 2000 - index,
				settledAt: NOW_SECONDS + index,
			});
		}

		const repository = createDailyChallengeRepository(db);
		const three = await repository.readLeaderboard(challenge.id, 3);
		expect(three.entries).toHaveLength(3);
		expect(three.entries.map((entry) => entry.endingBankroll)).toEqual([2000, 1999, 1998]);

		const full = await repository.readLeaderboard(challenge.id, 50);
		expect(full.entries).toHaveLength(5);
	});
});

describe('daily challenge history', () => {
	test('returns one challenge-centric entry per day with top score, participants, and user result', async () => {
		const challengeA = await seedChallenge(buildChallengeRecord());
		const challengeB = await seedChallenge(
			buildChallengeRecord({
				id: CHALLENGE_ID_NEXT,
				periodKey: PERIOD_KEY_NEXT,
				endsAt: getDailyChallengeWindow(NOW_SECONDS + 86_400).endsAt,
			}),
		);
		await seedNamedUser('hist-top-a', 'TopA');
		await seedLeaderboardResult({
			userId: 'hist-top-a',
			attemptId: 'hist-b-top-a-attempt000000001',
			challengeId: challengeB.id,
			endingBankroll: 1500,
			settledAt: NOW_SECONDS + 150,
		});
		await seedLeaderboardResult({
			userId: USER_ID,
			attemptId: 'hist-b-user-attempt0000000001',
			challengeId: challengeB.id,
			endingBankroll: 800,
			settledAt: NOW_SECONDS + 200,
		});
		await seedLeaderboardResult({
			userId: OTHER_USER_ID,
			attemptId: 'hist-b-inelig-attempt0000001',
			challengeId: challengeB.id,
			endingBankroll: 9999,
			settledAt: NOW_SECONDS + 250,
			eligible: false,
			terminalReason: 'forfeited',
		});
		await seedLeaderboardResult({
			userId: USER_ID,
			attemptId: 'hist-a-attempt0000000000001',
			challengeId: challengeA.id,
			endingBankroll: 1200,
			settledAt: NOW_SECONDS + 100,
		});

		const repository = createDailyChallengeRepository(db);
		const full = await repository.listChallengeHistory(10, USER_ID);
		expect(full.entries.map((entry) => entry.periodKey)).toEqual([PERIOD_KEY_NEXT, PERIOD_KEY]);
		expect(full.entries[0]).toMatchObject({
			periodKey: PERIOD_KEY_NEXT,
			challengeRulesetVersion: 'blackjack-daily-v1',
			topEndingBankroll: 1500,
			participantCount: 2,
		});
		expect(full.entries[0]?.userResult).toMatchObject({
			endingBankroll: 800,
			roundsCompleted: 10,
			terminalReason: 'completed',
			eligible: true,
		});
		expect(full.entries[1]).toMatchObject({
			periodKey: PERIOD_KEY,
			topEndingBankroll: 1200,
			participantCount: 1,
		});
		expect(full.entries[1]?.userResult?.endingBankroll).toBe(1200);

		const bounded = await repository.listChallengeHistory(1, USER_ID);
		expect(bounded.entries).toHaveLength(1);
		expect(bounded.entries[0]?.periodKey).toBe(PERIOD_KEY_NEXT);
	});

	test('a guest history omits user results and still reports top score and participants', async () => {
		const challenge = await seedChallenge();
		await seedNamedUser('hist-other', 'Other');
		await seedLeaderboardResult({
			userId: 'hist-other',
			attemptId: 'hist-other-attempt000000001',
			challengeId: challenge.id,
			endingBankroll: 500,
			settledAt: NOW_SECONDS + 5,
		});

		const history = await createDailyChallengeRepository(db).listChallengeHistory(10);
		expect(history.entries).toHaveLength(1);
		expect(history.entries[0]?.periodKey).toBe(PERIOD_KEY);
		expect(history.entries[0]?.topEndingBankroll).toBe(500);
		expect(history.entries[0]?.participantCount).toBe(1);
		expect(history.entries[0]?.userResult).toBeNull();
	});

	test('a challenge day with no eligible results reports no top score and zero participants', async () => {
		const challenge = await seedChallenge();
		await seedNamedUser('hist-elig-none', 'Nobody');
		await seedLeaderboardResult({
			userId: 'hist-elig-none',
			attemptId: 'hist-elig-none-attempt0000001',
			challengeId: challenge.id,
			endingBankroll: 700,
			settledAt: NOW_SECONDS + 5,
			eligible: false,
			terminalReason: 'expired',
		});

		const history = await createDailyChallengeRepository(db).listChallengeHistory(10, USER_ID);
		expect(history.entries).toHaveLength(1);
		expect(history.entries[0]?.topEndingBankroll).toBeNull();
		expect(history.entries[0]?.participantCount).toBe(0);
		expect(history.entries[0]?.userResult).toBeNull();
	});
});

describe('daily challenge retention', () => {
	test('listExpiredAttempts returns an ordered page of 100 expired active attempts', async () => {
		const challenge = await seedChallenge();
		for (let index = 0; index < 101; index += 1) {
			const userId = `exp-user-${String(index).padStart(3, '0')}`;
			await seedNamedUser(userId, `Expired${index}`);
			await insertDailyChallengeAttempt(db, {
				id: `exp-attempt-${String(index).padStart(3, '0')}`.padEnd(22, '0'),
				challengeId: challenge.id,
				userId,
				startRequestId: `req-${index}-padding-padding`,
				status: 'active',
				expiresAt: NOW_SECONDS - 100 + index,
				createdAt: NOW_SECONDS - 10_000,
				updatedAt: NOW_SECONDS - 10_000,
			});
		}

		const repository = createDailyChallengeRepository(db);
		const firstPage = await repository.listExpiredAttempts(NOW_SECONDS);

		expect(firstPage).toHaveLength(100);
		expect(firstPage[0]?.id).toBe('exp-attempt-000'.padEnd(22, '0'));
		expect(firstPage.at(-1)?.id).toBe('exp-attempt-099'.padEnd(22, '0'));
		expect(firstPage[0]?.expiresAt).toBe(NOW_SECONDS - 100);
	});

	test('a cursor advances past a poison row so later attempts are not blocked', async () => {
		const challenge = await seedChallenge();
		const ids = [
			'poison-row-padding-padding00',
			'later-row-padding-padding0',
			'last-row-padding-padding00',
		];
		for (let index = 0; index < 3; index += 1) {
			const userId = `cursor-user-${index}`;
			await seedNamedUser(userId, `Cursor${index}`);
			await insertDailyChallengeAttempt(db, {
				id: ids[index],
				challengeId: challenge.id,
				userId,
				startRequestId: `req-cursor-${index}-padding-pad`,
				status: 'active',
				expiresAt: NOW_SECONDS - (3 - index),
				createdAt: NOW_SECONDS - 10_000,
				updatedAt: NOW_SECONDS - 10_000,
			});
		}

		const repository = createDailyChallengeRepository(db);
		const firstPage = await repository.listExpiredAttempts(NOW_SECONDS);
		expect(firstPage.map((row) => row.id)).toEqual(ids);

		const poison = firstPage[0];
		const cursor: DailyChallengeExpirationCursor = { expiresAt: poison.expiresAt, id: poison.id };
		const nextPage = await repository.listExpiredAttempts(NOW_SECONDS, cursor);
		expect(nextPage.map((row) => row.id)).toEqual(ids.slice(1));
	});

	test('deleteTerminalAttemptsBefore deletes only old terminal attempts and preserves results and challenges', async () => {
		const challenge = await seedChallenge();
		const oldAttemptId = 'del-old-terminal-padding001';
		const newAttemptId = 'del-new-terminal-padding001';
		const activeAttemptId = 'del-active-terminal-padd01';
		await insertDailyChallengeAttempt(db, {
			id: oldAttemptId,
			challengeId: challenge.id,
			userId: USER_ID,
			startRequestId: 'req-del-old-padding-padding',
			status: 'completed',
			expiresAt: RETENTION_CUTOFF - 1,
			createdAt: RETENTION_CUTOFF - 100,
			updatedAt: RETENTION_CUTOFF - 1,
			settledAt: RETENTION_CUTOFF - 1,
		});
		await insertDailyChallengeAttempt(db, {
			id: newAttemptId,
			challengeId: challenge.id,
			userId: OTHER_USER_ID,
			startRequestId: 'req-del-new-padding-padding',
			status: 'completed',
			expiresAt: RETENTION_CUTOFF + 1,
			createdAt: RETENTION_CUTOFF + 100,
			updatedAt: RETENTION_CUTOFF + 1,
			settledAt: RETENTION_CUTOFF + 1,
		});
		await seedNamedUser('del-active-user', 'DelActive');
		await insertDailyChallengeAttempt(db, {
			id: activeAttemptId,
			challengeId: challenge.id,
			userId: 'del-active-user',
			startRequestId: 'req-del-active-padding-pad',
			status: 'active',
			expiresAt: RETENTION_CUTOFF - 10_000,
			createdAt: RETENTION_CUTOFF - 20_000,
			updatedAt: RETENTION_CUTOFF - 10_000,
		});
		await insertDailyChallengeResult(db, {
			attemptId: oldAttemptId,
			challengeId: challenge.id,
			userId: USER_ID,
			endingBankroll: 1500,
			settledAt: RETENTION_CUTOFF - 1,
		});

		const deleted =
			await createDailyChallengeRepository(db).deleteTerminalAttemptsBefore(RETENTION_CUTOFF);

		expect(deleted).toBe(1);
		const remaining = await db
			.prepare('SELECT id FROM daily_challenge_attempt ORDER BY id')
			.all<{ id: string }>();
		expect(remaining.results.map((row) => row.id)).toEqual([activeAttemptId, newAttemptId]);
		expect(await countResults()).toBe(1);
		expect(await countChallenges()).toBe(1);
	});
});

describe('daily challenge findAttemptById', () => {
	test('returns the persisted attempt for a known id', async () => {
		await seedActiveAttempt();
		const repository = createDailyChallengeRepository(db);
		const found = await repository.findAttemptById(ATTEMPT_ID);
		expect(found).not.toBeNull();
		expect(found?.id).toBe(ATTEMPT_ID);
		expect(found?.status).toBe('active');
	});

	test('returns null when no attempt exists for the id', async () => {
		const repository = createDailyChallengeRepository(db);
		expect(await repository.findAttemptById('nonexistent-attempt-id')).toBeNull();
	});
});

describe('daily challenge findChallengeById', () => {
	test('returns the persisted challenge for a known id', async () => {
		const record = await seedChallenge();
		const repository = createDailyChallengeRepository(db);
		const found = await repository.findChallengeById(record.id);
		expect(found).not.toBeNull();
		expect(found?.id).toBe(record.id);
		expect(found?.config).toEqual(BLACKJACK_DAILY_V1_CONFIG);
	});

	test('returns null when no challenge exists for the id', async () => {
		const repository = createDailyChallengeRepository(db);
		expect(await repository.findChallengeById('nonexistent-challenge-id')).toBeNull();
	});

	test('returns null for an unsupported challenge ruleset version', async () => {
		const record = await seedChallenge();
		await db
			.prepare('UPDATE daily_challenge SET challengeRulesetVersion = ? WHERE id = ?')
			.bind('something-else', record.id)
			.run();
		const repository = createDailyChallengeRepository(db);
		expect(await repository.findChallengeById(record.id)).toBeNull();
	});
});

describe('daily challenge findChallengeByPeriodKey unsupported version', () => {
	test('returns null when the persisted ruleset version is unsupported', async () => {
		const record = await seedChallenge();
		await db
			.prepare('UPDATE daily_challenge SET challengeRulesetVersion = ? WHERE id = ?')
			.bind('something-else', record.id)
			.run();
		const repository = createDailyChallengeRepository(db);
		expect(await repository.findChallengeByPeriodKey('blackjack-daily', PERIOD_KEY)).toBeNull();
	});
});

describe('daily challenge findStanding', () => {
	test('returns rank and percentile for a user with an eligible result', async () => {
		const challenge = await seedChallenge();
		await seedLeaderboardResult({
			userId: USER_ID,
			attemptId: 'standing-attempt00000000001',
			challengeId: challenge.id,
			endingBankroll: 1500,
			settledAt: NOW_SECONDS + 10,
		});
		const repository = createDailyChallengeRepository(db);
		const standing = await repository.findStanding(challenge.id, USER_ID);
		expect(standing).not.toBeNull();
		expect(standing?.rank).toBe(1);
		expect(standing?.percentile).toBe(calculateDailyChallengePercentile(1, 0));
	});

	test('returns null for a user with no result', async () => {
		const challenge = await seedChallenge();
		const repository = createDailyChallengeRepository(db);
		expect(await repository.findStanding(challenge.id, USER_ID)).toBeNull();
	});
});

describe('daily challenge readLeaderboard invalid inputs', () => {
	test('rejects an empty challenge id', async () => {
		const repository = createDailyChallengeRepository(db);
		await expect(repository.readLeaderboard('', 50)).rejects.toBeInstanceOf(
			DailyChallengeRepositoryInvariantError,
		);
	});

	test('rejects a zero limit', async () => {
		const challenge = await seedChallenge();
		const repository = createDailyChallengeRepository(db);
		await expect(repository.readLeaderboard(challenge.id, 0)).rejects.toBeInstanceOf(
			DailyChallengeRepositoryInvariantError,
		);
	});

	test('rejects a negative limit', async () => {
		const challenge = await seedChallenge();
		const repository = createDailyChallengeRepository(db);
		await expect(repository.readLeaderboard(challenge.id, -1)).rejects.toBeInstanceOf(
			DailyChallengeRepositoryInvariantError,
		);
	});
});

describe('daily challenge listChallengeHistory invalid limit', () => {
	test('rejects a zero limit', async () => {
		const repository = createDailyChallengeRepository(db);
		await expect(repository.listChallengeHistory(0)).rejects.toBeInstanceOf(
			DailyChallengeRepositoryInvariantError,
		);
	});

	test('rejects a negative limit', async () => {
		const repository = createDailyChallengeRepository(db);
		await expect(repository.listChallengeHistory(-1)).rejects.toBeInstanceOf(
			DailyChallengeRepositoryInvariantError,
		);
	});
});

describe('daily challenge terminal validation invariants', () => {
	async function seedForTerminal(): Promise<{
		challenge: NewDailyChallengeRecord;
		finalLog: DailyChallengeCommandV1[];
	}> {
		const { challenge } = await seedActiveAttempt();
		const finalLog: DailyChallengeCommandV1[] = [{ sequence: 0, command: 'stand' }];
		return { challenge, finalLog };
	}

	test('rejects an invalid terminal challenge id', async () => {
		const { challenge, finalLog } = await seedForTerminal();
		const repository = createDailyChallengeRepository(db);
		const terminal = {
			...terminalBundle({
				challenge,
				actionLogHash: hashLog(finalLog),
				endingBankroll: 1500,
				roundsCompleted: 10,
			}),
			challengeId: 'short',
		};
		const promise = repository.runCommandTransition(
			commandTransition({
				current: INITIAL_PROJECTION,
				next: { sequence: 1, actionLog: finalLog, availableBankroll: 1500, roundsCompleted: 10 },
				terminal,
			}),
		);
		await expect(promise).rejects.toBeInstanceOf(DailyChallengeRepositoryInvariantError);
		await expect(promise).rejects.toThrow('Invalid daily challenge terminal challenge id');
	});

	test('rejects an invalid terminal challenge ruleset version', async () => {
		const { challenge, finalLog } = await seedForTerminal();
		const repository = createDailyChallengeRepository(db);
		const terminal = {
			...terminalBundle({
				challenge,
				actionLogHash: hashLog(finalLog),
				endingBankroll: 1500,
				roundsCompleted: 10,
			}),
			challengeRulesetVersion: 'wrong' as 'blackjack-daily-v1',
		};
		const promise = repository.runCommandTransition(
			commandTransition({
				current: INITIAL_PROJECTION,
				next: { sequence: 1, actionLog: finalLog, availableBankroll: 1500, roundsCompleted: 10 },
				terminal,
			}),
		);
		await expect(promise).rejects.toBeInstanceOf(DailyChallengeRepositoryInvariantError);
		await expect(promise).rejects.toThrow('Invalid daily challenge terminal challenge ruleset');
	});

	test('rejects an invalid terminal game ruleset version', async () => {
		const { challenge, finalLog } = await seedForTerminal();
		const repository = createDailyChallengeRepository(db);
		const terminal = {
			...terminalBundle({
				challenge,
				actionLogHash: hashLog(finalLog),
				endingBankroll: 1500,
				roundsCompleted: 10,
			}),
			gameRulesetVersion: 'wrong' as 'blackjack-ranked-v1',
		};
		const promise = repository.runCommandTransition(
			commandTransition({
				current: INITIAL_PROJECTION,
				next: { sequence: 1, actionLog: finalLog, availableBankroll: 1500, roundsCompleted: 10 },
				terminal,
			}),
		);
		await expect(promise).rejects.toBeInstanceOf(DailyChallengeRepositoryInvariantError);
		await expect(promise).rejects.toThrow('Invalid daily challenge terminal game ruleset');
	});

	test('rejects an invalid terminal score version', async () => {
		const { challenge, finalLog } = await seedForTerminal();
		const repository = createDailyChallengeRepository(db);
		const terminal = {
			...terminalBundle({
				challenge,
				actionLogHash: hashLog(finalLog),
				endingBankroll: 1500,
				roundsCompleted: 10,
			}),
			scoreVersion: 'wrong' as 'blackjack-daily-score-v1',
		};
		const promise = repository.runCommandTransition(
			commandTransition({
				current: INITIAL_PROJECTION,
				next: { sequence: 1, actionLog: finalLog, availableBankroll: 1500, roundsCompleted: 10 },
				terminal,
			}),
		);
		await expect(promise).rejects.toBeInstanceOf(DailyChallengeRepositoryInvariantError);
		await expect(promise).rejects.toThrow('Invalid daily challenge terminal score version');
	});

	test('rejects an invalid terminal period key', async () => {
		const { challenge, finalLog } = await seedForTerminal();
		const repository = createDailyChallengeRepository(db);
		const terminal = {
			...terminalBundle({
				challenge,
				actionLogHash: hashLog(finalLog),
				endingBankroll: 1500,
				roundsCompleted: 10,
			}),
			periodKey: 'not-a-date',
		};
		const promise = repository.runCommandTransition(
			commandTransition({
				current: INITIAL_PROJECTION,
				next: { sequence: 1, actionLog: finalLog, availableBankroll: 1500, roundsCompleted: 10 },
				terminal,
			}),
		);
		await expect(promise).rejects.toBeInstanceOf(DailyChallengeRepositoryInvariantError);
		await expect(promise).rejects.toThrow('Invalid daily challenge terminal period key');
	});

	test('rejects a terminal receipt hash mismatch', async () => {
		const { challenge, finalLog } = await seedForTerminal();
		const repository = createDailyChallengeRepository(db);
		const terminal = {
			...terminalBundle({
				challenge,
				actionLogHash: hashLog(finalLog),
				endingBankroll: 1500,
				roundsCompleted: 10,
			}),
			receiptHash: '0'.repeat(64),
		};
		const promise = repository.runCommandTransition(
			commandTransition({
				current: INITIAL_PROJECTION,
				next: { sequence: 1, actionLog: finalLog, availableBankroll: 1500, roundsCompleted: 10 },
				terminal,
			}),
		);
		await expect(promise).rejects.toBeInstanceOf(DailyChallengeRepositoryInvariantError);
		await expect(promise).rejects.toThrow('Daily challenge terminal receipt hash mismatch');
	});
});

describe('daily challenge command transition action-log hash mismatch', () => {
	test('rejects a next action log whose hash does not match the JSON', async () => {
		await seedActiveAttempt();
		const repository = createDailyChallengeRepository(db);
		const nextLog: DailyChallengeCommandV1[] = [{ sequence: 0, command: 'start-round', wager: 10 }];
		const input = {
			...commandTransition({
				current: INITIAL_PROJECTION,
				next: { sequence: 1, actionLog: nextLog, availableBankroll: 990, roundsCompleted: 0 },
			}),
			nextActionLogHash: hashLog([]),
		};
		await expect(repository.runCommandTransition(input)).rejects.toBeInstanceOf(
			DailyChallengeRepositoryInvariantError,
		);
	});
});

describe('daily challenge parseChallengeRow invariants', () => {
	test('invalid config JSON triggers an invariant error on read', async () => {
		const record = await seedChallenge();
		await db
			.prepare('UPDATE daily_challenge SET configJson = ? WHERE id = ?')
			.bind('not-json{', record.id)
			.run();
		const repository = createDailyChallengeRepository(db);
		await expect(
			repository.findChallengeByPeriodKey('blackjack-daily', PERIOD_KEY),
		).rejects.toBeInstanceOf(DailyChallengeRepositoryInvariantError);
	});

	test('invalid ranked seed triggers an invariant error on read', async () => {
		const record = await seedChallenge();
		await db
			.prepare('UPDATE daily_challenge SET rankedSeed = ? WHERE id = ?')
			.bind('not-valid-base64!', record.id)
			.run();
		const repository = createDailyChallengeRepository(db);
		await expect(
			repository.findChallengeByPeriodKey('blackjack-daily', PERIOD_KEY),
		).rejects.toBeInstanceOf(DailyChallengeRepositoryInvariantError);
	});

	test('unsupported game ruleset version triggers an invariant error on read', async () => {
		const record = await seedChallenge();
		await db
			.prepare('UPDATE daily_challenge SET gameRulesetVersion = ? WHERE id = ?')
			.bind('wrong', record.id)
			.run();
		const repository = createDailyChallengeRepository(db);
		await expect(repository.findChallengeById(record.id)).rejects.toBeInstanceOf(
			DailyChallengeRepositoryInvariantError,
		);
	});

	test('unsupported score version triggers an invariant error on read', async () => {
		const record = await seedChallenge();
		await db
			.prepare('UPDATE daily_challenge SET scoreVersion = ? WHERE id = ?')
			.bind('wrong', record.id)
			.run();
		const repository = createDailyChallengeRepository(db);
		await expect(repository.findChallengeById(record.id)).rejects.toBeInstanceOf(
			DailyChallengeRepositoryInvariantError,
		);
	});

	test('negative startsAt triggers an invariant error on read', async () => {
		const record = await seedChallenge();
		await db
			.prepare('UPDATE daily_challenge SET startsAt = ? WHERE id = ?')
			.bind(-1, record.id)
			.run();
		const repository = createDailyChallengeRepository(db);
		await expect(
			repository.findChallengeByPeriodKey('blackjack-daily', PERIOD_KEY),
		).rejects.toBeInstanceOf(DailyChallengeRepositoryInvariantError);
	});
});

describe('daily challenge parseAttemptRow invariants', () => {
	test('a corrupt next command sequence triggers an invariant error on read', async () => {
		await seedActiveAttempt();
		await db
			.prepare('UPDATE daily_challenge_attempt SET nextCommandSequence = ? WHERE id = ?')
			.bind(-1, ATTEMPT_ID)
			.run();
		const repository = createDailyChallengeRepository(db);
		await expect(repository.findAttemptById(ATTEMPT_ID)).rejects.toBeInstanceOf(
			DailyChallengeRepositoryInvariantError,
		);
	});

	test('corrupt action log JSON triggers an invariant error on read', async () => {
		await seedActiveAttempt();
		await db
			.prepare('UPDATE daily_challenge_attempt SET actionLogJson = ? WHERE id = ?')
			.bind('not-json', ATTEMPT_ID)
			.run();
		const repository = createDailyChallengeRepository(db);
		await expect(repository.findAttemptById(ATTEMPT_ID)).rejects.toBeInstanceOf(
			DailyChallengeRepositoryInvariantError,
		);
	});
});

describe('daily challenge parseResultRow invariants', () => {
	async function seedTerminalResult(): Promise<NewDailyChallengeRecord> {
		const { challenge } = await seedActiveAttempt();
		const repository = createDailyChallengeRepository(db);
		const finalLog: DailyChallengeCommandV1[] = [{ sequence: 0, command: 'stand' }];
		await repository.runCommandTransition(
			commandTransition({
				current: INITIAL_PROJECTION,
				next: { sequence: 1, actionLog: finalLog, availableBankroll: 1500, roundsCompleted: 10 },
				nowSeconds: TERMINAL_SETTLED_AT,
				terminal: terminalBundle({
					challenge,
					actionLogHash: hashLog(finalLog),
					endingBankroll: 1500,
					roundsCompleted: 10,
				}),
			}),
		);
		return challenge;
	}

	test('a non-boolean eligible value triggers an invariant error on read', async () => {
		await seedTerminalResult();
		await db
			.prepare('UPDATE daily_challenge_result SET eligible = ? WHERE attemptId = ?')
			.bind(2, ATTEMPT_ID)
			.run();
		const repository = createDailyChallengeRepository(db);
		await expect(repository.findResultByAttempt(ATTEMPT_ID)).rejects.toBeInstanceOf(
			DailyChallengeRepositoryInvariantError,
		);
	});

	test('an unsupported challenge ruleset version triggers an invariant error on read', async () => {
		await seedTerminalResult();
		await db
			.prepare('UPDATE daily_challenge SET challengeRulesetVersion = ? WHERE id = ?')
			.bind('wrong', CHALLENGE_ID)
			.run();
		const repository = createDailyChallengeRepository(db);
		await expect(repository.findResultByAttempt(ATTEMPT_ID)).rejects.toBeInstanceOf(
			DailyChallengeRepositoryInvariantError,
		);
	});

	test('an unsupported game ruleset version triggers an invariant error on read', async () => {
		await seedTerminalResult();
		await db
			.prepare('UPDATE daily_challenge SET gameRulesetVersion = ? WHERE id = ?')
			.bind('wrong', CHALLENGE_ID)
			.run();
		const repository = createDailyChallengeRepository(db);
		await expect(repository.findResultByAttempt(ATTEMPT_ID)).rejects.toBeInstanceOf(
			DailyChallengeRepositoryInvariantError,
		);
	});

	test('an unsupported score version triggers an invariant error on read', async () => {
		await seedTerminalResult();
		await db
			.prepare('UPDATE daily_challenge_result SET scoreVersion = ? WHERE attemptId = ?')
			.bind('wrong', ATTEMPT_ID)
			.run();
		const repository = createDailyChallengeRepository(db);
		await expect(repository.findResultByAttempt(ATTEMPT_ID)).rejects.toBeInstanceOf(
			DailyChallengeRepositoryInvariantError,
		);
	});

	test('a corrupt period key triggers an invariant error on read', async () => {
		await seedTerminalResult();
		await db
			.prepare('UPDATE daily_challenge SET periodKey = ? WHERE id = ?')
			.bind('not-a-date', CHALLENGE_ID)
			.run();
		const repository = createDailyChallengeRepository(db);
		await expect(repository.findResultByAttempt(ATTEMPT_ID)).rejects.toBeInstanceOf(
			DailyChallengeRepositoryInvariantError,
		);
	});
});

describe('daily challenge parseHistoryRow invariants', () => {
	test('an unsupported history ruleset version triggers an invariant error', async () => {
		await seedChallenge();
		await db
			.prepare('UPDATE daily_challenge SET challengeRulesetVersion = ? WHERE id = ?')
			.bind('wrong', CHALLENGE_ID)
			.run();
		const repository = createDailyChallengeRepository(db);
		await expect(repository.listChallengeHistory(10)).rejects.toBeInstanceOf(
			DailyChallengeRepositoryInvariantError,
		);
	});

	test('a corrupt history period key triggers an invariant error', async () => {
		await seedChallenge();
		await db
			.prepare('UPDATE daily_challenge SET periodKey = ? WHERE id = ?')
			.bind('bad', CHALLENGE_ID)
			.run();
		const repository = createDailyChallengeRepository(db);
		await expect(repository.listChallengeHistory(10)).rejects.toBeInstanceOf(
			DailyChallengeRepositoryInvariantError,
		);
	});
});

describe('daily challenge parseLeaderboardRow empty player name', () => {
	test('an empty player name triggers an invariant error on read', async () => {
		const challenge = await seedChallenge();
		await insertDailyChallengeTestUser(db, {
			id: 'empty-name-user',
			name: '',
			chipBalance: 10000,
		});
		await seedLeaderboardResult({
			userId: 'empty-name-user',
			attemptId: 'empty-name-attempt0000000001',
			challengeId: challenge.id,
			endingBankroll: 1100,
			settledAt: NOW_SECONDS + 10,
		});
		const repository = createDailyChallengeRepository(db);
		await expect(repository.readLeaderboard(challenge.id, 50)).rejects.toBeInstanceOf(
			DailyChallengeRepositoryInvariantError,
		);
	});
});
