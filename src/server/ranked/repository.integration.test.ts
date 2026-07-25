import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { Miniflare } from 'miniflare';
import { BLACKJACK_RANKED_V1_CONFIG } from '../../lib/ranked/blackjack/adapter';
import { canonicalizeRanked, hashCanonical, sha256Hex } from '../../lib/ranked/canonical';
import { acquireMultiplayerMembership } from '../mp/membership';
import { RANKED_RATE_LIMITS, buildRateLimitStatement, getRetryAfterSeconds } from './rate-limit';
import {
	RANKED_START_ACCOUNT_SNAPSHOT_SQL,
	RankedRepositoryInvariantError,
	createRankedRepository,
	type NewRankedSessionRecord,
	type RankedRateLimitInput,
	type StartTransitionInput,
} from './repository';
import { createRankedLogEntry, redactRankedIdentifier } from './logging';
import { createRankedTestD1, insertRankedTestUser } from './test-d1';

const USER_ID = 'ranked-repository-user';
const NOW_SECONDS = 1_800_000_000;
const SESSION_A = 'AAAAAAAAAAAAAAAAAAAAAA';
const SESSION_B = 'BBBBBBBBBBBBBBBBBBBBBB';

let mf: Miniflare;
let db: D1Database;

beforeAll(async () => {
	({ mf, db } = await createRankedTestD1());
});

afterAll(async () => {
	await mf.dispose();
});

beforeEach(async () => {
	await db.batch([
		db.prepare('DELETE FROM ranked_result'),
		db.prepare('DELETE FROM ranked_session'),
		db.prepare('DELETE FROM ranked_rate_limit'),
		db.prepare('DELETE FROM mp_membership'),
		db.prepare('DELETE FROM user'),
	]);
	await insertRankedTestUser(db, { id: USER_ID, chipBalance: 1000 });
});

function newSession({
	id = SESSION_A,
	requestId = 'request-00000001',
	startPayloadHash = sha256Hex('start-payload-a'),
	wager = 100,
}: {
	id?: string;
	requestId?: string;
	startPayloadHash?: string;
	wager?: number;
} = {}): NewRankedSessionRecord {
	const config = { ...BLACKJACK_RANKED_V1_CONFIG, initialWager: wager };
	return {
		id,
		startRequestId: requestId,
		startPayloadHash,
		gameType: 'blackjack',
		rulesetVersion: 'blackjack-ranked-v1',
		configJson: canonicalizeRanked(config),
		configHash: hashCanonical(config),
		seed: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
		seedCommitment: sha256Hex('seed-commitment'),
		actionLogJson: canonicalizeRanked([]),
		actionLogHash: hashCanonical([]),
		initialWager: wager,
		committedWager: wager,
		expiresAt: NOW_SECONDS + 900,
		createdAt: NOW_SECONDS,
		updatedAt: NOW_SECONDS,
	};
}

function startInput(
	session = newSession(),
	expectedBalance = 1000,
	nowSeconds = NOW_SECONDS,
): StartTransitionInput {
	return {
		userId: USER_ID,
		expectedBalance,
		session,
		rateLimit: {
			userId: USER_ID,
			operation: 'ranked_start',
			nowSeconds,
		},
	};
}

async function readBalance(): Promise<{ chipBalance: number; heldChips: number }> {
	const row = await db
		.prepare('SELECT chipBalance, heldChips FROM user WHERE id = ?')
		.bind(USER_ID)
		.first<{ chipBalance: number; heldChips: number }>();
	if (!row) throw new Error('missing test user');
	return row;
}

async function countSessions(): Promise<number> {
	const row = await db
		.prepare('SELECT COUNT(*) AS count FROM ranked_session WHERE userId = ?')
		.bind(USER_ID)
		.first<{ count: number }>();
	return row?.count ?? 0;
}

async function readRateCount(operation: keyof typeof RANKED_RATE_LIMITS): Promise<number> {
	const row = await db
		.prepare(
			'SELECT count FROM ranked_rate_limit WHERE userId = ? AND operation = ? AND windowStart = ?',
		)
		.bind(USER_ID, operation, NOW_SECONDS)
		.first<{ count: number }>();
	return row?.count ?? 0;
}

async function consumeBatch(
	operation: keyof typeof RANKED_RATE_LIMITS,
	count: number,
	nowSeconds = NOW_SECONDS,
): Promise<number[]> {
	const results = await db.batch(
		Array.from({ length: count }, () =>
			buildRateLimitStatement(db, { userId: USER_ID, operation, nowSeconds }),
		),
	);
	return results.map((result) => result.meta.changes ?? 0);
}

const VALID_OUTCOME = {
	result: 'win',
	hands: [{ handIndex: 0, result: 'win', wager: 100, payout: 200 }],
	committedWager: 100,
	payout: 200,
	gameNetDelta: 100,
} as const;

const VALID_STATS_EFFECTS = {
	sessionsPlayed: 1,
	totalWins: 1,
	totalLosses: 0,
	totalPushes: 0,
	totalForfeits: 0,
	netProfit: 100,
	biggestWin: 100,
} as const;

const VALID_ACHIEVEMENT_EFFECTS: readonly string[] = [];
const VALID_REWARD_EFFECTS: readonly { rewardId: string; chipAmount: number }[] = [];

async function insertResult({
	statsEffects = VALID_STATS_EFFECTS,
	achievementEffects = VALID_ACHIEVEMENT_EFFECTS,
	rewardEffects = VALID_REWARD_EFFECTS,
}: {
	statsEffects?: unknown;
	achievementEffects?: unknown;
	rewardEffects?: unknown;
} = {}): Promise<void> {
	const receiptWithoutHash = {
		sessionId: SESSION_A,
		gameType: 'blackjack',
		rulesetVersion: 'blackjack-ranked-v1',
		seedCommitment: sha256Hex('seed-commitment'),
		configHash: hashCanonical({ ...BLACKJACK_RANKED_V1_CONFIG, initialWager: 100 }),
		actionLogHash: hashCanonical([]),
		outcome: VALID_OUTCOME,
		initialWager: 100,
		committedWager: 100,
		payout: 200,
		gameNetDelta: 100,
		rewardDelta: 0,
		balanceAfter: 1100,
		statsEffects,
		achievementEffects,
		rewardEffects,
		settledAt: NOW_SECONDS + 1,
	};
	await db.batch([
		db
			.prepare('UPDATE user SET chipBalance = ?, updatedAt = ? WHERE id = ?')
			.bind(1100, NOW_SECONDS + 1, USER_ID),
		db
			.prepare(
				"UPDATE ranked_session SET activeUserId = NULL, status = 'settled', settledAt = ?, updatedAt = ? WHERE id = ?",
			)
			.bind(NOW_SECONDS + 1, NOW_SECONDS + 1, SESSION_A),
	]);
	await db
		.prepare(
			`INSERT INTO ranked_result (
				sessionId, userId, gameType, rulesetVersion, seedCommitment, configHash,
				actionLogHash, outcomeJson, initialWager, committedWager, payout,
				gameNetDelta, rewardDelta, balanceAfter, statsEffectsJson,
				achievementEffectsJson, rewardEffectsJson, receiptHash, settledAt
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			SESSION_A,
			USER_ID,
			'blackjack',
			'blackjack-ranked-v1',
			receiptWithoutHash.seedCommitment,
			receiptWithoutHash.configHash,
			receiptWithoutHash.actionLogHash,
			canonicalizeRanked(VALID_OUTCOME),
			100,
			100,
			200,
			100,
			0,
			1100,
			canonicalizeRanked(statsEffects as never),
			canonicalizeRanked(achievementEffects as never),
			canonicalizeRanked(rewardEffects as never),
			hashCanonical(receiptWithoutHash as never),
			NOW_SECONDS + 1,
		)
		.run();
}

describe('durable ranked rate limits', () => {
	test.each([
		['ranked_start', 6],
		['ranked_action', 30],
		['ranked_resume', 120],
		['ranked_replay', 120],
	] as const)('allows exactly the configured %s fixed-window limit', async (operation, limit) => {
		const changes = await consumeBatch(operation, limit + 1);

		expect(changes.slice(0, limit).every((value) => value === 1)).toBe(true);
		expect(changes.at(-1)).toBe(0);
		expect(await readRateCount(operation)).toBe(limit);
	});

	test('fresh repository instances share one durable counter', async () => {
		await db
			.prepare(
				'INSERT INTO ranked_rate_limit (userId, operation, windowStart, count, expiresAt) VALUES (?, ?, ?, ?, ?)',
			)
			.bind(USER_ID, 'ranked_resume', NOW_SECONDS, 119, NOW_SECONDS + 60)
			.run();
		const left = createRankedRepository(db);
		const right = createRankedRepository(db);

		const results = await Promise.all([
			left.consumeStandaloneRateLimit(USER_ID, 'ranked_resume', NOW_SECONDS),
			right.consumeStandaloneRateLimit(USER_ID, 'ranked_resume', NOW_SECONDS),
		]);

		expect(results.map((result) => result.kind).sort()).toEqual(['allowed', 'rate-limited']);
		expect(results.find((result) => result.kind === 'rate-limited')).toEqual({
			kind: 'rate-limited',
			retryAfter: 60,
		});
		expect(await readRateCount('ranked_resume')).toBe(120);
	});

	test('returns exact Retry-After metadata until the next fixed window', () => {
		expect(getRetryAfterSeconds('ranked_start', NOW_SECONDS)).toBe(60);
		expect(getRetryAfterSeconds('ranked_start', NOW_SECONDS + 59)).toBe(1);
		expect(getRetryAfterSeconds('ranked_start', NOW_SECONDS + 60)).toBe(60);
	});
});

describe('ranked start account snapshot', () => {
	test('a matched no-op reports one change and a stale exact balance reports zero', async () => {
		const firstRate: RankedRateLimitInput = {
			userId: USER_ID,
			operation: 'ranked_start',
			nowSeconds: NOW_SECONDS,
		};
		const [, matched] = await db.batch([
			buildRateLimitStatement(db, firstRate),
			db.prepare(RANKED_START_ACCOUNT_SNAPSHOT_SQL).bind(USER_ID, 1000, 100, USER_ID, USER_ID),
		]);
		expect(matched.meta.changes).toBe(1);

		await db.prepare('UPDATE user SET chipBalance = ? WHERE id = ?').bind(999, USER_ID).run();
		const [, stale] = await db.batch([
			buildRateLimitStatement(db, {
				...firstRate,
				nowSeconds: NOW_SECONDS + 60,
			}),
			db.prepare(RANKED_START_ACCOUNT_SNAPSHOT_SQL).bind(USER_ID, 1000, 100, USER_ID, USER_ID),
		]);
		expect(stale.meta.changes).toBe(0);
		expect(await readBalance()).toEqual({ chipBalance: 999, heldChips: 0 });
	});
});

describe('ranked start transaction', () => {
	test('creates one active session and deducts the opening wager relatively', async () => {
		const result = await createRankedRepository(db).runStartTransition(startInput());

		expect(result).toEqual({ kind: 'created' });
		expect(await readBalance()).toEqual({ chipBalance: 900, heldChips: 0 });
		expect(await countSessions()).toBe(1);
		expect(await readRateCount('ranked_start')).toBe(1);
	});

	test('commits only the rate unit when the opening wager is insufficient', async () => {
		await db.prepare('UPDATE user SET chipBalance = ? WHERE id = ?').bind(50, USER_ID).run();

		const result = await createRankedRepository(db).runStartTransition(
			startInput(newSession(), 50),
		);

		expect(result).toEqual({ kind: 'balance-changed' });
		expect(await readBalance()).toEqual({ chipBalance: 50, heldChips: 0 });
		expect(await countSessions()).toBe(0);
		expect(await readRateCount('ranked_start')).toBe(1);
	});

	test('a denied start limit gates every account, session, and wager mutation', async () => {
		await consumeBatch('ranked_start', RANKED_RATE_LIMITS.ranked_start.limit);

		const result = await createRankedRepository(db).runStartTransition(startInput());

		expect(result).toEqual({ kind: 'rate-limited', retryAfter: 60 });
		expect(await readBalance()).toEqual({ chipBalance: 1000, heldChips: 0 });
		expect(await countSessions()).toBe(0);
		expect(await readRateCount('ranked_start')).toBe(6);
	});

	test('heldChips introduced after preflight blocks the session and wager', async () => {
		const repository = createRankedRepository(db);
		const preflight = await repository.readAccount(USER_ID);
		await db.prepare('UPDATE user SET heldChips = ? WHERE id = ?').bind(250, USER_ID).run();

		const result = await repository.runStartTransition(
			startInput(newSession(), preflight?.chipBalance ?? -1),
		);

		expect(result).toEqual({ kind: 'balance-changed' });
		expect(await readBalance()).toEqual({ chipBalance: 1000, heldChips: 250 });
		expect(await countSessions()).toBe(0);
		expect(await readRateCount('ranked_start')).toBe(1);
	});

	test('a stale casual balance snapshot cannot insert a session or deduct a wager', async () => {
		const repository = createRankedRepository(db);
		const preflight = await repository.readAccount(USER_ID);
		await db.prepare('UPDATE user SET chipBalance = ? WHERE id = ?').bind(975, USER_ID).run();

		const result = await repository.runStartTransition(
			startInput(newSession(), preflight?.chipBalance ?? -1),
		);

		expect(result).toEqual({ kind: 'balance-changed' });
		expect(await readBalance()).toEqual({ chipBalance: 975, heldChips: 0 });
		expect(await countSessions()).toBe(0);
		expect(await readRateCount('ranked_start')).toBe(1);
	});

	test('a conflict-tolerant duplicate start commits rate but no second wager', async () => {
		const repository = createRankedRepository(db);
		const input = startInput();

		const [first, second] = await Promise.all([
			repository.runStartTransition(input),
			repository.runStartTransition(input),
		]);

		expect([first.kind, second.kind].sort()).toEqual(['created', 'not-created']);
		expect(await readBalance()).toEqual({ chipBalance: 900, heldChips: 0 });
		expect(await countSessions()).toBe(1);
		expect(await readRateCount('ranked_start')).toBe(2);
	});

	test('request-ID reuse with a mismatched payload commits no second wager', async () => {
		const repository = createRankedRepository(db);
		expect(await repository.runStartTransition(startInput())).toEqual({ kind: 'created' });
		await db
			.prepare("UPDATE ranked_session SET activeUserId = NULL, status = 'settled' WHERE id = ?")
			.bind(SESSION_A)
			.run();
		const mismatched = newSession({
			id: SESSION_B,
			requestId: 'request-00000001',
			startPayloadHash: sha256Hex('different-start-payload'),
		});

		const result = await repository.runStartTransition(startInput(mismatched, 900));

		expect(result).toEqual({ kind: 'not-created' });
		expect(await readBalance()).toEqual({ chipBalance: 900, heldChips: 0 });
		expect(await countSessions()).toBe(1);
		expect(await readRateCount('ranked_start')).toBe(2);
	});

	test('a different active session blocks a new request without another wager', async () => {
		const repository = createRankedRepository(db);
		expect(await repository.runStartTransition(startInput())).toEqual({ kind: 'created' });
		const second = newSession({
			id: SESSION_B,
			requestId: 'request-00000002',
			startPayloadHash: sha256Hex('start-payload-b'),
		});

		const result = await repository.runStartTransition(startInput(second, 900));

		expect(result).toEqual({ kind: 'not-created' });
		expect(await readBalance()).toEqual({ chipBalance: 900, heldChips: 0 });
		expect(await countSessions()).toBe(1);
		expect(await readRateCount('ranked_start')).toBe(2);
	});

	test('racing different starts produce exactly one owner and one wager', async () => {
		const repository = createRankedRepository(db);
		const left = startInput();
		const right = startInput(
			newSession({
				id: SESSION_B,
				requestId: 'request-00000002',
				startPayloadHash: sha256Hex('start-payload-b'),
			}),
		);

		const results = await Promise.all([
			repository.runStartTransition(left),
			repository.runStartTransition(right),
		]);

		expect(results.map((result) => result.kind).sort()).toEqual(['created', 'not-created']);
		expect(await readBalance()).toEqual({ chipBalance: 900, heldChips: 0 });
		expect(await countSessions()).toBe(1);
		expect(await readRateCount('ranked_start')).toBe(2);
	});

	test('inverse ranked and multiplayer acquisitions leave exactly one owner', async () => {
		const repository = createRankedRepository(db);

		const [rankedResult, membershipResult] = await Promise.all([
			repository.runStartTransition(startInput()),
			acquireMultiplayerMembership({
				db,
				userId: USER_ID,
				roomCode: 'MP-RACE01',
				joinedAtMs: NOW_SECONDS * 1000,
			}),
		]);

		const ranked = await db
			.prepare('SELECT id FROM ranked_session WHERE activeUserId = ?')
			.bind(USER_ID)
			.first<{ id: string }>();
		const membership = await db
			.prepare('SELECT roomCode FROM mp_membership WHERE userId = ?')
			.bind(USER_ID)
			.first<{ roomCode: string }>();
		expect(Number(ranked !== null) + Number(membership !== null)).toBe(1);
		if (ranked) {
			expect(rankedResult).toEqual({ kind: 'created' });
			expect(membershipResult).toEqual({ kind: 'blocked' });
			expect(await readBalance()).toEqual({ chipBalance: 900, heldChips: 0 });
		} else {
			expect(rankedResult).toEqual({ kind: 'balance-changed' });
			expect(membershipResult).toEqual({ kind: 'acquired', roomCode: 'MP-RACE01' });
			expect(await readBalance()).toEqual({ chipBalance: 1000, heldChips: 0 });
		}
		expect(await readRateCount('ranked_start')).toBe(1);
	});
});

describe('typed ranked repository reads', () => {
	test('parses strict versioned config and action JSON for start and owned reads', async () => {
		const repository = createRankedRepository(db);
		const session = newSession();
		expect(await repository.runStartTransition(startInput(session))).toEqual({ kind: 'created' });

		const byRequest = await repository.findByStartRequest(USER_ID, session.startRequestId);
		const owned = await repository.findOwnedSession(USER_ID, session.id);

		expect(byRequest?.config).toEqual({
			...BLACKJACK_RANKED_V1_CONFIG,
			initialWager: 100,
		});
		expect(byRequest?.actionLog).toEqual([]);
		expect(owned).toEqual(byRequest);
		expect(await repository.readAccount(USER_ID)).toEqual({
			chipBalance: 900,
			heldChips: 0,
		});
	});

	test('parses immutable result JSON into typed fields', async () => {
		const repository = createRankedRepository(db);
		expect(await repository.runStartTransition(startInput())).toEqual({ kind: 'created' });
		await insertResult();

		const result = await repository.findResult(SESSION_A);

		expect(result?.outcome).toEqual(VALID_OUTCOME);
		expect(result?.statsEffects).toEqual(VALID_STATS_EFFECTS);
		expect(result?.achievementEffects).toEqual(VALID_ACHIEVEMENT_EFFECTS);
		expect(result?.rewardEffects).toEqual(VALID_REWARD_EFFECTS);
	});

	test('rejects canonical hash-matched unknown action fields through the strict schema', async () => {
		const repository = createRankedRepository(db);
		expect(await repository.runStartTransition(startInput())).toEqual({ kind: 'created' });
		const actionLogWithUnknownField = [{ sequence: 0, action: 'hit', extra: true }] as const;

		await db
			.prepare('UPDATE ranked_session SET actionLogJson = ?, actionLogHash = ? WHERE id = ?')
			.bind(
				canonicalizeRanked(actionLogWithUnknownField),
				hashCanonical(actionLogWithUnknownField),
				SESSION_A,
			)
			.run();
		await expect(repository.findOwnedSession(USER_ID, SESSION_A)).rejects.toBeInstanceOf(
			RankedRepositoryInvariantError,
		);
	});

	test('rejects a valid canonical action log with a mismatched stored hash', async () => {
		const repository = createRankedRepository(db);
		expect(await repository.runStartTransition(startInput())).toEqual({ kind: 'created' });
		const validActionLog = [{ sequence: 0, action: 'hit' }] as const;

		await db
			.prepare('UPDATE ranked_session SET actionLogJson = ?, actionLogHash = ? WHERE id = ?')
			.bind(canonicalizeRanked(validActionLog), sha256Hex('wrong-action-log-hash'), SESSION_A)
			.run();
		await expect(repository.findOwnedSession(USER_ID, SESSION_A)).rejects.toBeInstanceOf(
			RankedRepositoryInvariantError,
		);
	});

	test('treats strict config and config-hash failures as invariants', async () => {
		const repository = createRankedRepository(db);
		expect(await repository.runStartTransition(startInput())).toEqual({ kind: 'created' });
		const configWithUnknownField = {
			...BLACKJACK_RANKED_V1_CONFIG,
			initialWager: 100,
			extra: true,
		};
		await db
			.prepare(
				'UPDATE ranked_session SET actionLogJson = ?, actionLogHash = ?, configJson = ?, configHash = ? WHERE id = ?',
			)
			.bind(
				canonicalizeRanked([]),
				hashCanonical([]),
				canonicalizeRanked(configWithUnknownField),
				hashCanonical(configWithUnknownField),
				SESSION_A,
			)
			.run();
		await expect(repository.findOwnedSession(USER_ID, SESSION_A)).rejects.toBeInstanceOf(
			RankedRepositoryInvariantError,
		);

		await db
			.prepare('UPDATE ranked_session SET configJson = ?, configHash = ? WHERE id = ?')
			.bind(
				canonicalizeRanked({ ...BLACKJACK_RANKED_V1_CONFIG, initialWager: 100 }),
				sha256Hex('wrong-hash'),
				SESSION_A,
			)
			.run();
		await expect(repository.findOwnedSession(USER_ID, SESSION_A)).rejects.toBeInstanceOf(
			RankedRepositoryInvariantError,
		);
	});

	test.each([
		{
			label: 'statistics unknown field',
			statsEffects: { ...VALID_STATS_EFFECTS, extra: true },
			achievementEffects: VALID_ACHIEVEMENT_EFFECTS,
			rewardEffects: VALID_REWARD_EFFECTS,
		},
		{
			label: 'unknown achievement ID',
			statsEffects: VALID_STATS_EFFECTS,
			achievementEffects: ['rising_star'],
			rewardEffects: VALID_REWARD_EFFECTS,
		},
		{
			label: 'reward unknown field',
			statsEffects: VALID_STATS_EFFECTS,
			achievementEffects: VALID_ACHIEVEMENT_EFFECTS,
			rewardEffects: [{ rewardId: 'ranked_debut_100', chipAmount: 100, extra: true }],
		},
	])(
		'rejects canonical receipt-hash-matched $label result effects',
		async ({ statsEffects, achievementEffects, rewardEffects }) => {
			const repository = createRankedRepository(db);
			expect(await repository.runStartTransition(startInput())).toEqual({ kind: 'created' });
			await insertResult({ statsEffects, achievementEffects, rewardEffects });

			await expect(repository.findResult(SESSION_A)).rejects.toBeInstanceOf(
				RankedRepositoryInvariantError,
			);
		},
	);
});

describe('ranked logging redaction', () => {
	test('emits only stable SHA-256-derived identifier references', () => {
		const userRef = redactRankedIdentifier(USER_ID);
		const entry = createRankedLogEntry('ranked_session_started', {
			userId: USER_ID,
			sessionId: SESSION_A,
		});

		expect(userRef).toMatch(/^[a-f0-9]{12}$/);
		expect(userRef).toBe(redactRankedIdentifier(USER_ID));
		expect(userRef).not.toContain(USER_ID);
		expect(JSON.stringify(entry)).not.toContain(USER_ID);
		expect(JSON.stringify(entry)).not.toContain(SESSION_A);
		expect(entry).toEqual({
			event: 'ranked_session_started',
			userRef,
			sessionRef: redactRankedIdentifier(SESSION_A),
		});
	});
});
