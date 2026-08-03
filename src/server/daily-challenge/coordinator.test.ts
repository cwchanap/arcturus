import { describe, expect, test } from 'bun:test';
import {
	BLACKJACK_DAILY_V1_CONFIG,
	getDailyChallengeWindow,
} from '../../lib/daily-challenge/config';
import {
	DailyChallengeServiceError,
	type DailyChallengeCommandV1,
	type DailyChallengeStartRequest,
} from '../../lib/daily-challenge/protocol';
import { replayDailyChallenge } from '../../lib/daily-challenge/replay';
import { createDailyChallengeSeedCommitment } from '../../lib/daily-challenge/random';
import {
	canonicalizeRanked,
	decodeCanonicalBase64Url,
	encodeBase64Url,
	hashCanonical,
	sha256Hex,
} from '../../lib/ranked/canonical';
import {
	createDailyChallengeCoordinator,
	type DailyChallengeCoordinator,
	type DailyChallengeCoordinatorDeps,
	type DailyChallengeLogEntry,
} from './coordinator';
import type {
	DailyChallengeAttemptRecord,
	DailyChallengeCommandTransitionInput,
	DailyChallengeCommandTransitionResult,
	DailyChallengeExpirationCursor,
	DailyChallengeExpirationRow,
	DailyChallengeHistoryRead,
	DailyChallengeLeaderboardRead,
	DailyChallengeRecord,
	DailyChallengeResultRecord,
	DailyChallengeStartTransitionInput,
	DailyChallengeStartTransitionResult,
	NewDailyChallengeAttemptRecord,
	NewDailyChallengeRecord,
} from './repository';

const USER_ID = 'coordinator-user-01';
const OTHER_USER_ID = 'coordinator-user-02';
const NOW_SECONDS = Math.trunc(Date.parse('2025-06-15T12:30:00Z') / 1000);
const WINDOW = getDailyChallengeWindow(NOW_SECONDS);
const MASTER_SEED = Uint8Array.from({ length: 32 }, (_, index) => index);
const PRACTICE_SEED = Uint8Array.from({ length: 32 }, (_, index) => (index + 100) % 256);
const DEFAULT_WAGER = BLACKJACK_DAILY_V1_CONFIG.minimumWager;

function startRound(sequence: number, wager: number): DailyChallengeCommandV1 {
	return { sequence, command: 'start-round', wager };
}

function cmd(
	sequence: number,
	command: 'hit' | 'stand' | 'double-down' | 'split' | 'forfeit',
): DailyChallengeCommandV1 {
	return { sequence, command };
}

async function expectDailyError(
	promise: Promise<unknown>,
	code: DailyChallengeServiceError['code'],
	expectedSequence?: number,
): Promise<void> {
	try {
		await promise;
		throw new Error('Expected daily challenge service error');
	} catch (error) {
		expect(error).toBeInstanceOf(DailyChallengeServiceError);
		expect(error).toMatchObject({
			code,
			...(expectedSequence === undefined ? {} : { expectedSequence }),
		});
	}
}

function findActiveRoundSeed(wager: number): Uint8Array {
	for (let n = 0; n < 50_000; n += 1) {
		const seed =
			n === 0
				? MASTER_SEED
				: Uint8Array.from({ length: 32 }, (_, index) => (index * 7 + n * 13) % 256);
		const replay = replayDailyChallenge(BLACKJACK_DAILY_V1_CONFIG, seed, [startRound(0, wager)]);
		if (replay.status === 'active' && replay.activeRound !== null && replay.roundsCompleted === 0) {
			return seed;
		}
	}
	throw new Error('Could not find an active-round seed');
}

const ACTIVE_SEED = findActiveRoundSeed(DEFAULT_WAGER);

interface Projections {
	availableBankroll: number;
	roundsCompleted: number;
	nextCommandSequence: number;
	actionLogJson: string;
	actionLogHash: string;
}

function computeProjections(
	seed: Uint8Array,
	commands: readonly DailyChallengeCommandV1[],
): Projections {
	const replay = replayDailyChallenge(BLACKJACK_DAILY_V1_CONFIG, seed, commands);
	return {
		availableBankroll: replay.availableBankroll,
		roundsCompleted: replay.roundsCompleted,
		nextCommandSequence: replay.nextCommandSequence,
		actionLogJson: canonicalizeRanked(commands),
		actionLogHash: hashCanonical(commands),
	};
}

function baseChallenge(overrides: Partial<DailyChallengeRecord> = {}): DailyChallengeRecord {
	const seed = ACTIVE_SEED;
	const record: NewDailyChallengeRecord = {
		id: 'test-challenge-id-0001',
		challengeKind: 'blackjack-daily',
		periodKey: WINDOW.periodKey,
		challengeRulesetVersion: 'blackjack-daily-v1',
		gameRulesetVersion: 'blackjack-ranked-v1',
		scoreVersion: 'blackjack-daily-score-v1',
		configJson: canonicalizeRanked(BLACKJACK_DAILY_V1_CONFIG),
		configHash: hashCanonical(BLACKJACK_DAILY_V1_CONFIG),
		rankedSeed: encodeBase64Url(seed),
		rankedSeedCommitment: createDailyChallengeSeedCommitment('blackjack-daily-v1', seed),
		practiceSeed: encodeBase64Url(PRACTICE_SEED),
		startsAt: WINDOW.startsAt,
		rankedEntryClosesAt: WINDOW.rankedEntryClosesAt,
		endsAt: WINDOW.endsAt,
		createdAt: NOW_SECONDS,
	};
	return { ...record, config: BLACKJACK_DAILY_V1_CONFIG, ...overrides };
}

function challengeWithSeed(
	seed: Uint8Array,
	overrides: Partial<DailyChallengeRecord> = {},
): DailyChallengeRecord {
	return baseChallenge({
		rankedSeed: encodeBase64Url(seed),
		rankedSeedCommitment: createDailyChallengeSeedCommitment('blackjack-daily-v1', seed),
		...overrides,
	});
}

interface AttemptState extends NewDailyChallengeAttemptRecord {
	actionLog: DailyChallengeCommandV1[];
}

function baseAttempt(
	overrides: Partial<NewDailyChallengeAttemptRecord> = {},
): NewDailyChallengeAttemptRecord {
	return {
		id: 'attemptaaaaaaaaaaaaaaaaaa',
		challengeId: 'test-challenge-id-0001',
		userId: USER_ID,
		startRequestId: 'request-aaaaaaaaaaaaaaaa',
		startPayloadHash: sha256Hex(canonicalizeRanked({ requestId: 'request-aaaaaaaaaaaaaaaa' })),
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

function fixtureAttempt(
	commands: readonly DailyChallengeCommandV1[],
	overrides: Partial<NewDailyChallengeAttemptRecord> = {},
): AttemptState {
	const projections = computeProjections(ACTIVE_SEED, commands);
	return {
		...baseAttempt({
			nextCommandSequence: projections.nextCommandSequence,
			availableBankroll: projections.availableBankroll,
			roundsCompleted: projections.roundsCompleted,
			actionLogJson: projections.actionLogJson,
			actionLogHash: projections.actionLogHash,
			...overrides,
		}),
		actionLog: commands.map((entry) => ({ ...entry })),
	};
}

interface FakeOptions {
	challenges?: DailyChallengeRecord[];
	attempts?: AttemptState[];
	results?: DailyChallengeResultRecord[];
}

class FakeRepository {
	readonly challenges = new Map<string, DailyChallengeRecord>();
	readonly attempts = new Map<string, AttemptState>();
	readonly results = new Map<string, DailyChallengeResultRecord>();
	readonly startTransitions: DailyChallengeStartTransitionInput[] = [];
	readonly commandTransitions: DailyChallengeCommandTransitionInput[] = [];

	constructor(options: FakeOptions = {}) {
		for (const challenge of options.challenges ?? [baseChallenge()]) {
			this.challenges.set(challenge.id, challenge);
		}
		for (const attempt of options.attempts ?? []) {
			this.attempts.set(attempt.id, {
				...attempt,
				actionLog: attempt.actionLog.map((entry) => ({ ...entry })),
			});
		}
		for (const result of options.results ?? []) {
			this.results.set(result.attemptId, result);
		}
	}

	async findChallengeByPeriodKey(
		challengeKind: 'blackjack-daily',
		periodKey: string,
	): Promise<DailyChallengeRecord | null> {
		for (const challenge of this.challenges.values()) {
			if (challenge.challengeKind === challengeKind && challenge.periodKey === periodKey) {
				return challenge;
			}
		}
		return null;
	}

	async insertChallengeIfAbsent(record: NewDailyChallengeRecord): Promise<'inserted' | 'existing'> {
		for (const existing of this.challenges.values()) {
			if (
				existing.challengeKind === record.challengeKind &&
				existing.periodKey === record.periodKey
			) {
				return 'existing';
			}
		}
		this.challenges.set(record.id, { ...record, config: BLACKJACK_DAILY_V1_CONFIG });
		return 'inserted';
	}

	async findAttemptByUserAndRequestId(
		userId: string,
		startRequestId: string,
	): Promise<DailyChallengeAttemptRecord | null> {
		for (const attempt of this.attempts.values()) {
			if (attempt.userId === userId && attempt.startRequestId === startRequestId) {
				return this.snapshotAttempt(attempt);
			}
		}
		return null;
	}

	async findAttemptByChallengeAndUser(
		challengeId: string,
		userId: string,
	): Promise<DailyChallengeAttemptRecord | null> {
		for (const attempt of this.attempts.values()) {
			if (attempt.challengeId === challengeId && attempt.userId === userId) {
				return this.snapshotAttempt(attempt);
			}
		}
		return null;
	}

	async findAttemptById(attemptId: string): Promise<DailyChallengeAttemptRecord | null> {
		const attempt = this.attempts.get(attemptId);
		return attempt ? this.snapshotAttempt(attempt) : null;
	}

	async findChallengeById(challengeId: string): Promise<DailyChallengeRecord | null> {
		return this.challenges.get(challengeId) ?? null;
	}

	async runStartTransition(
		input: DailyChallengeStartTransitionInput,
	): Promise<DailyChallengeStartTransitionResult> {
		this.startTransitions.push(input);
		const { attempt } = input;
		for (const existing of this.attempts.values()) {
			if (existing.challengeId === attempt.challengeId && existing.userId === attempt.userId) {
				return { kind: 'not-created' };
			}
			if (
				existing.userId === attempt.userId &&
				existing.startRequestId === attempt.startRequestId
			) {
				return { kind: 'not-created' };
			}
		}
		this.attempts.set(attempt.id, {
			...attempt,
			actionLog: [],
		});
		return { kind: 'created' };
	}

	async runCommandTransition(
		input: DailyChallengeCommandTransitionInput,
	): Promise<DailyChallengeCommandTransitionResult> {
		this.commandTransitions.push(input);
		const current = this.attempts.get(input.attemptId);
		if (!current) return { kind: 'not-applied' };
		if (
			current.status !== 'active' ||
			current.nextCommandSequence !== input.expectedSequence ||
			current.actionLogHash !== input.expectedActionLogHash ||
			current.availableBankroll !== input.expectedAvailableBankroll ||
			current.roundsCompleted !== input.expectedRoundsCompleted
		) {
			return { kind: 'not-applied' };
		}
		const actionLog = JSON.parse(input.nextActionLogJson) as DailyChallengeCommandV1[];
		const terminal = input.terminal;
		const status = terminal
			? terminal.terminalReason === 'forfeited'
				? 'forfeited'
				: terminal.terminalReason === 'expired'
					? 'expired'
					: 'completed'
			: 'active';
		const updated: AttemptState = {
			...current,
			actionLogJson: input.nextActionLogJson,
			actionLogHash: input.nextActionLogHash,
			nextCommandSequence: input.nextCommandSequence,
			availableBankroll: input.availableBankroll,
			roundsCompleted: input.roundsCompleted,
			status,
			updatedAt: input.nowSeconds,
			settledAt: terminal ? input.nowSeconds : null,
			actionLog,
		};
		this.attempts.set(current.id, updated);
		let result: DailyChallengeResultRecord | null = null;
		if (terminal) {
			result = {
				attemptId: input.attemptId,
				challengeId: terminal.challengeId,
				userId: current.userId,
				endingBankroll: input.availableBankroll,
				roundsCompleted: input.roundsCompleted,
				eligible: terminal.eligible,
				terminalReason: terminal.terminalReason,
				durationSeconds: terminal.durationSeconds,
				scoreVersion: terminal.scoreVersion,
				configHash: terminal.configHash,
				rankedSeedCommitment: terminal.rankedSeedCommitment,
				actionLogHash: input.nextActionLogHash,
				receiptHash: terminal.receiptHash,
				createdAt: input.nowSeconds,
				settledAt: input.nowSeconds,
				periodKey: terminal.periodKey,
				challengeRulesetVersion: terminal.challengeRulesetVersion,
				gameRulesetVersion: terminal.gameRulesetVersion,
			};
			this.results.set(input.attemptId, result);
		}
		return { kind: 'applied', result };
	}

	async findResultByAttempt(attemptId: string): Promise<DailyChallengeResultRecord | null> {
		return this.results.get(attemptId) ?? null;
	}

	async findStanding(
		challengeId: string,
		userId: string,
	): Promise<{ rank: number; percentile: number } | null> {
		const eligible = [...this.results.values()]
			.filter((result) => result.challengeId === challengeId && result.eligible)
			.sort((a, b) => b.endingBankroll - a.endingBankroll || b.roundsCompleted - a.roundsCompleted);
		const userIndex = eligible.findIndex((result) => result.userId === userId);
		if (userIndex === -1) return null;
		const totalEligible = eligible.length;
		const playersAtOrBelow = totalEligible - userIndex;
		const percentile = Math.min(
			100,
			Math.max(1, Math.round((100 * playersAtOrBelow) / totalEligible)),
		);
		return { rank: userIndex + 1, percentile };
	}

	async readLeaderboard(
		challengeId: string,
		limit: number,
		currentUserId?: string | null,
	): Promise<DailyChallengeLeaderboardRead> {
		const eligible = [...this.results.values()]
			.filter((result) => result.challengeId === challengeId && result.eligible)
			.sort((a, b) => b.endingBankroll - a.endingBankroll || b.roundsCompleted - a.roundsCompleted);
		const entries = eligible.slice(0, limit).map((result, index) => ({
			rank: index + 1,
			userId: result.userId,
			playerName: result.userId,
			endingBankroll: result.endingBankroll,
			roundsCompleted: result.roundsCompleted,
			durationSeconds: result.durationSeconds,
			settledAt: result.settledAt,
		}));
		if (!currentUserId) return { entries, currentUser: null };
		const userIndex = eligible.findIndex((result) => result.userId === currentUserId);
		if (userIndex === -1) return { entries, currentUser: null };
		const totalEligible = eligible.length;
		const playersAtOrBelow = totalEligible - userIndex;
		const percentile = Math.min(
			100,
			Math.max(1, Math.round((100 * playersAtOrBelow) / totalEligible)),
		);
		return { entries, currentUser: { rank: userIndex + 1, totalEligible, percentile } };
	}

	async listChallengeHistory(
		limit: number,
		currentUserId?: string | null,
	): Promise<DailyChallengeHistoryRead> {
		const challenges = [...this.challenges.values()]
			.sort((a, b) => b.endsAt - a.endsAt)
			.slice(0, limit);
		return {
			entries: challenges.map((challenge) => {
				const eligible = [...this.results.values()].filter(
					(result) => result.challengeId === challenge.id && result.eligible,
				);
				const top =
					eligible.length === 0
						? null
						: eligible.reduce((best, result) =>
								result.endingBankroll > best.endingBankroll ||
								(result.endingBankroll === best.endingBankroll &&
									result.roundsCompleted > best.roundsCompleted)
									? result
									: best,
							);
				const userResult = currentUserId
					? ([...this.results.values()].find(
							(result) => result.challengeId === challenge.id && result.userId === currentUserId,
						) ?? null)
					: null;
				return {
					periodKey: challenge.periodKey,
					challengeRulesetVersion: challenge.challengeRulesetVersion,
					topEndingBankroll: top ? top.endingBankroll : null,
					participantCount: eligible.length,
					userResult: userResult
						? {
								endingBankroll: userResult.endingBankroll,
								roundsCompleted: userResult.roundsCompleted,
								terminalReason: userResult.terminalReason,
								eligible: userResult.eligible,
								settledAt: userResult.settledAt,
							}
						: null,
				};
			}),
		};
	}

	async listExpiredAttempts(
		_nowSeconds: number,
		_cursor?: DailyChallengeExpirationCursor | null,
	): Promise<readonly DailyChallengeExpirationRow[]> {
		return [];
	}

	async deleteTerminalAttemptsBefore(_cutoffSeconds: number): Promise<number> {
		return 0;
	}

	snapshotAttempt(attempt: AttemptState): DailyChallengeAttemptRecord {
		return {
			id: attempt.id,
			challengeId: attempt.challengeId,
			userId: attempt.userId,
			startRequestId: attempt.startRequestId,
			startPayloadHash: attempt.startPayloadHash,
			status: attempt.status,
			actionLogJson: attempt.actionLogJson,
			actionLogHash: attempt.actionLogHash,
			nextCommandSequence: attempt.nextCommandSequence,
			availableBankroll: attempt.availableBankroll,
			roundsCompleted: attempt.roundsCompleted,
			expiresAt: attempt.expiresAt,
			createdAt: attempt.createdAt,
			updatedAt: attempt.updatedAt,
			settledAt: attempt.settledAt,
			actionLog: attempt.actionLog.map((entry) => ({ ...entry })),
		};
	}
}

interface ConcurrentWinnerState {
	challenge: DailyChallengeRecord;
	actionLog: DailyChallengeCommandV1[];
	status: 'completed' | 'forfeited' | 'expired';
	nextCommandSequence?: number;
}

class ConcurrentTerminalRepository extends FakeRepository {
	private raceUsed = false;

	constructor(
		options: FakeOptions,
		private readonly winner: ConcurrentWinnerState,
	) {
		super(options);
	}

	override async runCommandTransition(
		input: DailyChallengeCommandTransitionInput,
	): Promise<DailyChallengeCommandTransitionResult> {
		if (this.raceUsed) return super.runCommandTransition(input);
		this.raceUsed = true;
		const current = this.attempts.get(input.attemptId);
		if (!current) return { kind: 'not-applied' };
		const actionLogJson = canonicalizeRanked(this.winner.actionLog);
		const updated: AttemptState = {
			...current,
			actionLogJson,
			actionLogHash: hashCanonical(this.winner.actionLog),
			nextCommandSequence: this.winner.nextCommandSequence ?? this.winner.actionLog.length,
			status: this.winner.status,
			updatedAt: input.nowSeconds,
			settledAt: input.nowSeconds,
			actionLog: this.winner.actionLog.map((entry) => ({ ...entry })),
		};
		this.attempts.set(current.id, updated);
		this.results.set(input.attemptId, {
			attemptId: input.attemptId,
			challengeId: current.challengeId,
			userId: current.userId,
			endingBankroll: updated.availableBankroll,
			roundsCompleted: updated.roundsCompleted,
			eligible: false,
			terminalReason: this.winner.status === 'expired' ? 'expired' : 'forfeited',
			durationSeconds: 1,
			scoreVersion: 'blackjack-daily-score-v1',
			configHash: this.winner.challenge.configHash,
			rankedSeedCommitment: this.winner.challenge.rankedSeedCommitment,
			actionLogHash: hashCanonical(this.winner.actionLog),
			receiptHash: 'c'.repeat(64),
			createdAt: input.nowSeconds,
			settledAt: input.nowSeconds,
			periodKey: this.winner.challenge.periodKey,
			challengeRulesetVersion: this.winner.challenge.challengeRulesetVersion,
			gameRulesetVersion: this.winner.challenge.gameRulesetVersion,
		});
		return { kind: 'not-applied' };
	}
}

interface FakeClock {
	now(): Date;
	set(seconds: number): void;
	advance(seconds: number): void;
}

function createFakeClock(initialSeconds: number): FakeClock {
	let current = initialSeconds;
	return {
		now: () => new Date(current * 1000),
		set: (seconds) => {
			current = seconds;
		},
		advance: (seconds) => {
			current += seconds;
		},
	};
}

interface FakeRandom {
	randomBytes(length: number): Uint8Array;
}

function createFakeRandom(): FakeRandom {
	let counter = 1;
	return {
		randomBytes: (length) => {
			const bytes = new Uint8Array(length);
			for (let index = 0; index < length; index += 1) {
				bytes[index] = (counter + index * 7) % 256;
			}
			counter += length;
			return bytes;
		},
	};
}

interface FakeRateLimiter {
	consumeStart: DailyChallengeCoordinatorDeps['consumeStartRateLimit'];
	consumeCommand: DailyChallengeCoordinatorDeps['consumeCommandRateLimit'];
	consumeResume: DailyChallengeCoordinatorDeps['consumeResumeRateLimit'];
	startCalls: Array<{ userId: string; nowSeconds: number }>;
	commandCalls: Array<{ userId: string; nowSeconds: number }>;
	resumeCalls: Array<{ userId: string; nowSeconds: number }>;
	setAllowed(): void;
	setRateLimited(retryAfter: number): void;
}

function createFakeRateLimiter(): FakeRateLimiter {
	const startCalls: Array<{ userId: string; nowSeconds: number }> = [];
	const commandCalls: Array<{ userId: string; nowSeconds: number }> = [];
	const resumeCalls: Array<{ userId: string; nowSeconds: number }> = [];
	let mode: { kind: 'allowed' } | { kind: 'rate-limited'; retryAfter: number } = {
		kind: 'allowed',
	};
	return {
		startCalls,
		commandCalls,
		resumeCalls,
		setAllowed: () => {
			mode = { kind: 'allowed' };
		},
		setRateLimited: (retryAfter) => {
			mode = { kind: 'rate-limited', retryAfter };
		},
		consumeStart: async (userId, nowSeconds) => {
			startCalls.push({ userId, nowSeconds });
			if (mode.kind === 'allowed') {
				return { kind: 'allowed', statement: {} as D1PreparedStatement, retryAfter: 60 };
			}
			return { kind: 'rate-limited', retryAfter: mode.retryAfter };
		},
		consumeCommand: async (userId, nowSeconds) => {
			commandCalls.push({ userId, nowSeconds });
			if (mode.kind === 'allowed') {
				return { kind: 'allowed', statement: {} as D1PreparedStatement, retryAfter: 60 };
			}
			return { kind: 'rate-limited', retryAfter: mode.retryAfter };
		},
		consumeResume: async (userId, nowSeconds) => {
			resumeCalls.push({ userId, nowSeconds });
			if (mode.kind === 'allowed') {
				return { kind: 'allowed' };
			}
			return { kind: 'rate-limited', retryAfter: mode.retryAfter };
		},
	};
}

interface DepsBundle {
	deps: DailyChallengeCoordinatorDeps;
	clock: FakeClock;
	random: FakeRandom;
	rateLimiter: FakeRateLimiter;
	logs: DailyChallengeLogEntry[];
	coordinator: DailyChallengeCoordinator;
}

function createBundle(repository: FakeRepository, initialSeconds = NOW_SECONDS): DepsBundle {
	const clock = createFakeClock(initialSeconds);
	const random = createFakeRandom();
	const rateLimiter = createFakeRateLimiter();
	const logs: DailyChallengeLogEntry[] = [];
	const deps: DailyChallengeCoordinatorDeps = {
		repository,
		now: clock.now,
		randomBytes: random.randomBytes,
		log: (entry) => {
			logs.push(entry);
		},
		consumeStartRateLimit: rateLimiter.consumeStart,
		consumeCommandRateLimit: rateLimiter.consumeCommand,
		consumeResumeRateLimit: rateLimiter.consumeResume,
	};
	return {
		deps,
		clock,
		random,
		rateLimiter,
		logs,
		coordinator: createDailyChallengeCoordinator(deps),
	};
}

describe('daily challenge coordinator lazy catalog', () => {
	test('getCurrent resolves the exact UTC challenge window', async () => {
		const repository = new FakeRepository({ challenges: [] });
		const { coordinator } = createBundle(repository);

		const response = await coordinator.getCurrent({ userId: USER_ID });

		expect(response.periodKey).toBe(WINDOW.periodKey);
		expect(response.startsAt).toBe(WINDOW.startsAt);
		expect(response.rankedEntryClosesAt).toBe(WINDOW.rankedEntryClosesAt);
		expect(response.endsAt).toBe(WINDOW.endsAt);
		expect(response.challengeKind).toBe('blackjack-daily');
		expect(response.attempt).toBeNull();
	});

	test('lazy-created catalog draws independent ranked and practice seeds', async () => {
		const repository = new FakeRepository({ challenges: [] });
		const { coordinator } = createBundle(repository);

		await coordinator.getCurrent({ userId: USER_ID });

		const persisted = await repository.findChallengeByPeriodKey(
			'blackjack-daily',
			WINDOW.periodKey,
		);
		expect(persisted).not.toBeNull();
		expect(persisted?.rankedSeed).not.toBe(persisted?.practiceSeed);
		const rankedBytes = decodeCanonicalBase64Url(persisted!.rankedSeed);
		expect(rankedBytes).toHaveLength(32);
		expect(persisted?.rankedSeedCommitment).toBe(
			createDailyChallengeSeedCommitment('blackjack-daily-v1', rankedBytes),
		);
		expect(persisted?.rankedSeedCommitment).toMatch(/^[0-9a-f]{64}$/);
	});

	test('concurrent catalog candidates converge on the persisted winner', async () => {
		const repository = new FakeRepository({ challenges: [] });
		const { coordinator } = createBundle(repository);

		const [first, second] = await Promise.all([
			coordinator.getCurrent({ userId: USER_ID }),
			coordinator.getCurrent({ userId: OTHER_USER_ID }),
		]);

		const persisted = await repository.findChallengeByPeriodKey(
			'blackjack-daily',
			WINDOW.periodKey,
		);
		expect(persisted).not.toBeNull();
		expect(first.periodKey).toBe(persisted!.periodKey);
		expect(second.periodKey).toBe(persisted!.periodKey);
		expect(repository.challenges.size).toBe(1);
	});

	test('byPeriod returns CHALLENGE_NOT_FOUND for an unknown period', async () => {
		const repository = new FakeRepository({ challenges: [] });
		const { coordinator } = createBundle(repository);

		await expectDailyError(
			coordinator.getByPeriod({ periodKey: '2024-01-01', userId: USER_ID }),
			'CHALLENGE_NOT_FOUND',
		);
	});
});

describe('daily challenge coordinator start classification', () => {
	test('rejects start after the ranked entry cutoff', async () => {
		const repository = new FakeRepository();
		const { coordinator } = createBundle(repository, WINDOW.rankedEntryClosesAt);

		await expectDailyError(
			coordinator.start({ userId: USER_ID, body: { requestId: 'request-cutoff-000001' } }),
			'RANKED_ENTRY_CLOSED',
		);
		expect(repository.startTransitions).toHaveLength(0);
	});

	test('exact start request replay returns the persisted attempt without consuming the start rate', async () => {
		const repository = new FakeRepository();
		const { coordinator, rateLimiter } = createBundle(repository);
		const body: DailyChallengeStartRequest = { requestId: 'request-exact-0000001' };

		const first = await coordinator.start({ userId: USER_ID, body });
		const firstCalls = rateLimiter.startCalls.length;
		const second = await coordinator.start({ userId: USER_ID, body });

		expect(rateLimiter.startCalls.length).toBe(firstCalls);
		expect(second.attemptId).toBe(first.attemptId);
		expect(second.startRequestId).toBe(body.requestId);
		expect(second.status).toBe('active');
	});

	test('global request ID reuse across periods is rejected as a mismatch', async () => {
		const pastPeriod = getDailyChallengeWindow(NOW_SECONDS - 86_400);
		const pastChallenge = baseChallenge({
			id: 'test-challenge-past-001',
			periodKey: pastPeriod.periodKey,
			startsAt: pastPeriod.startsAt,
			rankedEntryClosesAt: pastPeriod.rankedEntryClosesAt,
			endsAt: pastPeriod.endsAt,
			createdAt: NOW_SECONDS - 86_400,
		});
		const pastAttempt = baseAttempt({
			id: 'attemptpastaaaaaaaaaaaaaa',
			challengeId: pastChallenge.id,
			startRequestId: 'request-shared-000001',
			status: 'completed',
			settledAt: NOW_SECONDS - 86_400 + 60,
		});
		const repository = new FakeRepository({
			challenges: [pastChallenge, baseChallenge()],
			attempts: [{ ...pastAttempt, actionLog: [] }],
		});
		const { coordinator } = createBundle(repository);

		await expectDailyError(
			coordinator.start({ userId: USER_ID, body: { requestId: 'request-shared-000001' } }),
			'IDENTIFIER_REUSE_MISMATCH',
		);
	});

	test("a different request ID recovers today's attempt and echoes the stored startRequestId", async () => {
		const repository = new FakeRepository();
		const { coordinator } = createBundle(repository);

		const first = await coordinator.start({
			userId: USER_ID,
			body: { requestId: 'request-recover-00001' },
		});
		const second = await coordinator.start({
			userId: USER_ID,
			body: { requestId: 'request-recover-00002' },
		});

		expect(second.attemptId).toBe(first.attemptId);
		expect(second.startRequestId).toBe('request-recover-00001');
		expect(repository.attempts.size).toBe(1);
	});

	test('concurrent different request IDs return exactly one winning attempt', async () => {
		const repository = new FakeRepository();
		const { coordinator } = createBundle(repository);

		const [left, right] = await Promise.all([
			coordinator.start({ userId: USER_ID, body: { requestId: 'request-race-left-001' } }),
			coordinator.start({ userId: USER_ID, body: { requestId: 'request-race-right-001' } }),
		]);

		expect(repository.attempts.size).toBe(1);
		const winnerId = [...repository.attempts.values()][0].id;
		expect(left.attemptId).toBe(winnerId);
		expect(right.attemptId).toBe(winnerId);
	});

	test('a fresh attempt expires no later than the challenge end', async () => {
		const repository = new FakeRepository();
		const { coordinator } = createBundle(repository, WINDOW.rankedEntryClosesAt - 1);

		const attempt = await coordinator.start({
			userId: USER_ID,
			body: { requestId: 'request-deadline-0001' },
		});

		expect(attempt.expiresAt).toBeLessThanOrEqual(WINDOW.endsAt);
	});

	test('a denied start rate limit short-circuits before the guarded insert', async () => {
		const repository = new FakeRepository();
		const { coordinator, rateLimiter } = createBundle(repository);
		rateLimiter.setRateLimited(120);

		await expectDailyError(
			coordinator.start({ userId: USER_ID, body: { requestId: 'request-rate-denied-001' } }),
			'RATE_LIMITED',
		);
		expect(repository.attempts.size).toBe(0);
		expect(repository.startTransitions).toHaveLength(0);
	});

	test('coordinator dependencies never reach for account or membership services', () => {
		const repository = new FakeRepository();
		const { deps } = createBundle(repository);
		expect(Object.keys(deps).sort()).toEqual([
			'consumeCommandRateLimit',
			'consumeResumeRateLimit',
			'consumeStartRateLimit',
			'log',
			'now',
			'randomBytes',
			'repository',
		]);
	});
});

describe('daily challenge coordinator resume and render', () => {
	test('resume for a non-owned attempt returns ATTEMPT_NOT_FOUND', async () => {
		const attempt = fixtureAttempt([startRound(0, DEFAULT_WAGER)]);
		const repository = new FakeRepository({ attempts: [attempt] });
		const { coordinator } = createBundle(repository);

		await expectDailyError(
			coordinator.resume({ userId: OTHER_USER_ID, attemptId: attempt.id }),
			'ATTEMPT_NOT_FOUND',
		);
	});

	test('resume detects a malformed stored projection as INTERNAL_ERROR', async () => {
		const attempt = { ...baseAttempt({ availableBankroll: 999 }), actionLog: [] };
		const repository = new FakeRepository({ attempts: [attempt] });
		const { coordinator } = createBundle(repository);

		await expectDailyError(
			coordinator.resume({ userId: USER_ID, attemptId: attempt.id }),
			'INTERNAL_ERROR',
		);
	});

	test('resume renders the active round projection for an in-progress attempt', async () => {
		const attempt = fixtureAttempt([startRound(0, DEFAULT_WAGER)]);
		const repository = new FakeRepository({ attempts: [attempt] });
		const { coordinator } = createBundle(repository);

		const state = await coordinator.resume({ userId: USER_ID, attemptId: attempt.id });

		expect(state.status).toBe('active');
		expect(state.nextCommandSequence).toBe(1);
		expect(state.activeRound).not.toBeNull();
		expect(state.receipt).toBeNull();
	});

	test('resume consumes the resume bucket before replaying or rendering', async () => {
		const attempt = fixtureAttempt([startRound(0, DEFAULT_WAGER)]);
		const repository = new FakeRepository({ attempts: [attempt] });
		const { coordinator, rateLimiter } = createBundle(repository);

		await coordinator.resume({ userId: USER_ID, attemptId: attempt.id });

		expect(rateLimiter.resumeCalls).toEqual([{ userId: USER_ID, nowSeconds: NOW_SECONDS }]);
	});

	test('a denied resume rate limit returns RATE_LIMITED before replay', async () => {
		const attempt = fixtureAttempt([startRound(0, DEFAULT_WAGER)]);
		const repository = new FakeRepository({ attempts: [attempt] });
		const { coordinator, rateLimiter } = createBundle(repository);
		rateLimiter.setRateLimited(90);

		await expectDailyError(
			coordinator.resume({ userId: USER_ID, attemptId: attempt.id }),
			'RATE_LIMITED',
		);
		expect(rateLimiter.resumeCalls).toHaveLength(1);
	});
});

describe('daily challenge coordinator command classification', () => {
	test('a behind-sequence exact command replays the authoritative state', async () => {
		const opener = startRound(0, DEFAULT_WAGER);
		const attempt = fixtureAttempt([opener]);
		const repository = new FakeRepository({ attempts: [attempt] });
		const { coordinator } = createBundle(repository);

		const state = await coordinator.command({
			userId: USER_ID,
			attemptId: attempt.id,
			body: opener,
		});

		expect(state.nextCommandSequence).toBe(1);
		expect(repository.commandTransitions).toHaveLength(0);
	});

	test('an on-time command consumes the command bucket before the guarded transition', async () => {
		const opener = startRound(0, DEFAULT_WAGER);
		const attempt = fixtureAttempt([opener]);
		const repository = new FakeRepository({ attempts: [attempt] });
		const { coordinator, rateLimiter } = createBundle(repository);

		const state = await coordinator.command({
			userId: USER_ID,
			attemptId: attempt.id,
			body: cmd(1, 'forfeit'),
		});

		expect(state.status).toBe('forfeited');
		expect(state.receipt?.eligible).toBe(false);
		expect(rateLimiter.commandCalls).toEqual([{ userId: USER_ID, nowSeconds: NOW_SECONDS }]);
		const transition = repository.commandTransitions.at(-1);
		expect(transition?.rateLimitStatement).toBeDefined();
		expect(transition?.retryAfter).toBe(60);
	});

	test('an exact behind-sequence replay never consumes the command bucket', async () => {
		const opener = startRound(0, DEFAULT_WAGER);
		const attempt = fixtureAttempt([opener]);
		const repository = new FakeRepository({ attempts: [attempt] });
		const { coordinator, rateLimiter } = createBundle(repository);

		const state = await coordinator.command({
			userId: USER_ID,
			attemptId: attempt.id,
			body: opener,
		});

		expect(state.nextCommandSequence).toBe(1);
		expect(rateLimiter.commandCalls).toEqual([]);
		expect(repository.commandTransitions).toHaveLength(0);
	});

	test('a sequence mismatch never consumes the command bucket', async () => {
		const attempt = fixtureAttempt([]);
		const repository = new FakeRepository({ attempts: [attempt] });
		const { coordinator, rateLimiter } = createBundle(repository);

		await expectDailyError(
			coordinator.command({ userId: USER_ID, attemptId: attempt.id, body: cmd(5, 'stand') }),
			'SEQUENCE_MISMATCH',
		);
		expect(rateLimiter.commandCalls).toEqual([]);
	});

	test('a denied command rate limit returns RATE_LIMITED before the guarded transition', async () => {
		const opener = startRound(0, DEFAULT_WAGER);
		const attempt = fixtureAttempt([opener]);
		const repository = new FakeRepository({ attempts: [attempt] });
		const { coordinator, rateLimiter } = createBundle(repository);
		rateLimiter.setRateLimited(45);

		await expectDailyError(
			coordinator.command({
				userId: USER_ID,
				attemptId: attempt.id,
				body: cmd(1, 'forfeit'),
			}),
			'RATE_LIMITED',
		);
		expect(rateLimiter.commandCalls).toHaveLength(1);
		expect(repository.commandTransitions).toHaveLength(0);
	});

	test('a behind-sequence different command rejects with IDENTIFIER_REUSE_MISMATCH', async () => {
		const attempt = fixtureAttempt([startRound(0, DEFAULT_WAGER)]);
		const repository = new FakeRepository({ attempts: [attempt] });
		const { coordinator } = createBundle(repository);

		await expectDailyError(
			coordinator.command({
				userId: USER_ID,
				attemptId: attempt.id,
				body: startRound(0, DEFAULT_WAGER * 2),
			}),
			'IDENTIFIER_REUSE_MISMATCH',
		);
	});

	test('an ahead-of-sequence command rejects with SEQUENCE_MISMATCH', async () => {
		const attempt = fixtureAttempt([]);
		const repository = new FakeRepository({ attempts: [attempt] });
		const { coordinator } = createBundle(repository);

		await expectDailyError(
			coordinator.command({ userId: USER_ID, attemptId: attempt.id, body: cmd(5, 'stand') }),
			'SEQUENCE_MISMATCH',
		);
	});

	test('a static wager below the minimum rejects with INVALID_WAGER', async () => {
		const attempt = fixtureAttempt([]);
		const repository = new FakeRepository({ attempts: [attempt] });
		const { coordinator } = createBundle(repository);

		await expectDailyError(
			coordinator.command({
				userId: USER_ID,
				attemptId: attempt.id,
				body: startRound(0, 1),
			}),
			'INVALID_WAGER',
		);
	});

	test('a dynamic double-down funding gap rejects with INSUFFICIENT_CHALLENGE_BANKROLL', async () => {
		const smallWager = BLACKJACK_DAILY_V1_CONFIG.startingBankroll - 5;
		const opener = startRound(0, smallWager);
		let seed: Uint8Array | null = null;
		for (let n = 1; n < 50_000; n += 1) {
			const candidate = Uint8Array.from({ length: 32 }, (_, index) => (index * 29 + n * 11) % 256);
			const afterOpen = replayDailyChallenge(BLACKJACK_DAILY_V1_CONFIG, candidate, [opener]);
			if (afterOpen.status !== 'active' || !afterOpen.activeRound) continue;
			const legal = afterOpen.activeRound.replay.legalActions;
			if (!legal.some((entry) => entry.action === 'double-down')) continue;
			try {
				replayDailyChallenge(BLACKJACK_DAILY_V1_CONFIG, candidate, [opener, cmd(1, 'double-down')]);
				continue;
			} catch (error) {
				if (
					error instanceof DailyChallengeServiceError &&
					error.code === 'INSUFFICIENT_CHALLENGE_BANKROLL'
				) {
					seed = candidate;
					break;
				}
			}
		}
		expect(seed).not.toBeNull();
		const challenge = challengeWithSeed(seed!);
		const attempt = fixtureAttempt([]);
		const repository = new FakeRepository({ challenges: [challenge], attempts: [attempt] });
		const { coordinator } = createBundle(repository);

		await coordinator.command({ userId: USER_ID, attemptId: attempt.id, body: opener });

		await expectDailyError(
			coordinator.command({ userId: USER_ID, attemptId: attempt.id, body: cmd(1, 'double-down') }),
			'INSUFFICIENT_CHALLENGE_BANKROLL',
		);
	});

	test('a natural terminal settles the attempt with an eligible receipt', async () => {
		let seed: Uint8Array | null = null;
		const fullWager = BLACKJACK_DAILY_V1_CONFIG.startingBankroll;
		for (let n = 1; n < 50_000; n += 1) {
			const candidate = Uint8Array.from({ length: 32 }, (_, index) => (index * 31 + n * 17) % 256);
			const replay = replayDailyChallenge(BLACKJACK_DAILY_V1_CONFIG, candidate, [
				startRound(0, fullWager),
				cmd(1, 'stand'),
			]);
			if (
				replay.roundsCompleted === 1 &&
				replay.availableBankroll === 0 &&
				replay.terminalReason === 'bankroll-below-minimum'
			) {
				seed = candidate;
				break;
			}
		}
		expect(seed).not.toBeNull();
		const challenge = challengeWithSeed(seed!);
		const attempt = fixtureAttempt([]);
		const repository = new FakeRepository({ challenges: [challenge], attempts: [attempt] });
		const { coordinator } = createBundle(repository);

		await coordinator.command({
			userId: USER_ID,
			attemptId: attempt.id,
			body: startRound(0, fullWager),
		});
		const state = await coordinator.command({
			userId: USER_ID,
			attemptId: attempt.id,
			body: cmd(1, 'stand'),
		});

		expect(state.status).toBe('completed');
		expect(state.receipt).not.toBeNull();
		expect(state.receipt?.terminalReason).toBe('bankroll-below-minimum');
		expect(state.receipt?.eligible).toBe(true);
		expect(state.activeRound).toBeNull();
	});

	test('an accepted forfeit settles as ineligible', async () => {
		const opener = startRound(0, DEFAULT_WAGER);
		const attempt = fixtureAttempt([opener]);
		const repository = new FakeRepository({ attempts: [attempt] });
		const { coordinator } = createBundle(repository);

		const state = await coordinator.command({
			userId: USER_ID,
			attemptId: attempt.id,
			body: cmd(1, 'forfeit'),
		});

		expect(state.status).toBe('forfeited');
		expect(state.receipt?.terminalReason).toBe('forfeited');
		expect(state.receipt?.eligible).toBe(false);
	});

	test('round-count completion takes precedence over a depleted bankroll', async () => {
		const attempt = fixtureAttempt([]);
		const repository = new FakeRepository({ attempts: [attempt] });
		const { coordinator } = createBundle(repository);

		const roundCount = BLACKJACK_DAILY_V1_CONFIG.roundCount;
		let seq = 0;
		let finalState: Awaited<ReturnType<typeof coordinator.command>> | undefined = undefined;
		for (let round = 0; round < roundCount; round += 1) {
			finalState = await coordinator.command({
				userId: USER_ID,
				attemptId: attempt.id,
				body: startRound(seq, DEFAULT_WAGER),
			});
			seq = finalState.nextCommandSequence;
			if (finalState.status !== 'active') break;
			while (finalState.status === 'active' && finalState.activeRound !== null) {
				finalState = await coordinator.command({
					userId: USER_ID,
					attemptId: attempt.id,
					body: cmd(seq, 'stand'),
				});
				seq = finalState.nextCommandSequence;
			}
			if (finalState.status !== 'active') break;
		}

		expect(finalState).toBeDefined();
		expect(finalState!.status).toBe('completed');
		expect(finalState!.receipt?.terminalReason).toBe('completed');
		expect(finalState!.receipt?.roundsCompleted).toBe(roundCount);
		expect(finalState!.receipt?.eligible).toBe(true);
	});
});

describe('daily challenge coordinator expiry semantics', () => {
	test('lazy expiry on resume returns the terminal receipt mapped to expired', async () => {
		const attempt = { ...baseAttempt({ expiresAt: NOW_SECONDS - 1 }), actionLog: [] };
		const repository = new FakeRepository({ attempts: [attempt] });
		const { coordinator } = createBundle(repository);

		const state = await coordinator.resume({ userId: USER_ID, attemptId: attempt.id });

		expect(state.status).toBe('expired');
		expect(state.receipt).not.toBeNull();
		expect(state.receipt?.terminalReason).toBe('expired');
		expect(state.receipt?.eligible).toBe(false);
		expect(state.activeRound).toBeNull();
	});

	test('an on-time command past the deadline expires instead of applying', async () => {
		const opener = startRound(0, DEFAULT_WAGER);
		const attempt = fixtureAttempt([opener], { expiresAt: NOW_SECONDS - 1 });
		const repository = new FakeRepository({ attempts: [attempt] });
		const { coordinator } = createBundle(repository);

		const state = await coordinator.command({
			userId: USER_ID,
			attemptId: attempt.id,
			body: cmd(1, 'stand'),
		});

		expect(state.status).toBe('expired');
		expect(repository.commandTransitions).toHaveLength(1);
		const stored = await repository.findAttemptById(attempt.id);
		expect(stored?.nextCommandSequence).toBe(1);
		expect(stored?.status).toBe('expired');
	});

	test('retrying the unrecorded expiry-triggering command returns ATTEMPT_COMPLETE', async () => {
		const attempt = { ...baseAttempt({ expiresAt: NOW_SECONDS - 1 }), actionLog: [] };
		const repository = new FakeRepository({ attempts: [attempt] });
		const { coordinator } = createBundle(repository);

		await coordinator.command({
			userId: USER_ID,
			attemptId: attempt.id,
			body: startRound(0, DEFAULT_WAGER),
		});

		await expectDailyError(
			coordinator.command({
				userId: USER_ID,
				attemptId: attempt.id,
				body: startRound(0, DEFAULT_WAGER),
			}),
			'ATTEMPT_COMPLETE',
		);
	});

	test('challenge end independently blocks commands even before attempt ttl', async () => {
		const attempt = { ...baseAttempt({ expiresAt: WINDOW.endsAt + 3600 }), actionLog: [] };
		const repository = new FakeRepository({ attempts: [attempt] });
		const { coordinator } = createBundle(repository, WINDOW.endsAt);

		const state = await coordinator.command({
			userId: USER_ID,
			attemptId: attempt.id,
			body: startRound(0, DEFAULT_WAGER),
		});

		expect(state.status).toBe('expired');
		expect(state.receipt?.terminalReason).toBe('expired');
	});

	test('effective expired duration uses the deadline, not the discovery time', async () => {
		const createdAt = NOW_SECONDS - 600;
		const expiresAt = NOW_SECONDS - 60;
		const attempt = { ...baseAttempt({ createdAt, expiresAt }), actionLog: [] };
		const repository = new FakeRepository({ attempts: [attempt] });
		const { coordinator } = createBundle(repository, NOW_SECONDS);

		const state = await coordinator.expire(attempt.id);

		expect(state.receipt?.durationSeconds).toBe(expiresAt - createdAt);
		expect(state.receipt?.settledAt).toBe(NOW_SECONDS);
	});

	test('expire on an already-terminal attempt renders the existing receipt without a new write', async () => {
		const opener = startRound(0, DEFAULT_WAGER);
		const attempt = fixtureAttempt([opener]);
		const repository = new FakeRepository({ attempts: [attempt] });
		const { coordinator } = createBundle(repository);

		const terminal = await coordinator.command({
			userId: USER_ID,
			attemptId: attempt.id,
			body: cmd(1, 'forfeit'),
		});
		expect(terminal.status).toBe('forfeited');
		const transitionsBefore = repository.commandTransitions.length;

		const expired = await coordinator.expire(attempt.id);

		expect(expired.status).toBe('forfeited');
		expect(repository.commandTransitions.length).toBe(transitionsBefore);
		expect(JSON.stringify(expired.receipt)).toBe(JSON.stringify(terminal.receipt));
	});
});

describe('daily challenge coordinator concurrent terminal classification', () => {
	test('an exact terminal replay that loses the race returns the immutable terminal response', async () => {
		const challenge = baseChallenge();
		const opener = startRound(0, DEFAULT_WAGER);
		const attempt = fixtureAttempt([opener]);
		const repository = new ConcurrentTerminalRepository(
			{ challenges: [challenge], attempts: [attempt] },
			{
				challenge,
				actionLog: [opener, cmd(1, 'forfeit')],
				status: 'forfeited',
			},
		);
		const { coordinator } = createBundle(repository);

		const state = await coordinator.command({
			userId: USER_ID,
			attemptId: attempt.id,
			body: cmd(1, 'forfeit'),
		});

		expect(state.status).toBe('forfeited');
		expect(state.receipt).not.toBeNull();
		expect(state.receipt?.terminalReason).toBe('forfeited');
		expect(state.receipt?.receiptHash).toBe('c'.repeat(64));
		expect(state.activeRound).toBeNull();
	});

	test('a different command at a terminal recorded sequence returns IDENTIFIER_REUSE_MISMATCH', async () => {
		const challenge = baseChallenge();
		const opener = startRound(0, DEFAULT_WAGER);
		const attempt = fixtureAttempt([opener]);
		const repository = new ConcurrentTerminalRepository(
			{ challenges: [challenge], attempts: [attempt] },
			{
				challenge,
				actionLog: [opener, cmd(1, 'forfeit')],
				status: 'forfeited',
			},
		);
		const { coordinator } = createBundle(repository);

		await expectDailyError(
			coordinator.command({
				userId: USER_ID,
				attemptId: attempt.id,
				body: cmd(1, 'hit'),
			}),
			'IDENTIFIER_REUSE_MISMATCH',
		);
	});

	test('a sequence at the terminal boundary of an expired racing attempt returns ATTEMPT_COMPLETE', async () => {
		const challenge = baseChallenge();
		const opener = startRound(0, DEFAULT_WAGER);
		const attempt = fixtureAttempt([opener]);
		const repository = new ConcurrentTerminalRepository(
			{ challenges: [challenge], attempts: [attempt] },
			{
				challenge,
				actionLog: [opener],
				status: 'expired',
				nextCommandSequence: 1,
			},
		);
		const { coordinator } = createBundle(repository);

		await expectDailyError(
			coordinator.command({
				userId: USER_ID,
				attemptId: attempt.id,
				body: cmd(1, 'hit'),
			}),
			'ATTEMPT_COMPLETE',
		);
	});
});

describe('daily challenge coordinator terminal receipt integrity', () => {
	test('a terminal receipt remains byte-identical across renders', async () => {
		const opener = startRound(0, DEFAULT_WAGER);
		const attempt = fixtureAttempt([opener]);
		const repository = new FakeRepository({ attempts: [attempt] });
		const { coordinator } = createBundle(repository);

		const first = await coordinator.command({
			userId: USER_ID,
			attemptId: attempt.id,
			body: cmd(1, 'forfeit'),
		});
		const second = await coordinator.resume({ userId: USER_ID, attemptId: attempt.id });

		expect(second.status).toBe('forfeited');
		expect(JSON.stringify(second.receipt)).toBe(JSON.stringify(first.receipt));
	});
});

describe('daily challenge coordinator leaderboard and history', () => {
	test('leaderboard returns ranked entries and the current user standing', async () => {
		const challenge = baseChallenge();
		const repository = new FakeRepository({
			challenges: [challenge],
			results: [
				{
					attemptId: 'a',
					challengeId: challenge.id,
					userId: USER_ID,
					endingBankroll: 1500,
					roundsCompleted: 10,
					eligible: true,
					terminalReason: 'completed',
					durationSeconds: 120,
					scoreVersion: 'blackjack-daily-score-v1',
					configHash: challenge.configHash,
					rankedSeedCommitment: challenge.rankedSeedCommitment,
					actionLogHash: 'a'.repeat(64),
					receiptHash: 'b'.repeat(64),
					createdAt: NOW_SECONDS,
					settledAt: NOW_SECONDS,
					periodKey: challenge.periodKey,
					challengeRulesetVersion: 'blackjack-daily-v1',
					gameRulesetVersion: 'blackjack-ranked-v1',
				},
			],
		});
		const { coordinator } = createBundle(repository);

		const board = await coordinator.leaderboard({
			periodKey: challenge.periodKey,
			userId: USER_ID,
			limit: 10,
		});

		expect(board.entries).toHaveLength(1);
		expect(board.entries[0]).toMatchObject({
			rank: 1,
			playerName: USER_ID,
			endingBankroll: 1500,
			roundsCompleted: 10,
			durationSeconds: 120,
			settledAt: NOW_SECONDS,
			isCurrentUser: true,
		});
		expect(Object.hasOwn(board.entries[0], 'userId')).toBe(false);
		expect(board.currentUser?.rank).toBe(1);
		expect(board.currentUser?.totalEligible).toBe(1);
	});

	test('leaderboard strips userId from every public entry and marks only the current user', async () => {
		const challenge = baseChallenge();
		const repository = new FakeRepository({
			challenges: [challenge],
			results: [
				{
					attemptId: 'a',
					challengeId: challenge.id,
					userId: USER_ID,
					endingBankroll: 1500,
					roundsCompleted: 10,
					eligible: true,
					terminalReason: 'completed',
					durationSeconds: 120,
					scoreVersion: 'blackjack-daily-score-v1',
					configHash: challenge.configHash,
					rankedSeedCommitment: challenge.rankedSeedCommitment,
					actionLogHash: 'a'.repeat(64),
					receiptHash: 'b'.repeat(64),
					createdAt: NOW_SECONDS,
					settledAt: NOW_SECONDS,
					periodKey: challenge.periodKey,
					challengeRulesetVersion: 'blackjack-daily-v1',
					gameRulesetVersion: 'blackjack-ranked-v1',
				},
				{
					attemptId: 'b',
					challengeId: challenge.id,
					userId: OTHER_USER_ID,
					endingBankroll: 1400,
					roundsCompleted: 10,
					eligible: true,
					terminalReason: 'completed',
					durationSeconds: 200,
					scoreVersion: 'blackjack-daily-score-v1',
					configHash: challenge.configHash,
					rankedSeedCommitment: challenge.rankedSeedCommitment,
					actionLogHash: 'c'.repeat(64),
					receiptHash: 'd'.repeat(64),
					createdAt: NOW_SECONDS,
					settledAt: NOW_SECONDS + 10,
					periodKey: challenge.periodKey,
					challengeRulesetVersion: 'blackjack-daily-v1',
					gameRulesetVersion: 'blackjack-ranked-v1',
				},
			],
		});
		const { coordinator } = createBundle(repository);

		const board = await coordinator.leaderboard({
			periodKey: challenge.periodKey,
			userId: USER_ID,
			limit: 10,
		});

		expect(board.entries).toHaveLength(2);
		expect(board.entries[0]?.isCurrentUser).toBe(true);
		expect(board.entries[1]?.isCurrentUser).toBeUndefined();
		for (const entry of board.entries) {
			expect(Object.hasOwn(entry, 'userId')).toBe(false);
		}
	});

	test('a guest leaderboard response exposes no userId and no current-user marker', async () => {
		const challenge = baseChallenge();
		const repository = new FakeRepository({
			challenges: [challenge],
			results: [
				{
					attemptId: 'a',
					challengeId: challenge.id,
					userId: USER_ID,
					endingBankroll: 1500,
					roundsCompleted: 10,
					eligible: true,
					terminalReason: 'completed',
					durationSeconds: 120,
					scoreVersion: 'blackjack-daily-score-v1',
					configHash: challenge.configHash,
					rankedSeedCommitment: challenge.rankedSeedCommitment,
					actionLogHash: 'a'.repeat(64),
					receiptHash: 'b'.repeat(64),
					createdAt: NOW_SECONDS,
					settledAt: NOW_SECONDS,
					periodKey: challenge.periodKey,
					challengeRulesetVersion: 'blackjack-daily-v1',
					gameRulesetVersion: 'blackjack-ranked-v1',
				},
			],
		});
		const { coordinator } = createBundle(repository);

		const board = await coordinator.leaderboard({
			periodKey: challenge.periodKey,
			userId: null,
			limit: 10,
		});

		expect(board.entries).toHaveLength(1);
		expect(board.entries[0]?.isCurrentUser).toBeUndefined();
		expect(Object.hasOwn(board.entries[0], 'userId')).toBe(false);
		expect(board.currentUser).toBeNull();
	});

	test('history returns one challenge-centric entry per day with the user result attached', async () => {
		const challenge = baseChallenge();
		const repository = new FakeRepository({
			challenges: [challenge],
			results: [
				{
					attemptId: 'a',
					challengeId: challenge.id,
					userId: USER_ID,
					endingBankroll: 1500,
					roundsCompleted: 10,
					eligible: true,
					terminalReason: 'completed',
					durationSeconds: 120,
					scoreVersion: 'blackjack-daily-score-v1',
					configHash: challenge.configHash,
					rankedSeedCommitment: challenge.rankedSeedCommitment,
					actionLogHash: 'a'.repeat(64),
					receiptHash: 'b'.repeat(64),
					createdAt: NOW_SECONDS,
					settledAt: NOW_SECONDS,
					periodKey: challenge.periodKey,
					challengeRulesetVersion: 'blackjack-daily-v1',
					gameRulesetVersion: 'blackjack-ranked-v1',
				},
			],
		});
		const { coordinator } = createBundle(repository);

		const history = await coordinator.history({ userId: USER_ID, limit: 10 });

		expect(history.entries).toHaveLength(1);
		expect(history.entries[0]).toMatchObject({
			periodKey: challenge.periodKey,
			challengeRulesetVersion: 'blackjack-daily-v1',
			topEndingBankroll: 1500,
			participantCount: 1,
		});
		expect(history.entries[0].userResult).toMatchObject({
			endingBankroll: 1500,
			roundsCompleted: 10,
			terminalReason: 'completed',
			eligible: true,
			settledAt: NOW_SECONDS,
		});
	});

	test('a guest history omits every user result', async () => {
		const challenge = baseChallenge();
		const repository = new FakeRepository({
			challenges: [challenge],
			results: [
				{
					attemptId: 'a',
					challengeId: challenge.id,
					userId: USER_ID,
					endingBankroll: 1500,
					roundsCompleted: 10,
					eligible: true,
					terminalReason: 'completed',
					durationSeconds: 120,
					scoreVersion: 'blackjack-daily-score-v1',
					configHash: challenge.configHash,
					rankedSeedCommitment: challenge.rankedSeedCommitment,
					actionLogHash: 'a'.repeat(64),
					receiptHash: 'b'.repeat(64),
					createdAt: NOW_SECONDS,
					settledAt: NOW_SECONDS,
					periodKey: challenge.periodKey,
					challengeRulesetVersion: 'blackjack-daily-v1',
					gameRulesetVersion: 'blackjack-ranked-v1',
				},
			],
		});
		const { coordinator } = createBundle(repository);

		const history = await coordinator.history({ userId: null, limit: 10 });

		expect(history.entries).toHaveLength(1);
		expect(history.entries[0].topEndingBankroll).toBe(1500);
		expect(history.entries[0].participantCount).toBe(1);
		expect(history.entries[0].userResult).toBeNull();
	});
});

describe('daily challenge coordinator ranked seed reveal', () => {
	test('a live challenge response never exposes the ranked seed', async () => {
		const repository = new FakeRepository();
		const { coordinator } = createBundle(repository);

		const response = await coordinator.getCurrent({ userId: USER_ID });

		expect(response.revealedRankedSeed).toBeNull();
	});

	test('a live challenge response exposes the stored canonical practice seed', async () => {
		const repository = new FakeRepository();
		const { coordinator } = createBundle(repository);

		const response = await coordinator.getCurrent({ userId: null });

		expect(response.practiceSeed).toBe(baseChallenge().practiceSeed);
		expect(decodeCanonicalBase64Url(response.practiceSeed)).toEqual(
			decodeCanonicalBase64Url(baseChallenge().practiceSeed),
		);
	});

	test('a closed challenge response keeps exposing the practice seed', async () => {
		const pastWindow = getDailyChallengeWindow(NOW_SECONDS - 86_400);
		const pastChallenge = baseChallenge({
			id: 'test-challenge-past-0001',
			periodKey: pastWindow.periodKey,
			startsAt: pastWindow.startsAt,
			rankedEntryClosesAt: pastWindow.rankedEntryClosesAt,
			endsAt: pastWindow.endsAt,
			createdAt: pastWindow.startsAt,
		});
		const repository = new FakeRepository({ challenges: [pastChallenge] });
		const { coordinator } = createBundle(repository);

		const response = await coordinator.getByPeriod({
			periodKey: pastWindow.periodKey,
			userId: null,
		});

		expect(response.revealedRankedSeed).toBe(pastChallenge.rankedSeed);
		expect(response.practiceSeed).toBe(pastChallenge.practiceSeed);
	});

	test('a closed challenge response reveals the stored canonical seed', async () => {
		const pastWindow = getDailyChallengeWindow(NOW_SECONDS - 86_400);
		const pastChallenge = baseChallenge({
			id: 'test-challenge-past-0001',
			periodKey: pastWindow.periodKey,
			startsAt: pastWindow.startsAt,
			rankedEntryClosesAt: pastWindow.rankedEntryClosesAt,
			endsAt: pastWindow.endsAt,
			createdAt: pastWindow.startsAt,
		});
		const repository = new FakeRepository({ challenges: [pastChallenge] });
		const { coordinator } = createBundle(repository);

		const response = await coordinator.getByPeriod({
			periodKey: pastWindow.periodKey,
			userId: null,
		});

		expect(response.revealedRankedSeed).toBe(pastChallenge.rankedSeed);
		expect(decodeCanonicalBase64Url(response.revealedRankedSeed!)).toEqual(
			decodeCanonicalBase64Url(pastChallenge.rankedSeed),
		);
	});

	test('a challenge response at the exact close boundary reveals the seed', async () => {
		const pastWindow = getDailyChallengeWindow(NOW_SECONDS - 86_400);
		const pastChallenge = baseChallenge({
			id: 'test-challenge-past-0001',
			periodKey: pastWindow.periodKey,
			startsAt: pastWindow.startsAt,
			rankedEntryClosesAt: pastWindow.rankedEntryClosesAt,
			endsAt: pastWindow.endsAt,
			createdAt: pastWindow.startsAt,
		});
		const repository = new FakeRepository({ challenges: [pastChallenge] });
		const { coordinator } = createBundle(repository, pastWindow.endsAt);

		const response = await coordinator.getByPeriod({
			periodKey: pastWindow.periodKey,
			userId: null,
		});

		expect(response.revealedRankedSeed).toBe(pastChallenge.rankedSeed);
	});

	test('coordinator log entries never carry the ranked seed', async () => {
		const repository = new FakeRepository();
		const { coordinator, logs } = createBundle(repository);

		const started = await coordinator.start({
			userId: USER_ID,
			body: { requestId: 'request-log-seed-0001' },
		});
		await coordinator.command({
			userId: USER_ID,
			attemptId: started.attemptId,
			body: startRound(0, DEFAULT_WAGER),
		});

		const persisted = await repository.findChallengeByPeriodKey(
			'blackjack-daily',
			WINDOW.periodKey,
		);
		expect(persisted).not.toBeNull();
		const seed = persisted!.rankedSeed;
		expect(logs.length).toBeGreaterThan(0);
		expect(logs.every((entry) => !JSON.stringify(entry).includes(seed))).toBe(true);
	});
});
