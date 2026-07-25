import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { Miniflare } from 'miniflare';
import { BLACKJACK_RANKED_V1_CONFIG } from '../../lib/ranked/blackjack/adapter';
import { canonicalizeRanked, hashCanonical, sha256Hex } from '../../lib/ranked/canonical';
import { acquireMultiplayerMembership } from '../mp/membership';
import { RANKED_RATE_LIMITS, buildRateLimitStatement, getRetryAfterSeconds } from './rate-limit';
import {
	RANKED_START_ACCOUNT_SNAPSHOT_SQL,
	RANKED_TERMINAL_ACCOUNT_SNAPSHOT_SQL,
	RankedRepositoryInvariantError,
	createRankedRepository,
	type ActionTransitionInput,
	type ExpirationTransitionInput,
	type NewRankedSessionRecord,
	type RankedRateLimitInput,
	type StartTransitionInput,
	type TerminalTransitionInput,
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
		db.prepare('DELETE FROM user_achievement'),
		db.prepare('DELETE FROM ranked_reward_grant'),
		db.prepare('DELETE FROM ranked_game_stats'),
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

const RANKED_DEBUT_ACHIEVEMENT_EFFECTS = ['ranked_debut'] as const;
const RANKED_DEBUT_REWARD_EFFECTS = [{ rewardId: 'ranked_debut_100', chipAmount: 100 }] as const;

function receiptHashFor({
	session = newSession(),
	actionLogHash = session.actionLogHash,
	committedWager = session.committedWager,
	outcome = VALID_OUTCOME,
	payout = outcome.payout,
	gameNetDelta = outcome.gameNetDelta,
	rewardDelta = 0,
	balanceAfter,
	statsEffects = VALID_STATS_EFFECTS,
	achievementEffects = VALID_ACHIEVEMENT_EFFECTS,
	rewardEffects = VALID_REWARD_EFFECTS,
	settledAt = NOW_SECONDS + 1,
}: {
	session?: NewRankedSessionRecord;
	actionLogHash?: string;
	committedWager?: number;
	outcome?:
		| typeof VALID_OUTCOME
		| {
				result: 'win' | 'loss' | 'push';
				hands: readonly {
					handIndex: number;
					result: 'win' | 'loss' | 'push' | 'blackjack';
					wager: number;
					payout: number;
				}[];
				committedWager: number;
				payout: number;
				gameNetDelta: number;
		  };
	payout?: number;
	gameNetDelta?: number;
	rewardDelta?: 0 | 100;
	balanceAfter: number;
	statsEffects?:
		| typeof VALID_STATS_EFFECTS
		| {
				sessionsPlayed: 1;
				totalWins: 0 | 1;
				totalLosses: 0 | 1;
				totalPushes: 0 | 1;
				totalForfeits: 0 | 1;
				netProfit: number;
				biggestWin: number;
		  };
	achievementEffects?: readonly 'ranked_debut'[];
	rewardEffects?: readonly { rewardId: 'ranked_debut_100'; chipAmount: 100 }[];
	settledAt?: number;
}): string {
	return hashCanonical({
		sessionId: session.id,
		gameType: session.gameType,
		rulesetVersion: session.rulesetVersion,
		seedCommitment: session.seedCommitment,
		configHash: session.configHash,
		actionLogHash,
		outcome,
		initialWager: session.initialWager,
		committedWager,
		payout,
		gameNetDelta,
		rewardDelta,
		balanceAfter,
		statsEffects,
		achievementEffects,
		rewardEffects,
		settledAt,
	});
}

function terminalInput({
	session = newSession(),
	expectedWalletBalance = 900,
	finalAdditionalWager = 0,
	committedWager = session.committedWager + finalAdditionalWager,
	payout = 200,
	rewardDelta = 100,
	settledAt = NOW_SECONDS + 1,
	actionLogHash = session.actionLogHash,
	outcome = {
		result: 'win' as const,
		hands: [{ handIndex: 0, result: 'win' as const, wager: committedWager, payout }],
		committedWager,
		payout,
		gameNetDelta: payout - committedWager,
	},
	statsEffects = {
		sessionsPlayed: 1 as const,
		totalWins: 1 as const,
		totalLosses: 0 as const,
		totalPushes: 0 as const,
		totalForfeits: 0 as const,
		netProfit: outcome.gameNetDelta,
		biggestWin: Math.max(payout - committedWager, 0),
	},
	achievementEffects = rewardDelta === 100
		? RANKED_DEBUT_ACHIEVEMENT_EFFECTS
		: VALID_ACHIEVEMENT_EFFECTS,
	rewardEffects = rewardDelta === 100 ? RANKED_DEBUT_REWARD_EFFECTS : VALID_REWARD_EFFECTS,
}: {
	session?: NewRankedSessionRecord;
	expectedWalletBalance?: number;
	finalAdditionalWager?: number;
	committedWager?: number;
	payout?: number;
	rewardDelta?: 0 | 100;
	settledAt?: number;
	actionLogHash?: string;
	outcome?: {
		result: 'win' | 'loss' | 'push';
		hands: readonly {
			handIndex: number;
			result: 'win' | 'loss' | 'push' | 'blackjack';
			wager: number;
			payout: number;
		}[];
		committedWager: number;
		payout: number;
		gameNetDelta: number;
	};
	statsEffects?: {
		sessionsPlayed: 1;
		totalWins: 0 | 1;
		totalLosses: 0 | 1;
		totalPushes: 0 | 1;
		totalForfeits: 0 | 1;
		netProfit: number;
		biggestWin: number;
	};
	achievementEffects?: readonly 'ranked_debut'[];
	rewardEffects?: readonly { rewardId: 'ranked_debut_100'; chipAmount: 100 }[];
} = {}): TerminalTransitionInput {
	const gameNetDelta = outcome.gameNetDelta;
	const balanceAfter = expectedWalletBalance - finalAdditionalWager + payout + rewardDelta;
	const outcomeJson = canonicalizeRanked(outcome);
	const statsEffectsJson = canonicalizeRanked(statsEffects);
	const achievementEffectsJson = canonicalizeRanked(achievementEffects);
	const rewardEffectsJson = canonicalizeRanked(rewardEffects);
	return {
		expectedWalletBalance,
		finalAdditionalWager,
		payout,
		gameNetDelta,
		rewardDelta,
		balanceAfter,
		outcomeJson,
		statsEffectsJson,
		achievementEffectsJson,
		rewardEffectsJson,
		receiptHash: receiptHashFor({
			session,
			actionLogHash,
			committedWager,
			outcome,
			payout,
			gameNetDelta,
			rewardDelta,
			balanceAfter,
			statsEffects,
			achievementEffects,
			rewardEffects,
			settledAt,
		}),
		settledAt,
	};
}

function actionInput({
	sessionId = SESSION_A,
	expectedSequence = 0,
	action = 'double-down',
	additionalWager = 100,
	committedWager = 200,
	terminal,
	nonRewardTerminal,
	nowSeconds = NOW_SECONDS + 1,
}: {
	sessionId?: string;
	expectedSequence?: number;
	action?: 'hit' | 'stand' | 'double-down' | 'split';
	additionalWager?: number;
	committedWager?: number;
	terminal?: TerminalTransitionInput;
	nonRewardTerminal?: TerminalTransitionInput;
	nowSeconds?: number;
} = {}): ActionTransitionInput {
	const actionLog = [{ sequence: expectedSequence, action }];
	return {
		userId: USER_ID,
		sessionId,
		expectedSequence,
		actionLogJson: canonicalizeRanked(actionLog),
		actionLogHash: hashCanonical(actionLog),
		additionalWager,
		committedWager,
		nowSeconds,
		terminal,
		nonRewardTerminal,
	};
}

function expirationInput({
	session = newSession(),
	expectedWalletBalance = 900,
	nowSeconds = NOW_SECONDS + 901,
}: {
	session?: NewRankedSessionRecord;
	expectedWalletBalance?: number;
	nowSeconds?: number;
} = {}): ExpirationTransitionInput {
	const outcome = {
		result: 'loss' as const,
		hands: [
			{
				handIndex: 0,
				result: 'loss' as const,
				wager: session.committedWager,
				payout: 0,
			},
		],
		committedWager: session.committedWager,
		payout: 0,
		gameNetDelta: -session.committedWager,
	};
	const statsEffects = {
		sessionsPlayed: 1 as const,
		totalWins: 0 as const,
		totalLosses: 1 as const,
		totalPushes: 0 as const,
		totalForfeits: 1 as const,
		netProfit: -session.committedWager,
		biggestWin: 0,
	};
	return {
		userId: USER_ID,
		sessionId: session.id,
		nowSeconds,
		terminal: terminalInput({
			session,
			expectedWalletBalance,
			finalAdditionalWager: 0,
			committedWager: session.committedWager,
			payout: 0,
			rewardDelta: 0,
			settledAt: nowSeconds,
			actionLogHash: session.actionLogHash,
			outcome,
			statsEffects,
		}),
	};
}

async function readSessionState(sessionId = SESSION_A): Promise<{
	status: string;
	activeUserId: string | null;
	nextSequence: number;
	committedWager: number;
	actionLogJson: string;
}> {
	const row = await db
		.prepare(
			'SELECT status, activeUserId, nextSequence, committedWager, actionLogJson FROM ranked_session WHERE id = ?',
		)
		.bind(sessionId)
		.first<{
			status: string;
			activeUserId: string | null;
			nextSequence: number;
			committedWager: number;
			actionLogJson: string;
		}>();
	if (!row) throw new Error('missing test ranked session');
	return row;
}

async function rowCount(
	table: 'ranked_result' | 'ranked_game_stats' | 'ranked_reward_grant' | 'user_achievement',
): Promise<number> {
	const row = await db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<{ count: number }>();
	return row?.count ?? 0;
}

async function readRankedStats(): Promise<{
	sessionsPlayed: number;
	totalWins: number;
	totalLosses: number;
	totalPushes: number;
	totalForfeits: number;
	netProfit: number;
	biggestWin: number;
} | null> {
	return db
		.prepare(
			'SELECT sessionsPlayed, totalWins, totalLosses, totalPushes, totalForfeits, netProfit, biggestWin FROM ranked_game_stats WHERE userId = ? AND gameType = ?',
		)
		.bind(USER_ID, 'blackjack')
		.first();
}

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

describe('ranked action transaction', () => {
	test('parallel funded actions produce one sequence winner and one wallet effect', async () => {
		const repository = createRankedRepository(db);
		expect(await repository.runStartTransition(startInput())).toEqual({ kind: 'created' });
		const input = actionInput();

		const [left, right] = await Promise.all([
			repository.runActionTransition(input),
			repository.runActionTransition(input),
		]);

		expect([left.kind, right.kind].filter((kind) => kind === 'applied')).toHaveLength(1);
		expect(await readBalance()).toEqual({ chipBalance: 800, heldChips: 0 });
		expect(await readSessionState()).toEqual({
			status: 'active',
			activeUserId: USER_ID,
			nextSequence: 1,
			committedWager: 200,
			actionLogJson: canonicalizeRanked([{ sequence: 0, action: 'double-down' }]),
		});
		expect(await readRateCount('ranked_action')).toBe(2);
	});

	test('a denied action rate gates every account and session mutation', async () => {
		const repository = createRankedRepository(db);
		expect(await repository.runStartTransition(startInput())).toEqual({ kind: 'created' });
		await consumeBatch('ranked_action', RANKED_RATE_LIMITS.ranked_action.limit, NOW_SECONDS + 1);

		const result = await repository.runActionTransition(actionInput());

		expect(result).toEqual({ kind: 'rate-limited', retryAfter: 59 });
		expect(await readBalance()).toEqual({ chipBalance: 900, heldChips: 0 });
		expect((await readSessionState()).nextSequence).toBe(0);
		const rateRow = await db
			.prepare(
				'SELECT count FROM ranked_rate_limit WHERE userId = ? AND operation = ? AND windowStart = ?',
			)
			.bind(USER_ID, 'ranked_action', NOW_SECONDS)
			.first<{ count: number }>();
		expect(rateRow?.count).toBe(30);
	});

	test('escrow introduced after action preflight blocks wallet and sequence changes', async () => {
		const repository = createRankedRepository(db);
		expect(await repository.runStartTransition(startInput())).toEqual({ kind: 'created' });
		await repository.readAccount(USER_ID);
		await db.prepare('UPDATE user SET heldChips = ? WHERE id = ?').bind(250, USER_ID).run();

		const result = await repository.runActionTransition(actionInput());

		expect(result).toEqual({ kind: 'balance-changed' });
		expect(await readBalance()).toEqual({ chipBalance: 900, heldChips: 250 });
		expect((await readSessionState()).nextSequence).toBe(0);
	});

	test('insufficient additional wager leaves balance and sequence unchanged', async () => {
		const repository = createRankedRepository(db);
		expect(await repository.runStartTransition(startInput())).toEqual({ kind: 'created' });
		await db.prepare('UPDATE user SET chipBalance = ? WHERE id = ?').bind(50, USER_ID).run();

		const result = await repository.runActionTransition(actionInput());

		expect(result).toEqual({ kind: 'balance-changed' });
		expect(await readBalance()).toEqual({ chipBalance: 50, heldChips: 0 });
		expect((await readSessionState()).nextSequence).toBe(0);
	});

	test('mismatched concurrent actions produce one stored log and one wallet effect', async () => {
		const repository = createRankedRepository(db);
		expect(await repository.runStartTransition(startInput())).toEqual({ kind: 'created' });
		const leftInput = actionInput({ action: 'double-down' });
		const rightInput = actionInput({ action: 'split' });

		const [left, right] = await Promise.all([
			repository.runActionTransition(leftInput),
			repository.runActionTransition(rightInput),
		]);

		expect([left.kind, right.kind].sort()).toEqual(['applied', 'not-applied']);
		expect(await readBalance()).toEqual({ chipBalance: 800, heldChips: 0 });
		const session = await readSessionState();
		expect(session.nextSequence).toBe(1);
		expect([
			canonicalizeRanked([{ sequence: 0, action: 'double-down' }]),
			canonicalizeRanked([{ sequence: 0, action: 'split' }]),
		]).toContain(session.actionLogJson);
	});

	test('a committed-wager CAS mismatch cannot debit the wallet before the session update', async () => {
		const repository = createRankedRepository(db);
		expect(await repository.runStartTransition(startInput())).toEqual({ kind: 'created' });

		const result = await repository.runActionTransition(
			actionInput({ additionalWager: 100, committedWager: 999 }),
		);

		expect(result).toEqual({ kind: 'not-applied' });
		expect(await readBalance()).toEqual({ chipBalance: 900, heldChips: 0 });
		expect(await readSessionState()).toMatchObject({
			nextSequence: 0,
			committedWager: 100,
		});
	});

	test('a mismatched prior action-log prefix cannot debit or rewrite the stored history', async () => {
		const repository = createRankedRepository(db);
		expect(await repository.runStartTransition(startInput())).toEqual({ kind: 'created' });
		expect(
			await repository.runActionTransition(
				actionInput({
					action: 'hit',
					additionalWager: 0,
					committedWager: 100,
				}),
			),
		).toEqual({ kind: 'applied', result: null });
		const mismatchedLog = [
			{ sequence: 0, action: 'stand' },
			{ sequence: 1, action: 'double-down' },
		] as const;

		const result = await repository.runActionTransition({
			...actionInput({
				expectedSequence: 1,
				action: 'double-down',
				additionalWager: 100,
				committedWager: 200,
			}),
			actionLogJson: canonicalizeRanked(mismatchedLog),
			actionLogHash: hashCanonical(mismatchedLog),
		});

		expect(result).toEqual({ kind: 'not-applied' });
		expect(await readBalance()).toEqual({ chipBalance: 900, heldChips: 0 });
		expect(await readSessionState()).toMatchObject({
			nextSequence: 1,
			actionLogJson: canonicalizeRanked([{ sequence: 0, action: 'hit' }]),
		});
	});
});

describe('ranked terminal account snapshot', () => {
	test('a matched terminal no-op reports one change and a stale exact balance reports zero', async () => {
		const repository = createRankedRepository(db);
		expect(await repository.runStartTransition(startInput())).toEqual({ kind: 'created' });
		const firstRate: RankedRateLimitInput = {
			userId: USER_ID,
			operation: 'ranked_action',
			nowSeconds: NOW_SECONDS + 1,
		};
		const [, matched] = await db.batch([
			buildRateLimitStatement(db, firstRate),
			db
				.prepare(RANKED_TERMINAL_ACCOUNT_SNAPSHOT_SQL)
				.bind(USER_ID, 900, SESSION_A, USER_ID, USER_ID, 0),
		]);
		expect(matched.meta.changes).toBe(1);

		await db.prepare('UPDATE user SET chipBalance = ? WHERE id = ?').bind(925, USER_ID).run();
		const [, stale] = await db.batch([
			buildRateLimitStatement(db, { ...firstRate, nowSeconds: NOW_SECONDS + 61 }),
			db
				.prepare(RANKED_TERMINAL_ACCOUNT_SNAPSHOT_SQL)
				.bind(USER_ID, 900, SESSION_A, USER_ID, USER_ID, 0),
		]);
		expect(stale.meta.changes).toBe(0);
		expect(await readBalance()).toEqual({ chipBalance: 925, heldChips: 0 });
	});
});

describe('ranked terminal transaction', () => {
	test('a stale terminal balance snapshot commits only rate and no terminal effects', async () => {
		const repository = createRankedRepository(db);
		expect(await repository.runStartTransition(startInput())).toEqual({ kind: 'created' });
		const actionLog = [{ sequence: 0, action: 'stand' }] as const;
		const logHash = hashCanonical(actionLog);
		const terminal = terminalInput({ actionLogHash: logHash });
		await db.prepare('UPDATE user SET chipBalance = ? WHERE id = ?').bind(950, USER_ID).run();

		const result = await repository.runTerminalTransition(
			actionInput({
				action: 'stand',
				additionalWager: 0,
				committedWager: 100,
				terminal,
			}),
		);

		expect(result).toEqual({ kind: 'balance-changed' });
		expect(await readBalance()).toEqual({ chipBalance: 950, heldChips: 0 });
		expect(await readSessionState()).toMatchObject({ status: 'active', nextSequence: 0 });
		expect(await rowCount('ranked_result')).toBe(0);
		expect(await rowCount('ranked_game_stats')).toBe(0);
		expect(await rowCount('ranked_reward_grant')).toBe(0);
		expect(await rowCount('user_achievement')).toBe(0);
	});

	test('fresh terminal retry stores the actual account balance and a self-verifying receipt', async () => {
		const repository = createRankedRepository(db);
		expect(await repository.runStartTransition(startInput())).toEqual({ kind: 'created' });
		await db.prepare('UPDATE user SET chipBalance = ? WHERE id = ?').bind(950, USER_ID).run();
		const actionLog = [{ sequence: 0, action: 'stand' }] as const;
		const actionLogHash = hashCanonical(actionLog);
		const terminal = terminalInput({
			expectedWalletBalance: 950,
			actionLogHash,
		});

		const transition = await repository.runTerminalTransition(
			actionInput({
				action: 'stand',
				additionalWager: 0,
				committedWager: 100,
				terminal,
			}),
		);

		expect(transition.kind).toBe('applied');
		expect(await readBalance()).toEqual({ chipBalance: 1250, heldChips: 0 });
		const stored = await repository.findResult(SESSION_A);
		expect(stored?.balanceAfter).toBe(1250);
		expect(stored?.receiptHash).toBe(
			hashCanonical({
				sessionId: stored?.sessionId,
				gameType: stored?.gameType,
				rulesetVersion: stored?.rulesetVersion,
				seedCommitment: stored?.seedCommitment,
				configHash: stored?.configHash,
				actionLogHash: stored?.actionLogHash,
				outcome: stored?.outcome,
				initialWager: stored?.initialWager,
				committedWager: stored?.committedWager,
				payout: stored?.payout,
				gameNetDelta: stored?.gameNetDelta,
				rewardDelta: stored?.rewardDelta,
				balanceAfter: stored?.balanceAfter,
				statsEffects: stored?.statsEffects,
				achievementEffects: stored?.achievementEffects,
				rewardEffects: stored?.rewardEffects,
				settledAt: stored?.settledAt,
			} as never),
		);
	});

	test('an exact terminal retry returns the immutable stored result and applies stats and reward once', async () => {
		const repository = createRankedRepository(db);
		expect(await repository.runStartTransition(startInput())).toEqual({ kind: 'created' });
		const actionLogHash = hashCanonical([{ sequence: 0, action: 'stand' }]);
		const input = actionInput({
			action: 'stand',
			additionalWager: 0,
			committedWager: 100,
			terminal: terminalInput({ actionLogHash }),
		});

		const first = await repository.runTerminalTransition(input);
		const second = await repository.runTerminalTransition(input);

		expect(first.kind).toBe('applied');
		expect(second).toEqual(first);
		expect(await readBalance()).toEqual({ chipBalance: 1200, heldChips: 0 });
		expect(await rowCount('ranked_result')).toBe(1);
		expect(await rowCount('ranked_reward_grant')).toBe(1);
		expect(await rowCount('user_achievement')).toBe(1);
		expect(await readRankedStats()).toEqual({
			sessionsPlayed: 1,
			totalWins: 1,
			totalLosses: 0,
			totalPushes: 0,
			totalForfeits: 0,
			netProfit: 100,
			biggestWin: 100,
		});
	});

	test('an exact funded terminal retry returns the stored result without a second wager', async () => {
		const repository = createRankedRepository(db);
		expect(await repository.runStartTransition(startInput())).toEqual({ kind: 'created' });
		const actionLogHash = hashCanonical([{ sequence: 0, action: 'double-down' }]);
		const input = actionInput({
			action: 'double-down',
			additionalWager: 100,
			committedWager: 200,
			terminal: terminalInput({
				actionLogHash,
				finalAdditionalWager: 100,
				committedWager: 200,
				payout: 400,
			}),
		});

		const first = await repository.runTerminalTransition(input);
		const second = await repository.runTerminalTransition(input);

		expect(first.kind).toBe('applied');
		expect(second).toEqual(first);
		expect(await readBalance()).toEqual({ chipBalance: 1300, heldChips: 0 });
		expect(await readRankedStats()).toMatchObject({
			sessionsPlayed: 1,
			netProfit: 200,
			biggestWin: 200,
		});
	});

	test('a consistent unique reward conflict rolls back then retries the non-reward branch', async () => {
		const repository = createRankedRepository(db);
		expect(await repository.runStartTransition(startInput())).toEqual({ kind: 'created' });
		const firstLogHash = hashCanonical([{ sequence: 0, action: 'stand' }]);
		expect(
			(
				await repository.runTerminalTransition(
					actionInput({
						action: 'stand',
						additionalWager: 0,
						committedWager: 100,
						terminal: terminalInput({ actionLogHash: firstLogHash }),
					}),
				)
			).kind,
		).toBe('applied');
		const secondSession = newSession({
			id: SESSION_B,
			requestId: 'request-00000002',
			startPayloadHash: sha256Hex('start-payload-b'),
		});
		expect(
			await repository.runStartTransition(startInput(secondSession, 1200, NOW_SECONDS + 60)),
		).toEqual({ kind: 'created' });
		const secondLogHash = hashCanonical([{ sequence: 0, action: 'stand' }]);
		const nonRewardTerminal = terminalInput({
			session: secondSession,
			expectedWalletBalance: 1100,
			actionLogHash: secondLogHash,
			rewardDelta: 0,
		});

		const result = await repository.runTerminalTransition(
			actionInput({
				sessionId: SESSION_B,
				action: 'stand',
				additionalWager: 0,
				committedWager: 100,
				nowSeconds: NOW_SECONDS + 61,
				terminal: terminalInput({
					session: secondSession,
					expectedWalletBalance: 1100,
					actionLogHash: secondLogHash,
				}),
				nonRewardTerminal,
			}),
		);

		expect(result.kind).toBe('applied');
		expect(result.kind === 'applied' ? result.result.rewardDelta : null).toBe(0);
		expect(result.kind === 'applied' ? result.result.receiptHash : null).toBe(
			nonRewardTerminal.receiptHash,
		);
		expect(await readBalance()).toEqual({ chipBalance: 1300, heldChips: 0 });
		expect(await rowCount('ranked_result')).toBe(2);
		expect(await rowCount('ranked_reward_grant')).toBe(1);
		expect(await readRankedStats()).toEqual({
			sessionsPlayed: 2,
			totalWins: 2,
			totalLosses: 0,
			totalPushes: 0,
			totalForfeits: 0,
			netProfit: 200,
			biggestWin: 100,
		});
	});

	test('reward chips are excluded from ranked net profit and biggest win', async () => {
		const repository = createRankedRepository(db);
		expect(await repository.runStartTransition(startInput())).toEqual({ kind: 'created' });
		const actionLogHash = hashCanonical([{ sequence: 0, action: 'stand' }]);

		await repository.runTerminalTransition(
			actionInput({
				action: 'stand',
				additionalWager: 0,
				committedWager: 100,
				terminal: terminalInput({ actionLogHash }),
			}),
		);

		expect(await readRankedStats()).toMatchObject({ netProfit: 100, biggestWin: 100 });
		expect(await readBalance()).toEqual({ chipBalance: 1200, heldChips: 0 });
	});

	test('a result persistence failure rolls back wallet, session, reward, and stats', async () => {
		const repository = createRankedRepository(db);
		expect(await repository.runStartTransition(startInput())).toEqual({ kind: 'created' });
		await db
			.prepare(
				`CREATE TRIGGER fail_ranked_result
				BEFORE INSERT ON ranked_result
				BEGIN SELECT RAISE(ABORT, 'forced ranked result failure'); END`,
			)
			.run();
		const actionLogHash = hashCanonical([{ sequence: 0, action: 'stand' }]);

		await expect(
			repository.runTerminalTransition(
				actionInput({
					action: 'stand',
					additionalWager: 0,
					committedWager: 100,
					terminal: terminalInput({ actionLogHash }),
				}),
			),
		).rejects.toThrow('forced ranked result failure');
		await db.prepare('DROP TRIGGER fail_ranked_result').run();

		expect(await readBalance()).toEqual({ chipBalance: 900, heldChips: 0 });
		expect(await readSessionState()).toMatchObject({ status: 'active', nextSequence: 0 });
		expect(await rowCount('ranked_result')).toBe(0);
		expect(await rowCount('ranked_game_stats')).toBe(0);
		expect(await rowCount('ranked_reward_grant')).toBe(0);
		expect(await rowCount('user_achievement')).toBe(0);
	});

	test('a terminal committed-wager mismatch cannot reserve reward or mutate the wallet', async () => {
		const repository = createRankedRepository(db);
		expect(await repository.runStartTransition(startInput())).toEqual({ kind: 'created' });
		const actionLogHash = hashCanonical([{ sequence: 0, action: 'stand' }]);
		const terminal = terminalInput({
			actionLogHash,
			committedWager: 999,
			payout: 1099,
		});

		await expect(
			repository.runTerminalTransition(
				actionInput({
					action: 'stand',
					additionalWager: 0,
					committedWager: 999,
					terminal,
				}),
			),
		).rejects.toBeInstanceOf(RankedRepositoryInvariantError);
		expect(await readBalance()).toEqual({ chipBalance: 900, heldChips: 0 });
		expect(await readSessionState()).toMatchObject({
			status: 'active',
			nextSequence: 0,
			committedWager: 100,
		});
		expect(await rowCount('ranked_reward_grant')).toBe(0);
		expect(await rowCount('ranked_result')).toBe(0);
	});
});

describe('opening natural and expiration transactions', () => {
	test('an opening natural settles session, wager, receipt, stats, and reward in one start batch', async () => {
		const repository = createRankedRepository(db);
		const session = newSession();
		const terminal = terminalInput({
			session,
			expectedWalletBalance: 900,
			payout: 250,
			outcome: {
				result: 'win',
				hands: [{ handIndex: 0, result: 'blackjack', wager: 100, payout: 250 }],
				committedWager: 100,
				payout: 250,
				gameNetDelta: 150,
			},
			statsEffects: {
				sessionsPlayed: 1,
				totalWins: 1,
				totalLosses: 0,
				totalPushes: 0,
				totalForfeits: 0,
				netProfit: 150,
				biggestWin: 150,
			},
		});

		const result = await repository.runStartTransition({
			...startInput(session),
			openingTerminal: terminal,
		});

		expect(result.kind).toBe('created');
		expect(result.kind === 'created' ? result.result?.receiptHash : null).toBe(
			terminal.receiptHash,
		);
		expect(await readBalance()).toEqual({ chipBalance: 1250, heldChips: 0 });
		expect(await readSessionState()).toMatchObject({
			status: 'settled',
			activeUserId: null,
			nextSequence: 0,
		});
		expect(await rowCount('ranked_result')).toBe(1);
		expect(await rowCount('ranked_reward_grant')).toBe(1);
		expect(await readRankedStats()).toMatchObject({
			sessionsPlayed: 1,
			netProfit: 150,
			biggestWin: 150,
		});
	});

	test('a stale opening-natural start snapshot leaves no session, result, stats, or reward', async () => {
		const repository = createRankedRepository(db);
		const session = newSession();
		await db.prepare('UPDATE user SET chipBalance = ? WHERE id = ?').bind(1050, USER_ID).run();

		const result = await repository.runStartTransition({
			...startInput(session, 1000),
			openingTerminal: terminalInput({
				session,
				expectedWalletBalance: 900,
				payout: 250,
				outcome: {
					result: 'win',
					hands: [{ handIndex: 0, result: 'blackjack', wager: 100, payout: 250 }],
					committedWager: 100,
					payout: 250,
					gameNetDelta: 150,
				},
				statsEffects: {
					sessionsPlayed: 1,
					totalWins: 1,
					totalLosses: 0,
					totalPushes: 0,
					totalForfeits: 0,
					netProfit: 150,
					biggestWin: 150,
				},
			}),
		});

		expect(result).toEqual({ kind: 'balance-changed' });
		expect(await readBalance()).toEqual({ chipBalance: 1050, heldChips: 0 });
		expect(await countSessions()).toBe(0);
		expect(await rowCount('ranked_result')).toBe(0);
		expect(await rowCount('ranked_game_stats')).toBe(0);
		expect(await rowCount('ranked_reward_grant')).toBe(0);
	});

	test('expiration applies a forfeit receipt and ranked loss exactly once without reward', async () => {
		const repository = createRankedRepository(db);
		expect(await repository.runStartTransition(startInput())).toEqual({ kind: 'created' });
		const input = expirationInput();

		const first = await repository.runExpirationTransition(input);
		const second = await repository.runExpirationTransition(input);

		expect(first.kind).toBe('applied');
		expect(second).toEqual(first);
		expect(await readBalance()).toEqual({ chipBalance: 900, heldChips: 0 });
		expect(await readSessionState()).toMatchObject({
			status: 'expired',
			activeUserId: null,
			nextSequence: 0,
		});
		expect(await rowCount('ranked_result')).toBe(1);
		expect(await rowCount('ranked_reward_grant')).toBe(0);
		expect(await rowCount('user_achievement')).toBe(0);
		expect(await readRankedStats()).toEqual({
			sessionsPlayed: 1,
			totalWins: 0,
			totalLosses: 1,
			totalPushes: 0,
			totalForfeits: 1,
			netProfit: -100,
			biggestWin: 0,
		});
	});

	test('a stale expiration snapshot leaves the session active until rebuilt from the fresh balance', async () => {
		const repository = createRankedRepository(db);
		expect(await repository.runStartTransition(startInput())).toEqual({ kind: 'created' });
		await db.prepare('UPDATE user SET chipBalance = ? WHERE id = ?').bind(875, USER_ID).run();

		const stale = await repository.runExpirationTransition(expirationInput());

		expect(stale).toEqual({ kind: 'balance-changed' });
		expect(await readSessionState()).toMatchObject({ status: 'active', activeUserId: USER_ID });
		expect(await rowCount('ranked_result')).toBe(0);
		expect(await rowCount('ranked_game_stats')).toBe(0);
		const fresh = await repository.runExpirationTransition(
			expirationInput({ expectedWalletBalance: 875 }),
		);
		expect(fresh.kind).toBe('applied');
		expect(fresh.kind === 'applied' ? fresh.result.balanceAfter : null).toBe(875);
		expect(await readBalance()).toEqual({ chipBalance: 875, heldChips: 0 });
	});

	test('lists only the oldest one hundred active expired sessions in stable order', async () => {
		await db.prepare('DELETE FROM user').run();
		const statements: D1PreparedStatement[] = [];
		for (let index = 0; index < 102; index += 1) {
			const userId = `expiry-user-${String(index).padStart(3, '0')}`;
			const session = newSession({
				id: String(index).padStart(22, '0'),
				requestId: `expiry-request-${String(index).padStart(3, '0')}`,
			});
			await insertRankedTestUser(db, { id: userId, chipBalance: 1000 });
			statements.push(
				db
					.prepare(
						`INSERT INTO ranked_session (
							id, userId, startRequestId, startPayloadHash, activeUserId,
							gameType, rulesetVersion, configJson, configHash, seed, seedCommitment,
							actionLogJson, actionLogHash, nextSequence, initialWager, committedWager,
							status, expiresAt, createdAt, updatedAt
						) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 'active', ?, ?, ?)`,
					)
					.bind(
						session.id,
						userId,
						session.startRequestId,
						session.startPayloadHash,
						userId,
						session.gameType,
						session.rulesetVersion,
						session.configJson,
						session.configHash,
						session.seed,
						session.seedCommitment,
						session.actionLogJson,
						session.actionLogHash,
						session.initialWager,
						session.committedWager,
						NOW_SECONDS - index,
						session.createdAt,
						session.updatedAt,
					),
			);
		}
		await db.batch(statements);

		const ids = await createRankedRepository(db).listExpiredSessions(NOW_SECONDS);

		expect(ids).toHaveLength(100);
		expect(ids[0]).toBe(String(101).padStart(22, '0'));
		expect(ids.at(-1)).toBe(String(2).padStart(22, '0'));
	});

	test('deletes only expired ranked rate buckets', async () => {
		await db.batch([
			db
				.prepare(
					'INSERT INTO ranked_rate_limit (userId, operation, windowStart, count, expiresAt) VALUES (?, ?, ?, ?, ?)',
				)
				.bind(USER_ID, 'ranked_action', NOW_SECONDS - 60, 1, NOW_SECONDS),
			db
				.prepare(
					'INSERT INTO ranked_rate_limit (userId, operation, windowStart, count, expiresAt) VALUES (?, ?, ?, ?, ?)',
				)
				.bind(USER_ID, 'ranked_action', NOW_SECONDS, 1, NOW_SECONDS + 60),
		]);

		expect(await createRankedRepository(db).deleteExpiredRateBuckets(NOW_SECONDS)).toBe(1);
		const remaining = await db
			.prepare('SELECT expiresAt FROM ranked_rate_limit ORDER BY expiresAt')
			.all<{ expiresAt: number }>();
		expect(remaining.results).toEqual([{ expiresAt: NOW_SECONDS + 60 }]);
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

	test('rejects a canonical stored result whose receipt hash no longer matches its fields', async () => {
		const repository = createRankedRepository(db);
		expect(await repository.runStartTransition(startInput())).toEqual({ kind: 'created' });
		await insertResult();
		await db
			.prepare('UPDATE ranked_result SET balanceAfter = ? WHERE sessionId = ?')
			.bind(1101, SESSION_A)
			.run();

		await expect(repository.findResult(SESSION_A)).rejects.toBeInstanceOf(
			RankedRepositoryInvariantError,
		);
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
