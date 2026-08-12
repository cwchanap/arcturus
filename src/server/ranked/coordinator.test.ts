import { describe, expect, test } from 'bun:test';
import { blackjackRankedV1Adapter, issueBlackjackConfig } from '../../lib/ranked/blackjack/adapter';
import { canonicalizeRanked, encodeBase64Url, hashCanonical } from '../../lib/ranked/canonical';
import { createSeedCommitment } from '../../lib/ranked/random';
import { getRankedAdapter } from '../../lib/ranked/registry';
import {
	RANKED_ERROR_STATUS,
	RankedServiceError,
	type RankedBlackjackActionLogV1,
	type RankedStartRequest,
} from '../../lib/ranked/protocol';
import {
	createRankedCoordinator,
	SNAPSHOT_ATTEMPTS,
	type RankedCoordinatorDeps,
} from './coordinator';
import type {
	ActionTransitionInput,
	ExpirationTransitionInput,
	NewRankedSessionRecord,
	RankedRepository,
	RankedResultRecord,
	RankedSessionRecord,
	StartTransitionInput,
	TerminalTransitionInput,
} from './repository';
import { createRankedRepository } from './repository';
import { RANKED_RATE_LIMITS } from './rate-limit';
import { createRankedTestD1, insertRankedTestUser } from './test-d1';

const USER_ID = 'ranked-coordinator-user';
const NOW_SECONDS = 1_800_000_000;
const NOW = new Date(NOW_SECONDS * 1000);
const REQUEST_ID = 'request-00000001';
const SESSION_ID = 'BwcHBwcHBwcHBwcHBwcHBw';
const ACTIVE_SEED = Uint8Array.from({ length: 32 }, (_, index) => index);
const NATURAL_SEED = Uint8Array.from({ length: 32 }, (_, index) => index + 2);

const START_REQUEST: RankedStartRequest = {
	requestId: REQUEST_ID,
	gameType: 'blackjack',
	rulesetVersion: 'blackjack-ranked-v1',
	wager: 100,
};

interface RepositoryCalls {
	findByStartRequest: [string, string][];
	findActiveSession: string[];
	findSessionOwner: string[];
	findOwnedSession: [string, string][];
	findResult: string[];
	readAccount: string[];
	consumeStandaloneRateLimit: [string, string, number][];
	runStartTransition: StartTransitionInput[];
	runActionTransition: ActionTransitionInput[];
	runTerminalTransition: ActionTransitionInput[];
	runExpirationTransition: ExpirationTransitionInput[];
}

function session({
	status = 'active',
	seed = ACTIVE_SEED,
	actions = [],
	expiresAt = NOW_SECONDS + 900,
	startPayloadHash = hashCanonical(START_REQUEST),
}: {
	status?: 'active' | 'settled' | 'expired';
	seed?: Uint8Array;
	actions?: RankedBlackjackActionLogV1;
	expiresAt?: number;
	startPayloadHash?: string;
} = {}): RankedSessionRecord {
	const config = issueBlackjackConfig(100);
	const actionLogJson = canonicalizeRanked(actions);
	return {
		id: SESSION_ID,
		userId: USER_ID,
		startRequestId: REQUEST_ID,
		startPayloadHash,
		activeUserId: status === 'active' ? USER_ID : null,
		gameType: 'blackjack',
		rulesetVersion: 'blackjack-ranked-v1',
		configJson: canonicalizeRanked(config),
		configHash: hashCanonical(config),
		seed: encodeBase64Url(seed),
		seedCommitment: createSeedCommitment(seed),
		actionLogJson,
		actionLogHash: hashCanonical(actions),
		nextSequence: actions.length,
		initialWager: 100,
		committedWager: 100,
		status,
		expiresAt,
		settledAt: status === 'active' ? null : NOW_SECONDS,
		createdAt: NOW_SECONDS - 30,
		updatedAt: NOW_SECONDS - 10,
		config,
		actionLog: actions,
	};
}

function resultFromTerminal(
	storedSession: RankedSessionRecord | NewRankedSessionRecord,
	terminal: TerminalTransitionInput,
): RankedResultRecord {
	return {
		sessionId: storedSession.id,
		userId: USER_ID,
		gameType: 'blackjack',
		rulesetVersion: 'blackjack-ranked-v1',
		seedCommitment: storedSession.seedCommitment,
		configHash: storedSession.configHash,
		actionLogHash: storedSession.actionLogHash,
		outcomeJson: terminal.outcomeJson,
		initialWager: storedSession.initialWager,
		committedWager: JSON.parse(terminal.outcomeJson).committedWager as number,
		payout: terminal.payout,
		gameNetDelta: terminal.gameNetDelta,
		rewardDelta: terminal.rewardDelta,
		balanceAfter: terminal.balanceAfter,
		statsEffectsJson: terminal.statsEffectsJson,
		achievementEffectsJson: terminal.achievementEffectsJson,
		rewardEffectsJson: terminal.rewardEffectsJson,
		receiptHash: terminal.receiptHash,
		settledAt: terminal.settledAt,
		outcome: JSON.parse(terminal.outcomeJson) as RankedResultRecord['outcome'],
		statsEffects: JSON.parse(terminal.statsEffectsJson) as RankedResultRecord['statsEffects'],
		achievementEffects: JSON.parse(
			terminal.achievementEffectsJson,
		) as RankedResultRecord['achievementEffects'],
		rewardEffects: JSON.parse(terminal.rewardEffectsJson) as RankedResultRecord['rewardEffects'],
	};
}

function createRepository(
	overrides: Partial<RankedRepository> = {},
): RankedRepository & { calls: RepositoryCalls } {
	const calls: RepositoryCalls = {
		findByStartRequest: [],
		findActiveSession: [],
		findSessionOwner: [],
		findOwnedSession: [],
		findResult: [],
		readAccount: [],
		consumeStandaloneRateLimit: [],
		runStartTransition: [],
		runActionTransition: [],
		runTerminalTransition: [],
		runExpirationTransition: [],
	};
	return {
		calls,
		async findByStartRequest(userId, requestId) {
			calls.findByStartRequest.push([userId, requestId]);
			return overrides.findByStartRequest?.(userId, requestId) ?? null;
		},
		async findActiveSession(userId) {
			calls.findActiveSession.push(userId);
			return overrides.findActiveSession?.(userId) ?? null;
		},
		async findSessionOwner(sessionId) {
			calls.findSessionOwner.push(sessionId);
			return overrides.findSessionOwner?.(sessionId) ?? null;
		},
		async findOwnedSession(userId, sessionId) {
			calls.findOwnedSession.push([userId, sessionId]);
			return overrides.findOwnedSession?.(userId, sessionId) ?? null;
		},
		async findResult(sessionId) {
			calls.findResult.push(sessionId);
			return overrides.findResult?.(sessionId) ?? null;
		},
		async readAccount(userId) {
			calls.readAccount.push(userId);
			return overrides.readAccount?.(userId) ?? { chipBalance: 900 };
		},
		async consumeStandaloneRateLimit(userId, operation, nowSeconds) {
			calls.consumeStandaloneRateLimit.push([userId, operation, nowSeconds]);
			return (
				overrides.consumeStandaloneRateLimit?.(userId, operation, nowSeconds) ?? {
					kind: 'allowed',
				}
			);
		},
		async runStartTransition(input) {
			calls.runStartTransition.push(input);
			return overrides.runStartTransition?.(input) ?? { kind: 'not-created' };
		},
		async runActionTransition(input) {
			calls.runActionTransition.push(input);
			return overrides.runActionTransition?.(input) ?? { kind: 'not-applied' };
		},
		async runTerminalTransition(input) {
			calls.runTerminalTransition.push(input);
			return overrides.runTerminalTransition?.(input) ?? { kind: 'not-applied' };
		},
		async runExpirationTransition(input) {
			calls.runExpirationTransition.push(input);
			return overrides.runExpirationTransition?.(input) ?? { kind: 'not-applied' };
		},
		async listExpiredSessions(nowSeconds, cursor) {
			return overrides.listExpiredSessions?.(nowSeconds, cursor) ?? [];
		},
		async deleteExpiredRateBuckets(nowSeconds) {
			return overrides.deleteExpiredRateBuckets?.(nowSeconds) ?? 0;
		},
	};
}

function coordinator(
	repository: RankedRepository,
	{
		randomSeed = ACTIVE_SEED,
		log,
	}: {
		randomSeed?: Uint8Array;
		log?: RankedCoordinatorDeps['log'];
	} = {},
) {
	const deps: RankedCoordinatorDeps = {
		repository,
		getAdapter: getRankedAdapter,
		now: () => new Date(NOW),
		randomBytes(length) {
			if (length === 16) return Uint8Array.from({ length }, () => 7);
			if (length === 32) return randomSeed.slice();
			throw new Error(`unexpected random length ${length}`);
		},
		log,
	};
	return createRankedCoordinator(deps);
}

async function expectRankedError(
	promise: Promise<unknown>,
	code: RankedServiceError['code'],
	expectedSequence?: number,
): Promise<void> {
	try {
		await promise;
		throw new Error('Expected ranked service error');
	} catch (error) {
		expect(error).toBeInstanceOf(RankedServiceError);
		expect(error).toMatchObject({
			code,
			...(expectedSequence === undefined ? {} : { expectedSequence }),
		});
	}
}

describe('ranked coordinator start lifecycle', () => {
	test('constructs and starts without multiplayer membership dependencies', async () => {
		let storedSession: RankedSessionRecord | null = null;
		const repository = createRepository({
			findByStartRequest: async () => storedSession,
			findOwnedSession: async () => storedSession,
			runStartTransition: async (input) => {
				storedSession = {
					...input.session,
					userId: USER_ID,
					activeUserId: USER_ID,
					nextSequence: 0,
					status: 'active',
					settledAt: null,
					config: issueBlackjackConfig(100),
					actionLog: [],
				};
				return { kind: 'created' };
			},
		});

		const response = await coordinator(repository).start({
			userId: USER_ID,
			body: START_REQUEST,
		});

		expect(response.status).toBe('active');
		expect(repository.calls.runStartTransition).toHaveLength(1);
	});

	test('a matching start request uses the replay bucket and returns the same authoritative session', async () => {
		const existing = session();
		const repository = createRepository({
			findByStartRequest: async () => existing,
			findOwnedSession: async () => existing,
		});

		const response = await coordinator(repository).start({
			userId: USER_ID,
			body: START_REQUEST,
		});

		expect(response.sessionId).toBe(SESSION_ID);
		expect(response.nextSequence).toBe(0);
		expect(repository.calls.consumeStandaloneRateLimit).toEqual([
			[USER_ID, 'ranked_replay', NOW_SECONDS],
		]);
		expect(repository.calls.runStartTransition).toHaveLength(0);
	});

	test('a mismatched start request consumes start capacity before rejecting identifier reuse', async () => {
		const repository = createRepository({
			findByStartRequest: async () => session({ startPayloadHash: hashCanonical({ wager: 200 }) }),
		});

		await expectRankedError(
			coordinator(repository).start({ userId: USER_ID, body: START_REQUEST }),
			'IDENTIFIER_REUSE_MISMATCH',
		);

		expect(repository.calls.consumeStandaloneRateLimit).toEqual([
			[USER_ID, 'ranked_start', NOW_SECONDS],
		]);
		expect(repository.calls.runStartTransition).toHaveLength(0);
	});

	test('replay-bucket exhaustion rate-limits an otherwise matching start retry', async () => {
		const repository = createRepository({
			findByStartRequest: async () => session(),
			consumeStandaloneRateLimit: async () => ({ kind: 'rate-limited', retryAfter: 17 }),
		});

		await expect(
			coordinator(repository).start({ userId: USER_ID, body: START_REQUEST }),
		).rejects.toMatchObject({ code: 'RATE_LIMITED', retryAfter: 17 });
	});

	test('an opening natural is settled in the start transaction and returns the stored receipt', async () => {
		let storedSession: RankedSessionRecord | null = null;
		let storedResult: RankedResultRecord | null = null;
		const repository = createRepository({
			findByStartRequest: async () => storedSession,
			findOwnedSession: async () => storedSession,
			runStartTransition: async (input) => {
				expect(input.openingTerminal).toBeDefined();
				expect(input.openingNonRewardTerminal).toBeDefined();
				storedSession = {
					...input.session,
					userId: USER_ID,
					activeUserId: null,
					nextSequence: 0,
					status: 'settled',
					settledAt: NOW_SECONDS,
					config: issueBlackjackConfig(100),
					actionLog: [],
				};
				storedResult = resultFromTerminal(input.session, input.openingTerminal!);
				return { kind: 'created', result: storedResult };
			},
			findResult: async () => storedResult,
		});

		const response = await coordinator(repository, { randomSeed: NATURAL_SEED }).start({
			userId: USER_ID,
			body: START_REQUEST,
		});

		expect(response.status).toBe('settled');
		expect(response.receipt?.receiptHash).toBe(storedResult?.receiptHash);
		expect(response.receipt?.rewardDelta).toBe(100);
		expect(JSON.stringify(response)).not.toContain(encodeBase64Url(NATURAL_SEED));
	});

	test('a start balance race rebuilds the opening receipt from the fresh snapshot', async () => {
		let accountRead = 0;
		let storedSession: RankedSessionRecord | null = null;
		let storedResult: RankedResultRecord | null = null;
		const repository = createRepository({
			findByStartRequest: async () => storedSession,
			findOwnedSession: async () => storedSession,
			readAccount: async () => ({
				chipBalance: accountRead++ === 0 ? 1000 : 1050,
			}),
			runStartTransition: async (input) => {
				if (repository.calls.runStartTransition.length === 1) {
					return { kind: 'balance-changed' };
				}
				storedSession = {
					...input.session,
					userId: USER_ID,
					activeUserId: null,
					nextSequence: 0,
					status: 'settled',
					settledAt: NOW_SECONDS,
					config: issueBlackjackConfig(100),
					actionLog: [],
				};
				storedResult = resultFromTerminal(input.session, input.openingTerminal!);
				return { kind: 'created', result: storedResult };
			},
			findResult: async () => storedResult,
		});

		const response = await coordinator(repository, { randomSeed: NATURAL_SEED }).start({
			userId: USER_ID,
			body: START_REQUEST,
		});

		expect(repository.calls.runStartTransition).toHaveLength(2);
		expect(
			repository.calls.runStartTransition.map(({ expectedBalance }) => expectedBalance),
		).toEqual([1000, 1050]);
		expect(repository.calls.runStartTransition[0].openingTerminal?.receiptHash).not.toBe(
			repository.calls.runStartTransition[1].openingTerminal?.receiptHash,
		);
		expect(response.receipt?.balanceAfter).toBe(1050);
	});
});

describe('ranked coordinator action and resume lifecycle', () => {
	test('a matching old action returns current authoritative state through the replay bucket', async () => {
		const current = session({ actions: [{ sequence: 0, action: 'hit' }] });
		const repository = createRepository({
			findOwnedSession: async () => current,
		});

		const response = await coordinator(repository).act({
			userId: USER_ID,
			sessionId: SESSION_ID,
			body: { sequence: 0, action: 'hit' },
		});

		expect(response.nextSequence).toBe(1);
		expect(response.state.nextSequence).toBe(1);
		expect(repository.calls.consumeStandaloneRateLimit).toEqual([
			[USER_ID, 'ranked_replay', NOW_SECONDS],
		]);
		expect(repository.calls.runActionTransition).toHaveLength(0);
	});

	test('recorded mismatch wins over terminal receipt replay', async () => {
		const settled = session({
			status: 'settled',
			actions: [{ sequence: 0, action: 'stand' }],
		});
		const repository = createRepository({
			findOwnedSession: async () => settled,
		});

		await expectRankedError(
			coordinator(repository).act({
				userId: USER_ID,
				sessionId: SESSION_ID,
				body: { sequence: 0, action: 'hit' },
			}),
			'IDENTIFIER_REUSE_MISMATCH',
		);

		expect(repository.calls.consumeStandaloneRateLimit).toEqual([
			[USER_ID, 'ranked_action', NOW_SECONDS],
		]);
	});

	test('a sequence gap remains a mismatch after settlement', async () => {
		const settled = session({
			status: 'settled',
			actions: [{ sequence: 0, action: 'stand' }],
		});
		const repository = createRepository({
			findOwnedSession: async () => settled,
		});

		await expectRankedError(
			coordinator(repository).act({
				userId: USER_ID,
				sessionId: SESSION_ID,
				body: { sequence: 2, action: 'hit' },
			}),
			'SEQUENCE_MISMATCH',
			1,
		);
	});

	test('a terminal request at nextSequence returns the immutable stored receipt', async () => {
		const settled = session({
			status: 'settled',
			actions: [{ sequence: 0, action: 'stand' }],
		});
		const replay = await blackjackRankedV1Adapter.replay(
			ACTIVE_SEED,
			settled.config,
			settled.actionLog,
		);
		const terminal = terminalFixture(settled, replay.outcome!, 900, 0);
		const storedResult = resultFromTerminal(settled, terminal);
		const repository = createRepository({
			findOwnedSession: async () => settled,
			findResult: async () => storedResult,
		});

		const response = await coordinator(repository).act({
			userId: USER_ID,
			sessionId: SESSION_ID,
			body: { sequence: 1, action: 'hit' },
		});

		expect(response.receipt?.receiptHash).toBe(storedResult.receiptHash);
		expect(repository.calls.consumeStandaloneRateLimit[0]?.[1]).toBe('ranked_replay');
	});

	test('ownership is hidden as SESSION_NOT_FOUND', async () => {
		const repository = createRepository();

		await expectRankedError(
			coordinator(repository).resume({ userId: USER_ID, sessionId: SESSION_ID }),
			'SESSION_NOT_FOUND',
		);
		await expectRankedError(
			coordinator(repository).act({
				userId: USER_ID,
				sessionId: SESSION_ID,
				body: { sequence: 0, action: 'hit' },
			}),
			'SESSION_NOT_FOUND',
		);
	});

	test('resume lazily expires at the immutable opening deadline and returns a receipt', async () => {
		let current = session({ expiresAt: NOW_SECONDS });
		let storedResult: RankedResultRecord | null = null;
		const originalDeadline = current.expiresAt;
		const repository = createRepository({
			findOwnedSession: async () => current,
			readAccount: async () => ({ chipBalance: 900 }),
			runExpirationTransition: async (input) => {
				storedResult = resultFromTerminal(current, input.terminal);
				current = {
					...current,
					activeUserId: null,
					status: 'expired',
					settledAt: input.nowSeconds,
				};
				return { kind: 'applied', result: storedResult };
			},
			findResult: async () => storedResult,
		});

		const response = await coordinator(repository).resume({
			userId: USER_ID,
			sessionId: SESSION_ID,
		});

		expect(response.status).toBe('expired');
		expect(response.expiresAt).toBe(originalDeadline);
		expect(response.receipt?.statsEffects.totalForfeits).toBe(1);
		expect(response.state.phase).toBe('complete');
		expect(response.state.availableActions).toEqual([]);
		expect(response.state.outcome).toEqual(response.receipt?.outcome);
		// Expiration must reveal the full dealer hand, not just the up-card projection.
		const fullDealerProjection = blackjackRankedV1Adapter.projectTerminal(
			await blackjackRankedV1Adapter.replay(ACTIVE_SEED, issueBlackjackConfig(100), []),
			900,
		).dealer;
		expect(response.state.dealer.cards).toEqual(fullDealerProjection.cards);
		expect(response.state.dealer.value).toEqual(fullDealerProjection.value);
		expect(response.state.dealer.cards.length).toBe(2);
		expect(repository.calls.consumeStandaloneRateLimit[0]?.[1]).toBe('ranked_resume');
	});

	test('a terminal balance race rebuilds both reward branches and retries at most three snapshots', async () => {
		const initial = session();
		let current = initial;
		let accountRead = 0;
		let storedResult: RankedResultRecord | null = null;
		const repository = createRepository({
			findOwnedSession: async () => current,
			readAccount: async () => ({
				chipBalance: accountRead++ === 0 ? 900 : 875,
			}),
			runTerminalTransition: async (input) => {
				if (repository.calls.runTerminalTransition.length === 1) {
					return { kind: 'balance-changed' };
				}
				current = {
					...current,
					activeUserId: null,
					status: 'settled',
					nextSequence: 1,
					actionLog: [{ sequence: 0, action: 'stand' }],
					actionLogJson: input.actionLogJson,
					actionLogHash: input.actionLogHash,
					settledAt: NOW_SECONDS,
				};
				storedResult = resultFromTerminal(current, input.terminal!);
				return { kind: 'applied', result: storedResult };
			},
			findResult: async () => storedResult,
		});

		const response = await coordinator(repository).act({
			userId: USER_ID,
			sessionId: SESSION_ID,
			body: { sequence: 0, action: 'stand' },
		});

		expect(repository.calls.runTerminalTransition).toHaveLength(2);
		expect(repository.calls.consumeStandaloneRateLimit).toEqual([
			[USER_ID, 'ranked_action', NOW_SECONDS],
		]);
		expect(
			repository.calls.runTerminalTransition.every(
				({ rateLimitMode }) => rateLimitMode === 'already-consumed',
			),
		).toBe(true);
		expect(
			repository.calls.runTerminalTransition.map(({ terminal }) => terminal?.expectedWalletBalance),
		).toEqual([900, 875]);
		expect(repository.calls.runTerminalTransition[0].terminal?.receiptHash).not.toBe(
			repository.calls.runTerminalTransition[1].terminal?.receiptHash,
		);
		for (const input of repository.calls.runTerminalTransition) {
			expect(input.nonRewardTerminal).toBeDefined();
			expect(input.nonRewardTerminal?.rewardDelta).toBe(0);
			expect(input.terminal?.rewardDelta).toBe(100);
		}
		expect(response.receipt?.balanceAfter).toBe(1175);
	});

	test('three sufficient terminal snapshot races return retriable ACCOUNT_BALANCE_CHANGED', async () => {
		let accountRead = 0;
		const repository = createRepository({
			findOwnedSession: async () => session(),
			readAccount: async () => ({
				chipBalance: 900 + accountRead++,
			}),
			runTerminalTransition: async () => ({ kind: 'balance-changed' }),
		});

		await expectRankedError(
			coordinator(repository).act({
				userId: USER_ID,
				sessionId: SESSION_ID,
				body: { sequence: 0, action: 'stand' },
			}),
			'ACCOUNT_BALANCE_CHANGED',
		);

		expect(repository.calls.runTerminalTransition).toHaveLength(3);
		expect(
			new Set(repository.calls.runTerminalTransition.map((call) => call.terminal?.receiptHash)),
		).toHaveProperty('size', 3);
	});

	test('a transition-batch rate denial emits the redacted ranked_rate_limited event', async () => {
		const events: string[] = [];
		const repository = createRepository({
			findOwnedSession: async () => session(),
			runTerminalTransition: async () => ({ kind: 'rate-limited', retryAfter: 19 }),
		});

		await expect(
			coordinator(repository, {
				log: ({ event }) => events.push(event),
			}).act({
				userId: USER_ID,
				sessionId: SESSION_ID,
				body: { sequence: 0, action: 'stand' },
			}),
		).rejects.toMatchObject({ code: 'RATE_LIMITED', retryAfter: 19 });
		expect(events).toContain('ranked_rate_limited');
	});

	test('a fresh snapshot that cannot fund an additional wager returns INSUFFICIENT_BALANCE', async () => {
		const doubleSeed = Uint8Array.from({ length: 32 }, (_, index) => index + 5);
		const active = session({ seed: doubleSeed });
		let accountRead = 0;
		const repository = createRepository({
			findOwnedSession: async () => active,
			readAccount: async () => ({
				chipBalance: accountRead++ === 0 ? 100 : 99,
			}),
			runTerminalTransition: async () => ({ kind: 'balance-changed' }),
		});

		await expectRankedError(
			coordinator(repository).act({
				userId: USER_ID,
				sessionId: SESSION_ID,
				body: { sequence: 0, action: 'double-down' },
			}),
			'INSUFFICIENT_BALANCE',
		);

		expect(repository.calls.runTerminalTransition).toHaveLength(1);
	});

	test('an illegal action at the active sequence is rejected as INVALID_ACTION', async () => {
		// 'split' is only legal on a pair; the default session is not a pair.
		const repository = createRepository({
			findOwnedSession: async () => session(),
		});

		await expectRankedError(
			coordinator(repository).act({
				userId: USER_ID,
				sessionId: SESSION_ID,
				body: { sequence: 0, action: 'split' },
			}),
			'INVALID_ACTION',
		);

		// No transition attempted for an illegal action.
		expect(repository.calls.runActionTransition).toHaveLength(0);
		expect(repository.calls.runTerminalTransition).toHaveLength(0);
	});

	test('a non-terminal action applies the action transition and renders the new state', async () => {
		const initial = session();
		let current = initial;
		const repository = createRepository({
			findOwnedSession: async () => current,
			runActionTransition: async (input) => {
				current = {
					...current,
					nextSequence: input.expectedSequence + 1,
					actionLog: [...current.actionLog, { sequence: input.expectedSequence, action: 'hit' }],
					actionLogJson: input.actionLogJson,
					actionLogHash: input.actionLogHash,
				};
				return { kind: 'applied' };
			},
		});

		const response = await coordinator(repository).act({
			userId: USER_ID,
			sessionId: SESSION_ID,
			body: { sequence: 0, action: 'hit' },
		});

		expect(repository.calls.runActionTransition).toHaveLength(1);
		expect(repository.calls.runTerminalTransition).toHaveLength(0);
		expect(response.nextSequence).toBe(1);
		expect(response.status).toBe('active');
	});

	test('a non-terminal balance race with no session advance surfaces ACCOUNT_BALANCE_CHANGED', async () => {
		const repository = createRepository({
			findOwnedSession: async () => session(),
			readAccount: async () => ({ chipBalance: 900 }),
			runActionTransition: async () => ({ kind: 'balance-changed' }),
		});

		await expectRankedError(
			coordinator(repository).act({
				userId: USER_ID,
				sessionId: SESSION_ID,
				body: { sequence: 0, action: 'hit' },
			}),
			'ACCOUNT_BALANCE_CHANGED',
		);

		// Recoverable balance conflicts retry through all SNAPSHOT_ATTEMPTS
		// before surfacing ACCOUNT_BALANCE_CHANGED.
		expect(repository.calls.runActionTransition).toHaveLength(SNAPSHOT_ATTEMPTS);
	});

	test('a stale snapshot whose sequence advanced past the request replays the stored action', async () => {
		// First findOwnedSession returns an active session at sequence 0; after
		// the balance-changed transition, a concurrent winner advanced it to 1.
		let callCount = 0;
		const advanced = session({ actions: [{ sequence: 0, action: 'hit' }] });
		const repository = createRepository({
			findOwnedSession: async () => {
				callCount += 1;
				return callCount === 1 ? session() : advanced;
			},
			runActionTransition: async () => ({ kind: 'balance-changed' }),
		});

		const response = await coordinator(repository).act({
			userId: USER_ID,
			sessionId: SESSION_ID,
			body: { sequence: 0, action: 'hit' },
		});

		expect(response.nextSequence).toBe(1);
		expect(repository.calls.runActionTransition).toHaveLength(1);
	});

	test('a stale snapshot whose sequence advanced with a mismatched action rejects identifier reuse', async () => {
		let callCount = 0;
		const advanced = session({ actions: [{ sequence: 0, action: 'stand' }] });
		const repository = createRepository({
			findOwnedSession: async () => {
				callCount += 1;
				return callCount === 1 ? session() : advanced;
			},
			runActionTransition: async () => ({ kind: 'balance-changed' }),
		});

		await expectRankedError(
			coordinator(repository).act({
				userId: USER_ID,
				sessionId: SESSION_ID,
				body: { sequence: 0, action: 'hit' },
			}),
			'IDENTIFIER_REUSE_MISMATCH',
		);
	});

	test('a settled stale snapshot renders the stored receipt without retrying', async () => {
		let callCount = 0;
		const settled = session({
			status: 'settled',
			actions: [{ sequence: 0, action: 'stand' }],
		});
		const replay = await blackjackRankedV1Adapter.replay(
			ACTIVE_SEED,
			settled.config,
			settled.actionLog,
		);
		const terminal = terminalFixture(settled, replay.outcome!, 900, 0);
		const storedResult = resultFromTerminal(settled, terminal);
		const repository = createRepository({
			findOwnedSession: async () => {
				callCount += 1;
				return callCount === 1 ? session() : settled;
			},
			findResult: async () => storedResult,
			runTerminalTransition: async () => ({ kind: 'balance-changed' }),
		});

		const response = await coordinator(repository).act({
			userId: USER_ID,
			sessionId: SESSION_ID,
			body: { sequence: 0, action: 'stand' },
		});

		expect(response.status).toBe('settled');
		expect(response.receipt?.receiptHash).toBe(storedResult.receiptHash);
		expect(repository.calls.runTerminalTransition).toHaveLength(1);
	});

	test('an action against a session that has since expired is lazily expired', async () => {
		let current = session({ expiresAt: NOW_SECONDS });
		let storedResult: RankedResultRecord | null = null;
		const repository = createRepository({
			findOwnedSession: async () => current,
			readAccount: async () => ({ chipBalance: 900 }),
			runExpirationTransition: async (input) => {
				storedResult = resultFromTerminal(current, input.terminal);
				current = {
					...current,
					activeUserId: null,
					status: 'expired',
					settledAt: input.nowSeconds,
				};
				return { kind: 'applied', result: storedResult };
			},
			findResult: async () => storedResult,
		});

		const response = await coordinator(repository).act({
			userId: USER_ID,
			sessionId: SESSION_ID,
			body: { sequence: 0, action: 'hit' },
		});

		expect(response.status).toBe('expired');
		expect(repository.calls.runExpirationTransition).toHaveLength(1);
		expect(repository.calls.runActionTransition).toHaveLength(0);
	});

	test('an action against a settled session replays the stored receipt', async () => {
		const settled = session({
			status: 'settled',
			actions: [{ sequence: 0, action: 'stand' }],
		});
		const replay = await blackjackRankedV1Adapter.replay(
			ACTIVE_SEED,
			settled.config,
			settled.actionLog,
		);
		const terminal = terminalFixture(settled, replay.outcome!, 900, 0);
		const storedResult = resultFromTerminal(settled, terminal);
		const repository = createRepository({
			findOwnedSession: async () => settled,
			findResult: async () => storedResult,
		});

		const response = await coordinator(repository).act({
			userId: USER_ID,
			sessionId: SESSION_ID,
			body: { sequence: 1, action: 'hit' },
		});

		expect(response.status).toBe('settled');
		// Settled sessions short-circuit to a replay-bucket consume, not action.
		expect(repository.calls.consumeStandaloneRateLimit[0]?.[1]).toBe('ranked_replay');
	});

	test('a preflight rate denial on an action rejects before any transition', async () => {
		const repository = createRepository({
			findOwnedSession: async () => session(),
			consumeStandaloneRateLimit: async () => ({
				kind: 'rate-limited',
				retryAfter: 7,
			}),
		});

		await expectRankedError(
			coordinator(repository).act({
				userId: USER_ID,
				sessionId: SESSION_ID,
				body: { sequence: 0, action: 'hit' },
			}),
			'RATE_LIMITED',
		);

		expect(repository.calls.runActionTransition).toHaveLength(0);
		expect(repository.calls.runTerminalTransition).toHaveLength(0);
	});
});

test('real D1 start, settlement, and replay preserve one stored receipt and wallet effect', async () => {
	const { mf, db } = await createRankedTestD1();
	try {
		await insertRankedTestUser(db, { id: USER_ID, chipBalance: 1000 });
		const repository = createRankedRepository(db);
		const ranked = createRankedCoordinator({
			repository,
			getAdapter: getRankedAdapter,
			now: () => new Date(NOW),
			randomBytes(length) {
				if (length === 16) return Uint8Array.from({ length }, () => 7);
				return ACTIVE_SEED.slice();
			},
		});

		const started = await ranked.start({ userId: USER_ID, body: START_REQUEST });
		const settled = await ranked.act({
			userId: USER_ID,
			sessionId: started.sessionId,
			body: { sequence: 0, action: 'stand' },
		});
		await db.prepare('UPDATE user SET chipBalance = ? WHERE id = ?').bind(777, USER_ID).run();
		const replayed = await ranked.act({
			userId: USER_ID,
			sessionId: started.sessionId,
			body: { sequence: 0, action: 'stand' },
		});

		expect(started.status).toBe('active');
		expect(started.balance).toBe(900);
		expect(settled.status).toBe('settled');
		expect(settled.balance).toBe(1200);
		expect(settled.receipt?.balanceAfter).toBe(1200);
		expect(replayed.balance).toBe(1200);
		expect(replayed.receipt).toEqual(settled.receipt);
		expect(await repository.readAccount(USER_ID)).toEqual({
			chipBalance: 777,
		});
		expect(
			await db
				.prepare('SELECT COUNT(*) AS count FROM ranked_result WHERE sessionId = ?')
				.bind(started.sessionId)
				.first<{ count: number }>(),
		).toEqual({ count: 1 });
	} finally {
		await mf.dispose();
	}
});

test('real D1 resume and matching start replay refresh an active casual cross-tab balance', async () => {
	const { mf, db } = await createRankedTestD1();
	try {
		await insertRankedTestUser(db, { id: USER_ID, chipBalance: 1000 });
		const ranked = createRankedCoordinator({
			repository: createRankedRepository(db),
			getAdapter: getRankedAdapter,
			now: () => new Date(NOW),
			randomBytes(length) {
				return length === 16 ? Uint8Array.from({ length }, () => 7) : ACTIVE_SEED.slice();
			},
		});
		const started = await ranked.start({ userId: USER_ID, body: START_REQUEST });
		await db.prepare('UPDATE user SET chipBalance = ? WHERE id = ?').bind(725, USER_ID).run();

		const resumed = await ranked.resume({
			userId: USER_ID,
			sessionId: started.sessionId,
		});
		const replayedStart = await ranked.start({ userId: USER_ID, body: START_REQUEST });

		expect(started.balance).toBe(900);
		expect(resumed.balance).toBe(725);
		expect(replayedStart.balance).toBe(725);
		expect(resumed.status).toBe('active');
		expect(replayedStart.sessionId).toBe(started.sessionId);
	} finally {
		await mf.dispose();
	}
});

test('real D1 underfunded starts consume durable capacity until RATE_LIMITED', async () => {
	const { mf, db } = await createRankedTestD1();
	try {
		await insertRankedTestUser(db, { id: USER_ID, chipBalance: 5 });
		const ranked = createRankedCoordinator({
			repository: createRankedRepository(db),
			getAdapter: getRankedAdapter,
			now: () => new Date(NOW),
			randomBytes: (length) => new Uint8Array(length),
		});
		const codes: string[] = [];

		for (let attempt = 0; attempt < 7; attempt += 1) {
			try {
				await ranked.start({ userId: USER_ID, body: START_REQUEST });
			} catch (error) {
				codes.push((error as RankedServiceError).code);
			}
		}

		expect(codes).toEqual([
			'INSUFFICIENT_BALANCE',
			'INSUFFICIENT_BALANCE',
			'INSUFFICIENT_BALANCE',
			'INSUFFICIENT_BALANCE',
			'INSUFFICIENT_BALANCE',
			'INSUFFICIENT_BALANCE',
			'RATE_LIMITED',
		]);
		expect(
			await db
				.prepare(
					"SELECT count FROM ranked_rate_limit WHERE userId = ? AND operation = 'ranked_start'",
				)
				.bind(USER_ID)
				.first<{ count: number }>(),
		).toEqual({ count: 6 });
	} finally {
		await mf.dispose();
	}
});

test('real D1 random valid resume IDs return the same public 404 until durable exhaustion', async () => {
	const { mf, db } = await createRankedTestD1();
	try {
		await insertRankedTestUser(db, { id: USER_ID, chipBalance: 1000 });
		const ranked = createRankedCoordinator({
			repository: createRankedRepository(db),
			getAdapter: getRankedAdapter,
			now: () => new Date(NOW),
			randomBytes: (length) => new Uint8Array(length),
		});
		const errors: RankedServiceError[] = [];

		for (let attempt = 0; attempt <= RANKED_RATE_LIMITS.ranked_resume.limit; attempt += 1) {
			const randomValidId = encodeBase64Url(
				Uint8Array.from({ length: 16 }, (_, index) => (attempt + index) & 0xff),
			);
			try {
				await ranked.resume({ userId: USER_ID, sessionId: randomValidId });
				throw new Error('Expected missing ranked session');
			} catch (error) {
				expect(error).toBeInstanceOf(RankedServiceError);
				errors.push(error as RankedServiceError);
			}
		}

		expect(
			errors
				.slice(0, RANKED_RATE_LIMITS.ranked_resume.limit)
				.map(({ code }) => [code, RANKED_ERROR_STATUS[code]]),
		).toEqual(
			Array.from({ length: RANKED_RATE_LIMITS.ranked_resume.limit }, () => [
				'SESSION_NOT_FOUND',
				404,
			]),
		);
		expect(errors.at(-1)).toMatchObject({ code: 'RATE_LIMITED', retryAfter: 60 });
		expect(
			await db
				.prepare(
					"SELECT count FROM ranked_rate_limit WHERE userId = ? AND operation = 'ranked_resume'",
				)
				.bind(USER_ID)
				.first<{ count: number }>(),
		).toEqual({ count: RANKED_RATE_LIMITS.ranked_resume.limit });
	} finally {
		await mf.dispose();
	}
});

test('real D1 non-owned action IDs return the same public 404 until durable exhaustion', async () => {
	const { mf, db } = await createRankedTestD1();
	const ownerId = 'ranked-session-owner';
	try {
		await insertRankedTestUser(db, { id: ownerId, chipBalance: 1000 });
		await insertRankedTestUser(db, { id: USER_ID, chipBalance: 1000 });
		const repository = createRankedRepository(db);
		const ranked = createRankedCoordinator({
			repository,
			getAdapter: getRankedAdapter,
			now: () => new Date(NOW),
			randomBytes(length) {
				return length === 16 ? Uint8Array.from({ length }, () => 7) : ACTIVE_SEED.slice();
			},
		});
		const started = await ranked.start({ userId: ownerId, body: START_REQUEST });
		const errors: RankedServiceError[] = [];

		for (let attempt = 0; attempt <= RANKED_RATE_LIMITS.ranked_action.limit; attempt += 1) {
			try {
				await ranked.act({
					userId: USER_ID,
					sessionId: started.sessionId,
					body: { sequence: 0, action: 'hit' },
				});
				throw new Error('Expected hidden ranked ownership');
			} catch (error) {
				expect(error).toBeInstanceOf(RankedServiceError);
				errors.push(error as RankedServiceError);
			}
		}

		expect(
			errors
				.slice(0, RANKED_RATE_LIMITS.ranked_action.limit)
				.map(({ code }) => [code, RANKED_ERROR_STATUS[code]]),
		).toEqual(
			Array.from({ length: RANKED_RATE_LIMITS.ranked_action.limit }, () => [
				'SESSION_NOT_FOUND',
				404,
			]),
		);
		expect(errors.at(-1)).toMatchObject({ code: 'RATE_LIMITED', retryAfter: 60 });
		expect(
			await db
				.prepare(
					"SELECT count FROM ranked_rate_limit WHERE userId = ? AND operation = 'ranked_action'",
				)
				.bind(USER_ID)
				.first<{ count: number }>(),
		).toEqual({ count: RANKED_RATE_LIMITS.ranked_action.limit });
		expect(await repository.findOwnedSession(ownerId, started.sessionId)).toMatchObject({
			status: 'active',
			nextSequence: 0,
		});
	} finally {
		await mf.dispose();
	}
});

test('real D1 concurrent different terminal actions return one winner and one identifier mismatch', async () => {
	const { mf, db } = await createRankedTestD1();
	try {
		await insertRankedTestUser(db, { id: USER_ID, chipBalance: 1000 });
		const terminalSeed = Uint8Array.from({ length: 32 }, (_, index) => index + 20);
		const ranked = createRankedCoordinator({
			repository: createRankedRepository(db),
			getAdapter: getRankedAdapter,
			now: () => new Date(NOW),
			randomBytes(length) {
				return length === 16 ? Uint8Array.from({ length }, () => 7) : terminalSeed.slice();
			},
		});
		const started = await ranked.start({ userId: USER_ID, body: START_REQUEST });

		const outcomes = await Promise.allSettled([
			ranked.act({
				userId: USER_ID,
				sessionId: started.sessionId,
				body: { sequence: 0, action: 'stand' },
			}),
			ranked.act({
				userId: USER_ID,
				sessionId: started.sessionId,
				body: { sequence: 0, action: 'hit' },
			}),
		]);

		expect(outcomes.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
		const rejection = outcomes.find(({ status }) => status === 'rejected');
		expect(rejection).toMatchObject({
			status: 'rejected',
			reason: { code: 'IDENTIFIER_REUSE_MISMATCH' },
		});
		expect(
			await db
				.prepare('SELECT COUNT(*) AS count FROM ranked_result WHERE sessionId = ?')
				.bind(started.sessionId)
				.first<{ count: number }>(),
		).toEqual({ count: 1 });
	} finally {
		await mf.dispose();
	}
});

test('a terminal snapshot retry at the 29/30 boundary consumes exactly one action unit', async () => {
	const { mf, db } = await createRankedTestD1();
	try {
		await insertRankedTestUser(db, { id: USER_ID, chipBalance: 1000 });
		const durableRepository = createRankedRepository(db);
		let armBalanceRace = false;
		let balanceRaced = false;
		const repository: RankedRepository = {
			...durableRepository,
			async readAccount(userId) {
				const account = await durableRepository.readAccount(userId);
				if (armBalanceRace && !balanceRaced) {
					balanceRaced = true;
					await db.prepare('UPDATE user SET chipBalance = ? WHERE id = ?').bind(875, userId).run();
				}
				return account;
			},
		};
		const ranked = createRankedCoordinator({
			repository,
			getAdapter: getRankedAdapter,
			now: () => new Date(NOW),
			randomBytes(length) {
				return length === 16 ? Uint8Array.from({ length }, () => 7) : ACTIVE_SEED.slice();
			},
		});
		const started = await ranked.start({ userId: USER_ID, body: START_REQUEST });
		for (let count = 0; count < 29; count += 1) {
			expect(
				await durableRepository.consumeStandaloneRateLimit(USER_ID, 'ranked_action', NOW_SECONDS),
			).toEqual({ kind: 'allowed' });
		}
		armBalanceRace = true;

		const settled = await ranked.act({
			userId: USER_ID,
			sessionId: started.sessionId,
			body: { sequence: 0, action: 'stand' },
		});

		expect(settled.receipt?.balanceAfter).toBe(1175);
		expect(
			await db
				.prepare(
					"SELECT count FROM ranked_rate_limit WHERE userId = ? AND operation = 'ranked_action'",
				)
				.bind(USER_ID)
				.first<{ count: number }>(),
		).toEqual({ count: 30 });
	} finally {
		await mf.dispose();
	}
});

test('a pre-consume denial leaves a valid real D1 action and wallet unchanged', async () => {
	const { mf, db } = await createRankedTestD1();
	try {
		await insertRankedTestUser(db, { id: USER_ID, chipBalance: 1000 });
		const durableRepository = createRankedRepository(db);
		const ranked = createRankedCoordinator({
			repository: durableRepository,
			getAdapter: getRankedAdapter,
			now: () => new Date(NOW),
			randomBytes(length) {
				return length === 16 ? Uint8Array.from({ length }, () => 7) : ACTIVE_SEED.slice();
			},
		});
		const started = await ranked.start({ userId: USER_ID, body: START_REQUEST });
		for (let count = 0; count < RANKED_RATE_LIMITS.ranked_action.limit; count += 1) {
			expect(
				await durableRepository.consumeStandaloneRateLimit(USER_ID, 'ranked_action', NOW_SECONDS),
			).toEqual({ kind: 'allowed' });
		}

		await expect(
			ranked.act({
				userId: USER_ID,
				sessionId: started.sessionId,
				body: { sequence: 0, action: 'stand' },
			}),
		).rejects.toMatchObject({ code: 'RATE_LIMITED', retryAfter: 60 });

		expect(await durableRepository.readAccount(USER_ID)).toEqual({
			chipBalance: 900,
		});
		expect(await durableRepository.findOwnedSession(USER_ID, started.sessionId)).toMatchObject({
			status: 'active',
			nextSequence: 0,
			actionLog: [],
		});
		expect(await durableRepository.findResult(started.sessionId)).toBeNull();
		expect(
			await db
				.prepare(
					"SELECT count FROM ranked_rate_limit WHERE userId = ? AND operation = 'ranked_action'",
				)
				.bind(USER_ID)
				.first<{ count: number }>(),
		).toEqual({ count: RANKED_RATE_LIMITS.ranked_action.limit });
	} finally {
		await mf.dispose();
	}
});

function terminalFixture(
	storedSession: RankedSessionRecord,
	outcome: RankedResultRecord['outcome'],
	expectedWalletBalance: number,
	rewardDelta: 0 | 100,
): TerminalTransitionInput {
	const statsEffects = {
		sessionsPlayed: 1 as const,
		totalWins: (outcome.result === 'win' ? 1 : 0) as 0 | 1,
		totalLosses: (outcome.result === 'loss' ? 1 : 0) as 0 | 1,
		totalPushes: (outcome.result === 'push' ? 1 : 0) as 0 | 1,
		totalForfeits: 0 as const,
		netProfit: outcome.gameNetDelta,
		biggestWin: Math.max(outcome.gameNetDelta, 0),
	};
	const achievementEffects = rewardDelta === 100 ? (['ranked_debut'] as const) : [];
	const rewardEffects =
		rewardDelta === 100 ? ([{ rewardId: 'ranked_debut_100', chipAmount: 100 }] as const) : [];
	const balanceAfter = expectedWalletBalance + outcome.payout + rewardDelta;
	const receipt = {
		sessionId: storedSession.id,
		gameType: storedSession.gameType,
		rulesetVersion: storedSession.rulesetVersion,
		seedCommitment: storedSession.seedCommitment,
		configHash: storedSession.configHash,
		actionLogHash: storedSession.actionLogHash,
		outcome,
		initialWager: storedSession.initialWager,
		committedWager: outcome.committedWager,
		payout: outcome.payout,
		gameNetDelta: outcome.gameNetDelta,
		rewardDelta,
		balanceAfter,
		statsEffects,
		achievementEffects,
		rewardEffects,
		settledAt: NOW_SECONDS,
	};
	return {
		expectedWalletBalance,
		finalAdditionalWager: 0,
		payout: outcome.payout,
		gameNetDelta: outcome.gameNetDelta,
		rewardDelta,
		balanceAfter,
		outcomeJson: canonicalizeRanked(outcome),
		statsEffectsJson: canonicalizeRanked(statsEffects),
		achievementEffectsJson: canonicalizeRanked(achievementEffects),
		rewardEffectsJson: canonicalizeRanked(rewardEffects),
		receiptHash: hashCanonical(receipt),
		settledAt: NOW_SECONDS,
	};
}

function coordinatorWith(
	repository: RankedRepository,
	overrides: Partial<
		Pick<RankedCoordinatorDeps, 'now' | 'randomBytes' | 'getAdapter' | 'log'>
	> = {},
): ReturnType<typeof createRankedCoordinator> {
	const deps: RankedCoordinatorDeps = {
		repository,
		getAdapter: overrides.getAdapter ?? getRankedAdapter,
		now: overrides.now ?? (() => new Date(NOW)),
		randomBytes:
			overrides.randomBytes ??
			((length: number) => {
				if (length === 16) return Uint8Array.from({ length }, () => 7);
				if (length === 32) return ACTIVE_SEED.slice();
				throw new Error(`unexpected random length ${length}`);
			}),
		log: overrides.log,
	};
	return createRankedCoordinator(deps);
}

function throwingAdapter(error: Error): typeof blackjackRankedV1Adapter {
	return {
		gameType: 'blackjack',
		rulesetVersion: 'blackjack-ranked-v1',
		async issue() {
			throw error;
		},
		async replay() {
			throw new Error('unused');
		},
		project() {
			throw new Error('unused');
		},
		projectTerminal() {
			throw new Error('unused');
		},
		terminalOutcome() {
			return null;
		},
	} as unknown as typeof blackjackRankedV1Adapter;
}

function accountSequence(balances: number[]): () => Promise<{ chipBalance: number }> {
	let index = 0;
	return async () => ({ chipBalance: balances[index++] ?? balances[balances.length - 1] });
}

describe('ranked coordinator branch coverage', () => {
	test('asNowSeconds rejects a negative clock before any repository work', async () => {
		const repository = createRepository();
		await expect(
			coordinatorWith(repository, { now: () => new Date(-2000) }).start({
				userId: USER_ID,
				body: START_REQUEST,
			}),
		).rejects.toThrow('Invalid ranked coordinator clock');
		expect(repository.calls.consumeStandaloneRateLimit).toHaveLength(0);
	});

	test('requireRandomBytes surfaces INTERNAL_ERROR for an invalid byte count', async () => {
		const repository = createRepository({
			findByStartRequest: async () => null,
			findActiveSession: async () => null,
			readAccount: async () => ({ chipBalance: 1000 }),
		});

		await expectRankedError(
			coordinatorWith(repository, {
				randomBytes: () => Uint8Array.from({ length: 5 }, () => 1),
			}).start({ userId: USER_ID, body: START_REQUEST }),
			'INTERNAL_ERROR',
		);
	});

	test('render rejects a terminal session with no stored result', async () => {
		const settled = session({
			status: 'settled',
			actions: [{ sequence: 0, action: 'stand' }],
		});
		const repository = createRepository({
			findOwnedSession: async () => settled,
			findResult: async () => null,
		});

		await expectRankedError(
			coordinator(repository).resume({ userId: USER_ID, sessionId: SESSION_ID }),
			'INTERNAL_ERROR',
		);
	});

	test('render rejects an invalid response balance', async () => {
		const active = session();
		const repository = createRepository({
			findOwnedSession: async () => active,
			readAccount: async () => ({ chipBalance: -5 }),
		});

		await expectRankedError(
			coordinator(repository).resume({ userId: USER_ID, sessionId: SESSION_ID }),
			'INTERNAL_ERROR',
		);
	});

	test('expire hides a missing owner as SESSION_NOT_FOUND', async () => {
		const repository = createRepository();

		await expectRankedError(coordinator(repository).expire(SESSION_ID), 'SESSION_NOT_FOUND');
	});

	test('expire renders an active non-expired session owned by the resolved owner', async () => {
		const active = session();
		const repository = createRepository({
			findSessionOwner: async () => USER_ID,
			findOwnedSession: async () => active,
		});

		const response = await coordinator(repository).expire(SESSION_ID);

		expect(response.status).toBe('active');
		expect(repository.calls.findSessionOwner).toEqual([SESSION_ID]);
	});

	test('expireOwned surfaces SESSION_NOT_FOUND when the session vanishes after a non-applied transition', async () => {
		let callCount = 0;
		const active = session({ expiresAt: NOW_SECONDS });
		const repository = createRepository({
			findSessionOwner: async () => USER_ID,
			findOwnedSession: async () => {
				callCount += 1;
				return callCount <= 1 ? active : null;
			},
			readAccount: async () => ({ chipBalance: 900 }),
			runExpirationTransition: async () => ({ kind: 'not-applied' }),
		});

		await expectRankedError(coordinator(repository).expire(SESSION_ID), 'SESSION_NOT_FOUND');
	});

	test('expireOwned renders a settled snapshot after a non-applied transition', async () => {
		let callCount = 0;
		const active = session({ expiresAt: NOW_SECONDS });
		const settled = session({
			status: 'settled',
			actions: [{ sequence: 0, action: 'stand' }],
		});
		const replay = await blackjackRankedV1Adapter.replay(
			ACTIVE_SEED,
			settled.config,
			settled.actionLog,
		);
		const terminal = terminalFixture(settled, replay.outcome!, 900, 0);
		const storedResult = resultFromTerminal(settled, terminal);
		const repository = createRepository({
			findSessionOwner: async () => USER_ID,
			findOwnedSession: async () => {
				callCount += 1;
				return callCount <= 1 ? active : settled;
			},
			readAccount: async () => ({ chipBalance: 900 }),
			runExpirationTransition: async () => ({ kind: 'not-applied' }),
			findResult: async () => storedResult,
		});

		const response = await coordinator(repository).expire(SESSION_ID);

		expect(response.status).toBe('settled');
		expect(response.receipt?.receiptHash).toBe(storedResult.receiptHash);
	});

	test('a matching replayed start that has since expired is lazily expired', async () => {
		let current = session({ expiresAt: NOW_SECONDS });
		let storedResult: RankedResultRecord | null = null;
		const repository = createRepository({
			findByStartRequest: async () => current,
			findOwnedSession: async () => current,
			readAccount: async () => ({ chipBalance: 900 }),
			runExpirationTransition: async (input) => {
				storedResult = resultFromTerminal(current, input.terminal);
				current = {
					...current,
					activeUserId: null,
					status: 'expired',
					settledAt: input.nowSeconds,
				};
				return { kind: 'applied', result: storedResult };
			},
			findResult: async () => storedResult,
		});

		const response = await coordinator(repository).start({
			userId: USER_ID,
			body: START_REQUEST,
		});

		expect(response.status).toBe('expired');
		expect(repository.calls.consumeStandaloneRateLimit[0]?.[1]).toBe('ranked_replay');
	});

	test('an expired active session is lazily expired before a fresh start', async () => {
		let current = session({ expiresAt: NOW_SECONDS });
		let storedResult: RankedResultRecord | null = null;
		let activeCallCount = 0;
		const repository = createRepository({
			findByStartRequest: async () => null,
			findActiveSession: async () => {
				activeCallCount += 1;
				return activeCallCount === 1 ? current : null;
			},
			findOwnedSession: async () => current,
			readAccount: accountSequence([900, 900, 5]),
			runExpirationTransition: async (input) => {
				storedResult = resultFromTerminal(current, input.terminal);
				current = {
					...current,
					activeUserId: null,
					status: 'expired',
					settledAt: input.nowSeconds,
				};
				return { kind: 'applied', result: storedResult };
			},
			findResult: async () => storedResult,
		});

		await expectRankedError(
			coordinator(repository).start({ userId: USER_ID, body: START_REQUEST }),
			'INSUFFICIENT_BALANCE',
		);

		expect(repository.calls.runExpirationTransition).toHaveLength(1);
		expect(repository.calls.findActiveSession).toHaveLength(2);
	});

	test('a fresh active session blocks a new start with ACTIVE_SESSION_EXISTS', async () => {
		const active = session();
		const repository = createRepository({
			findByStartRequest: async () => null,
			findActiveSession: async () => active,
		});

		await expectRankedError(
			coordinator(repository).start({ userId: USER_ID, body: START_REQUEST }),
			'ACTIVE_SESSION_EXISTS',
		);

		expect(repository.calls.consumeStandaloneRateLimit).toEqual([
			[USER_ID, 'ranked_start', NOW_SECONDS],
		]);
	});

	test('an out-of-range wager is mapped to INVALID_WAGER from a RangeError', async () => {
		const repository = createRepository({
			findByStartRequest: async () => null,
			findActiveSession: async () => null,
			readAccount: async () => ({ chipBalance: 1000 }),
		});

		await expectRankedError(
			coordinator(repository).start({
				userId: USER_ID,
				body: { ...START_REQUEST, requestId: 'request-wager-5', wager: 5 },
			}),
			'INVALID_WAGER',
		);
	});

	test('a RankedServiceError thrown by issue is rethrown unchanged', async () => {
		const repository = createRepository({
			findByStartRequest: async () => null,
			findActiveSession: async () => null,
			readAccount: async () => ({ chipBalance: 1000 }),
		});

		await expectRankedError(
			coordinatorWith(repository, {
				getAdapter: () => throwingAdapter(new RankedServiceError('INVALID_REQUEST')),
			}).start({ userId: USER_ID, body: START_REQUEST }),
			'INVALID_REQUEST',
		);
	});

	test('a non-RankedServiceError thrown by issue is rethrown verbatim', async () => {
		const repository = createRepository({
			findByStartRequest: async () => null,
			findActiveSession: async () => null,
			readAccount: async () => ({ chipBalance: 1000 }),
		});
		const boom = new Error('adapter blew up');

		await expect(
			coordinatorWith(repository, {
				getAdapter: () => throwingAdapter(boom),
			}).start({ userId: USER_ID, body: START_REQUEST }),
		).rejects.toBe(boom);
	});

	test('a start transition rate denial inside the retry loop throws RATE_LIMITED', async () => {
		const events: string[] = [];
		const repository = createRepository({
			findByStartRequest: async () => null,
			findActiveSession: async () => null,
			readAccount: async () => ({ chipBalance: 1000 }),
			runStartTransition: async () => ({ kind: 'rate-limited', retryAfter: 23 }),
		});

		await expect(
			coordinator(repository, { log: ({ event }) => events.push(event) }).start({
				userId: USER_ID,
				body: START_REQUEST,
			}),
		).rejects.toMatchObject({ code: 'RATE_LIMITED', retryAfter: 23 });
		expect(events).toContain('ranked_rate_limited');
	});

	test('a concurrent winner with a mismatched start hash rejects identifier reuse', async () => {
		let startCallCount = 0;
		const winner = session({ startPayloadHash: hashCanonical({ wager: 200 }) });
		const repository = createRepository({
			findByStartRequest: async () => {
				startCallCount += 1;
				return startCallCount === 1 ? null : winner;
			},
			findActiveSession: async () => null,
			readAccount: async () => ({ chipBalance: 1000 }),
			runStartTransition: async () => ({ kind: 'balance-changed' }),
		});

		await expectRankedError(
			coordinator(repository).start({ userId: USER_ID, body: START_REQUEST }),
			'IDENTIFIER_REUSE_MISMATCH',
		);
	});

	test('a concurrent winner with a matching start hash renders the stored session', async () => {
		let startCallCount = 0;
		const winner = session();
		const repository = createRepository({
			findByStartRequest: async () => {
				startCallCount += 1;
				return startCallCount === 1 ? null : winner;
			},
			findActiveSession: async () => null,
			readAccount: async () => ({ chipBalance: 900 }),
			runStartTransition: async () => ({ kind: 'balance-changed' }),
		});

		const response = await coordinator(repository).start({
			userId: USER_ID,
			body: START_REQUEST,
		});

		expect(response.sessionId).toBe(SESSION_ID);
		expect(response.status).toBe('active');
	});

	test('a blocking active session inside the retry loop throws ACTIVE_SESSION_EXISTS', async () => {
		let activeCallCount = 0;
		const blocking = session();
		const repository = createRepository({
			findByStartRequest: async () => null,
			findActiveSession: async () => {
				activeCallCount += 1;
				return activeCallCount === 2 ? blocking : null;
			},
			readAccount: async () => ({ chipBalance: 1000 }),
			runStartTransition: async () => ({ kind: 'balance-changed' }),
		});

		await expectRankedError(
			coordinator(repository).start({ userId: USER_ID, body: START_REQUEST }),
			'ACTIVE_SESSION_EXISTS',
		);
	});

	test('an unclassifiable not-created start conflict surfaces INTERNAL_ERROR', async () => {
		const repository = createRepository({
			findByStartRequest: async () => null,
			findActiveSession: async () => null,
			readAccount: async () => ({ chipBalance: 1000 }),
			runStartTransition: async () => ({ kind: 'not-created' }),
		});

		await expectRankedError(
			coordinator(repository).start({ userId: USER_ID, body: START_REQUEST }),
			'INTERNAL_ERROR',
		);
	});

	test('a balance-changed start retry that drops below the wager throws INSUFFICIENT_BALANCE', async () => {
		const repository = createRepository({
			findByStartRequest: async () => null,
			findActiveSession: async () => null,
			readAccount: accountSequence([1000, 5]),
			runStartTransition: async () => ({ kind: 'balance-changed' }),
		});

		await expectRankedError(
			coordinator(repository).start({ userId: USER_ID, body: START_REQUEST }),
			'INSUFFICIENT_BALANCE',
		);
		expect(repository.calls.runStartTransition).toHaveLength(1);
	});

	test('a blocking expired session inside the retry loop is expired then rechecked for funds', async () => {
		let current = session({ expiresAt: NOW_SECONDS });
		let storedResult: RankedResultRecord | null = null;
		let activeCallCount = 0;
		const repository = createRepository({
			findByStartRequest: async () => null,
			findActiveSession: async () => {
				activeCallCount += 1;
				return activeCallCount === 2 ? current : null;
			},
			findOwnedSession: async () => current,
			readAccount: accountSequence([1000, 900, 900, 5]),
			runStartTransition: async () => ({ kind: 'balance-changed' }),
			runExpirationTransition: async (input) => {
				storedResult = resultFromTerminal(current, input.terminal);
				current = {
					...current,
					activeUserId: null,
					status: 'expired',
					settledAt: input.nowSeconds,
				};
				return { kind: 'applied', result: storedResult };
			},
			findResult: async () => storedResult,
		});

		await expectRankedError(
			coordinator(repository).start({ userId: USER_ID, body: START_REQUEST }),
			'INSUFFICIENT_BALANCE',
		);

		expect(repository.calls.runExpirationTransition).toHaveLength(1);
		expect(repository.calls.runStartTransition).toHaveLength(1);
	});

	test('a matching old action against an expired active session is lazily expired', async () => {
		let current = session({
			actions: [{ sequence: 0, action: 'hit' }],
			expiresAt: NOW_SECONDS,
		});
		let storedResult: RankedResultRecord | null = null;
		const repository = createRepository({
			findOwnedSession: async () => current,
			readAccount: async () => ({ chipBalance: 900 }),
			runExpirationTransition: async (input) => {
				storedResult = resultFromTerminal(current, input.terminal);
				current = {
					...current,
					activeUserId: null,
					status: 'expired',
					settledAt: input.nowSeconds,
				};
				return { kind: 'applied', result: storedResult };
			},
			findResult: async () => storedResult,
		});

		const response = await coordinator(repository).act({
			userId: USER_ID,
			sessionId: SESSION_ID,
			body: { sequence: 0, action: 'hit' },
		});

		expect(response.status).toBe('expired');
		expect(repository.calls.consumeStandaloneRateLimit[0]?.[1]).toBe('ranked_replay');
		expect(repository.calls.runExpirationTransition).toHaveLength(1);
	});

	test('an action whose fresh account cannot fund the additional wager throws INSUFFICIENT_BALANCE', async () => {
		const doubleSeed = Uint8Array.from({ length: 32 }, (_, index) => index + 5);
		const active = session({ seed: doubleSeed });
		const repository = createRepository({
			findOwnedSession: async () => active,
			readAccount: async () => ({ chipBalance: 50 }),
		});

		await expectRankedError(
			coordinator(repository).act({
				userId: USER_ID,
				sessionId: SESSION_ID,
				body: { sequence: 0, action: 'double-down' },
			}),
			'INSUFFICIENT_BALANCE',
		);

		expect(repository.calls.runTerminalTransition).toHaveLength(0);
		expect(repository.calls.runActionTransition).toHaveLength(0);
	});

	test('expireOwned exhausts retries and surfaces ACCOUNT_BALANCE_CHANGED', async () => {
		const active = session({ expiresAt: NOW_SECONDS });
		const repository = createRepository({
			findOwnedSession: async () => active,
			readAccount: async () => ({ chipBalance: 900 }),
			runExpirationTransition: async () => ({ kind: 'balance-changed' }),
		});

		await expectRankedError(
			coordinator(repository).resume({ userId: USER_ID, sessionId: SESSION_ID }),
			'ACCOUNT_BALANCE_CHANGED',
		);

		expect(repository.calls.runExpirationTransition).toHaveLength(SNAPSHOT_ATTEMPTS);
	});

	test('a start retry loop that never resolves exhausts retries and surfaces ACCOUNT_BALANCE_CHANGED', async () => {
		const repository = createRepository({
			findByStartRequest: async () => null,
			findActiveSession: async () => null,
			readAccount: async () => ({ chipBalance: 1000 }),
			runStartTransition: async () => ({ kind: 'balance-changed' }),
		});

		await expectRankedError(
			coordinator(repository).start({ userId: USER_ID, body: START_REQUEST }),
			'ACCOUNT_BALANCE_CHANGED',
		);

		expect(repository.calls.runStartTransition).toHaveLength(SNAPSHOT_ATTEMPTS);
	});
});
