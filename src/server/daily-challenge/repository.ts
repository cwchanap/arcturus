import { z } from 'zod';
import { BLACKJACK_DAILY_V1_CONFIG } from '../../lib/daily-challenge/config';
import type { DailyChallengeCommandV1 } from '../../lib/daily-challenge/protocol';
import { dailyChallengeCommandLogSchema } from '../../lib/daily-challenge/protocol';
import {
	type RankedJson,
	canonicalizeRanked,
	decodeCanonicalBase64Url,
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
	runStartTransition(
		input: DailyChallengeStartTransitionInput,
	): Promise<DailyChallengeStartTransitionResult>;
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
		runStartTransition(input) {
			return executeStartTransition(db, input);
		},
	};
}
