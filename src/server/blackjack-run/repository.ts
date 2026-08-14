import { z } from 'zod';
import {
	blackjackRunCommandSchema,
	type BlackjackRunCommand,
} from '../../lib/blackjack-run/protocol';
import { calculateDailyPercentile } from '../../lib/blackjack-run/daily';

export type BlackjackRunMode = 'ranked' | 'daily';
export type BlackjackRunStatus = 'active' | 'settled' | 'completed' | 'forfeited' | 'expired';

export class BlackjackRunRepositoryInvariantError extends Error {
	constructor(message = 'Blackjack run repository invariant failed') {
		super(message);
		this.name = 'BlackjackRunRepositoryInvariantError';
	}
}

export interface BlackjackRunRecord {
	id: string;
	userId: string;
	activeUserId: string | null;
	mode: BlackjackRunMode;
	periodKey: string | null;
	startRequestId: string;
	initialWager: number | null;
	seed: string;
	commands: readonly BlackjackRunCommand[];
	nextSequence: number;
	status: BlackjackRunStatus;
	resultJson: string | null;
	dailyEndingBankroll: number | null;
	dailyRoundsCompleted: number | null;
	// mode: 'timestamp' columns store/read unix seconds (not ms).
	expiresAt: number;
	createdAt: number;
	updatedAt: number;
	settledAt: number | null;
}

export interface CreateRankedRunWithStakeInput {
	userId: string;
	id: string;
	startRequestId: string;
	initialWager: number;
	seed: string;
	expiresAt: number;
	createdAt: number;
	updatedAt: number;
}

export type CreateRankedRunWithStakeResult =
	| { kind: 'applied' }
	| { kind: 'insufficient' }
	| { kind: 'active-exists' }
	| { kind: 'duplicate-request' };

export interface CreateDailyRunInput {
	userId: string;
	id: string;
	periodKey: string;
	startRequestId: string;
	seed: string;
	expiresAt: number;
	createdAt: number;
	updatedAt: number;
}

export type CreateDailyRunResult = { kind: 'created' } | { kind: 'existing' };

export interface AppendRankedCommandWithStakeInput {
	userId: string;
	runId: string;
	expectedSequence: number;
	/** The full new command log (previous commands plus the appended one). */
	commandsJson: string;
	/** Additional stake committed by the command (split/double-down); 0 otherwise. */
	additionalWager: number;
	nowSeconds: number;
}

export type AppendRankedCommandWithStakeResult =
	| { kind: 'applied' }
	| { kind: 'not-applied' }
	| { kind: 'insufficient' };

export interface AppendDailyCommandInput {
	userId: string;
	runId: string;
	expectedSequence: number;
	commandsJson: string;
	nowSeconds: number;
}

export type AppendDailyCommandResult = { kind: 'applied' } | { kind: 'not-applied' };

export interface FinishRunInput {
	userId: string;
	runId: string;
	mode: BlackjackRunMode;
	expectedSequence: number;
	status: Exclude<BlackjackRunStatus, 'active'>;
	resultJson: string | null;
	dailyEndingBankroll: number | null;
	dailyRoundsCompleted: number | null;
	nowSeconds: number;
}

export type FinishRunResult = { kind: 'applied' } | { kind: 'not-applied' };

export interface BlackjackRunExpirationCursor {
	readonly expiresAt: number;
	readonly id: string;
}

export interface BlackjackRunExpirationRow {
	readonly id: string;
	readonly expiresAt: number;
}

export interface BlackjackDailyRecord {
	periodKey: string;
	seed: string;
	createdAt: number;
}

export interface DailyLeaderboardEntry {
	rank: number;
	userId: string;
	playerName: string;
	dailyEndingBankroll: number;
	dailyRoundsCompleted: number;
	settledAt: number;
}

export interface DailyCurrentUserStanding {
	rank: number;
	totalEligible: number;
	percentile: number;
}

export interface DailyLeaderboardRead {
	entries: readonly DailyLeaderboardEntry[];
	currentUser: DailyCurrentUserStanding | null;
}

export interface BlackjackRunRepository {
	createRankedRunWithStake(
		input: CreateRankedRunWithStakeInput,
	): Promise<CreateRankedRunWithStakeResult>;
	createDailyRun(input: CreateDailyRunInput): Promise<CreateDailyRunResult>;
	findOwnedRun(userId: string, runId: string): Promise<BlackjackRunRecord | null>;
	findByStartRequest(userId: string, requestId: string): Promise<BlackjackRunRecord | null>;
	findActiveRun(userId: string, mode: BlackjackRunMode): Promise<BlackjackRunRecord | null>;
	findDailyRun(userId: string, periodKey: string): Promise<BlackjackRunRecord | null>;
	appendRankedCommandWithStake(
		input: AppendRankedCommandWithStakeInput,
	): Promise<AppendRankedCommandWithStakeResult>;
	appendDailyCommand(input: AppendDailyCommandInput): Promise<AppendDailyCommandResult>;
	finishRun(input: FinishRunInput): Promise<FinishRunResult>;
	listExpiredPage(
		nowSeconds: number,
		cursor: BlackjackRunExpirationCursor | null,
		limit: number,
	): Promise<readonly BlackjackRunExpirationRow[]>;
	getOrCreateDaily(
		periodKey: string,
		seedFactory: () => string,
		nowSeconds: number,
	): Promise<BlackjackDailyRecord>;
	listDailyLeaderboard(
		periodKey: string,
		limit: number,
		userId?: string | null,
	): Promise<DailyLeaderboardRead>;
}

// Page size for listExpiredPage; callers pass their own limit, bounded here.
export const BLACKJACK_RUN_EXPIRATION_PAGE_SIZE = 100;

type BlackjackRunRow = Omit<BlackjackRunRecord, 'mode' | 'status' | 'commands'> & {
	mode: string;
	status: string;
	commandsJson: string;
};

const blackjackRunCommandLogSchema = z.array(blackjackRunCommandSchema);

// Guarded atomic Ranked start: the run INSERT is conditional on a sufficient
// balance and on there being no other active Ranked run for the user; the
// wager debit then chains off that INSERT via changes()=1 AND an EXISTS on
// the freshly inserted run row. Both statements run in one D1 batch, so the
// run row and the initial stake debit apply or not as a single outcome. The
// changes()-chain is the proven pattern from the previous Ranked repository
// (see its RANKED_START_WAGER_DEDUCTION_SQL): the debit can only match when
// the immediately preceding INSERT actually inserted a row, which closes the
// duplicate-request race (a pre-existing run row would satisfy the EXISTS
// but not changes()=1).
const RANKED_RUN_INSERT_SQL = `INSERT INTO blackjack_run (
	id, userId, activeUserId, mode, periodKey, startRequestId, initialWager,
	seed, commandsJson, nextSequence, status, resultJson,
	dailyEndingBankroll, dailyRoundsCompleted, expiresAt, createdAt, updatedAt, settledAt
)
SELECT ?, ?, ?, 'ranked', NULL, ?, ?, ?, '[]', 0, 'active', NULL, NULL, NULL, ?, ?, ?, NULL
WHERE EXISTS (SELECT 1 FROM user WHERE id = ? AND chipBalance >= ?)
	AND NOT EXISTS (SELECT 1 FROM blackjack_run WHERE activeUserId = ? AND mode = 'ranked')
ON CONFLICT DO NOTHING`;

const RANKED_START_WAGER_DEDUCTION_SQL = `UPDATE user
SET chipBalance = chipBalance - ?, updatedAt = ?
WHERE id = ?
	AND chipBalance >= ?
	AND changes() = 1
	AND EXISTS (
		SELECT 1 FROM blackjack_run
		WHERE id = ? AND userId = ? AND activeUserId = ? AND mode = 'ranked' AND status = 'active'
	)`;

const RANKED_COMMAND_APPEND_SQL = `UPDATE blackjack_run
SET commandsJson = ?, nextSequence = nextSequence + 1, updatedAt = ?
WHERE id = ? AND userId = ? AND activeUserId = ? AND mode = 'ranked'
	AND status = 'active' AND nextSequence = ?
	AND EXISTS (SELECT 1 FROM user WHERE id = ? AND chipBalance >= ?)`;

// Guarded atomic Ranked action: the command append runs first (its own CAS on
// the run state plus a pre-debit balance check), then the additional-wager
// debit chains off the append in the same D1 batch. The append is the batch's
// first statement, so it never reads changes(): that would reflect arbitrary
// prior connection state. The debit keeps changes()=1, which anchors it to
// this batch's append — the append is the connection's most recent write, so
// a 1-row append lets the debit run while a 0-row append (CAS lost or
// insufficient balance, both decided before the debit runs) blocks the debit
// at changes()=0. A stale-sequence request therefore cannot move chips, and
// two concurrent batches at the same sequence can never both debit.
const RANKED_ACTION_WAGER_DEDUCTION_SQL = `UPDATE user
SET chipBalance = chipBalance - ?, updatedAt = ?
WHERE id = ?
	AND chipBalance >= ?
	AND changes() = 1
	AND EXISTS (
		SELECT 1 FROM blackjack_run
		WHERE id = ? AND userId = ? AND activeUserId = ? AND mode = 'ranked'
			AND status = 'active' AND nextSequence = ? AND commandsJson = ?
	)`;

const DAILY_RUN_INSERT_SQL = `INSERT INTO blackjack_run (
	id, userId, activeUserId, mode, periodKey, startRequestId, initialWager,
	seed, commandsJson, nextSequence, status, resultJson,
	dailyEndingBankroll, dailyRoundsCompleted, expiresAt, createdAt, updatedAt, settledAt
)
SELECT ?, ?, NULL, 'daily', ?, ?, NULL, ?, '[]', 0, 'active', NULL, NULL, NULL, ?, ?, ?, NULL
WHERE NOT EXISTS (SELECT 1 FROM blackjack_run WHERE userId = ? AND mode = 'daily' AND periodKey = ?)
ON CONFLICT DO NOTHING`;

const DAILY_COMMAND_APPEND_SQL = `UPDATE blackjack_run
SET commandsJson = ?, nextSequence = nextSequence + 1, updatedAt = ?
WHERE id = ? AND userId = ? AND activeUserId IS NULL AND mode = 'daily'
	AND status = 'active' AND nextSequence = ?`;

const RANKED_FINISH_SQL = `UPDATE blackjack_run
SET activeUserId = NULL, status = ?, resultJson = ?, dailyEndingBankroll = ?,
	dailyRoundsCompleted = ?, settledAt = ?, updatedAt = ?
WHERE id = ? AND userId = ? AND activeUserId = ? AND mode = 'ranked'
	AND status = 'active' AND nextSequence = ?`;

const DAILY_FINISH_SQL = `UPDATE blackjack_run
SET status = ?, resultJson = ?, dailyEndingBankroll = ?, dailyRoundsCompleted = ?,
	settledAt = ?, updatedAt = ?
WHERE id = ? AND userId = ? AND activeUserId IS NULL AND mode = 'daily'
	AND status = 'active' AND nextSequence = ?`;

const DAILY_LEADERBOARD_SQL = `WITH ranked AS (
	SELECT
		r.userId,
		u.name AS playerName,
		r.dailyEndingBankroll,
		r.dailyRoundsCompleted,
		r.settledAt,
		RANK() OVER (
			ORDER BY r.dailyEndingBankroll DESC, r.dailyRoundsCompleted DESC
		) AS rank
	FROM blackjack_run AS r
	JOIN user AS u ON u.id = r.userId
	WHERE r.mode = 'daily' AND r.periodKey = ? AND r.status = 'completed'
)
SELECT userId, playerName, dailyEndingBankroll, dailyRoundsCompleted, settledAt, rank
FROM ranked
ORDER BY
	dailyEndingBankroll DESC,
	dailyRoundsCompleted DESC,
	settledAt ASC,
	userId ASC
LIMIT ?`;

const DAILY_CURRENT_USER_RANK_SQL = `SELECT rank FROM (
	SELECT userId, RANK() OVER (
		ORDER BY dailyEndingBankroll DESC, dailyRoundsCompleted DESC
	) AS rank
	FROM blackjack_run
	WHERE mode = 'daily' AND periodKey = ? AND status = 'completed'
) WHERE userId = ?
LIMIT 1`;

const DAILY_TOTAL_ELIGIBLE_SQL = `SELECT COUNT(*) AS total
	FROM blackjack_run
	WHERE mode = 'daily' AND periodKey = ? AND status = 'completed'`;

const LIST_EXPIRED_FIRST_SQL = `SELECT id, expiresAt
	FROM blackjack_run
	WHERE status = 'active' AND expiresAt <= ?
	ORDER BY expiresAt ASC, id ASC
	LIMIT ?`;

const LIST_EXPIRED_CURSOR_SQL = `SELECT id, expiresAt
	FROM blackjack_run
	WHERE status = 'active' AND expiresAt <= ?
		AND (expiresAt > ? OR (expiresAt = ? AND id > ?))
	ORDER BY expiresAt ASC, id ASC
	LIMIT ?`;

const DAILY_PERIOD_SELECT_SQL = `SELECT periodKey, seed, createdAt
	FROM blackjack_daily
	WHERE periodKey = ?
	LIMIT 1`;

const DAILY_PERIOD_INSERT_SQL = `INSERT INTO blackjack_daily (periodKey, seed, createdAt)
VALUES (?, ?, ?)
ON CONFLICT (periodKey) DO NOTHING`;

function invariant(message: string): never {
	throw new BlackjackRunRepositoryInvariantError(message);
}

function readChanges(result: D1Result, label: string): number {
	const changes = result.meta.changes;
	if (changes !== 0 && changes !== 1) {
		return invariant(`Unexpected blackjack run ${label} mutation count`);
	}
	return changes;
}

function assertSafeNonNegativeInteger(value: number, label: string): void {
	if (!Number.isSafeInteger(value) || value < 0) {
		invariant(`Invalid blackjack run ${label}`);
	}
}

function parseRunRow(row: BlackjackRunRow): BlackjackRunRecord {
	if (row.mode !== 'ranked' && row.mode !== 'daily') {
		return invariant('Corrupt blackjack run mode');
	}
	if (!['active', 'settled', 'completed', 'forfeited', 'expired'].includes(row.status)) {
		return invariant('Corrupt blackjack run status');
	}
	assertSafeNonNegativeInteger(row.nextSequence, 'run nextSequence');
	assertSafeNonNegativeInteger(row.expiresAt, 'run expiresAt');
	assertSafeNonNegativeInteger(row.createdAt, 'run createdAt');
	assertSafeNonNegativeInteger(row.updatedAt, 'run updatedAt');
	if (row.settledAt !== null) assertSafeNonNegativeInteger(row.settledAt, 'run settledAt');
	try {
		const commands = blackjackRunCommandLogSchema.parse(
			JSON.parse(row.commandsJson),
		) as BlackjackRunCommand[];
		return {
			...row,
			mode: row.mode as BlackjackRunMode,
			status: row.status as BlackjackRunStatus,
			commands,
		};
	} catch (error) {
		if (error instanceof BlackjackRunRepositoryInvariantError) throw error;
		return invariant('Corrupt blackjack run commands JSON');
	}
}

async function readRun(
	db: D1Database,
	sql: string,
	...binds: unknown[]
): Promise<BlackjackRunRecord | null> {
	const row = await db
		.prepare(sql)
		.bind(...binds)
		.first<BlackjackRunRow>();
	return row === null ? null : parseRunRow(row);
}

async function executeRankedRunStart(
	db: D1Database,
	input: CreateRankedRunWithStakeInput,
): Promise<CreateRankedRunWithStakeResult> {
	assertSafeNonNegativeInteger(input.initialWager, 'start initialWager');
	assertSafeNonNegativeInteger(input.expiresAt, 'start expiresAt');
	assertSafeNonNegativeInteger(input.createdAt, 'start createdAt');
	assertSafeNonNegativeInteger(input.updatedAt, 'start updatedAt');
	if (typeof input.userId !== 'string' || input.userId.length === 0) {
		return invariant('Invalid blackjack run start user id');
	}
	if (typeof input.id !== 'string' || input.id.length === 0) {
		return invariant('Invalid blackjack run start run id');
	}
	if (typeof input.startRequestId !== 'string' || input.startRequestId.length === 0) {
		return invariant('Invalid blackjack run start request id');
	}

	const results = await db.batch([
		db
			.prepare(RANKED_RUN_INSERT_SQL)
			.bind(
				input.id,
				input.userId,
				input.userId,
				input.startRequestId,
				input.initialWager,
				input.seed,
				input.expiresAt,
				input.createdAt,
				input.updatedAt,
				input.userId,
				input.initialWager,
				input.userId,
			),
		db
			.prepare(RANKED_START_WAGER_DEDUCTION_SQL)
			.bind(
				input.initialWager,
				input.updatedAt,
				input.userId,
				input.initialWager,
				input.id,
				input.userId,
				input.userId,
			),
	]);
	const insertChanges = readChanges(results[0], 'start run insert');
	const wagerChanges = readChanges(results[1], 'start wager');

	if (insertChanges === 1) {
		if (wagerChanges !== 1) {
			return invariant('Ranked run inserted without its initial wager debit');
		}
		return { kind: 'applied' };
	}
	if (wagerChanges !== 0) {
		return invariant('Ranked start wager applied without a run insert');
	}
	const [duplicate, active] = await Promise.all([
		db
			.prepare(
				'SELECT 1 AS found FROM blackjack_run WHERE userId = ? AND startRequestId = ? LIMIT 1',
			)
			.bind(input.userId, input.startRequestId)
			.first<{ found: number }>(),
		db
			.prepare('SELECT 1 AS found FROM blackjack_run WHERE activeUserId = ? AND mode = ? LIMIT 1')
			.bind(input.userId, 'ranked')
			.first<{ found: number }>(),
	]);
	if (duplicate) return { kind: 'duplicate-request' };
	if (active) return { kind: 'active-exists' };
	return { kind: 'insufficient' };
}

async function executeDailyRunStart(
	db: D1Database,
	input: CreateDailyRunInput,
): Promise<CreateDailyRunResult> {
	assertSafeNonNegativeInteger(input.expiresAt, 'start expiresAt');
	assertSafeNonNegativeInteger(input.createdAt, 'start createdAt');
	assertSafeNonNegativeInteger(input.updatedAt, 'start updatedAt');
	if (typeof input.userId !== 'string' || input.userId.length === 0) {
		return invariant('Invalid blackjack run start user id');
	}
	if (typeof input.id !== 'string' || input.id.length === 0) {
		return invariant('Invalid blackjack run start run id');
	}
	if (typeof input.periodKey !== 'string' || input.periodKey.length === 0) {
		return invariant('Invalid blackjack run start period key');
	}

	const result = await db
		.prepare(DAILY_RUN_INSERT_SQL)
		.bind(
			input.id,
			input.userId,
			input.periodKey,
			input.startRequestId,
			input.seed,
			input.expiresAt,
			input.createdAt,
			input.updatedAt,
			input.userId,
			input.periodKey,
		)
		.run();
	return readChanges(result, 'daily run insert') === 1 ? { kind: 'created' } : { kind: 'existing' };
}

async function executeRankedCommandAppend(
	db: D1Database,
	input: AppendRankedCommandWithStakeInput,
): Promise<AppendRankedCommandWithStakeResult> {
	assertSafeNonNegativeInteger(input.expectedSequence, 'command expectedSequence');
	assertSafeNonNegativeInteger(input.additionalWager, 'command additionalWager');
	assertSafeNonNegativeInteger(input.nowSeconds, 'command nowSeconds');

	const appendStatement = db
		.prepare(RANKED_COMMAND_APPEND_SQL)
		.bind(
			input.commandsJson,
			input.nowSeconds,
			input.runId,
			input.userId,
			input.userId,
			input.expectedSequence,
			input.userId,
			input.additionalWager,
		);
	const statements: D1PreparedStatement[] = [appendStatement];
	if (input.additionalWager > 0) {
		statements.push(
			db
				.prepare(RANKED_ACTION_WAGER_DEDUCTION_SQL)
				.bind(
					input.additionalWager,
					input.nowSeconds,
					input.userId,
					input.additionalWager,
					input.runId,
					input.userId,
					input.userId,
					input.expectedSequence + 1,
					input.commandsJson,
				),
		);
	}
	const results = await db.batch(statements);
	const appendChanges = readChanges(results[0], 'command append');

	if (input.additionalWager === 0) {
		return appendChanges === 1 ? { kind: 'applied' } : { kind: 'not-applied' };
	}
	const wagerChanges = readChanges(results[1], 'action wager');
	if (appendChanges === 1) {
		if (wagerChanges !== 1) {
			return invariant('Ranked command append applied without its additional wager');
		}
		return { kind: 'applied' };
	}
	// A 0-row append blocks the debit: the debit's changes()=1 chains it to
	// this batch's append (the connection's most recent write), so append=0
	// forces debit=0. No concurrent batch can have applied this command, so
	// append=0 means the command is simply not in the log.
	const row = await db
		.prepare('SELECT status, nextSequence FROM blackjack_run WHERE id = ? AND userId = ? LIMIT 1')
		.bind(input.runId, input.userId)
		.first<{ status: string; nextSequence: number }>();
	if (row && row.status === 'active' && row.nextSequence === input.expectedSequence) {
		return { kind: 'insufficient' };
	}
	return { kind: 'not-applied' };
}

async function executeDailyCommandAppend(
	db: D1Database,
	input: AppendDailyCommandInput,
): Promise<AppendDailyCommandResult> {
	assertSafeNonNegativeInteger(input.expectedSequence, 'command expectedSequence');
	assertSafeNonNegativeInteger(input.nowSeconds, 'command nowSeconds');
	const result = await db
		.prepare(DAILY_COMMAND_APPEND_SQL)
		.bind(input.commandsJson, input.nowSeconds, input.runId, input.userId, input.expectedSequence)
		.run();
	return readChanges(result, 'daily command append') === 1
		? { kind: 'applied' }
		: { kind: 'not-applied' };
}

async function executeFinishRun(db: D1Database, input: FinishRunInput): Promise<FinishRunResult> {
	assertSafeNonNegativeInteger(input.expectedSequence, 'finish expectedSequence');
	assertSafeNonNegativeInteger(input.nowSeconds, 'finish nowSeconds');
	if (input.dailyEndingBankroll !== null) {
		assertSafeNonNegativeInteger(input.dailyEndingBankroll, 'finish dailyEndingBankroll');
	}
	if (input.dailyRoundsCompleted !== null) {
		assertSafeNonNegativeInteger(input.dailyRoundsCompleted, 'finish dailyRoundsCompleted');
	}
	if (input.mode === 'ranked') {
		const result = await db
			.prepare(RANKED_FINISH_SQL)
			.bind(
				input.status,
				input.resultJson,
				input.dailyEndingBankroll,
				input.dailyRoundsCompleted,
				input.nowSeconds,
				input.nowSeconds,
				input.runId,
				input.userId,
				input.userId,
				input.expectedSequence,
			)
			.run();
		return readChanges(result, 'ranked finish') === 1
			? { kind: 'applied' }
			: { kind: 'not-applied' };
	}
	const result = await db
		.prepare(DAILY_FINISH_SQL)
		.bind(
			input.status,
			input.resultJson,
			input.dailyEndingBankroll,
			input.dailyRoundsCompleted,
			input.nowSeconds,
			input.nowSeconds,
			input.runId,
			input.userId,
			input.expectedSequence,
		)
		.run();
	return readChanges(result, 'daily finish') === 1 ? { kind: 'applied' } : { kind: 'not-applied' };
}

export function createBlackjackRunRepository(db: D1Database): BlackjackRunRepository {
	return {
		createRankedRunWithStake(input) {
			return executeRankedRunStart(db, input);
		},
		createDailyRun(input) {
			return executeDailyRunStart(db, input);
		},
		findOwnedRun(userId, runId) {
			return readRun(
				db,
				'SELECT * FROM blackjack_run WHERE userId = ? AND id = ? LIMIT 1',
				userId,
				runId,
			);
		},
		findByStartRequest(userId, requestId) {
			return readRun(
				db,
				'SELECT * FROM blackjack_run WHERE userId = ? AND startRequestId = ? LIMIT 1',
				userId,
				requestId,
			);
		},
		findActiveRun(userId, mode) {
			return readRun(
				db,
				'SELECT * FROM blackjack_run WHERE activeUserId = ? AND mode = ? LIMIT 1',
				userId,
				mode,
			);
		},
		findDailyRun(userId, periodKey) {
			return readRun(
				db,
				'SELECT * FROM blackjack_run WHERE userId = ? AND mode = ? AND periodKey = ? LIMIT 1',
				userId,
				'daily',
				periodKey,
			);
		},
		appendRankedCommandWithStake(input) {
			return executeRankedCommandAppend(db, input);
		},
		appendDailyCommand(input) {
			return executeDailyCommandAppend(db, input);
		},
		finishRun(input) {
			return executeFinishRun(db, input);
		},
		async listExpiredPage(nowSeconds, cursor, limit) {
			assertSafeNonNegativeInteger(nowSeconds, 'expiration cutoff');
			if (!Number.isSafeInteger(limit) || limit < 1) {
				return invariant('Invalid blackjack run expiration page limit');
			}
			const boundedLimit = Math.min(limit, BLACKJACK_RUN_EXPIRATION_PAGE_SIZE);
			if (cursor) {
				assertSafeNonNegativeInteger(cursor.expiresAt, 'expiration cursor expiresAt');
				if (typeof cursor.id !== 'string' || cursor.id.length === 0) {
					return invariant('Invalid blackjack run expiration cursor id');
				}
				const rows = await db
					.prepare(LIST_EXPIRED_CURSOR_SQL)
					.bind(nowSeconds, cursor.expiresAt, cursor.expiresAt, cursor.id, boundedLimit)
					.all<{ id: string; expiresAt: number }>();
				return rows.results.map(({ id, expiresAt }) => ({ id, expiresAt }));
			}
			const rows = await db
				.prepare(LIST_EXPIRED_FIRST_SQL)
				.bind(nowSeconds, boundedLimit)
				.all<{ id: string; expiresAt: number }>();
			return rows.results.map(({ id, expiresAt }) => ({ id, expiresAt }));
		},
		async getOrCreateDaily(periodKey, seedFactory, nowSeconds) {
			assertSafeNonNegativeInteger(nowSeconds, 'daily createdAt');
			if (typeof periodKey !== 'string' || periodKey.length === 0) {
				return invariant('Invalid blackjack daily period key');
			}
			const existing = await db
				.prepare(DAILY_PERIOD_SELECT_SQL)
				.bind(periodKey)
				.first<BlackjackDailyRecord>();
			if (existing) return existing;
			const seed = seedFactory();
			const result = await db
				.prepare(DAILY_PERIOD_INSERT_SQL)
				.bind(periodKey, seed, nowSeconds)
				.run();
			if (readChanges(result, 'daily period insert') === 1) {
				return { periodKey, seed, createdAt: nowSeconds };
			}
			// Lost the create race; read the winner's row.
			const raced = await db
				.prepare(DAILY_PERIOD_SELECT_SQL)
				.bind(periodKey)
				.first<BlackjackDailyRecord>();
			if (raced === null) return invariant('Daily period insert lost its race without a winner');
			return raced;
		},
		async listDailyLeaderboard(periodKey, limit, userId) {
			if (!Number.isSafeInteger(limit) || limit < 1) {
				return invariant('Invalid blackjack run leaderboard limit');
			}
			const rows = await db
				.prepare(DAILY_LEADERBOARD_SQL)
				.bind(periodKey, limit)
				.all<DailyLeaderboardEntry>();
			const entries = rows.results;
			if (!userId) return { entries, currentUser: null };
			const [rankRow, totalRow] = await Promise.all([
				db.prepare(DAILY_CURRENT_USER_RANK_SQL).bind(periodKey, userId).first<{ rank: number }>(),
				db.prepare(DAILY_TOTAL_ELIGIBLE_SQL).bind(periodKey).first<{ total: number }>(),
			]);
			if (!rankRow || !totalRow) return { entries, currentUser: null };
			const totalEligible = totalRow.total;
			if (!Number.isSafeInteger(totalEligible) || totalEligible < 1) {
				return { entries, currentUser: null };
			}
			const rank = rankRow.rank;
			if (!Number.isSafeInteger(rank) || rank < 1) {
				return invariant('Corrupt blackjack run current-user rank');
			}
			const percentile = calculateDailyPercentile(totalEligible, rank - 1);
			return { entries, currentUser: { rank, totalEligible, percentile } };
		},
	};
}
