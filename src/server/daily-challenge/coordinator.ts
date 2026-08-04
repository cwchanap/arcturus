import {
	BLACKJACK_DAILY_V1_CONFIG,
	getDailyChallengeWindow,
} from '../../lib/daily-challenge/config';
import {
	DailyChallengeServiceError,
	dailyChallengeCommandSchema,
	dailyChallengeStartRequestSchema,
	type DailyChallengeAttemptPublicStateV1,
	type DailyChallengeCommandV1,
	type DailyChallengeHistoryResponse,
	type DailyChallengeLeaderboardResponse,
	type DailyChallengePublicResponse,
	type DailyChallengeReceiptV1,
	type DailyChallengeStartRequest,
	type DailyChallengeTerminalReason,
} from '../../lib/daily-challenge/protocol';
import { createDailyChallengeSeedCommitment } from '../../lib/daily-challenge/random';
import {
	replayDailyChallenge,
	type DailyChallengeReplayV1,
} from '../../lib/daily-challenge/replay';
import {
	canonicalizeRanked,
	decodeCanonicalBase64Url,
	encodeBase64Url,
	hashCanonical,
	sha256Hex,
} from '../../lib/ranked/canonical';
import {
	type DailyChallengeAttemptRecord,
	type DailyChallengeCommandTransitionInput,
	type DailyChallengeRecord,
	type DailyChallengeRepository,
	type DailyChallengeResultRecord,
	type DailyChallengeTerminalTransition,
	type NewDailyChallengeAttemptRecord,
	type NewDailyChallengeRecord,
} from './repository';

export const DAILY_CHALLENGE_LOG_EVENTS = Object.freeze([
	'daily_challenge_started',
	'daily_challenge_command_accepted',
	'daily_challenge_command_rejected',
	'daily_challenge_replayed',
	'daily_challenge_settled',
	'daily_challenge_expired',
	'daily_challenge_rate_limited',
	'daily_challenge_invariant_violation',
] as const);

export type DailyChallengeLogEvent = (typeof DAILY_CHALLENGE_LOG_EVENTS)[number];

export interface DailyChallengeLogEntry {
	event: DailyChallengeLogEvent;
	userRef?: string;
	attemptRef?: string;
}

export interface DailyChallengeLogIdentifiers {
	userId?: string;
	attemptId?: string;
}

function redactDailyChallengeIdentifier(identifier: string): string {
	return sha256Hex(identifier).slice(0, 12);
}

export function createDailyChallengeLogEntry(
	event: DailyChallengeLogEvent,
	{ userId, attemptId }: DailyChallengeLogIdentifiers = {},
): DailyChallengeLogEntry {
	return {
		event,
		...(userId === undefined ? {} : { userRef: redactDailyChallengeIdentifier(userId) }),
		...(attemptId === undefined ? {} : { attemptRef: redactDailyChallengeIdentifier(attemptId) }),
	};
}

export interface DailyChallengeRateConsumption {
	kind: 'allowed';
	statement: D1PreparedStatement;
	retryAfter: number;
}

export interface DailyChallengeRateLimited {
	kind: 'rate-limited';
	retryAfter: number;
}

export interface DailyChallengeResumeRateConsumption {
	kind: 'allowed';
}

export interface DailyChallengeCoordinatorDeps {
	repository: DailyChallengeRepository;
	now(): Date;
	randomBytes(length: number): Uint8Array;
	log(entry: DailyChallengeLogEntry): void;
	consumeStartRateLimit(
		userId: string,
		nowSeconds: number,
	): Promise<DailyChallengeRateConsumption | DailyChallengeRateLimited>;
	consumeCommandRateLimit(
		userId: string,
		nowSeconds: number,
	): Promise<DailyChallengeRateConsumption | DailyChallengeRateLimited>;
	consumeResumeRateLimit(
		userId: string,
		nowSeconds: number,
	): Promise<DailyChallengeResumeRateConsumption | DailyChallengeRateLimited>;
}

export interface DailyChallengeCoordinator {
	getCurrent(input: { userId: string | null }): Promise<DailyChallengePublicResponse>;
	getByPeriod(input: {
		periodKey: string;
		userId: string | null;
	}): Promise<DailyChallengePublicResponse>;
	start(input: {
		userId: string;
		body: DailyChallengeStartRequest;
	}): Promise<DailyChallengeAttemptPublicStateV1>;
	resume(input: { userId: string; attemptId: string }): Promise<DailyChallengeAttemptPublicStateV1>;
	command(input: {
		userId: string;
		attemptId: string;
		body: DailyChallengeCommandV1;
	}): Promise<DailyChallengeAttemptPublicStateV1>;
	expire(attemptId: string): Promise<DailyChallengeAttemptPublicStateV1>;
	leaderboard(input: {
		periodKey: string;
		userId: string | null;
		limit: number;
	}): Promise<DailyChallengeLeaderboardResponse>;
	history(input: { userId: string | null; limit: number }): Promise<DailyChallengeHistoryResponse>;
}

function asNowSeconds(now: Date): number {
	const seconds = Math.trunc(now.getTime() / 1000);
	if (!Number.isSafeInteger(seconds) || seconds < 0) {
		throw new DailyChallengeServiceError('INTERNAL_ERROR', {
			message: 'Invalid daily challenge clock',
		});
	}
	return seconds;
}

function internalError(message: string): never {
	throw new DailyChallengeServiceError('INTERNAL_ERROR', { message });
}

function requireRandomBytes(
	randomBytes: DailyChallengeCoordinatorDeps['randomBytes'],
	length: number,
): Uint8Array {
	const bytes = randomBytes(length);
	if (!(bytes instanceof Uint8Array) || bytes.length !== length) {
		return internalError('Daily Challenge secure random source returned an invalid byte count');
	}
	return bytes.slice();
}

function buildReceipt(result: DailyChallengeResultRecord): DailyChallengeReceiptV1 {
	return {
		attemptId: result.attemptId,
		challengeId: result.challengeId,
		periodKey: result.periodKey,
		challengeRulesetVersion: result.challengeRulesetVersion,
		gameRulesetVersion: result.gameRulesetVersion,
		scoreVersion: result.scoreVersion,
		configHash: result.configHash,
		rankedSeedCommitment: result.rankedSeedCommitment,
		actionLogHash: result.actionLogHash,
		endingBankroll: result.endingBankroll,
		roundsCompleted: result.roundsCompleted,
		eligible: result.eligible,
		terminalReason: result.terminalReason,
		durationSeconds: result.durationSeconds,
		settledAt: result.settledAt,
		receiptHash: result.receiptHash,
	};
}

function buildNewChallengeRecord(
	window: ReturnType<typeof getDailyChallengeWindow>,
	rankedSeed: Uint8Array,
	practiceSeed: Uint8Array,
	nowSeconds: number,
	randomBytes: DailyChallengeCoordinatorDeps['randomBytes'],
): NewDailyChallengeRecord {
	const configJson = canonicalizeRanked(BLACKJACK_DAILY_V1_CONFIG);
	const configHash = hashCanonical(BLACKJACK_DAILY_V1_CONFIG);
	return {
		id: encodeBase64Url(requireRandomBytes(randomBytes, 16)),
		challengeKind: 'blackjack-daily',
		periodKey: window.periodKey,
		challengeRulesetVersion: 'blackjack-daily-v1',
		gameRulesetVersion: 'blackjack-ranked-v1',
		scoreVersion: 'blackjack-daily-score-v1',
		configJson,
		configHash,
		rankedSeed: encodeBase64Url(rankedSeed),
		rankedSeedCommitment: createDailyChallengeSeedCommitment('blackjack-daily-v1', rankedSeed),
		practiceSeed: encodeBase64Url(practiceSeed),
		startsAt: window.startsAt,
		rankedEntryClosesAt: window.rankedEntryClosesAt,
		endsAt: window.endsAt,
		createdAt: nowSeconds,
	};
}

function buildNewAttempt(
	challenge: DailyChallengeRecord,
	userId: string,
	startRequestId: string,
	startPayloadHash: string,
	attemptId: string,
	nowSeconds: number,
): NewDailyChallengeAttemptRecord {
	const actionLog: readonly DailyChallengeCommandV1[] = [];
	const actionLogJson = canonicalizeRanked(actionLog);
	const actionLogHash = hashCanonical(actionLog);
	const expiresAt = Math.min(nowSeconds + challenge.config.attemptTtlSeconds, challenge.endsAt);
	return {
		id: attemptId,
		challengeId: challenge.id,
		userId,
		startRequestId,
		startPayloadHash,
		status: 'active',
		actionLogJson,
		actionLogHash,
		nextCommandSequence: 0,
		availableBankroll: challenge.config.startingBankroll,
		roundsCompleted: 0,
		expiresAt,
		createdAt: nowSeconds,
		updatedAt: nowSeconds,
		settledAt: null,
	};
}

function buildTerminalTransition(
	challenge: DailyChallengeRecord,
	attempt: DailyChallengeAttemptRecord,
	replay: DailyChallengeReplayV1,
	reason: DailyChallengeTerminalReason,
	nowSeconds: number,
	nextActionLogHash: string,
): DailyChallengeTerminalTransition {
	const eligible = reason === 'completed' || reason === 'bankroll-below-minimum';
	// Expiration can be triggered either by the attempt TTL elapsing or by the
	// challenge window closing early (isAttemptExpired checks both). The
	// immutable receipt must record a duration bounded by the effective
	// deadline, not the stored attempt expiry — which may be later than the
	// challenge end and would otherwise overstate duration beyond settledAt.
	const deadline =
		reason === 'expired' ? Math.min(attempt.expiresAt, challenge.endsAt) : nowSeconds;
	const durationSeconds = deadline - attempt.createdAt;
	const receiptSource = {
		attemptId: attempt.id,
		challengeId: challenge.id,
		periodKey: challenge.periodKey,
		challengeRulesetVersion: challenge.challengeRulesetVersion,
		gameRulesetVersion: challenge.gameRulesetVersion,
		scoreVersion: challenge.scoreVersion,
		configHash: challenge.configHash,
		rankedSeedCommitment: challenge.rankedSeedCommitment,
		actionLogHash: nextActionLogHash,
		endingBankroll: replay.availableBankroll,
		roundsCompleted: replay.roundsCompleted,
		eligible,
		terminalReason: reason,
		durationSeconds,
		settledAt: nowSeconds,
	};
	const receiptHash = hashCanonical(receiptSource);
	return {
		challengeId: challenge.id,
		periodKey: challenge.periodKey,
		challengeRulesetVersion: challenge.challengeRulesetVersion,
		gameRulesetVersion: challenge.gameRulesetVersion,
		scoreVersion: challenge.scoreVersion,
		configHash: challenge.configHash,
		rankedSeedCommitment: challenge.rankedSeedCommitment,
		eligible,
		terminalReason: reason,
		durationSeconds,
		receiptHash,
	};
}

function mapInternalTerminalReason(
	reason: DailyChallengeReplayV1['terminalReason'],
): DailyChallengeTerminalReason {
	if (reason === 'completed') return 'completed';
	if (reason === 'bankroll-below-minimum') return 'bankroll-below-minimum';
	if (reason === 'forfeited') return 'forfeited';
	return internalError('Daily Challenge replay ended without a classifiable terminal reason');
}

export function createDailyChallengeCoordinator(
	deps: DailyChallengeCoordinatorDeps,
): DailyChallengeCoordinator {
	const log = (
		event: Parameters<typeof createDailyChallengeLogEntry>[0],
		identifiers: Parameters<typeof createDailyChallengeLogEntry>[1],
	): void => {
		deps.log(createDailyChallengeLogEntry(event, identifiers));
	};

	const getOrCreateCurrentChallenge = async (nowSeconds: number): Promise<DailyChallengeRecord> => {
		const window = getDailyChallengeWindow(nowSeconds);
		const existing = await deps.repository.findChallengeByPeriodKey(
			'blackjack-daily',
			window.periodKey,
		);
		if (existing) return existing;

		const rankedSeed = requireRandomBytes(deps.randomBytes, 32);
		const practiceSeed = requireRandomBytes(deps.randomBytes, 32);
		const candidate = buildNewChallengeRecord(
			window,
			rankedSeed,
			practiceSeed,
			nowSeconds,
			deps.randomBytes,
		);
		await deps.repository.insertChallengeIfAbsent(candidate);

		const persisted = await deps.repository.findChallengeByPeriodKey(
			'blackjack-daily',
			window.periodKey,
		);
		if (!persisted) return internalError('Daily Challenge catalog insert did not persist');
		return persisted;
	};

	const replayAttempt = (
		challenge: DailyChallengeRecord,
		attempt: DailyChallengeAttemptRecord,
	): { replay: DailyChallengeReplayV1; seed: Uint8Array } => {
		const seed = decodeCanonicalBase64Url(challenge.rankedSeed);
		const replay = replayDailyChallenge(challenge.config, seed, attempt.actionLog);
		return { replay, seed };
	};

	const assertProjectionIntegrity = (
		attempt: DailyChallengeAttemptRecord,
		replay: DailyChallengeReplayV1,
		identifiers: DailyChallengeLogIdentifiers,
	): void => {
		if (
			replay.availableBankroll !== attempt.availableBankroll ||
			replay.roundsCompleted !== attempt.roundsCompleted ||
			replay.nextCommandSequence !== attempt.nextCommandSequence
		) {
			log('daily_challenge_invariant_violation', identifiers);
			internalError('Daily Challenge stored projection disagrees with canonical replay');
		}
	};

	const renderAttempt = async (
		attempt: DailyChallengeAttemptRecord,
		challenge: DailyChallengeRecord,
	): Promise<DailyChallengeAttemptPublicStateV1> => {
		const { replay } = replayAttempt(challenge, attempt);
		assertProjectionIntegrity(attempt, replay, { userId: attempt.userId, attemptId: attempt.id });

		if (attempt.status === 'active') {
			return {
				attemptId: attempt.id,
				challengeId: challenge.id,
				startRequestId: attempt.startRequestId,
				status: 'active',
				nextCommandSequence: attempt.nextCommandSequence,
				availableBankroll: replay.availableBankroll,
				roundsCompleted: replay.roundsCompleted,
				activeRound: replay.activeRoundPublic as DailyChallengeAttemptPublicStateV1['activeRound'],
				rank: null,
				percentile: null,
				receipt: null,
				expiresAt: attempt.expiresAt,
			};
		}

		const result = await deps.repository.findResultByAttempt(attempt.id);
		if (!result) {
			log('daily_challenge_invariant_violation', { userId: attempt.userId, attemptId: attempt.id });
			return internalError('Daily Challenge terminal attempt has no stored result');
		}
		let rank: number | null = null;
		let percentile: number | null = null;
		if (result.eligible) {
			const standing = await deps.repository.findStanding(challenge.id, attempt.userId);
			if (standing) {
				rank = standing.rank;
				percentile = standing.percentile;
			}
		}
		return {
			attemptId: attempt.id,
			challengeId: challenge.id,
			startRequestId: attempt.startRequestId,
			status: attempt.status,
			nextCommandSequence: attempt.nextCommandSequence,
			availableBankroll: replay.availableBankroll,
			roundsCompleted: replay.roundsCompleted,
			activeRound: null,
			rank,
			percentile,
			receipt: buildReceipt(result),
			expiresAt: attempt.expiresAt,
		};
	};

	const renderChallengeResponse = async (
		challenge: DailyChallengeRecord,
		userId: string | null,
		nowSeconds: number,
	): Promise<DailyChallengePublicResponse> => {
		const attempt = userId
			? await deps.repository.findAttemptByChallengeAndUser(challenge.id, userId)
			: null;
		return {
			periodKey: challenge.periodKey,
			challengeKind: challenge.challengeKind,
			challengeRulesetVersion: challenge.challengeRulesetVersion,
			gameRulesetVersion: challenge.gameRulesetVersion,
			scoreVersion: challenge.scoreVersion,
			startsAt: challenge.startsAt,
			rankedEntryClosesAt: challenge.rankedEntryClosesAt,
			endsAt: challenge.endsAt,
			configHash: challenge.configHash,
			rankedSeedCommitment: challenge.rankedSeedCommitment,
			practiceSeed: challenge.practiceSeed,
			revealedRankedSeed: nowSeconds >= challenge.endsAt ? challenge.rankedSeed : null,
			attempt: attempt ? await renderAttempt(attempt, challenge) : null,
		};
	};

	const runExpiryTransition = async (
		attempt: DailyChallengeAttemptRecord,
		challenge: DailyChallengeRecord,
		nowSeconds: number,
	): Promise<DailyChallengeAttemptPublicStateV1> => {
		const { replay } = replayAttempt(challenge, attempt);
		assertProjectionIntegrity(attempt, replay, { userId: attempt.userId, attemptId: attempt.id });

		const nextActionLogJson = canonicalizeRanked(attempt.actionLog);
		const terminal = buildTerminalTransition(
			challenge,
			attempt,
			replay,
			'expired',
			nowSeconds,
			attempt.actionLogHash,
		);
		const input: DailyChallengeCommandTransitionInput = {
			userId: attempt.userId,
			attemptId: attempt.id,
			expectedSequence: attempt.nextCommandSequence,
			expectedActionLogHash: attempt.actionLogHash,
			expectedAvailableBankroll: attempt.availableBankroll,
			expectedRoundsCompleted: attempt.roundsCompleted,
			nextActionLogJson,
			nextActionLogHash: attempt.actionLogHash,
			nextCommandSequence: attempt.nextCommandSequence,
			availableBankroll: replay.availableBankroll,
			roundsCompleted: replay.roundsCompleted,
			nowSeconds,
			terminal,
		};
		const result = await deps.repository.runCommandTransition(input);
		if (result.kind === 'applied') {
			log('daily_challenge_expired', { userId: attempt.userId, attemptId: attempt.id });
		}
		const current = await deps.repository.findAttemptById(attempt.id);
		if (!current) return internalError('Daily Challenge expiry did not persist its attempt');
		const currentChallenge = await deps.repository.findChallengeById(attempt.challengeId);
		if (!currentChallenge)
			return internalError('Daily Challenge attempt references a missing challenge');
		return renderAttempt(current, currentChallenge);
	};

	const isAttemptExpired = (
		attempt: DailyChallengeAttemptRecord,
		challenge: DailyChallengeRecord,
		nowSeconds: number,
	): boolean => nowSeconds >= attempt.expiresAt || nowSeconds >= challenge.endsAt;

	const getCurrent = async ({
		userId,
	}: {
		userId: string | null;
	}): Promise<DailyChallengePublicResponse> => {
		const nowSeconds = asNowSeconds(deps.now());
		const challenge = await getOrCreateCurrentChallenge(nowSeconds);
		return renderChallengeResponse(challenge, userId, nowSeconds);
	};

	const getByPeriod = async ({
		periodKey,
		userId,
	}: {
		periodKey: string;
		userId: string | null;
	}): Promise<DailyChallengePublicResponse> => {
		const nowSeconds = asNowSeconds(deps.now());
		const challenge = await deps.repository.findChallengeByPeriodKey('blackjack-daily', periodKey);
		if (!challenge) throw new DailyChallengeServiceError('CHALLENGE_NOT_FOUND');
		return renderChallengeResponse(challenge, userId, nowSeconds);
	};

	const start = async ({
		userId,
		body,
	}: {
		userId: string;
		body: DailyChallengeStartRequest;
	}): Promise<DailyChallengeAttemptPublicStateV1> => {
		const parsed = dailyChallengeStartRequestSchema.safeParse(body);
		if (!parsed.success) throw new DailyChallengeServiceError('INVALID_REQUEST');
		const validBody = parsed.data;
		const nowSeconds = asNowSeconds(deps.now());
		const challenge = await getOrCreateCurrentChallenge(nowSeconds);

		if (nowSeconds >= challenge.rankedEntryClosesAt) {
			throw new DailyChallengeServiceError('RANKED_ENTRY_CLOSED');
		}

		const startPayloadHash = hashCanonical(validBody);

		const exact = await deps.repository.findAttemptByUserAndRequestId(userId, validBody.requestId);
		if (exact) {
			if (exact.challengeId !== challenge.id || exact.startPayloadHash !== startPayloadHash) {
				const rate = await deps.consumeStartRateLimit(userId, nowSeconds);
				if (rate.kind === 'rate-limited') {
					log('daily_challenge_rate_limited', { userId });
					throw new DailyChallengeServiceError('RATE_LIMITED', { retryAfter: rate.retryAfter });
				}
				log('daily_challenge_command_rejected', { userId, attemptId: exact.id });
				throw new DailyChallengeServiceError('IDENTIFIER_REUSE_MISMATCH');
			}
			log('daily_challenge_replayed', { userId, attemptId: exact.id });
			if (exact.status === 'active' && isAttemptExpired(exact, challenge, nowSeconds)) {
				return runExpiryTransition(exact, challenge, nowSeconds);
			}
			return renderAttempt(exact, challenge);
		}

		const todays = await deps.repository.findAttemptByChallengeAndUser(challenge.id, userId);
		if (todays) {
			log('daily_challenge_replayed', { userId, attemptId: todays.id });
			if (todays.status === 'active' && isAttemptExpired(todays, challenge, nowSeconds)) {
				return runExpiryTransition(todays, challenge, nowSeconds);
			}
			return renderAttempt(todays, challenge);
		}

		const rate = await deps.consumeStartRateLimit(userId, nowSeconds);
		if (rate.kind === 'rate-limited') {
			log('daily_challenge_rate_limited', { userId });
			throw new DailyChallengeServiceError('RATE_LIMITED', { retryAfter: rate.retryAfter });
		}

		const attemptId = encodeBase64Url(requireRandomBytes(deps.randomBytes, 16));
		const attempt = buildNewAttempt(
			challenge,
			userId,
			validBody.requestId,
			startPayloadHash,
			attemptId,
			nowSeconds,
		);
		const transition = await deps.repository.runStartTransition({
			userId,
			attempt,
			rateLimitStatement: rate.statement,
			retryAfter: rate.retryAfter,
		});
		if (transition.kind === 'rate-limited') {
			log('daily_challenge_rate_limited', { userId });
			throw new DailyChallengeServiceError('RATE_LIMITED', { retryAfter: transition.retryAfter });
		}
		if (transition.kind === 'created') {
			log('daily_challenge_started', { userId, attemptId });
			const created = await deps.repository.findAttemptById(attemptId);
			if (!created) return internalError('Daily Challenge start did not persist its attempt');
			return renderAttempt(created, challenge);
		}

		const winnerByRequest = await deps.repository.findAttemptByUserAndRequestId(
			userId,
			validBody.requestId,
		);
		if (winnerByRequest) {
			if (
				winnerByRequest.challengeId !== challenge.id ||
				winnerByRequest.startPayloadHash !== startPayloadHash
			) {
				log('daily_challenge_command_rejected', { userId, attemptId: winnerByRequest.id });
				throw new DailyChallengeServiceError('IDENTIFIER_REUSE_MISMATCH');
			}
			log('daily_challenge_replayed', { userId, attemptId: winnerByRequest.id });
			if (
				winnerByRequest.status === 'active' &&
				isAttemptExpired(winnerByRequest, challenge, nowSeconds)
			) {
				return runExpiryTransition(winnerByRequest, challenge, nowSeconds);
			}
			return renderAttempt(winnerByRequest, challenge);
		}
		const winnerByChallenge = await deps.repository.findAttemptByChallengeAndUser(
			challenge.id,
			userId,
		);
		if (winnerByChallenge) {
			log('daily_challenge_replayed', { userId, attemptId: winnerByChallenge.id });
			if (
				winnerByChallenge.status === 'active' &&
				isAttemptExpired(winnerByChallenge, challenge, nowSeconds)
			) {
				return runExpiryTransition(winnerByChallenge, challenge, nowSeconds);
			}
			return renderAttempt(winnerByChallenge, challenge);
		}
		return internalError('Daily Challenge start conflict could not be classified');
	};

	const loadOwnedAttempt = async (
		userId: string,
		attemptId: string,
	): Promise<{ attempt: DailyChallengeAttemptRecord; challenge: DailyChallengeRecord }> => {
		const attempt = await deps.repository.findAttemptById(attemptId);
		if (!attempt || attempt.userId !== userId) {
			throw new DailyChallengeServiceError('ATTEMPT_NOT_FOUND');
		}
		const challenge = await deps.repository.findChallengeById(attempt.challengeId);
		if (!challenge) return internalError('Daily Challenge attempt references a missing challenge');
		return { attempt, challenge };
	};

	const resume = async ({
		userId,
		attemptId,
	}: {
		userId: string;
		attemptId: string;
	}): Promise<DailyChallengeAttemptPublicStateV1> => {
		const nowSeconds = asNowSeconds(deps.now());
		const { attempt, challenge } = await loadOwnedAttempt(userId, attemptId);
		const rate = await deps.consumeResumeRateLimit(userId, nowSeconds);
		if (rate.kind === 'rate-limited') {
			log('daily_challenge_rate_limited', { userId });
			throw new DailyChallengeServiceError('RATE_LIMITED', { retryAfter: rate.retryAfter });
		}
		if (attempt.status === 'active' && isAttemptExpired(attempt, challenge, nowSeconds)) {
			return runExpiryTransition(attempt, challenge, nowSeconds);
		}
		return renderAttempt(attempt, challenge);
	};

	const applyCommandTransition = async (
		attempt: DailyChallengeAttemptRecord,
		challenge: DailyChallengeRecord,
		body: DailyChallengeCommandV1,
		nowSeconds: number,
		rateLimitStatement: D1PreparedStatement,
		retryAfter: number,
	): Promise<DailyChallengeAttemptPublicStateV1> => {
		const { replay: currentReplay, seed } = replayAttempt(challenge, attempt);
		assertProjectionIntegrity(attempt, currentReplay, {
			userId: attempt.userId,
			attemptId: attempt.id,
		});

		const nextActionLog: DailyChallengeCommandV1[] = [...attempt.actionLog, body];
		const nextReplay = replayDailyChallenge(challenge.config, seed, nextActionLog);

		const nextActionLogJson = canonicalizeRanked(nextActionLog);
		const nextActionLogHash = hashCanonical(nextActionLog);
		const terminal =
			nextReplay.status !== 'active'
				? buildTerminalTransition(
						challenge,
						attempt,
						nextReplay,
						mapInternalTerminalReason(nextReplay.terminalReason),
						nowSeconds,
						nextActionLogHash,
					)
				: undefined;

		const input: DailyChallengeCommandTransitionInput = {
			userId: attempt.userId,
			attemptId: attempt.id,
			expectedSequence: attempt.nextCommandSequence,
			expectedActionLogHash: attempt.actionLogHash,
			expectedAvailableBankroll: attempt.availableBankroll,
			expectedRoundsCompleted: attempt.roundsCompleted,
			nextActionLogJson,
			nextActionLogHash,
			nextCommandSequence: attempt.nextCommandSequence + 1,
			availableBankroll: nextReplay.availableBankroll,
			roundsCompleted: nextReplay.roundsCompleted,
			nowSeconds,
			terminal,
			rateLimitStatement,
			retryAfter,
		};

		const result = await deps.repository.runCommandTransition(input);
		if (result.kind === 'rate-limited') {
			log('daily_challenge_rate_limited', { userId: attempt.userId });
			throw new DailyChallengeServiceError('RATE_LIMITED', { retryAfter: result.retryAfter });
		}
		if (result.kind === 'applied') {
			log(terminal ? 'daily_challenge_settled' : 'daily_challenge_command_accepted', {
				userId: attempt.userId,
				attemptId: attempt.id,
			});
			const updated = await deps.repository.findAttemptById(attempt.id);
			if (!updated) return internalError('Daily Challenge command did not persist its attempt');
			return renderAttempt(updated, challenge);
		}

		const current = await deps.repository.findAttemptById(attempt.id);
		if (!current) return internalError('Daily Challenge command reread lost its attempt');
		if (current.status !== 'active') {
			if (body.sequence < current.nextCommandSequence) {
				const stored = current.actionLog[body.sequence];
				if (stored && canonicalizeRanked(stored) === canonicalizeRanked(body)) {
					log('daily_challenge_replayed', { userId: attempt.userId, attemptId: attempt.id });
					return renderAttempt(current, challenge);
				}
				log('daily_challenge_command_rejected', { userId: attempt.userId, attemptId: attempt.id });
				throw new DailyChallengeServiceError('IDENTIFIER_REUSE_MISMATCH');
			}
			throw new DailyChallengeServiceError('ATTEMPT_COMPLETE');
		}
		if (body.sequence < current.nextCommandSequence) {
			const stored = current.actionLog[body.sequence];
			if (stored && canonicalizeRanked(stored) === canonicalizeRanked(body)) {
				return renderAttempt(current, challenge);
			}
			log('daily_challenge_command_rejected', { userId: attempt.userId, attemptId: attempt.id });
			throw new DailyChallengeServiceError('IDENTIFIER_REUSE_MISMATCH');
		}
		if (body.sequence > current.nextCommandSequence) {
			throw new DailyChallengeServiceError('SEQUENCE_MISMATCH', {
				expectedSequence: current.nextCommandSequence,
			});
		}
		log('daily_challenge_invariant_violation', { userId: attempt.userId, attemptId: attempt.id });
		return internalError('Daily Challenge command conflict could not be classified');
	};

	const command = async ({
		userId,
		attemptId,
		body,
	}: {
		userId: string;
		attemptId: string;
		body: DailyChallengeCommandV1;
	}): Promise<DailyChallengeAttemptPublicStateV1> => {
		const parsed = dailyChallengeCommandSchema.safeParse(body);
		if (!parsed.success) throw new DailyChallengeServiceError('INVALID_COMMAND');
		const validBody = parsed.data;
		const nowSeconds = asNowSeconds(deps.now());
		const { attempt, challenge } = await loadOwnedAttempt(userId, attemptId);

		if (attempt.status !== 'active') {
			if (validBody.sequence < attempt.nextCommandSequence) {
				const stored = attempt.actionLog[validBody.sequence];
				if (stored && canonicalizeRanked(stored) === canonicalizeRanked(validBody)) {
					log('daily_challenge_replayed', { userId, attemptId });
					return renderAttempt(attempt, challenge);
				}
				log('daily_challenge_command_rejected', { userId, attemptId });
				throw new DailyChallengeServiceError('IDENTIFIER_REUSE_MISMATCH');
			}
			throw new DailyChallengeServiceError('ATTEMPT_COMPLETE');
		}

		if (validBody.sequence < attempt.nextCommandSequence) {
			const stored = attempt.actionLog[validBody.sequence];
			if (stored && canonicalizeRanked(stored) === canonicalizeRanked(validBody)) {
				log('daily_challenge_replayed', { userId, attemptId });
				return renderAttempt(attempt, challenge);
			}
			log('daily_challenge_command_rejected', { userId, attemptId });
			throw new DailyChallengeServiceError('IDENTIFIER_REUSE_MISMATCH');
		}
		if (validBody.sequence > attempt.nextCommandSequence) {
			log('daily_challenge_command_rejected', { userId, attemptId });
			throw new DailyChallengeServiceError('SEQUENCE_MISMATCH', {
				expectedSequence: attempt.nextCommandSequence,
			});
		}

		if (isAttemptExpired(attempt, challenge, nowSeconds)) {
			return runExpiryTransition(attempt, challenge, nowSeconds);
		}

		const rate = await deps.consumeCommandRateLimit(userId, nowSeconds);
		if (rate.kind === 'rate-limited') {
			log('daily_challenge_rate_limited', { userId });
			throw new DailyChallengeServiceError('RATE_LIMITED', { retryAfter: rate.retryAfter });
		}

		return applyCommandTransition(
			attempt,
			challenge,
			validBody,
			nowSeconds,
			rate.statement,
			rate.retryAfter,
		);
	};

	const expire = async (attemptId: string): Promise<DailyChallengeAttemptPublicStateV1> => {
		const nowSeconds = asNowSeconds(deps.now());
		const attempt = await deps.repository.findAttemptById(attemptId);
		if (!attempt) throw new DailyChallengeServiceError('ATTEMPT_NOT_FOUND');
		const challenge = await deps.repository.findChallengeById(attempt.challengeId);
		if (!challenge) return internalError('Daily Challenge attempt references a missing challenge');
		if (attempt.status !== 'active') {
			return renderAttempt(attempt, challenge);
		}
		if (!isAttemptExpired(attempt, challenge, nowSeconds)) {
			return renderAttempt(attempt, challenge);
		}
		return runExpiryTransition(attempt, challenge, nowSeconds);
	};

	const leaderboard = async ({
		periodKey,
		userId,
		limit,
	}: {
		periodKey: string;
		userId: string | null;
		limit: number;
	}): Promise<DailyChallengeLeaderboardResponse> => {
		const challenge = await deps.repository.findChallengeByPeriodKey('blackjack-daily', periodKey);
		if (!challenge) throw new DailyChallengeServiceError('CHALLENGE_NOT_FOUND');
		const read = await deps.repository.readLeaderboard(challenge.id, limit, userId ?? undefined);
		return {
			periodKey: challenge.periodKey,
			entries: read.entries.map((entry) => ({
				rank: entry.rank,
				playerName: entry.playerName,
				endingBankroll: entry.endingBankroll,
				roundsCompleted: entry.roundsCompleted,
				durationSeconds: entry.durationSeconds,
				settledAt: entry.settledAt,
				...(entry.userId === userId ? { isCurrentUser: true } : {}),
			})),
			currentUser: read.currentUser,
		};
	};

	const history = async ({
		userId,
		limit,
	}: {
		userId: string | null;
		limit: number;
	}): Promise<DailyChallengeHistoryResponse> => {
		const read = await deps.repository.listChallengeHistory(limit, userId ?? undefined);
		return { entries: [...read.entries] };
	};

	return {
		getCurrent,
		getByPeriod,
		start,
		resume,
		command,
		expire,
		leaderboard,
		history,
	};
}
