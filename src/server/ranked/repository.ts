import { z } from 'zod';
import type { RankedJson } from '../../lib/ranked/canonical';
import { canonicalizeRanked, sha256Hex } from '../../lib/ranked/canonical';
import type {
	RankedAchievementEffectsV1,
	RankedBlackjackActionLogV1,
	RankedRewardEffectsV1,
	RankedSessionStatus,
	RankedStatsEffectsV1,
} from '../../lib/ranked/protocol';
import {
	actionLogSchema,
	rankedAchievementEffectsV1Schema,
	rankedRewardEffectsV1Schema,
	rankedStatsEffectsV1Schema,
	safeIntegerSchema,
} from '../../lib/ranked/protocol';
import type {
	RankedBlackjackConfigV1,
	RankedBlackjackOutcomeV1,
} from '../../lib/ranked/blackjack/types';
import {
	buildRateLimitStatement,
	consumeStandaloneRateLimit,
	getRetryAfterSeconds,
	type RankedRateLimitInput,
	type RankedRateLimitResult,
	type RankedRateOperation,
} from './rate-limit';

export type { RankedRateLimitInput } from './rate-limit';

const blackjackRankedV1ConfigSchema = z
	.object({
		gameType: z.literal('blackjack'),
		rulesetVersion: z.literal('blackjack-ranked-v1'),
		deckCount: z.literal(1),
		minimumWager: z.literal(10),
		maximumWager: z.literal(1000),
		maximumHands: z.literal(4),
		dealerHitsSoft17: z.literal(false),
		blackjackProfitNumerator: z.literal(3),
		blackjackProfitDenominator: z.literal(2),
		normalWinProfitNumerator: z.literal(1),
		normalWinProfitDenominator: z.literal(1),
		initialWager: safeIntegerSchema.min(10).max(1000),
	})
	.strict();

const blackjackHandOutcomeV1Schema = z
	.object({
		handIndex: safeIntegerSchema.min(0),
		result: z.enum(['win', 'loss', 'push', 'blackjack']),
		wager: safeIntegerSchema.min(0),
		payout: safeIntegerSchema.min(0),
	})
	.strict();

const blackjackOutcomeV1Schema = z
	.object({
		result: z.enum(['win', 'loss', 'push']),
		hands: z.array(blackjackHandOutcomeV1Schema),
		committedWager: safeIntegerSchema.min(0),
		payout: safeIntegerSchema.min(0),
		gameNetDelta: safeIntegerSchema,
	})
	.strict();

export class RankedRepositoryInvariantError extends Error {
	constructor(message = 'Ranked repository invariant failed') {
		super(message);
		this.name = 'RankedRepositoryInvariantError';
	}
}

export interface NewRankedSessionRecord {
	id: string;
	startRequestId: string;
	startPayloadHash: string;
	gameType: 'blackjack';
	rulesetVersion: 'blackjack-ranked-v1';
	configJson: string;
	configHash: string;
	seed: string;
	seedCommitment: string;
	actionLogJson: string;
	actionLogHash: string;
	initialWager: number;
	committedWager: number;
	expiresAt: number;
	createdAt: number;
	updatedAt: number;
}

export interface RankedSessionRecord extends NewRankedSessionRecord {
	userId: string;
	activeUserId: string | null;
	nextSequence: number;
	status: RankedSessionStatus;
	settledAt: number | null;
	config: RankedBlackjackConfigV1;
	actionLog: RankedBlackjackActionLogV1;
}

export interface RankedResultRecord {
	sessionId: string;
	userId: string;
	gameType: 'blackjack';
	rulesetVersion: 'blackjack-ranked-v1';
	seedCommitment: string;
	configHash: string;
	actionLogHash: string;
	outcomeJson: string;
	initialWager: number;
	committedWager: number;
	payout: number;
	gameNetDelta: number;
	rewardDelta: number;
	balanceAfter: number;
	statsEffectsJson: string;
	achievementEffectsJson: string;
	rewardEffectsJson: string;
	receiptHash: string;
	settledAt: number;
	outcome: RankedBlackjackOutcomeV1;
	statsEffects: RankedStatsEffectsV1;
	achievementEffects: RankedAchievementEffectsV1;
	rewardEffects: RankedRewardEffectsV1;
}

export interface StartTransitionInput {
	userId: string;
	expectedBalance: number;
	session: NewRankedSessionRecord;
	rateLimit: RankedRateLimitInput;
}

export type StartTransitionResult =
	| { kind: 'created' }
	| { kind: 'not-created' }
	| { kind: 'balance-changed' }
	| { kind: 'rate-limited'; retryAfter: number };

export interface RankedRepository {
	findByStartRequest(userId: string, requestId: string): Promise<RankedSessionRecord | null>;
	findOwnedSession(userId: string, sessionId: string): Promise<RankedSessionRecord | null>;
	findResult(sessionId: string): Promise<RankedResultRecord | null>;
	readAccount(userId: string): Promise<{ chipBalance: number; heldChips: number } | null>;
	consumeStandaloneRateLimit(
		userId: string,
		operation: RankedRateOperation,
		nowSeconds: number,
	): Promise<RankedRateLimitResult>;
	runStartTransition(input: StartTransitionInput): Promise<StartTransitionResult>;
}

type RankedSessionRow = Omit<RankedSessionRecord, 'config' | 'actionLog'>;

type RankedResultRow = Omit<
	RankedResultRecord,
	'outcome' | 'statsEffects' | 'achievementEffects' | 'rewardEffects'
>;

export const RANKED_START_ACCOUNT_SNAPSHOT_SQL = `UPDATE user
SET chipBalance = chipBalance
WHERE id = ?
	AND chipBalance = ?
	AND chipBalance >= ?
	AND heldChips = 0
	AND changes() = 1
	AND NOT EXISTS (SELECT 1 FROM mp_membership WHERE userId = ?)
	AND NOT EXISTS (SELECT 1 FROM ranked_session WHERE activeUserId = ?)`;

export const RANKED_START_SESSION_INSERT_SQL = `INSERT INTO ranked_session (
	id, userId, startRequestId, startPayloadHash, activeUserId,
	gameType, rulesetVersion, configJson, configHash, seed, seedCommitment,
	actionLogJson, actionLogHash, nextSequence, initialWager, committedWager,
	status, expiresAt, createdAt, updatedAt
)
SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 'active', ?, ?, ?
WHERE changes() = 1
	AND EXISTS (
		SELECT 1 FROM user
		WHERE id = ? AND chipBalance = ? AND chipBalance >= ? AND heldChips = 0
	)
	AND NOT EXISTS (SELECT 1 FROM mp_membership WHERE userId = ?)
	AND NOT EXISTS (SELECT 1 FROM ranked_session WHERE activeUserId = ?)
ON CONFLICT DO NOTHING`;

export const RANKED_START_WAGER_DEDUCTION_SQL = `UPDATE user
SET chipBalance = chipBalance - ?, updatedAt = ?
WHERE id = ?
	AND chipBalance = ?
	AND heldChips = 0
	AND changes() = 1
	AND EXISTS (
		SELECT 1 FROM ranked_session
		WHERE id = ? AND userId = ? AND activeUserId = ? AND status = 'active'
	)`;

function invariant(message: string): never {
	throw new RankedRepositoryInvariantError(message);
}

function parseCanonicalJson(raw: string, label: string): RankedJson {
	try {
		const parsed = JSON.parse(raw) as RankedJson;
		if (canonicalizeRanked(parsed) !== raw) invariant(`Corrupt ranked ${label}`);
		return parsed;
	} catch (error) {
		if (error instanceof RankedRepositoryInvariantError) throw error;
		return invariant(`Corrupt ranked ${label}`);
	}
}

function parseSessionRow(row: RankedSessionRow): RankedSessionRecord {
	if (row.gameType !== 'blackjack' || row.rulesetVersion !== 'blackjack-ranked-v1') {
		return invariant('Unsupported persisted ranked session version');
	}
	if (!['active', 'settled', 'expired'].includes(row.status)) {
		return invariant('Corrupt ranked session status');
	}
	try {
		const configJson = parseCanonicalJson(row.configJson, 'session config JSON');
		const actionLogJson = parseCanonicalJson(row.actionLogJson, 'session action-log JSON');
		const config = blackjackRankedV1ConfigSchema.parse(configJson);
		const actionLog = actionLogSchema.parse(actionLogJson);
		if (sha256Hex(row.configJson) !== row.configHash) {
			return invariant('Corrupt ranked session config hash');
		}
		if (sha256Hex(row.actionLogJson) !== row.actionLogHash) {
			return invariant('Corrupt ranked session action-log hash');
		}
		return {
			...row,
			status: row.status as RankedSessionStatus,
			config,
			actionLog,
		};
	} catch (error) {
		if (error instanceof RankedRepositoryInvariantError) throw error;
		return invariant('Corrupt ranked session JSON');
	}
}

function parseResultRow(row: RankedResultRow): RankedResultRecord {
	if (row.gameType !== 'blackjack' || row.rulesetVersion !== 'blackjack-ranked-v1') {
		return invariant('Unsupported persisted ranked result version');
	}
	try {
		return {
			...row,
			gameType: 'blackjack',
			rulesetVersion: 'blackjack-ranked-v1',
			outcome: blackjackOutcomeV1Schema.parse(
				parseCanonicalJson(row.outcomeJson, 'result outcome JSON'),
			),
			statsEffects: rankedStatsEffectsV1Schema.parse(
				parseCanonicalJson(row.statsEffectsJson, 'result statistics JSON'),
			),
			achievementEffects: rankedAchievementEffectsV1Schema.parse(
				parseCanonicalJson(row.achievementEffectsJson, 'result achievement JSON'),
			),
			rewardEffects: rankedRewardEffectsV1Schema.parse(
				parseCanonicalJson(row.rewardEffectsJson, 'result reward JSON'),
			),
		};
	} catch (error) {
		if (error instanceof RankedRepositoryInvariantError) throw error;
		return invariant('Corrupt ranked result JSON');
	}
}

function readChanges(result: D1Result, statement: string): number {
	const changes = result.meta.changes;
	if (changes !== 0 && changes !== 1) {
		return invariant(`Unexpected ranked ${statement} mutation count`);
	}
	return changes;
}

async function hasConflictingSession(
	db: D1Database,
	userId: string,
	requestId: string,
): Promise<boolean> {
	const row = await db
		.prepare(
			`SELECT 1 AS conflict
			FROM ranked_session
			WHERE (userId = ? AND startRequestId = ?) OR activeUserId = ?
			LIMIT 1`,
		)
		.bind(userId, requestId, userId)
		.first<{ conflict: number }>();
	return row !== null;
}

function buildStartStatements(db: D1Database, input: StartTransitionInput): D1PreparedStatement[] {
	const { session, userId, expectedBalance } = input;
	return [
		buildRateLimitStatement(db, input.rateLimit),
		db
			.prepare(RANKED_START_ACCOUNT_SNAPSHOT_SQL)
			.bind(userId, expectedBalance, session.initialWager, userId, userId),
		db
			.prepare(RANKED_START_SESSION_INSERT_SQL)
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
				session.expiresAt,
				session.createdAt,
				session.updatedAt,
				userId,
				expectedBalance,
				session.initialWager,
				userId,
				userId,
			),
		db
			.prepare(RANKED_START_WAGER_DEDUCTION_SQL)
			.bind(
				session.initialWager,
				session.updatedAt,
				userId,
				expectedBalance,
				session.id,
				userId,
				userId,
			),
	];
}

export function createRankedRepository(db: D1Database): RankedRepository {
	return {
		async findByStartRequest(userId, requestId) {
			const row = await db
				.prepare('SELECT * FROM ranked_session WHERE userId = ? AND startRequestId = ? LIMIT 1')
				.bind(userId, requestId)
				.first<RankedSessionRow>();
			return row === null ? null : parseSessionRow(row);
		},
		async findOwnedSession(userId, sessionId) {
			const row = await db
				.prepare('SELECT * FROM ranked_session WHERE userId = ? AND id = ? LIMIT 1')
				.bind(userId, sessionId)
				.first<RankedSessionRow>();
			return row === null ? null : parseSessionRow(row);
		},
		async findResult(sessionId) {
			const row = await db
				.prepare('SELECT * FROM ranked_result WHERE sessionId = ? LIMIT 1')
				.bind(sessionId)
				.first<RankedResultRow>();
			return row === null ? null : parseResultRow(row);
		},
		async readAccount(userId) {
			return db
				.prepare('SELECT chipBalance, heldChips FROM user WHERE id = ? LIMIT 1')
				.bind(userId)
				.first<{ chipBalance: number; heldChips: number }>();
		},
		consumeStandaloneRateLimit(userId, operation, nowSeconds) {
			return consumeStandaloneRateLimit(db, userId, operation, nowSeconds);
		},
		async runStartTransition(input) {
			if (input.rateLimit.userId !== input.userId || input.rateLimit.operation !== 'ranked_start') {
				return invariant('Ranked start rate-limit input mismatch');
			}
			const [rateResult, snapshotResult, sessionResult, wagerResult] = await db.batch(
				buildStartStatements(db, input),
			);
			const rateChanges = readChanges(rateResult, 'start rate');
			const snapshotChanges = readChanges(snapshotResult, 'start snapshot');
			const sessionChanges = readChanges(sessionResult, 'start session');
			const wagerChanges = readChanges(wagerResult, 'start wager');

			if (rateChanges === 0) {
				if (snapshotChanges !== 0 || sessionChanges !== 0 || wagerChanges !== 0) {
					return invariant('Denied ranked start rate allowed downstream mutations');
				}
				return {
					kind: 'rate-limited',
					retryAfter: getRetryAfterSeconds(input.rateLimit.operation, input.rateLimit.nowSeconds),
				};
			}
			if (snapshotChanges === 0) {
				if (sessionChanges !== 0 || wagerChanges !== 0) {
					return invariant('Failed ranked start snapshot allowed downstream mutations');
				}
				if (await hasConflictingSession(db, input.userId, input.session.startRequestId)) {
					return { kind: 'not-created' };
				}
				return { kind: 'balance-changed' };
			}
			if (sessionChanges === 0) {
				if (wagerChanges !== 0) {
					return invariant('Failed ranked session insert allowed a wager mutation');
				}
				return { kind: 'not-created' };
			}
			if (wagerChanges !== 1) {
				return invariant('Created ranked session did not deduct its opening wager');
			}
			return { kind: 'created' };
		},
	};
}
