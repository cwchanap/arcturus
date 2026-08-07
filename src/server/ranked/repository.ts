import { z } from 'zod';
import type { RankedJson } from '../../lib/ranked/canonical';
import { canonicalizeRanked, hashCanonical, sha256Hex } from '../../lib/ranked/canonical';
import type {
	RankedAchievementEffectsV1,
	RankedBlackjackActionLogV1,
	RankedRewardEffectsV1,
	RankedReceiptV1,
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
	buildRateLimitContinuationStatement,
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
	/** Defaults to consuming one unit; retries may prove a unit consumed earlier in this request. */
	rateLimitMode?: 'consume' | 'already-consumed';
	openingTerminal?: TerminalTransitionInput;
	/** Precomputed canonical fallback used only after a consistent prior grant is proven. */
	openingNonRewardTerminal?: TerminalTransitionInput;
}

export type StartTransitionResult =
	| { kind: 'created'; result?: RankedResultRecord }
	| { kind: 'not-created' }
	| { kind: 'balance-changed' }
	| { kind: 'rate-limited'; retryAfter: number };

export interface TerminalEffects {
	finalAdditionalWager: number;
	payout: number;
	gameNetDelta: number;
	rewardDelta: 0 | 100;
	outcomeJson: string;
	statsEffectsJson: string;
	achievementEffectsJson: string;
	rewardEffectsJson: string;
}

export interface TerminalTransitionInput extends TerminalEffects {
	expectedWalletBalance: number;
	balanceAfter: number;
	receiptHash: string;
	settledAt: number;
}

export interface ActionTransitionInput {
	userId: string;
	sessionId: string;
	expectedSequence: number;
	actionLogJson: string;
	actionLogHash: string;
	additionalWager: number;
	committedWager: number;
	nowSeconds: number;
	/** Defaults to consuming one unit; retries may prove a unit consumed earlier in this request. */
	rateLimitMode?: 'consume' | 'already-consumed';
	terminal?: TerminalTransitionInput;
	/** Precomputed canonical fallback used only after a consistent prior grant is proven. */
	nonRewardTerminal?: TerminalTransitionInput;
}

export type TerminalActionTransitionInput = ActionTransitionInput & {
	terminal: TerminalTransitionInput;
};

export type ActionTransitionResult =
	| { kind: 'applied'; result: RankedResultRecord | null }
	| { kind: 'not-applied' }
	| { kind: 'balance-changed' }
	| { kind: 'rate-limited'; retryAfter: number };

export interface ExpirationTransitionInput {
	userId: string;
	sessionId: string;
	nowSeconds: number;
	terminal: TerminalTransitionInput;
}

export type ExpirationTransitionResult =
	| { kind: 'applied'; result: RankedResultRecord }
	| { kind: 'not-applied' }
	| { kind: 'balance-changed' };

export interface RankedRepository {
	findByStartRequest(userId: string, requestId: string): Promise<RankedSessionRecord | null>;
	findActiveSession(userId: string): Promise<RankedSessionRecord | null>;
	findSessionOwner(sessionId: string): Promise<string | null>;
	findOwnedSession(userId: string, sessionId: string): Promise<RankedSessionRecord | null>;
	findResult(sessionId: string): Promise<RankedResultRecord | null>;
	readAccount(userId: string): Promise<{ chipBalance: number } | null>;
	consumeStandaloneRateLimit(
		userId: string,
		operation: RankedRateOperation,
		nowSeconds: number,
	): Promise<RankedRateLimitResult>;
	runStartTransition(input: StartTransitionInput): Promise<StartTransitionResult>;
	runActionTransition(input: ActionTransitionInput): Promise<ActionTransitionResult>;
	runTerminalTransition(input: TerminalActionTransitionInput): Promise<ActionTransitionResult>;
	runExpirationTransition(input: ExpirationTransitionInput): Promise<ExpirationTransitionResult>;
	listExpiredSessions(
		nowSeconds: number,
		cursor?: RankedExpirationCursor | null,
	): Promise<readonly RankedExpirationRow[]>;
	deleteExpiredRateBuckets(nowSeconds: number): Promise<number>;
}

type RankedSessionRow = Omit<RankedSessionRecord, 'config' | 'actionLog'>;

type RankedResultRow = Omit<
	RankedResultRecord,
	'outcome' | 'statsEffects' | 'achievementEffects' | 'rewardEffects'
>;

// Foundational settlement invariant: every value-preserving "snapshot"
// UPDATE (SET chipBalance = chipBalance WHERE ...) relies on SQLite's
// `changes()` returning 1 for a row that matches the WHERE clause even
// though no column value actually changes. This is the CAS-style guard
// that proves the row exists with the expected balance/escrow state at
// the moment the transition runs, without mutating the money path.
//
// This guarantee is proven on Miniflare (the local/test D1 backing
// store) via the repository integration tests. workerd production D1
// (libsql) is not independently probed today. SQLite documents
// `changes()` as the count of rows modified by the UPDATE, where
// "modified" means matched-and-written (SQLite always writes matched
// rows even when values are unchanged), so the assumption holds for
// stock SQLite. If a future workerd/libsql change reports 0 for
// value-preserving UPDATEs, every transition below degrades silently:
// starts/actions/expirations would report "balance-changed" and retry
// until exhaustion, surfacing as ACCOUNT_BALANCE_CHANGED to the user.
// A workerd canary probe should be added before relying on this across
// a platform migration; until then the Miniflare integration tests are
// the canary.
export const RANKED_START_ACCOUNT_SNAPSHOT_SQL = `UPDATE user
SET chipBalance = chipBalance
WHERE id = ?
	AND chipBalance = ?
	AND chipBalance >= ?
	AND changes() = 1
	AND NOT EXISTS (SELECT 1 FROM ranked_session WHERE activeUserId = ?)`;

// Page size for listExpiredSessions. Exported so the expiration flow can
// use the same value for its pagination-completion check; the two paths
// cannot diverge.
export const RANKED_EXPIRATION_PAGE_SIZE = 100;

// Stable cursor for advancing past rows already attempted in this
// invocation (whether the attempt succeeded or failed). Without it,
// unprocessable "poison" rows that remain active would be returned by
// every subsequent page query and permanently block later sessions
// (head-of-line blocking).
export interface RankedExpirationCursor {
	readonly expiresAt: number;
	readonly id: string;
}

export interface RankedExpirationRow {
	readonly id: string;
	readonly expiresAt: number;
}

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
		WHERE id = ? AND chipBalance = ? AND chipBalance >= ?
	)
	AND NOT EXISTS (SELECT 1 FROM ranked_session WHERE activeUserId = ?)
ON CONFLICT DO NOTHING`;

export const RANKED_START_WAGER_DEDUCTION_SQL = `UPDATE user
SET chipBalance = chipBalance - ?, updatedAt = ?
	WHERE id = ?
	AND chipBalance = ?
	AND changes() = 1
	AND EXISTS (
		SELECT 1 FROM ranked_session
		WHERE id = ? AND userId = ? AND activeUserId = ? AND status = 'active'
	)`;

export const RANKED_ACTION_WAGER_DEDUCTION_SQL = `UPDATE user
SET chipBalance = chipBalance - ?, updatedAt = ?
	WHERE id = ?
	AND chipBalance >= ?
	AND changes() = 1
	AND EXISTS (
		SELECT 1 FROM ranked_session
		WHERE id = ? AND userId = ? AND activeUserId = ?
			AND status = 'active' AND nextSequence = ?
			AND committedWager + ? = ?
			AND actionLogJson = ? AND actionLogHash = ?
	)`;

export const RANKED_ACTION_SESSION_UPDATE_SQL = `UPDATE ranked_session
SET actionLogJson = ?, actionLogHash = ?, nextSequence = nextSequence + 1,
	committedWager = committedWager + ?, updatedAt = ?
WHERE id = ? AND userId = ? AND activeUserId = ?
	AND status = 'active' AND nextSequence = ?
	AND committedWager + ? = ?
	AND actionLogJson = ? AND actionLogHash = ?
	AND changes() = 1`;

export const RANKED_TERMINAL_ACCOUNT_SNAPSHOT_SQL = `UPDATE user
SET chipBalance = chipBalance
WHERE id = ?
	AND chipBalance = ?
	AND changes() = 1
	AND EXISTS (
		SELECT 1 FROM ranked_session
		WHERE id = ? AND userId = ? AND activeUserId = ?
			AND status = 'active' AND nextSequence = ?
	)`;

export const RANKED_EXPIRATION_ACCOUNT_SNAPSHOT_SQL = `UPDATE user
SET chipBalance = chipBalance
WHERE id = ?
	AND chipBalance = ?
	AND EXISTS (
		SELECT 1 FROM ranked_session
		WHERE id = ? AND userId = ? AND activeUserId = ?
			AND status = 'active' AND expiresAt <= ? AND nextSequence = ?
			AND actionLogHash = ? AND committedWager = ?
	)`;

const RANKED_REWARD_RESERVATION_SQL = `INSERT INTO ranked_reward_grant (
	userId, rewardId, sourceSessionId, achievementId, chipAmount, grantedAt
)
SELECT ?, 'ranked_debut_100', ?, 'ranked_debut', 100, ?
WHERE changes() = 1`;

const RANKED_TERMINAL_WALLET_UPDATE_SQL = `UPDATE user
SET chipBalance = chipBalance - ? + ? + ?, updatedAt = ?
WHERE id = ?
	AND chipBalance = ?
	AND changes() = 1
	AND EXISTS (
		SELECT 1 FROM ranked_session
		WHERE id = ? AND userId = ? AND activeUserId = ?
			AND status = 'active' AND nextSequence = ?
	)`;

const RANKED_TERMINAL_SESSION_UPDATE_SQL = `UPDATE ranked_session
SET actionLogJson = ?, actionLogHash = ?, nextSequence = nextSequence + 1,
	committedWager = committedWager + ?, activeUserId = NULL,
	status = 'settled', settledAt = ?, updatedAt = ?
WHERE id = ? AND userId = ? AND activeUserId = ?
	AND status = 'active' AND nextSequence = ?
	AND committedWager + ? = ?
	AND changes() = 1`;

const RANKED_OPENING_TERMINAL_SESSION_UPDATE_SQL = `UPDATE ranked_session
SET activeUserId = NULL, status = 'settled', settledAt = ?, updatedAt = ?
WHERE id = ? AND userId = ? AND activeUserId = ?
	AND status = 'active' AND nextSequence = 0
	AND changes() = 1`;

const RANKED_EXPIRATION_SESSION_UPDATE_SQL = `UPDATE ranked_session
SET activeUserId = NULL, status = 'expired', settledAt = ?, updatedAt = ?
WHERE id = ? AND userId = ? AND activeUserId = ?
	AND status = 'active' AND expiresAt <= ?
	AND nextSequence = ? AND actionLogHash = ? AND committedWager = ?
	AND changes() = 1`;

const RANKED_RESULT_INSERT_SQL = `INSERT INTO ranked_result (
	sessionId, userId, gameType, rulesetVersion, seedCommitment,
	configHash, actionLogHash, outcomeJson, initialWager, committedWager,
	payout, gameNetDelta, rewardDelta, balanceAfter, statsEffectsJson,
	achievementEffectsJson, rewardEffectsJson, receiptHash, settledAt
)
SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
FROM user
WHERE id = ? AND chipBalance = ? AND changes() = 1`;

const RANKED_STATS_UPSERT_SQL = `INSERT INTO ranked_game_stats (
	userId, gameType, sessionsPlayed, totalWins, totalLosses, totalPushes,
	totalForfeits, netProfit, biggestWin, updatedAt
)
SELECT ?, 'blackjack', ?, ?, ?, ?, ?, ?, ?, ?
WHERE changes() = 1
ON CONFLICT(userId, gameType) DO UPDATE SET
	sessionsPlayed = ranked_game_stats.sessionsPlayed + excluded.sessionsPlayed,
	totalWins = ranked_game_stats.totalWins + excluded.totalWins,
	totalLosses = ranked_game_stats.totalLosses + excluded.totalLosses,
	totalPushes = ranked_game_stats.totalPushes + excluded.totalPushes,
	totalForfeits = ranked_game_stats.totalForfeits + excluded.totalForfeits,
	netProfit = ranked_game_stats.netProfit + excluded.netProfit,
	biggestWin = MAX(ranked_game_stats.biggestWin, excluded.biggestWin),
	updatedAt = excluded.updatedAt`;

const RANKED_ACHIEVEMENT_INSERT_SQL = `INSERT INTO user_achievement (
	userId, achievementId, earnedAt, gameType
)
SELECT ?, 'ranked_debut', ?, 'blackjack'
WHERE changes() = 1
ON CONFLICT(userId, achievementId) DO NOTHING`;

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
		const parsed = {
			...row,
			gameType: 'blackjack' as const,
			rulesetVersion: 'blackjack-ranked-v1' as const,
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
		const receiptWithoutHash: Omit<RankedReceiptV1<RankedBlackjackOutcomeV1>, 'receiptHash'> = {
			sessionId: parsed.sessionId,
			gameType: parsed.gameType,
			rulesetVersion: parsed.rulesetVersion,
			seedCommitment: parsed.seedCommitment,
			configHash: parsed.configHash,
			actionLogHash: parsed.actionLogHash,
			outcome: parsed.outcome,
			initialWager: parsed.initialWager,
			committedWager: parsed.committedWager,
			payout: parsed.payout,
			gameNetDelta: parsed.gameNetDelta,
			rewardDelta: parsed.rewardDelta,
			balanceAfter: parsed.balanceAfter,
			statsEffects: parsed.statsEffects,
			achievementEffects: parsed.achievementEffects,
			rewardEffects: parsed.rewardEffects,
			settledAt: parsed.settledAt,
		};
		if (hashCanonical(receiptWithoutHash) !== parsed.receiptHash) {
			return invariant('Corrupt ranked result receipt hash');
		}
		return parsed;
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

interface TerminalReceiptContext {
	sessionId: string;
	gameType: 'blackjack';
	rulesetVersion: 'blackjack-ranked-v1';
	seedCommitment: string;
	configHash: string;
	actionLogHash: string;
	initialWager: number;
	committedWager: number;
}

interface ValidatedTerminal {
	input: TerminalTransitionInput;
	outcome: RankedBlackjackOutcomeV1;
	statsEffects: RankedStatsEffectsV1;
	achievementEffects: RankedAchievementEffectsV1;
	rewardEffects: RankedRewardEffectsV1;
	monetaryDelta: number;
}

interface TransitionBatch {
	statements: D1PreparedStatement[];
	labels: string[];
	mandatory: boolean[];
}

interface CurrentTransitionState {
	account: { chipBalance: number } | null;
	session: RankedSessionRecord | null;
	result: RankedResultRecord | null;
}

function assertSafeNonNegativeInteger(value: number, label: string): void {
	if (!Number.isSafeInteger(value) || value < 0) {
		invariant(`Invalid ranked ${label}`);
	}
}

function validateActionLog(input: ActionTransitionInput): RankedBlackjackActionLogV1 {
	const actionLog = actionLogSchema.parse(
		parseCanonicalJson(input.actionLogJson, 'transition action-log JSON'),
	);
	if (sha256Hex(input.actionLogJson) !== input.actionLogHash) {
		invariant('Ranked transition action-log hash mismatch');
	}
	if (
		actionLog.length !== input.expectedSequence + 1 ||
		actionLog.at(-1)?.sequence !== input.expectedSequence
	) {
		invariant('Ranked transition action-log sequence mismatch');
	}
	return actionLog;
}

function validateTerminal(
	context: TerminalReceiptContext,
	terminal: TerminalTransitionInput,
): ValidatedTerminal {
	assertSafeNonNegativeInteger(terminal.expectedWalletBalance, 'terminal wallet snapshot');
	assertSafeNonNegativeInteger(terminal.finalAdditionalWager, 'terminal additional wager');
	assertSafeNonNegativeInteger(terminal.payout, 'terminal payout');
	assertSafeNonNegativeInteger(terminal.balanceAfter, 'terminal resulting balance');
	assertSafeNonNegativeInteger(terminal.settledAt, 'terminal settlement time');
	if (!Number.isSafeInteger(terminal.gameNetDelta)) {
		invariant('Invalid ranked terminal game net delta');
	}
	const expectedBalance =
		terminal.expectedWalletBalance -
		terminal.finalAdditionalWager +
		terminal.payout +
		terminal.rewardDelta;
	if (!Number.isSafeInteger(expectedBalance) || terminal.balanceAfter !== expectedBalance) {
		invariant('Ranked terminal balance identity mismatch');
	}

	const outcome = blackjackOutcomeV1Schema.parse(
		parseCanonicalJson(terminal.outcomeJson, 'terminal outcome JSON'),
	);
	const statsEffects = rankedStatsEffectsV1Schema.parse(
		parseCanonicalJson(terminal.statsEffectsJson, 'terminal statistics JSON'),
	);
	const achievementEffects = rankedAchievementEffectsV1Schema.parse(
		parseCanonicalJson(terminal.achievementEffectsJson, 'terminal achievement JSON'),
	);
	const rewardEffects = rankedRewardEffectsV1Schema.parse(
		parseCanonicalJson(terminal.rewardEffectsJson, 'terminal reward JSON'),
	);

	if (
		outcome.committedWager !== context.committedWager ||
		outcome.payout !== terminal.payout ||
		outcome.gameNetDelta !== terminal.gameNetDelta ||
		terminal.gameNetDelta !== terminal.payout - context.committedWager
	) {
		invariant('Ranked terminal outcome monetary identity mismatch');
	}
	const expectedBiggestWin = Math.max(terminal.gameNetDelta, 0);
	if (
		statsEffects.netProfit !== terminal.gameNetDelta ||
		statsEffects.biggestWin !== expectedBiggestWin
	) {
		invariant('Ranked terminal statistics include non-game effects');
	}
	if (terminal.rewardDelta === 100) {
		if (
			achievementEffects.length !== 1 ||
			achievementEffects[0] !== 'ranked_debut' ||
			rewardEffects.length !== 1 ||
			rewardEffects[0]?.rewardId !== 'ranked_debut_100' ||
			rewardEffects[0]?.chipAmount !== 100
		) {
			invariant('Ranked debut reward effects mismatch');
		}
	} else if (achievementEffects.length !== 0 || rewardEffects.length !== 0) {
		invariant('Unexpected ranked reward effects');
	}

	const receiptWithoutHash: Omit<RankedReceiptV1<RankedBlackjackOutcomeV1>, 'receiptHash'> = {
		sessionId: context.sessionId,
		gameType: context.gameType,
		rulesetVersion: context.rulesetVersion,
		seedCommitment: context.seedCommitment,
		configHash: context.configHash,
		actionLogHash: context.actionLogHash,
		outcome,
		initialWager: context.initialWager,
		committedWager: context.committedWager,
		payout: terminal.payout,
		gameNetDelta: terminal.gameNetDelta,
		rewardDelta: terminal.rewardDelta,
		balanceAfter: terminal.balanceAfter,
		statsEffects,
		achievementEffects,
		rewardEffects,
		settledAt: terminal.settledAt,
	};
	if (hashCanonical(receiptWithoutHash) !== terminal.receiptHash) {
		invariant('Ranked terminal receipt hash mismatch');
	}
	return {
		input: terminal,
		outcome,
		statsEffects,
		achievementEffects,
		rewardEffects,
		monetaryDelta: -terminal.finalAdditionalWager + terminal.payout + terminal.rewardDelta,
	};
}

function validateRewardFallback(
	primary: ValidatedTerminal,
	fallback: ValidatedTerminal | undefined,
): void {
	if (!fallback) return;
	if (
		primary.input.rewardDelta !== 100 ||
		fallback.input.rewardDelta !== 0 ||
		fallback.input.expectedWalletBalance !== primary.input.expectedWalletBalance ||
		fallback.input.finalAdditionalWager !== primary.input.finalAdditionalWager ||
		fallback.input.payout !== primary.input.payout ||
		fallback.input.gameNetDelta !== primary.input.gameNetDelta ||
		fallback.input.outcomeJson !== primary.input.outcomeJson ||
		fallback.input.statsEffectsJson !== primary.input.statsEffectsJson ||
		fallback.input.settledAt !== primary.input.settledAt
	) {
		invariant('Invalid ranked non-reward fallback');
	}
}

function resultInsertStatement(
	db: D1Database,
	userId: string,
	context: TerminalReceiptContext,
	terminal: ValidatedTerminal,
): D1PreparedStatement {
	const input = terminal.input;
	return db
		.prepare(RANKED_RESULT_INSERT_SQL)
		.bind(
			context.sessionId,
			userId,
			context.gameType,
			context.rulesetVersion,
			context.seedCommitment,
			context.configHash,
			context.actionLogHash,
			input.outcomeJson,
			context.initialWager,
			context.committedWager,
			input.payout,
			input.gameNetDelta,
			input.rewardDelta,
			input.balanceAfter,
			input.statsEffectsJson,
			input.achievementEffectsJson,
			input.rewardEffectsJson,
			input.receiptHash,
			input.settledAt,
			userId,
			input.balanceAfter,
		);
}

function statsUpsertStatement(
	db: D1Database,
	userId: string,
	terminal: ValidatedTerminal,
): D1PreparedStatement {
	const effects = terminal.statsEffects;
	return db
		.prepare(RANKED_STATS_UPSERT_SQL)
		.bind(
			userId,
			effects.sessionsPlayed,
			effects.totalWins,
			effects.totalLosses,
			effects.totalPushes,
			effects.totalForfeits,
			effects.netProfit,
			effects.biggestWin,
			terminal.input.settledAt,
		);
}

function appendTerminalTail(
	batch: TransitionBatch,
	db: D1Database,
	userId: string,
	context: TerminalReceiptContext,
	terminal: ValidatedTerminal,
	expectedSequence: number,
	sessionStatement: D1PreparedStatement,
): void {
	if (terminal.input.rewardDelta === 100) {
		batch.statements.push(
			db
				.prepare(RANKED_REWARD_RESERVATION_SQL)
				.bind(userId, context.sessionId, terminal.input.settledAt),
		);
		batch.labels.push('terminal reward');
		batch.mandatory.push(true);
	}
	if (terminal.monetaryDelta !== 0) {
		batch.statements.push(
			db
				.prepare(RANKED_TERMINAL_WALLET_UPDATE_SQL)
				.bind(
					terminal.input.finalAdditionalWager,
					terminal.input.payout,
					terminal.input.rewardDelta,
					terminal.input.settledAt,
					userId,
					terminal.input.expectedWalletBalance,
					context.sessionId,
					userId,
					userId,
					expectedSequence,
				),
		);
		batch.labels.push('terminal wallet');
		batch.mandatory.push(true);
	}
	batch.statements.push(sessionStatement);
	batch.labels.push('terminal session');
	batch.mandatory.push(true);
	batch.statements.push(resultInsertStatement(db, userId, context, terminal));
	batch.labels.push('terminal result');
	batch.mandatory.push(true);
	batch.statements.push(statsUpsertStatement(db, userId, terminal));
	batch.labels.push('terminal statistics');
	batch.mandatory.push(true);
	if (terminal.achievementEffects.length > 0) {
		batch.statements.push(
			db.prepare(RANKED_ACHIEVEMENT_INSERT_SQL).bind(userId, terminal.input.settledAt),
		);
		batch.labels.push('terminal achievement');
		batch.mandatory.push(false);
	}
}

function inspectSuccessfulCascade(results: D1Result[], batch: TransitionBatch): void {
	for (let index = 0; index < results.length; index += 1) {
		const changes = readChanges(results[index], batch.labels[index]);
		if (batch.mandatory[index] && changes !== 1) {
			invariant(`Ranked ${batch.labels[index]} cascade did not apply`);
		}
	}
}

async function readCurrentTransitionState(
	db: D1Database,
	userId: string,
	sessionId: string,
): Promise<CurrentTransitionState> {
	const [account, sessionRow, resultRow] = await Promise.all([
		db
			.prepare('SELECT chipBalance FROM user WHERE id = ? LIMIT 1')
			.bind(userId)
			.first<{ chipBalance: number }>(),
		db
			.prepare('SELECT * FROM ranked_session WHERE id = ? AND userId = ? LIMIT 1')
			.bind(sessionId, userId)
			.first<RankedSessionRow>(),
		db
			.prepare('SELECT * FROM ranked_result WHERE sessionId = ? LIMIT 1')
			.bind(sessionId)
			.first<RankedResultRow>(),
	]);
	return {
		account,
		session: sessionRow === null ? null : parseSessionRow(sessionRow),
		result: resultRow === null ? null : parseResultRow(resultRow),
	};
}

async function hasConsistentRankedDebutGrant(db: D1Database, userId: string): Promise<boolean> {
	const grant = await db
		.prepare(
			`SELECT sourceSessionId, achievementId, chipAmount
			FROM ranked_reward_grant
			WHERE userId = ? AND rewardId = 'ranked_debut_100'`,
		)
		.bind(userId)
		.first<{ sourceSessionId: string; achievementId: string; chipAmount: number }>();
	if (grant === null || grant.achievementId !== 'ranked_debut' || grant.chipAmount !== 100) {
		return false;
	}
	const [resultRow, achievement] = await Promise.all([
		db
			.prepare('SELECT * FROM ranked_result WHERE sessionId = ? AND userId = ? LIMIT 1')
			.bind(grant.sourceSessionId, userId)
			.first<RankedResultRow>(),
		db
			.prepare(
				"SELECT achievementId FROM user_achievement WHERE userId = ? AND achievementId = 'ranked_debut'",
			)
			.bind(userId)
			.first<{ achievementId: string }>(),
	]);
	if (resultRow === null || achievement === null) return false;
	const result = parseResultRow(resultRow);
	return (
		result.rewardDelta === 100 &&
		result.rewardEffects.length === 1 &&
		result.rewardEffects[0]?.rewardId === 'ranked_debut_100' &&
		result.rewardEffects[0]?.chipAmount === 100
	);
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
		input.rateLimitMode === 'already-consumed'
			? buildRateLimitContinuationStatement(db, input.rateLimit)
			: buildRateLimitStatement(db, input.rateLimit),
		db
			.prepare(RANKED_START_ACCOUNT_SNAPSHOT_SQL)
			.bind(userId, expectedBalance, session.initialWager, userId),
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

function buildStartBatch(
	db: D1Database,
	input: StartTransitionInput,
	terminalInput = input.openingTerminal,
): { batch: TransitionBatch; terminal?: ValidatedTerminal } {
	const statements = buildStartStatements(db, input);
	const batch: TransitionBatch = {
		statements,
		labels: ['start rate', 'start snapshot', 'start session', 'start wager'],
		mandatory: [true, true, true, true],
	};
	if (!terminalInput) return { batch };
	if (
		terminalInput.finalAdditionalWager !== 0 ||
		terminalInput.expectedWalletBalance !== input.expectedBalance - input.session.initialWager
	) {
		invariant('Opening ranked terminal snapshot mismatch');
	}
	const context: TerminalReceiptContext = {
		sessionId: input.session.id,
		gameType: input.session.gameType,
		rulesetVersion: input.session.rulesetVersion,
		seedCommitment: input.session.seedCommitment,
		configHash: input.session.configHash,
		actionLogHash: input.session.actionLogHash,
		initialWager: input.session.initialWager,
		committedWager: input.session.committedWager,
	};
	const terminal = validateTerminal(context, terminalInput);
	appendTerminalTail(
		batch,
		db,
		input.userId,
		context,
		terminal,
		0,
		db
			.prepare(RANKED_OPENING_TERMINAL_SESSION_UPDATE_SQL)
			.bind(
				terminal.input.settledAt,
				terminal.input.settledAt,
				input.session.id,
				input.userId,
				input.userId,
			),
	);
	return { batch, terminal };
}

function buildActionBatch(
	db: D1Database,
	input: ActionTransitionInput,
	terminalInput = input.terminal,
): { batch: TransitionBatch; terminal?: ValidatedTerminal } {
	assertSafeNonNegativeInteger(input.expectedSequence, 'action expected sequence');
	assertSafeNonNegativeInteger(input.additionalWager, 'action additional wager');
	assertSafeNonNegativeInteger(input.committedWager, 'action committed wager');
	assertSafeNonNegativeInteger(input.nowSeconds, 'action time');
	const actionLog = validateActionLog(input);
	const priorActionLog = actionLog.slice(0, -1);
	const priorActionLogJson = canonicalizeRanked(priorActionLog);
	const priorActionLogHash = sha256Hex(priorActionLogJson);
	const batch: TransitionBatch = {
		statements: [
			input.rateLimitMode === 'already-consumed'
				? buildRateLimitContinuationStatement(db, {
						userId: input.userId,
						operation: 'ranked_action',
						nowSeconds: input.nowSeconds,
					})
				: buildRateLimitStatement(db, {
						userId: input.userId,
						operation: 'ranked_action',
						nowSeconds: input.nowSeconds,
					}),
		],
		labels: ['action rate'],
		mandatory: [true],
	};
	if (!terminalInput) {
		if (input.additionalWager > 0) {
			batch.statements.push(
				db
					.prepare(RANKED_ACTION_WAGER_DEDUCTION_SQL)
					.bind(
						input.additionalWager,
						input.nowSeconds,
						input.userId,
						input.additionalWager,
						input.sessionId,
						input.userId,
						input.userId,
						input.expectedSequence,
						input.additionalWager,
						input.committedWager,
						priorActionLogJson,
						priorActionLogHash,
					),
			);
			batch.labels.push('action wager');
			batch.mandatory.push(true);
		}
		batch.statements.push(
			db
				.prepare(RANKED_ACTION_SESSION_UPDATE_SQL)
				.bind(
					input.actionLogJson,
					input.actionLogHash,
					input.additionalWager,
					input.nowSeconds,
					input.sessionId,
					input.userId,
					input.userId,
					input.expectedSequence,
					input.additionalWager,
					input.committedWager,
					priorActionLogJson,
					priorActionLogHash,
				),
		);
		batch.labels.push('action session');
		batch.mandatory.push(true);
		return { batch };
	}
	if (terminalInput.finalAdditionalWager !== input.additionalWager) {
		invariant('Ranked terminal action wager mismatch');
	}
	return { batch };
}

function completeActionTerminalBatch(
	db: D1Database,
	input: ActionTransitionInput,
	session: RankedSessionRecord,
	batch: TransitionBatch,
	terminalInput: TerminalTransitionInput,
): ValidatedTerminal {
	const context: TerminalReceiptContext = {
		sessionId: session.id,
		gameType: session.gameType,
		rulesetVersion: session.rulesetVersion,
		seedCommitment: session.seedCommitment,
		configHash: session.configHash,
		actionLogHash: input.actionLogHash,
		initialWager: session.initialWager,
		committedWager: input.committedWager,
	};
	const terminal = validateTerminal(context, terminalInput);
	batch.statements.push(
		db
			.prepare(RANKED_TERMINAL_ACCOUNT_SNAPSHOT_SQL)
			.bind(
				input.userId,
				terminal.input.expectedWalletBalance,
				input.sessionId,
				input.userId,
				input.userId,
				input.expectedSequence,
			),
	);
	batch.labels.push('terminal snapshot');
	batch.mandatory.push(true);
	appendTerminalTail(
		batch,
		db,
		input.userId,
		context,
		terminal,
		input.expectedSequence,
		db
			.prepare(RANKED_TERMINAL_SESSION_UPDATE_SQL)
			.bind(
				input.actionLogJson,
				input.actionLogHash,
				input.additionalWager,
				terminal.input.settledAt,
				terminal.input.settledAt,
				input.sessionId,
				input.userId,
				input.userId,
				input.expectedSequence,
				input.additionalWager,
				input.committedWager,
			),
	);
	return terminal;
}

function buildExpirationBatch(
	db: D1Database,
	input: ExpirationTransitionInput,
	session: RankedSessionRecord,
): { batch: TransitionBatch; terminal: ValidatedTerminal } {
	if (
		input.terminal.rewardDelta !== 0 ||
		input.terminal.finalAdditionalWager !== 0 ||
		input.terminal.payout !== 0
	) {
		invariant('Ranked expiration cannot wager, pay out, or grant rewards');
	}
	const context: TerminalReceiptContext = {
		sessionId: session.id,
		gameType: session.gameType,
		rulesetVersion: session.rulesetVersion,
		seedCommitment: session.seedCommitment,
		configHash: session.configHash,
		actionLogHash: session.actionLogHash,
		initialWager: session.initialWager,
		committedWager: session.committedWager,
	};
	const terminal = validateTerminal(context, input.terminal);
	const batch: TransitionBatch = {
		statements: [
			db
				.prepare(RANKED_EXPIRATION_ACCOUNT_SNAPSHOT_SQL)
				.bind(
					input.userId,
					terminal.input.expectedWalletBalance,
					input.sessionId,
					input.userId,
					input.userId,
					input.nowSeconds,
					session.nextSequence,
					session.actionLogHash,
					session.committedWager,
				),
			db
				.prepare(RANKED_EXPIRATION_SESSION_UPDATE_SQL)
				.bind(
					terminal.input.settledAt,
					terminal.input.settledAt,
					input.sessionId,
					input.userId,
					input.userId,
					input.nowSeconds,
					session.nextSequence,
					session.actionLogHash,
					session.committedWager,
				),
			resultInsertStatement(db, input.userId, context, terminal),
			statsUpsertStatement(db, input.userId, terminal),
		],
		labels: [
			'expiration snapshot',
			'expiration session',
			'expiration result',
			'expiration statistics',
		],
		mandatory: [true, true, true, true],
	};
	return { batch, terminal };
}

function everyChangeAfter(results: D1Result[], startIndex: number, expected: number): boolean {
	return results.slice(startIndex).every((result) => (result.meta.changes ?? 0) === expected);
}

async function executeStartTransition(
	db: D1Database,
	input: StartTransitionInput,
): Promise<StartTransitionResult> {
	if (input.rateLimit.userId !== input.userId || input.rateLimit.operation !== 'ranked_start') {
		return invariant('Ranked start rate-limit input mismatch');
	}
	let selected = buildStartBatch(db, input);
	if (input.openingNonRewardTerminal) {
		if (!selected.terminal) invariant('Opening non-reward fallback has no primary terminal');
		const fallback = buildStartBatch(db, input, input.openingNonRewardTerminal);
		if (!fallback.terminal) invariant('Missing opening non-reward terminal');
		validateRewardFallback(selected.terminal, fallback.terminal);
	}
	let results: D1Result[];
	try {
		results = await db.batch(selected.batch.statements);
	} catch (error) {
		if (
			selected.terminal?.input.rewardDelta !== 100 ||
			!input.openingNonRewardTerminal ||
			!(await hasConsistentRankedDebutGrant(db, input.userId))
		) {
			throw error;
		}
		selected = buildStartBatch(db, input, input.openingNonRewardTerminal);
		results = await db.batch(selected.batch.statements);
	}
	const rateChanges = readChanges(results[0], 'start rate');
	const snapshotChanges = readChanges(results[1], 'start snapshot');
	const sessionChanges = readChanges(results[2], 'start session');
	const wagerChanges = readChanges(results[3], 'start wager');

	if (rateChanges === 0) {
		if (!everyChangeAfter(results, 1, 0)) {
			return invariant('Denied ranked start rate allowed downstream mutations');
		}
		return {
			kind: 'rate-limited',
			retryAfter: getRetryAfterSeconds(input.rateLimit.operation, input.rateLimit.nowSeconds),
		};
	}
	if (snapshotChanges === 0) {
		if (!everyChangeAfter(results, 2, 0)) {
			return invariant('Failed ranked start snapshot allowed downstream mutations');
		}
		if (await hasConflictingSession(db, input.userId, input.session.startRequestId)) {
			return { kind: 'not-created' };
		}
		return { kind: 'balance-changed' };
	}
	if (sessionChanges === 0) {
		if (!everyChangeAfter(results, 3, 0)) {
			return invariant('Failed ranked session insert allowed downstream mutations');
		}
		return { kind: 'not-created' };
	}
	if (wagerChanges !== 1) {
		return invariant('Created ranked session did not deduct its opening wager');
	}
	if (!selected.terminal) return { kind: 'created' };
	for (let index = 4; index < results.length; index += 1) {
		const changes = readChanges(results[index], selected.batch.labels[index]);
		if (selected.batch.mandatory[index] && changes !== 1) {
			return invariant(`Ranked ${selected.batch.labels[index]} cascade did not apply`);
		}
	}
	const resultRow = await db
		.prepare('SELECT * FROM ranked_result WHERE sessionId = ? LIMIT 1')
		.bind(input.session.id)
		.first<RankedResultRow>();
	if (resultRow === null) return invariant('Opening ranked terminal did not store its result');
	return { kind: 'created', result: parseResultRow(resultRow) };
}

async function classifyActionMiss(
	db: D1Database,
	input: ActionTransitionInput,
	terminal: ValidatedTerminal | undefined,
): Promise<ActionTransitionResult> {
	const current = await readCurrentTransitionState(db, input.userId, input.sessionId);
	if (
		terminal &&
		current.result &&
		current.session?.actionLogJson === input.actionLogJson &&
		current.session.actionLogHash === input.actionLogHash &&
		current.session.nextSequence === input.expectedSequence + 1
	) {
		return { kind: 'applied', result: current.result };
	}
	if (
		current.session?.status === 'active' &&
		current.session.nextSequence === input.expectedSequence &&
		(current.account === null ||
			(terminal
				? current.account.chipBalance !== terminal.input.expectedWalletBalance
				: current.account.chipBalance < input.additionalWager))
	) {
		return { kind: 'balance-changed' };
	}
	return { kind: 'not-applied' };
}

async function executeActionTransition(
	db: D1Database,
	input: ActionTransitionInput,
): Promise<ActionTransitionResult> {
	const initial = buildActionBatch(db, input);
	let selectedBatch = initial.batch;
	let selectedTerminal: ValidatedTerminal | undefined;
	let session: RankedSessionRecord | null = null;
	if (input.terminal) {
		const row = await db
			.prepare('SELECT * FROM ranked_session WHERE id = ? AND userId = ? LIMIT 1')
			.bind(input.sessionId, input.userId)
			.first<RankedSessionRow>();
		session = row === null ? null : parseSessionRow(row);
		if (!session) return { kind: 'not-applied' };
		if (session.status === 'active') {
			const actionLog = actionLogSchema.parse(JSON.parse(input.actionLogJson));
			const priorActionLogJson = canonicalizeRanked(actionLog.slice(0, -1));
			if (
				session.actionLogJson !== priorActionLogJson ||
				session.actionLogHash !== sha256Hex(priorActionLogJson)
			) {
				return { kind: 'not-applied' };
			}
		}
		const expectedCommittedWager =
			session.status === 'active'
				? session.committedWager + input.additionalWager
				: session.committedWager;
		if (expectedCommittedWager !== input.committedWager) {
			return invariant('Ranked terminal committed wager mismatch');
		}
		selectedTerminal = completeActionTerminalBatch(
			db,
			input,
			session,
			selectedBatch,
			input.terminal,
		);
		if (input.nonRewardTerminal) {
			const fallbackBase = buildActionBatch(db, input, input.nonRewardTerminal);
			const fallbackTerminal = completeActionTerminalBatch(
				db,
				input,
				session,
				fallbackBase.batch,
				input.nonRewardTerminal,
			);
			validateRewardFallback(selectedTerminal, fallbackTerminal);
		}
	}

	let results: D1Result[];
	try {
		results = await db.batch(selectedBatch.statements);
	} catch (error) {
		if (
			!session ||
			selectedTerminal?.input.rewardDelta !== 100 ||
			!input.nonRewardTerminal ||
			!(await hasConsistentRankedDebutGrant(db, input.userId))
		) {
			throw error;
		}
		const fallbackBase = buildActionBatch(db, input, input.nonRewardTerminal);
		selectedBatch = fallbackBase.batch;
		selectedTerminal = completeActionTerminalBatch(
			db,
			input,
			session,
			selectedBatch,
			input.nonRewardTerminal,
		);
		results = await db.batch(selectedBatch.statements);
	}

	const rateChanges = readChanges(results[0], 'action rate');
	if (rateChanges === 0) {
		if (!everyChangeAfter(results, 1, 0)) {
			return invariant('Denied ranked action rate allowed downstream mutations');
		}
		return {
			kind: 'rate-limited',
			retryAfter: getRetryAfterSeconds('ranked_action', input.nowSeconds),
		};
	}

	if (selectedTerminal) {
		const snapshotChanges = readChanges(results[1], 'terminal snapshot');
		if (snapshotChanges === 0) {
			if (!everyChangeAfter(results, 2, 0)) {
				return invariant('Failed ranked terminal snapshot allowed downstream mutations');
			}
			return classifyActionMiss(db, input, selectedTerminal);
		}
		inspectSuccessfulCascade(results, selectedBatch);
		const resultRow = await db
			.prepare('SELECT * FROM ranked_result WHERE sessionId = ? LIMIT 1')
			.bind(input.sessionId)
			.first<RankedResultRow>();
		if (resultRow === null) return invariant('Ranked terminal did not store its result');
		return { kind: 'applied', result: parseResultRow(resultRow) };
	}

	const walletIndex = input.additionalWager > 0 ? 1 : -1;
	const sessionIndex = input.additionalWager > 0 ? 2 : 1;
	if (walletIndex !== -1 && readChanges(results[walletIndex], 'action wager') === 0) {
		if (!everyChangeAfter(results, sessionIndex, 0)) {
			return invariant('Failed ranked action wager allowed a session mutation');
		}
		return classifyActionMiss(db, input, undefined);
	}
	if (readChanges(results[sessionIndex], 'action session') === 0) {
		return classifyActionMiss(db, input, undefined);
	}
	return { kind: 'applied', result: null };
}

async function executeExpirationTransition(
	db: D1Database,
	input: ExpirationTransitionInput,
): Promise<ExpirationTransitionResult> {
	const row = await db
		.prepare('SELECT * FROM ranked_session WHERE id = ? AND userId = ? LIMIT 1')
		.bind(input.sessionId, input.userId)
		.first<RankedSessionRow>();
	if (row === null) return { kind: 'not-applied' };
	const session = parseSessionRow(row);
	const { batch, terminal } = buildExpirationBatch(db, input, session);
	const results = await db.batch(batch.statements);
	const snapshotChanges = readChanges(results[0], 'expiration snapshot');
	if (snapshotChanges === 0) {
		if (!everyChangeAfter(results, 1, 0)) {
			return invariant('Failed ranked expiration snapshot allowed downstream mutations');
		}
		const current = await readCurrentTransitionState(db, input.userId, input.sessionId);
		if (current.result && current.session?.status === 'expired') {
			return { kind: 'applied', result: current.result };
		}
		if (
			current.session?.status === 'active' &&
			(current.session.nextSequence !== session.nextSequence ||
				current.session.actionLogHash !== session.actionLogHash ||
				current.session.committedWager !== session.committedWager)
		) {
			return { kind: 'not-applied' };
		}
		if (
			current.session?.status === 'active' &&
			(current.account === null ||
				current.account.chipBalance !== terminal.input.expectedWalletBalance)
		) {
			return { kind: 'balance-changed' };
		}
		return { kind: 'not-applied' };
	}
	inspectSuccessfulCascade(results, batch);
	const resultRow = await db
		.prepare('SELECT * FROM ranked_result WHERE sessionId = ? LIMIT 1')
		.bind(input.sessionId)
		.first<RankedResultRow>();
	if (resultRow === null) return invariant('Ranked expiration did not store its result');
	return { kind: 'applied', result: parseResultRow(resultRow) };
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
		async findActiveSession(userId) {
			const row = await db
				.prepare('SELECT * FROM ranked_session WHERE activeUserId = ? LIMIT 1')
				.bind(userId)
				.first<RankedSessionRow>();
			return row === null ? null : parseSessionRow(row);
		},
		async findSessionOwner(sessionId) {
			const row = await db
				.prepare('SELECT userId FROM ranked_session WHERE id = ? LIMIT 1')
				.bind(sessionId)
				.first<{ userId: unknown }>();
			if (row === null) return null;
			if (typeof row.userId !== 'string' || row.userId.length === 0) {
				return invariant('Corrupt ranked session owner');
			}
			return row.userId;
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
				.prepare('SELECT chipBalance FROM user WHERE id = ? LIMIT 1')
				.bind(userId)
				.first<{ chipBalance: number }>();
		},
		consumeStandaloneRateLimit(userId, operation, nowSeconds) {
			return consumeStandaloneRateLimit(db, userId, operation, nowSeconds);
		},
		runStartTransition(input) {
			return executeStartTransition(db, input);
		},
		runActionTransition(input) {
			return executeActionTransition(db, input);
		},
		runTerminalTransition(input) {
			return executeActionTransition(db, input);
		},
		runExpirationTransition(input) {
			return executeExpirationTransition(db, input);
		},
		async listExpiredSessions(nowSeconds, cursor) {
			assertSafeNonNegativeInteger(nowSeconds, 'expiration cutoff');
			if (cursor) {
				assertSafeNonNegativeInteger(cursor.expiresAt, 'expiration cursor expiresAt');
				if (typeof cursor.id !== 'string' || cursor.id.length === 0) {
					invariant('Invalid ranked expiration cursor id');
				}
				const rows = await db
					.prepare(
						`SELECT id, expiresAt
						FROM ranked_session
						WHERE status = 'active' AND expiresAt <= ?
							AND (expiresAt > ? OR (expiresAt = ? AND id > ?))
						ORDER BY expiresAt ASC, id ASC
						LIMIT ${RANKED_EXPIRATION_PAGE_SIZE}`,
					)
					.bind(nowSeconds, cursor.expiresAt, cursor.expiresAt, cursor.id)
					.all<{ id: string; expiresAt: number }>();
				return rows.results.map(({ id, expiresAt }) => ({ id, expiresAt }));
			}
			const rows = await db
				.prepare(
					`SELECT id, expiresAt
					FROM ranked_session
					WHERE status = 'active' AND expiresAt <= ?
					ORDER BY expiresAt ASC, id ASC
					LIMIT ${RANKED_EXPIRATION_PAGE_SIZE}`,
				)
				.bind(nowSeconds)
				.all<{ id: string; expiresAt: number }>();
			return rows.results.map(({ id, expiresAt }) => ({ id, expiresAt }));
		},
		async deleteExpiredRateBuckets(nowSeconds) {
			assertSafeNonNegativeInteger(nowSeconds, 'rate cleanup cutoff');
			const result = await db
				.prepare('DELETE FROM ranked_rate_limit WHERE expiresAt <= ?')
				.bind(nowSeconds)
				.run();
			return result.meta.changes ?? 0;
		},
	};
}
