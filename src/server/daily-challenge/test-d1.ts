export {
	createRankedTestD1 as createDailyChallengeTestD1,
	insertRankedTestUser as insertDailyChallengeTestUser,
} from '../ranked/test-d1';

const DAILY_CHALLENGE_COLUMNS =
	`id, challengeKind, periodKey, challengeRulesetVersion, gameRulesetVersion,
	scoreVersion, configJson, configHash, rankedSeed, rankedSeedCommitment, practiceSeed,
	startsAt, rankedEntryClosesAt, endsAt, createdAt` as const;

interface DailyChallengeInsertDefaults {
	challengeRulesetVersion: string;
	gameRulesetVersion: string;
	scoreVersion: string;
	configJson: string;
	configHash: string;
	rankedSeed: string;
	rankedSeedCommitment: string;
	practiceSeed: string;
}

const DAILY_CHALLENGE_DEFAULTS: DailyChallengeInsertDefaults = {
	challengeRulesetVersion: 'blackjack-daily-v1',
	gameRulesetVersion: 'blackjack-ranked-v1',
	scoreVersion: 'blackjack-daily-score-v1',
	configJson: '{}',
	configHash: 'config-hash',
	rankedSeed: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
	rankedSeedCommitment: 'seed-commitment',
	practiceSeed: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
};

export interface InsertDailyChallengeInput {
	id: string;
	challengeKind: string;
	periodKey: string;
	startsAt?: number;
	rankedEntryClosesAt?: number;
	endsAt?: number;
	createdAt?: number;
}

// mode: 'timestamp' columns store unix seconds. Tests must bind
// Math.trunc(Date.now() / 1000) for raw timestamp values.
export async function insertDailyChallenge(
	db: D1Database,
	input: InsertDailyChallengeInput,
): Promise<void> {
	const now = Math.trunc(Date.now() / 1000);
	const d = DAILY_CHALLENGE_DEFAULTS;
	await db
		.prepare(
			`INSERT INTO daily_challenge (${DAILY_CHALLENGE_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			input.id,
			input.challengeKind,
			input.periodKey,
			d.challengeRulesetVersion,
			d.gameRulesetVersion,
			d.scoreVersion,
			d.configJson,
			d.configHash,
			d.rankedSeed,
			d.rankedSeedCommitment,
			d.practiceSeed,
			input.startsAt ?? now,
			input.rankedEntryClosesAt ?? now + 3600,
			input.endsAt ?? now + 86400,
			input.createdAt ?? now,
		)
		.run();
}

const DAILY_CHALLENGE_ATTEMPT_COLUMNS =
	`id, challengeId, userId, startRequestId, startPayloadHash, status,
	actionLogJson, actionLogHash, nextCommandSequence, availableBankroll, roundsCompleted,
	expiresAt, createdAt, updatedAt, settledAt` as const;

interface DailyChallengeAttemptInsertDefaults {
	startPayloadHash: string;
	actionLogJson: string;
	actionLogHash: string;
	nextCommandSequence: number;
	availableBankroll: number;
	roundsCompleted: number;
}

const DAILY_CHALLENGE_ATTEMPT_DEFAULTS: DailyChallengeAttemptInsertDefaults = {
	startPayloadHash: 'start-hash',
	actionLogJson: '[]',
	actionLogHash: 'action-log-hash',
	nextCommandSequence: 0,
	availableBankroll: 1000,
	roundsCompleted: 0,
};

export interface InsertDailyChallengeAttemptInput {
	id: string;
	challengeId: string;
	userId: string;
	startRequestId: string;
	status?: string;
	expiresAt?: number;
	createdAt?: number;
	updatedAt?: number;
	settledAt?: number | null;
}

export async function insertDailyChallengeAttempt(
	db: D1Database,
	input: InsertDailyChallengeAttemptInput,
): Promise<void> {
	const now = Math.trunc(Date.now() / 1000);
	const d = DAILY_CHALLENGE_ATTEMPT_DEFAULTS;
	await db
		.prepare(
			`INSERT INTO daily_challenge_attempt (${DAILY_CHALLENGE_ATTEMPT_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			input.id,
			input.challengeId,
			input.userId,
			input.startRequestId,
			d.startPayloadHash,
			input.status ?? 'active',
			d.actionLogJson,
			d.actionLogHash,
			d.nextCommandSequence,
			d.availableBankroll,
			d.roundsCompleted,
			input.expiresAt ?? now + 900,
			input.createdAt ?? now,
			input.updatedAt ?? now,
			input.settledAt ?? null,
		)
		.run();
}

const DAILY_CHALLENGE_RESULT_COLUMNS =
	`attemptId, challengeId, userId, endingBankroll, roundsCompleted,
	eligible, terminalReason, durationSeconds, scoreVersion, configHash, rankedSeedCommitment,
	actionLogHash, receiptHash, createdAt, settledAt` as const;

interface DailyChallengeResultInsertDefaults {
	eligible: number;
	terminalReason: string;
	durationSeconds: number;
	scoreVersion: string;
	configHash: string;
	rankedSeedCommitment: string;
	actionLogHash: string;
	receiptHash: string;
}

const DAILY_CHALLENGE_RESULT_DEFAULTS: DailyChallengeResultInsertDefaults = {
	eligible: 1,
	terminalReason: 'completed',
	durationSeconds: 120,
	scoreVersion: 'blackjack-daily-score-v1',
	configHash: 'config-hash',
	rankedSeedCommitment: 'seed-commitment',
	actionLogHash: 'action-log-hash',
	receiptHash: 'receipt-hash',
};

export interface InsertDailyChallengeResultInput {
	attemptId: string;
	challengeId: string;
	userId: string;
	endingBankroll: number;
	roundsCompleted?: number;
	eligible?: number;
	terminalReason?: string;
	createdAt?: number;
	settledAt?: number;
}

export async function insertDailyChallengeResult(
	db: D1Database,
	input: InsertDailyChallengeResultInput,
): Promise<void> {
	const now = Math.trunc(Date.now() / 1000);
	const d = DAILY_CHALLENGE_RESULT_DEFAULTS;
	await db
		.prepare(
			`INSERT INTO daily_challenge_result (${DAILY_CHALLENGE_RESULT_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			input.attemptId,
			input.challengeId,
			input.userId,
			input.endingBankroll,
			input.roundsCompleted ?? 0,
			input.eligible ?? d.eligible,
			input.terminalReason ?? d.terminalReason,
			d.durationSeconds,
			d.scoreVersion,
			d.configHash,
			d.rankedSeedCommitment,
			d.actionLogHash,
			d.receiptHash,
			input.createdAt ?? now,
			input.settledAt ?? now,
		)
		.run();
}
