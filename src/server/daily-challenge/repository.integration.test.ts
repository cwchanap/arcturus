import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { Miniflare } from 'miniflare';
import {
	BLACKJACK_DAILY_V1_CONFIG,
	getDailyChallengeWindow,
} from '../../lib/daily-challenge/config';
import { createDailyChallengeSeedCommitment } from '../../lib/daily-challenge/random';
import {
	canonicalizeRanked,
	encodeBase64Url,
	hashCanonical,
	sha256Hex,
} from '../../lib/ranked/canonical';
import { buildRateLimitStatement, RANKED_RATE_LIMITS } from '../ranked/rate-limit';
import {
	DailyChallengeRepositoryInvariantError,
	createDailyChallengeRepository,
	type DailyChallengeStartTransitionInput,
	type NewDailyChallengeAttemptRecord,
	type NewDailyChallengeRecord,
} from './repository';
import { createDailyChallengeTestD1, insertDailyChallengeTestUser } from './test-d1';

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
		const loser = buildChallengeRecord({
			id: 'daily-challenge-loser-0001',
			rankedSeed: encodeBase64Url(crypto.getRandomValues(new Uint8Array(32))),
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

		const loser = buildChallengeRecord({
			id: 'daily-challenge-loser-0002',
			rankedSeed: encodeBase64Url(crypto.getRandomValues(new Uint8Array(32))),
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
		expect(
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
		expect(
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
		expect(repository.findAttemptByUserAndRequestId(USER_ID, REQUEST_ID_A)).rejects.toBeInstanceOf(
			DailyChallengeRepositoryInvariantError,
		);
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
