import { z } from 'zod';
import { BLACKJACK_DAILY_V1_CONFIG } from '../../lib/daily-challenge/config';
import {
	type DailyChallengeCommandV1,
	type DailyChallengeReceiptV1,
	type DailyChallengeTerminalReason,
	dailyChallengeCommandLogSchema,
} from '../../lib/daily-challenge/protocol';
import { calculateDailyChallengePercentile } from '../../lib/daily-challenge/scoring';
import {
	type RankedJson,
	canonicalizeRanked,
	decodeCanonicalBase64Url,
	hashCanonical,
	sha256Hex,
} from '../../lib/ranked/canonical';

export type DailyChallengeConfig = typeof BLACKJACK_DAILY_V1_CONFIG;

const blackjackDailyV1ConfigSchema = z
	.object({
		challengeKind: z.literal('blackjack-daily'),
		challengeRulesetVersion: z.literal('blackjack-daily-v1'),
		gameType: z.literal('blackjack'),
		gameRulesetVersion: z.literal('blackjack-ranked-v1'),
		scoreVersion: z.literal('blackjack-daily-score-v1'),
		startingBankroll: z.literal(BLACKJACK_DAILY_V1_CONFIG.startingBankroll),
		roundCount: z.literal(BLACKJACK_DAILY_V1_CONFIG.roundCount),
		minimumWager: z.literal(BLACKJACK_DAILY_V1_CONFIG.minimumWager),
		maximumWager: z.literal(BLACKJACK_DAILY_V1_CONFIG.maximumWager),
		attemptTtlSeconds: z.literal(BLACKJACK_DAILY_V1_CONFIG.attemptTtlSeconds),
		rankedEntryCloseOffsetSeconds: z.literal(
			BLACKJACK_DAILY_V1_CONFIG.rankedEntryCloseOffsetSeconds,
		),
	})
	.strict();

const dailyChallengeStatusSchema = z.enum(['active', 'completed', 'forfeited', 'expired']);
const dailyChallengeSafeIntegerSchema = z
	.number()
	.refine((value) => Number.isSafeInteger(value) && !Object.is(value, -0));
const dailyChallengeSeedSchema = z.string().refine((value) => {
	try {
		decodeCanonicalBase64Url(value);
		return true;
	} catch {
		return false;
	}
}, 'Invalid canonical base64url seed');
const dailyChallengeHex64Schema = z.string().regex(/^[0-9a-f]{64}$/);

export class DailyChallengeRepositoryInvariantError extends Error {
	constructor(message = 'Daily Challenge repository invariant failed') {
		super(message);
		this.name = 'DailyChallengeRepositoryInvariantError';
	}
}

export interface NewDailyChallengeRecord {
	id: string;
	challengeKind: 'blackjack-daily';
	periodKey: string;
	challengeRulesetVersion: 'blackjack-daily-v1';
	gameRulesetVersion: 'blackjack-ranked-v1';
	scoreVersion: 'blackjack-daily-score-v1';
	configJson: string;
	configHash: string;
	rankedSeed: string;
	rankedSeedCommitment: string;
	practiceSeed: string;
	startsAt: number;
	rankedEntryClosesAt: number;
	endsAt: number;
	createdAt: number;
}

export interface DailyChallengeRecord extends NewDailyChallengeRecord {
	config: DailyChallengeConfig;
}

export interface NewDailyChallengeAttemptRecord {
	id: string;
	challengeId: string;
	userId: string;
	startRequestId: string;
	startPayloadHash: string;
	status: 'active' | 'completed' | 'forfeited' | 'expired';
	actionLogJson: string;
	actionLogHash: string;
	nextCommandSequence: number;
	availableBankroll: number;
	roundsCompleted: number;
	expiresAt: number;
	createdAt: number;
	updatedAt: number;
	settledAt: number | null;
}

export interface DailyChallengeAttemptRecord extends NewDailyChallengeAttemptRecord {
	actionLog: DailyChallengeCommandV1[];
}

type DailyChallengeRow = Omit<DailyChallengeRecord, 'config'>;
type DailyChallengeAttemptRow = Omit<DailyChallengeAttemptRecord, 'actionLog' | 'status'> & {
	status: string;
};

export interface DailyChallengeStartTransitionInput {
	userId: string;
	attempt: NewDailyChallengeAttemptRecord;
	rateLimitStatement: D1PreparedStatement;
	retryAfter: number;
}

export type DailyChallengeStartTransitionResult =
	| { kind: 'created' }
	| { kind: 'not-created' }
	| { kind: 'rate-limited'; retryAfter: number };

export interface DailyChallengeTerminalTransition {
	challengeId: string;
	periodKey: string;
	challengeRulesetVersion: 'blackjack-daily-v1';
	gameRulesetVersion: 'blackjack-ranked-v1';
	scoreVersion: 'blackjack-daily-score-v1';
	configHash: string;
	rankedSeedCommitment: string;
	eligible: boolean;
	terminalReason: DailyChallengeTerminalReason;
	durationSeconds: number;
	receiptHash: string;
}

export interface DailyChallengeCommandTransitionInput {
	userId: string;
	attemptId: string;
	expectedSequence: number;
	expectedActionLogHash: string;
	expectedAvailableBankroll: number;
	expectedRoundsCompleted: number;
	nextActionLogJson: string;
	nextActionLogHash: string;
	nextCommandSequence: number;
	availableBankroll: number;
	roundsCompleted: number;
	nowSeconds: number;
	terminal?: DailyChallengeTerminalTransition;
	rateLimitStatement?: D1PreparedStatement;
	retryAfter?: number;
}

export interface DailyChallengeResultRecord {
	attemptId: string;
	challengeId: string;
	userId: string;
	endingBankroll: number;
	roundsCompleted: number;
	eligible: boolean;
	terminalReason: DailyChallengeTerminalReason;
	durationSeconds: number;
	scoreVersion: 'blackjack-daily-score-v1';
	configHash: string;
	rankedSeedCommitment: string;
	actionLogHash: string;
	receiptHash: string;
	createdAt: number;
	settledAt: number;
	periodKey: string;
	challengeRulesetVersion: 'blackjack-daily-v1';
	gameRulesetVersion: 'blackjack-ranked-v1';
}

export type DailyChallengeCommandTransitionResult =
	| { kind: 'applied'; result: DailyChallengeResultRecord | null }
	| { kind: 'not-applied' }
	| { kind: 'rate-limited'; retryAfter: number };

export interface DailyChallengeLeaderboardEntry {
	rank: number;
	userId: string;
	playerName: string;
	endingBankroll: number;
	roundsCompleted: number;
	durationSeconds: number;
	settledAt: number;
}

export interface DailyChallengeCurrentUserStanding {
	rank: number;
	totalEligible: number;
	percentile: number;
}

export interface DailyChallengeLeaderboardRead {
	entries: readonly DailyChallengeLeaderboardEntry[];
	currentUser: DailyChallengeCurrentUserStanding | null;
}

export interface DailyChallengeHistoryUserResult {
	endingBankroll: number;
	roundsCompleted: number;
	terminalReason: DailyChallengeTerminalReason;
	eligible: boolean;
	settledAt: number;
}

export interface DailyChallengeHistoryEntry {
	periodKey: string;
	challengeRulesetVersion: 'blackjack-daily-v1';
	topEndingBankroll: number | null;
	participantCount: number;
	userResult: DailyChallengeHistoryUserResult | null;
}

export interface DailyChallengeHistoryRead {
	entries: readonly DailyChallengeHistoryEntry[];
}

export interface DailyChallengeExpirationCursor {
	readonly expiresAt: number;
	readonly id: string;
}

export interface DailyChallengeExpirationRow {
	readonly id: string;
	readonly expiresAt: number;
}

export interface DailyChallengeRepository {
	findChallengeByPeriodKey(
		challengeKind: 'blackjack-daily',
		periodKey: string,
	): Promise<DailyChallengeRecord | null>;
	insertChallengeIfAbsent(record: NewDailyChallengeRecord): Promise<'inserted' | 'existing'>;
	findAttemptByUserAndRequestId(
		userId: string,
		startRequestId: string,
	): Promise<DailyChallengeAttemptRecord | null>;
	findAttemptByChallengeAndUser(
		challengeId: string,
		userId: string,
	): Promise<DailyChallengeAttemptRecord | null>;
	findAttemptById(attemptId: string): Promise<DailyChallengeAttemptRecord | null>;
	findChallengeById(challengeId: string): Promise<DailyChallengeRecord | null>;
	runStartTransition(
		input: DailyChallengeStartTransitionInput,
	): Promise<DailyChallengeStartTransitionResult>;
	runCommandTransition(
		input: DailyChallengeCommandTransitionInput,
	): Promise<DailyChallengeCommandTransitionResult>;
	findResultByAttempt(attemptId: string): Promise<DailyChallengeResultRecord | null>;
	readLeaderboard(
		challengeId: string,
		limit: number,
		currentUserId?: string | null,
	): Promise<DailyChallengeLeaderboardRead>;
	listChallengeHistory(
		limit: number,
		currentUserId?: string | null,
	): Promise<DailyChallengeHistoryRead>;
	listExpiredAttempts(
		nowSeconds: number,
		cursor?: DailyChallengeExpirationCursor | null,
	): Promise<readonly DailyChallengeExpirationRow[]>;
	deleteTerminalAttemptsBefore(cutoffSeconds: number): Promise<number>;
}

const INSERT_CHALLENGE_SQL = `INSERT INTO daily_challenge (
	id, challengeKind, periodKey, challengeRulesetVersion, gameRulesetVersion,
	scoreVersion, configJson, configHash, rankedSeed, rankedSeedCommitment, practiceSeed,
	startsAt, rankedEntryClosesAt, endsAt, createdAt
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (challengeKind, periodKey) DO NOTHING`;

const INSERT_ATTEMPT_SQL = `INSERT INTO daily_challenge_attempt (
	id, challengeId, userId, startRequestId, startPayloadHash, status,
	actionLogJson, actionLogHash, nextCommandSequence, availableBankroll,
	roundsCompleted, expiresAt, createdAt, updatedAt
)
SELECT ?, ?, ?, ?, ?, 'active', ?, ?, 0, ?, 0, ?, ?, ?
WHERE changes() = 1
ON CONFLICT DO NOTHING`;

const UPDATE_ATTEMPT_SQL = `UPDATE daily_challenge_attempt
SET actionLogJson = ?,
	actionLogHash = ?,
	nextCommandSequence = ?,
	availableBankroll = ?,
	roundsCompleted = ?,
	status = ?,
	updatedAt = ?,
	settledAt = ?
WHERE id = ?
	AND userId = ?
	AND status = 'active'
	AND nextCommandSequence = ?
	AND actionLogHash = ?
	AND availableBankroll = ?
	AND roundsCompleted = ?`;

// Command transitions that consumed an authenticated command rate-limit unit
// couple the guarded attempt update to the rate-limit continuation statement
// inside the same atomic batch: the update only applies when the preceding
// continuation statement matched exactly one rate-limit row (count still
// within the approved limit), mirroring the start-transition guard.
const UPDATE_ATTEMPT_WITH_RATE_SQL = `UPDATE daily_challenge_attempt
SET actionLogJson = ?,
	actionLogHash = ?,
	nextCommandSequence = ?,
	availableBankroll = ?,
	roundsCompleted = ?,
	status = ?,
	updatedAt = ?,
	settledAt = ?
WHERE id = ?
	AND userId = ?
	AND status = 'active'
	AND nextCommandSequence = ?
	AND actionLogHash = ?
	AND availableBankroll = ?
	AND roundsCompleted = ?
	AND changes() = 1`;

const INSERT_RESULT_AFTER_TERMINAL_SQL = `INSERT INTO daily_challenge_result (
	attemptId, challengeId, userId, endingBankroll, roundsCompleted,
	eligible, terminalReason, durationSeconds, scoreVersion, configHash,
	rankedSeedCommitment, actionLogHash, receiptHash, createdAt, settledAt
)
SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
WHERE changes() = 1`;

const FIND_RESULT_BY_ATTEMPT_SQL = `SELECT
		r.attemptId, r.challengeId, r.userId, r.endingBankroll, r.roundsCompleted,
		r.eligible, r.terminalReason, r.durationSeconds, r.scoreVersion, r.configHash,
		r.rankedSeedCommitment, r.actionLogHash, r.receiptHash, r.createdAt, r.settledAt,
		c.periodKey, c.challengeRulesetVersion, c.gameRulesetVersion
	FROM daily_challenge_result AS r
	JOIN daily_challenge AS c ON c.id = r.challengeId
	WHERE r.attemptId = ?
	LIMIT 1`;

const LEADERBOARD_SQL = `WITH ranked AS (
	SELECT
		r.challengeId,
		r.userId,
		u.name AS playerName,
		r.endingBankroll,
		r.roundsCompleted,
		r.durationSeconds,
		r.settledAt,
		RANK() OVER (
			ORDER BY r.endingBankroll DESC, r.roundsCompleted DESC
		) AS rank
	FROM daily_challenge_result AS r
	JOIN user AS u ON u.id = r.userId
	WHERE r.challengeId = ?
		AND r.eligible = 1
)
SELECT *
FROM ranked
ORDER BY
	endingBankroll DESC,
	roundsCompleted DESC,
	settledAt ASC,
	userId ASC
LIMIT ?`;

const CURRENT_USER_RANK_SQL = `SELECT rank FROM (
	SELECT userId, RANK() OVER (
			ORDER BY endingBankroll DESC, roundsCompleted DESC
		) AS rank
	FROM daily_challenge_result
	WHERE challengeId = ? AND eligible = 1
) WHERE userId = ?
LIMIT 1`;

const TOTAL_ELIGIBLE_SQL = `SELECT COUNT(*) AS total
	FROM daily_challenge_result
	WHERE challengeId = ? AND eligible = 1`;

const HISTORY_SQL = `WITH recent AS (
	SELECT id, periodKey, challengeRulesetVersion, endsAt
	FROM daily_challenge
	WHERE challengeKind = 'blackjack-daily'
	ORDER BY endsAt DESC, periodKey DESC
	LIMIT ?
)
SELECT
	c.periodKey,
	c.challengeRulesetVersion,
	(
		SELECT endingBankroll
		FROM daily_challenge_result
		WHERE challengeId = c.id AND eligible = 1
		ORDER BY endingBankroll DESC, roundsCompleted DESC, settledAt ASC, userId ASC
		LIMIT 1
	) AS topEndingBankroll,
	(
		SELECT COUNT(*)
		FROM daily_challenge_result
		WHERE challengeId = c.id AND eligible = 1
	) AS participantCount,
	r.endingBankroll AS userEndingBankroll,
	r.roundsCompleted AS userRoundsCompleted,
	r.terminalReason AS userTerminalReason,
	r.eligible AS userEligible,
	r.settledAt AS userSettledAt
FROM recent AS c
LEFT JOIN daily_challenge_result AS r ON r.challengeId = c.id AND r.userId = ?
ORDER BY c.periodKey DESC`;

const LIST_EXPIRED_ATTEMPTS_SQL = `SELECT id, expiresAt
	FROM daily_challenge_attempt
	WHERE status = 'active' AND expiresAt <= ?
		AND (expiresAt > ? OR (expiresAt = ? AND id > ?))
	ORDER BY expiresAt ASC, id ASC
	LIMIT `;

const LIST_EXPIRED_ATTEMPTS_FIRST_SQL = `SELECT id, expiresAt
	FROM daily_challenge_attempt
	WHERE status = 'active' AND expiresAt <= ?
	ORDER BY expiresAt ASC, id ASC
	LIMIT `;

const DELETE_TERMINAL_BEFORE_SQL = `DELETE FROM daily_challenge_attempt
	WHERE status <> 'active' AND settledAt < ?`;

export const DAILY_CHALLENGE_LEADERBOARD_LIMIT = 50;
const DAILY_CHALLENGE_HISTORY_MAX_LIMIT = 100;
const DAILY_CHALLENGE_EXPIRATION_PAGE_SIZE = 100;

const dailyChallengeTerminalReasonSchema = z.enum([
	'completed',
	'bankroll-below-minimum',
	'forfeited',
	'expired',
]);

type DailyChallengeReceiptSource = Omit<DailyChallengeReceiptV1, 'receiptHash'>;

type DailyChallengeResultRow = {
	attemptId: string;
	challengeId: string;
	userId: string;
	endingBankroll: number;
	roundsCompleted: number;
	eligible: number | boolean;
	terminalReason: string;
	durationSeconds: number;
	scoreVersion: string;
	configHash: string;
	rankedSeedCommitment: string;
	actionLogHash: string;
	receiptHash: string;
	createdAt: number;
	settledAt: number;
	periodKey: string;
	challengeRulesetVersion: string;
	gameRulesetVersion: string;
};

type DailyChallengeLeaderboardRow = {
	rank: number;
	userId: string;
	playerName: string;
	endingBankroll: number;
	roundsCompleted: number;
	durationSeconds: number;
	settledAt: number;
};

type DailyChallengeHistoryRow = {
	periodKey: string;
	challengeRulesetVersion: string;
	topEndingBankroll: number | null;
	participantCount: number;
	userEndingBankroll: number | null;
	userRoundsCompleted: number | null;
	userTerminalReason: string | null;
	userEligible: number | boolean | null;
	userSettledAt: number | null;
};

function invariant(message: string): never {
	throw new DailyChallengeRepositoryInvariantError(message);
}

function parseCanonicalJson(raw: string, label: string): RankedJson {
	try {
		const parsed = JSON.parse(raw) as RankedJson;
		if (canonicalizeRanked(parsed) !== raw) invariant(`Corrupt daily challenge ${label}`);
		return parsed;
	} catch (error) {
		if (error instanceof DailyChallengeRepositoryInvariantError) throw error;
		return invariant(`Corrupt daily challenge ${label}`);
	}
}

function readChanges(result: D1Result, label: string): number {
	const changes = result.meta.changes;
	if (changes !== 0 && changes !== 1) {
		return invariant(`Unexpected daily challenge ${label} mutation count`);
	}
	return changes;
}

function assertSafeNonNegativeInteger(value: number, label: string): void {
	if (!Number.isSafeInteger(value) || value < 0) {
		invariant(`Invalid daily challenge ${label}`);
	}
}

function parseChallengeRow(row: DailyChallengeRow): DailyChallengeRecord {
	if (
		row.challengeKind !== 'blackjack-daily' ||
		row.challengeRulesetVersion !== 'blackjack-daily-v1' ||
		row.gameRulesetVersion !== 'blackjack-ranked-v1' ||
		row.scoreVersion !== 'blackjack-daily-score-v1'
	) {
		return invariant('Unsupported persisted daily challenge version');
	}
	assertSafeNonNegativeInteger(row.startsAt, 'challenge startsAt');
	assertSafeNonNegativeInteger(row.rankedEntryClosesAt, 'challenge rankedEntryClosesAt');
	assertSafeNonNegativeInteger(row.endsAt, 'challenge endsAt');
	assertSafeNonNegativeInteger(row.createdAt, 'challenge createdAt');
	try {
		const configJson = parseCanonicalJson(row.configJson, 'challenge config JSON');
		const config = blackjackDailyV1ConfigSchema.parse(configJson);
		if (sha256Hex(row.configJson) !== row.configHash) {
			return invariant('Corrupt daily challenge config hash');
		}
		dailyChallengeSeedSchema.parse(row.rankedSeed);
		dailyChallengeSeedSchema.parse(row.practiceSeed);
		dailyChallengeHex64Schema.parse(row.rankedSeedCommitment);
		return { ...row, config };
	} catch (error) {
		if (error instanceof DailyChallengeRepositoryInvariantError) throw error;
		return invariant('Corrupt daily challenge config JSON');
	}
}

function parseAttemptRow(row: DailyChallengeAttemptRow): DailyChallengeAttemptRecord {
	const status = dailyChallengeStatusSchema.safeParse(row.status);
	if (!status.success) return invariant('Corrupt daily challenge attempt status');
	if (row.nextCommandSequence < 0 || !Number.isSafeInteger(row.nextCommandSequence)) {
		return invariant('Corrupt daily challenge attempt sequence');
	}
	assertSafeNonNegativeInteger(row.availableBankroll, 'attempt availableBankroll');
	assertSafeNonNegativeInteger(row.roundsCompleted, 'attempt roundsCompleted');
	assertSafeNonNegativeInteger(row.expiresAt, 'attempt expiresAt');
	assertSafeNonNegativeInteger(row.createdAt, 'attempt createdAt');
	assertSafeNonNegativeInteger(row.updatedAt, 'attempt updatedAt');
	if (row.settledAt !== null) assertSafeNonNegativeInteger(row.settledAt, 'attempt settledAt');
	dailyChallengeSafeIntegerSchema.parse(row.nextCommandSequence);
	try {
		const actionLogJson = parseCanonicalJson(row.actionLogJson, 'attempt action-log JSON');
		const actionLog = dailyChallengeCommandLogSchema.parse(
			actionLogJson,
		) as DailyChallengeCommandV1[];
		if (sha256Hex(row.actionLogJson) !== row.actionLogHash) {
			return invariant('Corrupt daily challenge attempt action-log hash');
		}
		dailyChallengeHex64Schema.parse(row.startPayloadHash);
		return {
			...row,
			status: status.data,
			actionLog,
		};
	} catch (error) {
		if (error instanceof DailyChallengeRepositoryInvariantError) throw error;
		return invariant('Corrupt daily challenge attempt JSON');
	}
}

function bindChallengeInsert(db: D1Database, record: NewDailyChallengeRecord): D1PreparedStatement {
	return db
		.prepare(INSERT_CHALLENGE_SQL)
		.bind(
			record.id,
			record.challengeKind,
			record.periodKey,
			record.challengeRulesetVersion,
			record.gameRulesetVersion,
			record.scoreVersion,
			record.configJson,
			record.configHash,
			record.rankedSeed,
			record.rankedSeedCommitment,
			record.practiceSeed,
			record.startsAt,
			record.rankedEntryClosesAt,
			record.endsAt,
			record.createdAt,
		);
}

function bindAttemptInsert(
	db: D1Database,
	attempt: NewDailyChallengeAttemptRecord,
): D1PreparedStatement {
	return db
		.prepare(INSERT_ATTEMPT_SQL)
		.bind(
			attempt.id,
			attempt.challengeId,
			attempt.userId,
			attempt.startRequestId,
			attempt.startPayloadHash,
			attempt.actionLogJson,
			attempt.actionLogHash,
			attempt.availableBankroll,
			attempt.expiresAt,
			attempt.createdAt,
			attempt.updatedAt,
		);
}

function assertStartAttemptInvariant(
	attempt: NewDailyChallengeAttemptRecord,
	userId: string,
): void {
	if (attempt.userId !== userId) invariant('Daily challenge start user mismatch');
	if (attempt.status !== 'active') invariant('Daily challenge start status must be active');
	if (attempt.nextCommandSequence !== 0) invariant('Daily challenge start sequence must be zero');
	if (attempt.roundsCompleted !== 0) invariant('Daily challenge start rounds must be zero');
	if (attempt.settledAt !== null) invariant('Daily challenge start settledAt must be null');
	assertSafeNonNegativeInteger(attempt.availableBankroll, 'start availableBankroll');
	assertSafeNonNegativeInteger(attempt.expiresAt, 'start expiresAt');
	assertSafeNonNegativeInteger(attempt.createdAt, 'start createdAt');
	assertSafeNonNegativeInteger(attempt.updatedAt, 'start updatedAt');
}

async function executeStartTransition(
	db: D1Database,
	input: DailyChallengeStartTransitionInput,
): Promise<DailyChallengeStartTransitionResult> {
	assertStartAttemptInvariant(input.attempt, input.userId);
	const results = await db.batch([input.rateLimitStatement, bindAttemptInsert(db, input.attempt)]);
	const rateChanges = readChanges(results[0], 'start rate');
	const attemptChanges = readChanges(results[1], 'start attempt');
	if (rateChanges === 0) {
		if (attemptChanges !== 0) {
			return invariant('Denied daily challenge start rate allowed attempt creation');
		}
		return { kind: 'rate-limited', retryAfter: input.retryAfter };
	}
	if (attemptChanges === 1) return { kind: 'created' };
	return { kind: 'not-created' };
}

function terminalReasonToStatus(
	reason: DailyChallengeTerminalReason,
): 'completed' | 'forfeited' | 'expired' {
	if (reason === 'forfeited') return 'forfeited';
	if (reason === 'expired') return 'expired';
	return 'completed';
}

function coerceBoolean(value: number | boolean, label: string): boolean {
	if (value === true) return true;
	if (value === false) return false;
	if (value === 1) return true;
	if (value === 0) return false;
	return invariant(`Corrupt daily challenge ${label}`);
}

function buildReceiptSource(
	input: DailyChallengeCommandTransitionInput,
	terminal: DailyChallengeTerminalTransition,
): DailyChallengeReceiptSource {
	return {
		attemptId: input.attemptId,
		challengeId: terminal.challengeId,
		periodKey: terminal.periodKey,
		challengeRulesetVersion: terminal.challengeRulesetVersion,
		gameRulesetVersion: terminal.gameRulesetVersion,
		scoreVersion: terminal.scoreVersion,
		configHash: terminal.configHash,
		rankedSeedCommitment: terminal.rankedSeedCommitment,
		actionLogHash: input.nextActionLogHash,
		endingBankroll: input.availableBankroll,
		roundsCompleted: input.roundsCompleted,
		eligible: terminal.eligible,
		terminalReason: terminal.terminalReason,
		durationSeconds: terminal.durationSeconds,
		settledAt: input.nowSeconds,
	};
}

function validateTerminal(
	input: DailyChallengeCommandTransitionInput,
	terminal: DailyChallengeTerminalTransition,
): DailyChallengeTerminalTransition {
	if (
		typeof terminal.challengeId !== 'string' ||
		!/^[A-Za-z0-9_-]{16,64}$/.test(terminal.challengeId)
	) {
		return invariant('Invalid daily challenge terminal challenge id');
	}
	if (terminal.challengeRulesetVersion !== 'blackjack-daily-v1') {
		return invariant('Invalid daily challenge terminal challenge ruleset');
	}
	if (terminal.gameRulesetVersion !== 'blackjack-ranked-v1') {
		return invariant('Invalid daily challenge terminal game ruleset');
	}
	if (terminal.scoreVersion !== 'blackjack-daily-score-v1') {
		return invariant('Invalid daily challenge terminal score version');
	}
	if (!/^\d{4}-\d{2}-\d{2}$/.test(terminal.periodKey)) {
		return invariant('Invalid daily challenge terminal period key');
	}
	dailyChallengeHex64Schema.parse(terminal.configHash);
	dailyChallengeHex64Schema.parse(terminal.rankedSeedCommitment);
	dailyChallengeHex64Schema.parse(terminal.receiptHash);
	assertSafeNonNegativeInteger(terminal.durationSeconds, 'terminal duration');
	assertSafeNonNegativeInteger(input.nowSeconds, 'terminal settledAt');
	const source = buildReceiptSource(input, terminal);
	if (hashCanonical(source) !== terminal.receiptHash) {
		return invariant('Daily challenge terminal receipt hash mismatch');
	}
	return terminal;
}

function parseResultRow(row: DailyChallengeResultRow): DailyChallengeResultRecord {
	if (row.challengeRulesetVersion !== 'blackjack-daily-v1') {
		return invariant('Unsupported persisted daily challenge result challenge ruleset');
	}
	if (row.gameRulesetVersion !== 'blackjack-ranked-v1') {
		return invariant('Unsupported persisted daily challenge result game ruleset');
	}
	if (row.scoreVersion !== 'blackjack-daily-score-v1') {
		return invariant('Unsupported persisted daily challenge result score version');
	}
	const reason = dailyChallengeTerminalReasonSchema.safeParse(row.terminalReason);
	if (!reason.success) return invariant('Corrupt daily challenge result terminal reason');
	if (!/^\d{4}-\d{2}-\d{2}$/.test(row.periodKey)) {
		return invariant('Corrupt daily challenge result period key');
	}
	const eligible = coerceBoolean(row.eligible, 'result eligible');
	assertSafeNonNegativeInteger(row.endingBankroll, 'result endingBankroll');
	assertSafeNonNegativeInteger(row.roundsCompleted, 'result roundsCompleted');
	assertSafeNonNegativeInteger(row.durationSeconds, 'result durationSeconds');
	assertSafeNonNegativeInteger(row.createdAt, 'result createdAt');
	assertSafeNonNegativeInteger(row.settledAt, 'result settledAt');
	dailyChallengeHex64Schema.parse(row.configHash);
	dailyChallengeHex64Schema.parse(row.rankedSeedCommitment);
	dailyChallengeHex64Schema.parse(row.actionLogHash);
	dailyChallengeHex64Schema.parse(row.receiptHash);
	const source: DailyChallengeReceiptSource = {
		attemptId: row.attemptId,
		challengeId: row.challengeId,
		periodKey: row.periodKey,
		challengeRulesetVersion: 'blackjack-daily-v1',
		gameRulesetVersion: 'blackjack-ranked-v1',
		scoreVersion: 'blackjack-daily-score-v1',
		configHash: row.configHash,
		rankedSeedCommitment: row.rankedSeedCommitment,
		actionLogHash: row.actionLogHash,
		endingBankroll: row.endingBankroll,
		roundsCompleted: row.roundsCompleted,
		eligible,
		terminalReason: reason.data,
		durationSeconds: row.durationSeconds,
		settledAt: row.settledAt,
	};
	if (hashCanonical(source) !== row.receiptHash) {
		return invariant('Corrupt daily challenge result receipt hash');
	}
	return {
		attemptId: row.attemptId,
		challengeId: row.challengeId,
		userId: row.userId,
		endingBankroll: row.endingBankroll,
		roundsCompleted: row.roundsCompleted,
		eligible,
		terminalReason: reason.data,
		durationSeconds: row.durationSeconds,
		scoreVersion: 'blackjack-daily-score-v1',
		configHash: row.configHash,
		rankedSeedCommitment: row.rankedSeedCommitment,
		actionLogHash: row.actionLogHash,
		receiptHash: row.receiptHash,
		createdAt: row.createdAt,
		settledAt: row.settledAt,
		periodKey: row.periodKey,
		challengeRulesetVersion: 'blackjack-daily-v1',
		gameRulesetVersion: 'blackjack-ranked-v1',
	};
}

function parseLeaderboardRow(row: DailyChallengeLeaderboardRow): DailyChallengeLeaderboardEntry {
	assertSafeNonNegativeInteger(row.rank, 'leaderboard rank');
	if (row.rank < 1) return invariant('Corrupt daily challenge leaderboard rank');
	if (typeof row.userId !== 'string' || row.userId.length === 0) {
		return invariant('Corrupt daily challenge leaderboard user id');
	}
	if (typeof row.playerName !== 'string' || row.playerName.length === 0) {
		return invariant('Corrupt daily challenge leaderboard player name');
	}
	assertSafeNonNegativeInteger(row.endingBankroll, 'leaderboard endingBankroll');
	assertSafeNonNegativeInteger(row.roundsCompleted, 'leaderboard roundsCompleted');
	assertSafeNonNegativeInteger(row.durationSeconds, 'leaderboard durationSeconds');
	assertSafeNonNegativeInteger(row.settledAt, 'leaderboard settledAt');
	return {
		rank: row.rank,
		userId: row.userId,
		playerName: row.playerName,
		endingBankroll: row.endingBankroll,
		roundsCompleted: row.roundsCompleted,
		durationSeconds: row.durationSeconds,
		settledAt: row.settledAt,
	};
}

function parseHistoryUserResult(
	row: DailyChallengeHistoryRow,
): DailyChallengeHistoryUserResult | null {
	if (row.userEndingBankroll === null) {
		if (
			row.userRoundsCompleted !== null ||
			row.userTerminalReason !== null ||
			row.userEligible !== null ||
			row.userSettledAt !== null
		) {
			return invariant('Corrupt daily challenge history user result');
		}
		return null;
	}
	if (
		row.userRoundsCompleted === null ||
		row.userTerminalReason === null ||
		row.userEligible === null ||
		row.userSettledAt === null
	) {
		return invariant('Corrupt daily challenge history user result');
	}
	const reason = dailyChallengeTerminalReasonSchema.safeParse(row.userTerminalReason);
	if (!reason.success) return invariant('Corrupt daily challenge history user terminal reason');
	const eligible = coerceBoolean(row.userEligible, 'history user eligible');
	assertSafeNonNegativeInteger(row.userEndingBankroll, 'history user endingBankroll');
	assertSafeNonNegativeInteger(row.userRoundsCompleted, 'history user roundsCompleted');
	assertSafeNonNegativeInteger(row.userSettledAt, 'history user settledAt');
	return {
		endingBankroll: row.userEndingBankroll,
		roundsCompleted: row.userRoundsCompleted,
		terminalReason: reason.data,
		eligible,
		settledAt: row.userSettledAt,
	};
}

function parseHistoryRow(row: DailyChallengeHistoryRow): DailyChallengeHistoryEntry {
	if (row.challengeRulesetVersion !== 'blackjack-daily-v1') {
		return invariant('Unsupported persisted daily challenge history ruleset');
	}
	if (!/^\d{4}-\d{2}-\d{2}$/.test(row.periodKey)) {
		return invariant('Corrupt daily challenge history period key');
	}
	if (row.topEndingBankroll !== null) {
		assertSafeNonNegativeInteger(row.topEndingBankroll, 'history top endingBankroll');
	}
	assertSafeNonNegativeInteger(row.participantCount, 'history participant count');
	return {
		periodKey: row.periodKey,
		challengeRulesetVersion: 'blackjack-daily-v1',
		topEndingBankroll: row.topEndingBankroll,
		participantCount: row.participantCount,
		userResult: parseHistoryUserResult(row),
	};
}

function assertCommandTransitionInput(input: DailyChallengeCommandTransitionInput): void {
	assertSafeNonNegativeInteger(input.expectedSequence, 'transition expected sequence');
	assertSafeNonNegativeInteger(input.expectedAvailableBankroll, 'transition expected bankroll');
	assertSafeNonNegativeInteger(input.expectedRoundsCompleted, 'transition expected rounds');
	assertSafeNonNegativeInteger(input.nextCommandSequence, 'transition next sequence');
	assertSafeNonNegativeInteger(input.availableBankroll, 'transition next bankroll');
	assertSafeNonNegativeInteger(input.roundsCompleted, 'transition next rounds');
	assertSafeNonNegativeInteger(input.nowSeconds, 'transition now');
	dailyChallengeHex64Schema.parse(input.expectedActionLogHash);
	dailyChallengeHex64Schema.parse(input.nextActionLogHash);
}

async function executeCommandTransition(
	db: D1Database,
	input: DailyChallengeCommandTransitionInput,
): Promise<DailyChallengeCommandTransitionResult> {
	assertCommandTransitionInput(input);
	const actionLogJson = parseCanonicalJson(input.nextActionLogJson, 'transition action-log JSON');
	dailyChallengeCommandLogSchema.parse(actionLogJson);
	if (sha256Hex(input.nextActionLogJson) !== input.nextActionLogHash) {
		return invariant('Daily challenge transition action-log hash mismatch');
	}

	const terminal = input.terminal ? validateTerminal(input, input.terminal) : undefined;
	const status = terminal ? terminalReasonToStatus(terminal.terminalReason) : 'active';
	const settledAt = terminal ? input.nowSeconds : null;

	const withRate = input.rateLimitStatement !== undefined;
	const updateStatement = db
		.prepare(withRate ? UPDATE_ATTEMPT_WITH_RATE_SQL : UPDATE_ATTEMPT_SQL)
		.bind(
			input.nextActionLogJson,
			input.nextActionLogHash,
			input.nextCommandSequence,
			input.availableBankroll,
			input.roundsCompleted,
			status,
			input.nowSeconds,
			settledAt,
			input.attemptId,
			input.userId,
			input.expectedSequence,
			input.expectedActionLogHash,
			input.expectedAvailableBankroll,
			input.expectedRoundsCompleted,
		);

	const statements: D1PreparedStatement[] = [];
	if (withRate && input.rateLimitStatement !== undefined) {
		statements.push(input.rateLimitStatement);
	}
	const updateIndex = statements.length;
	statements.push(updateStatement);
	const labels: string[] = ['command attempt update'];
	if (terminal) {
		statements.push(
			db
				.prepare(INSERT_RESULT_AFTER_TERMINAL_SQL)
				.bind(
					input.attemptId,
					terminal.challengeId,
					input.userId,
					input.availableBankroll,
					input.roundsCompleted,
					terminal.eligible ? 1 : 0,
					terminal.terminalReason,
					terminal.durationSeconds,
					terminal.scoreVersion,
					terminal.configHash,
					terminal.rankedSeedCommitment,
					input.nextActionLogHash,
					terminal.receiptHash,
					input.nowSeconds,
					input.nowSeconds,
				),
		);
		labels.push('terminal result insert');
	}

	const results = await db.batch(statements);
	if (withRate) {
		const rateChanges = readChanges(results[0], 'command rate');
		if (rateChanges === 0) {
			const deniedUpdateChanges = readChanges(results[updateIndex], labels[updateIndex]);
			if (deniedUpdateChanges !== 0) {
				return invariant('Denied daily challenge command rate allowed attempt update');
			}
			return { kind: 'rate-limited', retryAfter: input.retryAfter ?? 0 };
		}
	}
	const updateChanges = readChanges(results[updateIndex], labels[updateIndex]);
	if (updateChanges === 0) {
		if (terminal) {
			const insertChanges = readChanges(results[updateIndex + 1], labels[updateIndex + 1]);
			if (insertChanges !== 0) {
				return invariant('Daily challenge terminal result applied without attempt update');
			}
		}
		return { kind: 'not-applied' };
	}
	if (!terminal) return { kind: 'applied', result: null };
	const insertChanges = readChanges(results[updateIndex + 1], labels[updateIndex + 1]);
	if (insertChanges !== 1) {
		return invariant('Daily challenge terminal update did not store its result');
	}
	const resultRow = await db
		.prepare(FIND_RESULT_BY_ATTEMPT_SQL)
		.bind(input.attemptId)
		.first<DailyChallengeResultRow>();
	if (resultRow === null) return invariant('Daily challenge terminal result did not persist');
	return { kind: 'applied', result: parseResultRow(resultRow) };
}

export function createDailyChallengeRepository(db: D1Database): DailyChallengeRepository {
	return {
		async findChallengeByPeriodKey(challengeKind, periodKey) {
			const row = await db
				.prepare('SELECT * FROM daily_challenge WHERE challengeKind = ? AND periodKey = ? LIMIT 1')
				.bind(challengeKind, periodKey)
				.first<DailyChallengeRow>();
			if (row === null) return null;
			if (
				row.challengeKind !== 'blackjack-daily' ||
				row.challengeRulesetVersion !== 'blackjack-daily-v1'
			) {
				return null;
			}
			return parseChallengeRow(row);
		},
		async insertChallengeIfAbsent(record) {
			const result = await bindChallengeInsert(db, record).run();
			return readChanges(result, 'challenge insert') === 1 ? 'inserted' : 'existing';
		},
		async findAttemptByUserAndRequestId(userId, startRequestId) {
			const row = await db
				.prepare(
					'SELECT * FROM daily_challenge_attempt WHERE userId = ? AND startRequestId = ? LIMIT 1',
				)
				.bind(userId, startRequestId)
				.first<DailyChallengeAttemptRow>();
			return row === null ? null : parseAttemptRow(row);
		},
		async findAttemptByChallengeAndUser(challengeId, userId) {
			const row = await db
				.prepare(
					'SELECT * FROM daily_challenge_attempt WHERE challengeId = ? AND userId = ? LIMIT 1',
				)
				.bind(challengeId, userId)
				.first<DailyChallengeAttemptRow>();
			return row === null ? null : parseAttemptRow(row);
		},
		async findAttemptById(attemptId) {
			const row = await db
				.prepare('SELECT * FROM daily_challenge_attempt WHERE id = ? LIMIT 1')
				.bind(attemptId)
				.first<DailyChallengeAttemptRow>();
			return row === null ? null : parseAttemptRow(row);
		},
		async findChallengeById(challengeId) {
			const row = await db
				.prepare('SELECT * FROM daily_challenge WHERE id = ? LIMIT 1')
				.bind(challengeId)
				.first<DailyChallengeRow>();
			if (row === null) return null;
			if (
				row.challengeKind !== 'blackjack-daily' ||
				row.challengeRulesetVersion !== 'blackjack-daily-v1'
			) {
				return null;
			}
			return parseChallengeRow(row);
		},
		runStartTransition(input) {
			return executeStartTransition(db, input);
		},
		runCommandTransition(input) {
			return executeCommandTransition(db, input);
		},
		async findResultByAttempt(attemptId) {
			const row = await db
				.prepare(FIND_RESULT_BY_ATTEMPT_SQL)
				.bind(attemptId)
				.first<DailyChallengeResultRow>();
			return row === null ? null : parseResultRow(row);
		},
		async readLeaderboard(challengeId, limit, currentUserId) {
			if (typeof challengeId !== 'string' || challengeId.length === 0) {
				return invariant('Invalid daily challenge leaderboard challenge id');
			}
			if (!Number.isSafeInteger(limit) || limit < 1) {
				return invariant('Invalid daily challenge leaderboard limit');
			}
			const rows = await db
				.prepare(LEADERBOARD_SQL)
				.bind(challengeId, limit)
				.all<DailyChallengeLeaderboardRow>();
			const entries = rows.results.map(parseLeaderboardRow);
			if (!currentUserId) return { entries, currentUser: null };
			const [rankRow, totalRow] = await Promise.all([
				db
					.prepare(CURRENT_USER_RANK_SQL)
					.bind(challengeId, currentUserId)
					.first<{ rank: number }>(),
				db.prepare(TOTAL_ELIGIBLE_SQL).bind(challengeId).first<{ total: number }>(),
			]);
			if (!rankRow || !totalRow) return { entries, currentUser: null };
			const totalEligible = totalRow.total;
			if (!Number.isSafeInteger(totalEligible) || totalEligible < 1) {
				return { entries, currentUser: null };
			}
			const rank = rankRow.rank;
			if (!Number.isSafeInteger(rank) || rank < 1) {
				return invariant('Corrupt daily challenge current-user rank');
			}
			const percentile = calculateDailyChallengePercentile(totalEligible, rank - 1);
			return {
				entries,
				currentUser: { rank, totalEligible, percentile },
			};
		},
		async listChallengeHistory(limit, currentUserId) {
			if (!Number.isSafeInteger(limit) || limit < 1) {
				return invariant('Invalid daily challenge history limit');
			}
			const boundedLimit = Math.min(limit, DAILY_CHALLENGE_HISTORY_MAX_LIMIT);
			const rows = await db
				.prepare(HISTORY_SQL)
				.bind(boundedLimit, currentUserId ?? null)
				.all<DailyChallengeHistoryRow>();
			return { entries: rows.results.map(parseHistoryRow) };
		},
		async listExpiredAttempts(nowSeconds, cursor) {
			assertSafeNonNegativeInteger(nowSeconds, 'expiration cutoff');
			if (cursor) {
				assertSafeNonNegativeInteger(cursor.expiresAt, 'expiration cursor expiresAt');
				if (typeof cursor.id !== 'string' || cursor.id.length === 0) {
					return invariant('Invalid daily challenge expiration cursor id');
				}
				const rows = await db
					.prepare(`${LIST_EXPIRED_ATTEMPTS_SQL}${DAILY_CHALLENGE_EXPIRATION_PAGE_SIZE}`)
					.bind(nowSeconds, cursor.expiresAt, cursor.expiresAt, cursor.id)
					.all<{ id: string; expiresAt: number }>();
				return rows.results.map(({ id, expiresAt }) => ({ id, expiresAt }));
			}
			const rows = await db
				.prepare(`${LIST_EXPIRED_ATTEMPTS_FIRST_SQL}${DAILY_CHALLENGE_EXPIRATION_PAGE_SIZE}`)
				.bind(nowSeconds)
				.all<{ id: string; expiresAt: number }>();
			return rows.results.map(({ id, expiresAt }) => ({ id, expiresAt }));
		},
		async deleteTerminalAttemptsBefore(cutoffSeconds) {
			assertSafeNonNegativeInteger(cutoffSeconds, 'retention cutoff');
			const result = await db.prepare(DELETE_TERMINAL_BEFORE_SQL).bind(cutoffSeconds).run();
			return result.meta.changes ?? 0;
		},
	};
}
