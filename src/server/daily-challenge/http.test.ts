import { describe, expect, test } from 'bun:test';
import {
	DAILY_CHALLENGE_ERROR_STATUS,
	DailyChallengeServiceError,
	type DailyChallengeAttemptPublicStateV1,
	type DailyChallengeCommandV1,
	type DailyChallengeHistoryResponse,
	type DailyChallengeLeaderboardResponse,
	type DailyChallengePublicResponse,
	type DailyChallengeStartRequest,
} from '../../lib/daily-challenge/protocol';
import { encodeBase64Url } from '../../lib/ranked/canonical';
import type { DailyChallengeCoordinator } from './coordinator';
import {
	createDailyChallengeCommandRateLimiter,
	createDailyChallengeHttpHandlers,
	createDailyChallengeResumeRateLimiter,
	createDailyChallengeStartRateLimiter,
	dailyChallengeJsonError,
} from './http';

const USER_ID = 'daily-http-user';
const OTHER_USER_ID = 'daily-http-other';
const ATTEMPT_ID = 'abcdefghijklmnopqrstuv';
const REQUEST_ID = 'start-request-0001';
const CHALLENGE_ID = 'challenge-00000001';
const PERIOD_KEY = '2026-08-02';
const HEX64 = 'a'.repeat(64);
const PRACTICE_SEED = encodeBase64Url(Uint8Array.from({ length: 32 }, (_, index) => 64 + index));
const START_BODY: DailyChallengeStartRequest = { requestId: REQUEST_ID };

function nowSeconds(): number {
	return Math.trunc(Date.now() / 1000);
}

function attemptState(
	overrides: Partial<DailyChallengeAttemptPublicStateV1> = {},
): DailyChallengeAttemptPublicStateV1 {
	return {
		attemptId: ATTEMPT_ID,
		challengeId: CHALLENGE_ID,
		startRequestId: REQUEST_ID,
		status: 'active',
		nextCommandSequence: 0,
		availableBankroll: 1000,
		roundsCompleted: 0,
		activeRound: null,
		rank: null,
		percentile: null,
		receipt: null,
		expiresAt: nowSeconds() + 1800,
		...overrides,
	};
}

function challengeResponse(
	overrides: Partial<DailyChallengePublicResponse> = {},
): DailyChallengePublicResponse {
	const base = nowSeconds();
	return {
		periodKey: PERIOD_KEY,
		challengeKind: 'blackjack-daily',
		challengeRulesetVersion: 'blackjack-daily-v1',
		gameRulesetVersion: 'blackjack-ranked-v1',
		scoreVersion: 'blackjack-daily-score-v1',
		startsAt: base,
		rankedEntryClosesAt: base + 1800,
		endsAt: base + 3600,
		configHash: HEX64,
		rankedSeedCommitment: HEX64,
		practiceSeed: PRACTICE_SEED,
		revealedRankedSeed: null,
		attempt: null,
		...overrides,
	};
}

function closedChallengeResponse(): DailyChallengePublicResponse {
	const base = nowSeconds();
	return challengeResponse({
		startsAt: base - 7200,
		rankedEntryClosesAt: base - 3600,
		endsAt: base - 3600,
		revealedRankedSeed: PRACTICE_SEED,
	});
}

function leaderboardResponse(
	overrides: Partial<DailyChallengeLeaderboardResponse> = {},
): DailyChallengeLeaderboardResponse {
	return {
		periodKey: PERIOD_KEY,
		entries: [],
		currentUser: null,
		...overrides,
	};
}

function historyResponse(): DailyChallengeHistoryResponse {
	return { entries: [] };
}

interface CoordinatorCalls {
	getCurrent: unknown[];
	getByPeriod: unknown[];
	start: unknown[];
	resume: unknown[];
	command: unknown[];
	expire: unknown[];
	leaderboard: unknown[];
	history: unknown[];
}

function fakeCoordinator(
	overrides: Partial<DailyChallengeCoordinator> = {},
): DailyChallengeCoordinator & { calls: CoordinatorCalls } {
	const calls: CoordinatorCalls = {
		getCurrent: [],
		getByPeriod: [],
		start: [],
		resume: [],
		command: [],
		expire: [],
		leaderboard: [],
		history: [],
	};
	return {
		calls,
		async getCurrent(input) {
			calls.getCurrent.push(input);
			return overrides.getCurrent?.(input) ?? challengeResponse();
		},
		async getByPeriod(input) {
			calls.getByPeriod.push(input);
			return overrides.getByPeriod?.(input) ?? challengeResponse();
		},
		async start(input) {
			calls.start.push(input);
			return overrides.start?.(input) ?? attemptState();
		},
		async resume(input) {
			calls.resume.push(input);
			return overrides.resume?.(input) ?? attemptState();
		},
		async command(input) {
			calls.command.push(input);
			return overrides.command?.(input) ?? attemptState();
		},
		async expire(input) {
			calls.expire.push(input);
			return overrides.expire?.(input) ?? attemptState();
		},
		async leaderboard(input) {
			calls.leaderboard.push(input);
			return overrides.leaderboard?.(input) ?? leaderboardResponse();
		},
		async history(input) {
			calls.history.push(input);
			return overrides.history?.(input) ?? historyResponse();
		},
	};
}

interface ContextOptions {
	userId?: string | null;
	body?: unknown;
	params?: Record<string, string | undefined>;
	query?: string;
	path?: string;
}

function context(options: ContextOptions = {}) {
	const {
		userId = USER_ID,
		body,
		params = {},
		query = '',
		path = '/api/daily-challenges',
	} = options;
	const url = new URL(`https://arcturus.test${path}${query ? `?${query}` : ''}`);
	return {
		locals: {
			user: userId === null ? null : { id: userId },
			runtime: {
				env: {
					DB: { binding: 'db' },
				},
			},
		},
		params,
		request: new Request(url, {
			method: body === undefined ? 'GET' : 'POST',
			headers: body === undefined ? undefined : { 'content-type': 'application/json' },
			body: body === undefined ? undefined : JSON.stringify(body),
		}),
		url,
	} as never;
}

async function json(response: Response): Promise<Record<string, unknown>> {
	return (await response.json()) as Record<string, unknown>;
}

describe('daily challenge HTTP authentication and parsing boundaries', () => {
	test('writes require auth before constructing the coordinator', async () => {
		let factoryCalls = 0;
		const handlers = createDailyChallengeHttpHandlers({
			createCoordinator() {
				factoryCalls += 1;
				return fakeCoordinator();
			},
		});

		const start = await handlers.start(context({ userId: null, body: START_BODY }));
		const resume = await handlers.resume(
			context({ userId: null, params: { attemptId: ATTEMPT_ID } }),
		);
		const command = await handlers.command(
			context({
				userId: null,
				params: { attemptId: ATTEMPT_ID },
				body: { sequence: 0, command: 'stand' },
			}),
		);

		expect([start.status, resume.status, command.status]).toEqual([401, 401, 401]);
		expect(await json(start)).toEqual({ error: 'UNAUTHORIZED' });
		expect(factoryCalls).toBe(0);
	});

	test('reads accept an optional guest identity without throwing', async () => {
		const coordinator = fakeCoordinator();
		const handlers = createDailyChallengeHttpHandlers({
			createCoordinator: () => coordinator,
		});

		const current = await handlers.current(context({ userId: null }));
		const detail = await handlers.detail(
			context({ userId: null, params: { periodKey: PERIOD_KEY } }),
		);
		const leaderboard = await handlers.leaderboard(
			context({ userId: null, params: { periodKey: PERIOD_KEY } }),
		);
		const history = await handlers.history(context({ userId: null }));

		expect([current.status, detail.status, leaderboard.status, history.status]).toEqual([
			200, 200, 200, 200,
		]);
		expect(coordinator.calls.getCurrent).toEqual([{ userId: null }]);
		expect(coordinator.calls.getByPeriod).toEqual([{ periodKey: PERIOD_KEY, userId: null }]);
	});

	test('malformed and impossible period keys are rejected before coordinator lookup', async () => {
		const coordinator = fakeCoordinator();
		const handlers = createDailyChallengeHttpHandlers({
			createCoordinator: () => coordinator,
		});

		const literal = await handlers.detail(context({ params: { periodKey: 'current' } }));
		const malformed = await handlers.detail(context({ params: { periodKey: '2026-8-2' } }));
		const impossible = await handlers.detail(context({ params: { periodKey: '2026-02-30' } }));
		const badMonth = await handlers.detail(context({ params: { periodKey: '2026-13-40' } }));

		expect([literal.status, malformed.status, impossible.status, badMonth.status]).toEqual([
			400, 400, 400, 400,
		]);
		expect(await json(literal)).toEqual({ error: 'INVALID_REQUEST' });
		expect(coordinator.calls.getByPeriod).toHaveLength(0);
	});

	test('leaderboard rejects malformed period keys before lookup', async () => {
		const coordinator = fakeCoordinator();
		const handlers = createDailyChallengeHttpHandlers({
			createCoordinator: () => coordinator,
		});

		const response = await handlers.leaderboard(context({ params: { periodKey: 'not-a-date' } }));

		expect(response.status).toBe(400);
		expect(await json(response)).toEqual({ error: 'INVALID_REQUEST' });
		expect(coordinator.calls.leaderboard).toHaveLength(0);
	});

	test('malformed attempt ids reject before repository lookup', async () => {
		const coordinator = fakeCoordinator();
		const handlers = createDailyChallengeHttpHandlers({
			createCoordinator: () => coordinator,
		});

		const resume = await handlers.resume(context({ params: { attemptId: 'too-short' } }));
		const command = await handlers.command(
			context({
				params: { attemptId: 'bad' },
				body: { sequence: 0, command: 'stand' },
			}),
		);

		expect([resume.status, command.status]).toEqual([400, 400]);
		expect(await json(resume)).toEqual({ error: 'INVALID_REQUEST' });
		expect(coordinator.calls.resume).toHaveLength(0);
		expect(coordinator.calls.command).toHaveLength(0);
	});

	test('start rejects malformed request ids and unknown fields', async () => {
		const coordinator = fakeCoordinator();
		const handlers = createDailyChallengeHttpHandlers({
			createCoordinator: () => coordinator,
		});

		const short = await handlers.start(context({ body: { requestId: 'short' } }));
		const unknown = await handlers.start(context({ body: { ...START_BODY, clientScore: 21 } }));

		expect([short.status, unknown.status]).toEqual([400, 400]);
		expect(await json(short)).toEqual({ error: 'INVALID_REQUEST' });
		expect(await json(unknown)).toEqual({ error: 'INVALID_REQUEST' });
		expect(coordinator.calls.start).toHaveLength(0);
	});

	test('command rejects unknown fields as INVALID_COMMAND', async () => {
		const coordinator = fakeCoordinator();
		const handlers = createDailyChallengeHttpHandlers({
			createCoordinator: () => coordinator,
		});

		const injected = await handlers.command(
			context({
				params: { attemptId: ATTEMPT_ID },
				body: { sequence: 0, command: 'stand', payout: 1000 },
			}),
		);

		expect(injected.status).toBe(400);
		expect(await json(injected)).toEqual({ error: 'INVALID_COMMAND' });
		expect(coordinator.calls.command).toHaveLength(0);
	});

	test('numeric static wager issues map to INVALID_WAGER, other command issues to INVALID_COMMAND', async () => {
		const coordinator = fakeCoordinator();
		const handlers = createDailyChallengeHttpHandlers({
			createCoordinator: () => coordinator,
		});

		const fractional = await handlers.command(
			context({
				params: { attemptId: ATTEMPT_ID },
				body: { sequence: 0, command: 'start-round', wager: 5.5 },
			}),
		);
		const stringWager = await handlers.command(
			context({
				params: { attemptId: ATTEMPT_ID },
				body: { sequence: 0, command: 'start-round', wager: '100' },
			}),
		);
		const missingWager = await handlers.command(
			context({
				params: { attemptId: ATTEMPT_ID },
				body: { sequence: 0, command: 'start-round' },
			}),
		);

		expect(await json(fractional)).toEqual({ error: 'INVALID_WAGER' });
		expect(await json(stringWager)).toEqual({ error: 'INVALID_COMMAND' });
		expect(await json(missingWager)).toEqual({ error: 'INVALID_COMMAND' });
		expect(coordinator.calls.command).toHaveLength(0);
	});

	test('query limits default and reject invalid bounds', async () => {
		const coordinator = fakeCoordinator();
		const handlers = createDailyChallengeHttpHandlers({
			createCoordinator: () => coordinator,
		});

		const leaderboardDefault = await handlers.leaderboard(
			context({ params: { periodKey: PERIOD_KEY } }),
		);
		const historyDefault = await handlers.history(context({}));

		expect(leaderboardDefault.status).toBe(200);
		expect(historyDefault.status).toBe(200);
		expect(coordinator.calls.leaderboard).toEqual([
			{ periodKey: PERIOD_KEY, userId: USER_ID, limit: 50 },
		]);
		expect(coordinator.calls.history).toEqual([{ userId: USER_ID, limit: 7 }]);

		const tooHigh = await handlers.leaderboard(
			context({ params: { periodKey: PERIOD_KEY }, query: 'limit=51' }),
		);
		const zero = await handlers.leaderboard(
			context({ params: { periodKey: PERIOD_KEY }, query: 'limit=0' }),
		);
		const nonNumeric = await handlers.leaderboard(
			context({ params: { periodKey: PERIOD_KEY }, query: 'limit=abc' }),
		);
		const historyTooHigh = await handlers.history(context({ query: 'limit=8' }));

		expect([tooHigh.status, zero.status, nonNumeric.status, historyTooHigh.status]).toEqual([
			400, 400, 400, 400,
		]);
		expect(await json(tooHigh)).toEqual({ error: 'INVALID_REQUEST' });
	});

	test('explicit in-range limits pass through to the coordinator', async () => {
		const coordinator = fakeCoordinator();
		const handlers = createDailyChallengeHttpHandlers({
			createCoordinator: () => coordinator,
		});

		await handlers.leaderboard(context({ params: { periodKey: PERIOD_KEY }, query: 'limit=20' }));
		await handlers.history(context({ query: 'limit=3' }));

		expect(coordinator.calls.leaderboard).toEqual([
			{ periodKey: PERIOD_KEY, userId: USER_ID, limit: 20 },
		]);
		expect(coordinator.calls.history).toEqual([{ userId: USER_ID, limit: 3 }]);
	});

	test('malformed JSON bodies are stable INVALID_REQUEST responses', async () => {
		const handlers = createDailyChallengeHttpHandlers({
			createCoordinator: () => fakeCoordinator(),
		});
		const malformed = context({ body: START_BODY }) as { request: Request };
		malformed.request = new Request('https://arcturus.test/api/daily-challenges/current/attempts', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: '{',
		});

		const response = await handlers.start(malformed as never);

		expect(response.status).toBe(400);
		expect(await json(response)).toEqual({ error: 'INVALID_REQUEST' });
	});

	test('valid handlers pass authenticated identity, strict bodies, and parsed ids', async () => {
		const coordinator = fakeCoordinator();
		const seenBindings: unknown[] = [];
		const handlers = createDailyChallengeHttpHandlers({
			createCoordinator(bindings) {
				seenBindings.push(bindings);
				return coordinator;
			},
		});
		const commandBody: DailyChallengeCommandV1 = { sequence: 0, command: 'stand' };

		expect((await handlers.start(context({ body: START_BODY }))).status).toBe(200);
		expect((await handlers.resume(context({ params: { attemptId: ATTEMPT_ID } }))).status).toBe(
			200,
		);
		expect(
			(await handlers.command(context({ params: { attemptId: ATTEMPT_ID }, body: commandBody })))
				.status,
		).toBe(200);

		expect(coordinator.calls.start).toEqual([{ userId: USER_ID, body: START_BODY }]);
		expect(coordinator.calls.resume).toEqual([{ userId: USER_ID, attemptId: ATTEMPT_ID }]);
		expect(coordinator.calls.command).toEqual([
			{ userId: USER_ID, attemptId: ATTEMPT_ID, body: commandBody },
		]);
		expect(seenBindings).toEqual([
			{ db: { binding: 'db' } },
			{ db: { binding: 'db' } },
			{ db: { binding: 'db' } },
		]);
	});
});

describe('daily challenge HTTP cache policy', () => {
	test('guest current uses live-detail cache and varies on Cookie', async () => {
		const handlers = createDailyChallengeHttpHandlers({
			createCoordinator: () => fakeCoordinator(),
		});

		const response = await handlers.current(context({ userId: null }));

		expect(response.headers.get('cache-control')).toBe(
			'public, max-age=0, s-maxage=60, stale-while-revalidate=300',
		);
		expect(response.headers.get('vary')).toBe('Cookie');
	});

	test('guest detail live challenge uses live-detail cache', async () => {
		const handlers = createDailyChallengeHttpHandlers({
			createCoordinator: () => fakeCoordinator(),
		});

		const response = await handlers.detail(
			context({ userId: null, params: { periodKey: PERIOD_KEY } }),
		);

		expect(response.headers.get('cache-control')).toBe(
			'public, max-age=0, s-maxage=60, stale-while-revalidate=300',
		);
		expect(response.headers.get('vary')).toBe('Cookie');
	});

	test('guest detail closed challenge uses closed-detail cache', async () => {
		const handlers = createDailyChallengeHttpHandlers({
			createCoordinator: () =>
				fakeCoordinator({ getByPeriod: async () => closedChallengeResponse() }),
		});

		const response = await handlers.detail(
			context({ userId: null, params: { periodKey: PERIOD_KEY } }),
		);

		expect(response.headers.get('cache-control')).toBe(
			'public, max-age=0, s-maxage=86400, stale-while-revalidate=604800',
		);
		expect(response.headers.get('vary')).toBe('Cookie');
	});

	test('guest leaderboard uses the short leaderboard cache', async () => {
		const handlers = createDailyChallengeHttpHandlers({
			createCoordinator: () => fakeCoordinator(),
		});

		const response = await handlers.leaderboard(
			context({ userId: null, params: { periodKey: PERIOD_KEY } }),
		);

		expect(response.headers.get('cache-control')).toBe(
			'public, max-age=0, s-maxage=15, stale-while-revalidate=60',
		);
		expect(response.headers.get('vary')).toBe('Cookie');
	});

	test('guest history uses the history cache', async () => {
		const handlers = createDailyChallengeHttpHandlers({
			createCoordinator: () => fakeCoordinator(),
		});

		const response = await handlers.history(context({ userId: null }));

		expect(response.headers.get('cache-control')).toBe(
			'public, max-age=0, s-maxage=60, stale-while-revalidate=300',
		);
		expect(response.headers.get('vary')).toBe('Cookie');
	});

	test('authenticated read responses are private/no-store and never shared', async () => {
		const handlers = createDailyChallengeHttpHandlers({
			createCoordinator: () => fakeCoordinator(),
		});

		const current = await handlers.current(context({}));
		const detail = await handlers.detail(context({ params: { periodKey: PERIOD_KEY } }));
		const leaderboard = await handlers.leaderboard(context({ params: { periodKey: PERIOD_KEY } }));
		const history = await handlers.history(context({}));

		for (const response of [current, detail, leaderboard, history]) {
			expect(response.headers.get('cache-control')).toBe('private, no-store');
		}
	});

	test('write and resume responses are private/no-store', async () => {
		const handlers = createDailyChallengeHttpHandlers({
			createCoordinator: () => fakeCoordinator(),
		});

		const start = await handlers.start(context({ body: START_BODY }));
		const resume = await handlers.resume(context({ params: { attemptId: ATTEMPT_ID } }));
		const command = await handlers.command(
			context({ params: { attemptId: ATTEMPT_ID }, body: { sequence: 0, command: 'stand' } }),
		);

		for (const response of [start, resume, command]) {
			expect(response.headers.get('cache-control')).toBe('private, no-store');
		}
	});
});

describe('daily challenge HTTP stable response contract', () => {
	test('another user attempt is indistinguishable from a missing attempt', async () => {
		const handlers = createDailyChallengeHttpHandlers({
			createCoordinator: () =>
				fakeCoordinator({
					resume: async () => {
						throw new DailyChallengeServiceError('ATTEMPT_NOT_FOUND');
					},
					command: async () => {
						throw new DailyChallengeServiceError('ATTEMPT_NOT_FOUND');
					},
				}),
		});

		const owner = await handlers.resume(context({ params: { attemptId: ATTEMPT_ID } }));
		const other = await handlers.resume(
			context({ userId: OTHER_USER_ID, params: { attemptId: ATTEMPT_ID } }),
		);
		const commandOther = await handlers.command(
			context({
				userId: OTHER_USER_ID,
				params: { attemptId: ATTEMPT_ID },
				body: { sequence: 0, command: 'stand' },
			}),
		);

		expect([owner.status, other.status, commandOther.status]).toEqual([404, 404, 404]);
		expect(await json(owner)).toEqual({ error: 'ATTEMPT_NOT_FOUND' });
		expect(await json(other)).toEqual({ error: 'ATTEMPT_NOT_FOUND' });
	});

	test('dynamic coordinator errors preserve their mapped status', async () => {
		const handlers = createDailyChallengeHttpHandlers({
			createCoordinator: () =>
				fakeCoordinator({
					start: async () => {
						throw new DailyChallengeServiceError('INSUFFICIENT_CHALLENGE_BANKROLL');
					},
					getByPeriod: async () => {
						throw new DailyChallengeServiceError('CHALLENGE_NOT_FOUND');
					},
					leaderboard: async () => {
						throw new DailyChallengeServiceError('RANKED_ENTRY_CLOSED');
					},
				}),
		});

		const bankroll = await handlers.start(context({ body: START_BODY }));
		const missing = await handlers.detail(context({ params: { periodKey: PERIOD_KEY } }));
		const closed = await handlers.leaderboard(context({ params: { periodKey: PERIOD_KEY } }));

		expect(bankroll.status).toBe(409);
		expect(missing.status).toBe(404);
		expect(closed.status).toBe(409);
	});

	test('Retry-After appears on RATE_LIMITED and expectedSequence on SEQUENCE_MISMATCH', async () => {
		const handlers = createDailyChallengeHttpHandlers({
			createCoordinator: () =>
				fakeCoordinator({
					start: async () => {
						throw new DailyChallengeServiceError('RATE_LIMITED', { retryAfter: 23 });
					},
					command: async () => {
						throw new DailyChallengeServiceError('SEQUENCE_MISMATCH', { expectedSequence: 7 });
					},
				}),
		});

		const rate = await handlers.start(context({ body: START_BODY }));
		const sequence = await handlers.command(
			context({ params: { attemptId: ATTEMPT_ID }, body: { sequence: 9, command: 'stand' } }),
		);

		expect(rate.status).toBe(429);
		expect(rate.headers.get('Retry-After')).toBe('23');
		expect(await json(rate)).toEqual({ error: 'RATE_LIMITED' });
		expect(sequence.status).toBe(409);
		expect(await json(sequence)).toEqual({ error: 'SEQUENCE_MISMATCH', expectedSequence: 7 });
		expect(sequence.headers.has('Retry-After')).toBe(false);
	});
});

describe('daily challenge HTTP error status mapping', () => {
	const mappedCodes = Object.entries(DAILY_CHALLENGE_ERROR_STATUS) as Array<
		[keyof typeof DAILY_CHALLENGE_ERROR_STATUS, number]
	>;

	test.each(mappedCodes)(
		'maps %s to HTTP %d with no-store and no unstable details',
		async (code, status) => {
			const response = dailyChallengeJsonError(new DailyChallengeServiceError(code));

			expect(response.status).toBe(status);
			expect(await json(response)).toEqual({ error: code });
			expect(response.headers.get('content-type')).toBe('application/json');
			expect(response.headers.get('cache-control')).toBe('no-store');
		},
	);
});

describe('daily challenge HTTP error fallbacks', () => {
	test('coordinatorFor returns INTERNAL_ERROR when the DB binding is missing', async () => {
		const handlers = createDailyChallengeHttpHandlers({
			createCoordinator: () => fakeCoordinator(),
		});

		const response = await handlers.current({
			locals: {
				user: null,
				runtime: { env: {} },
			},
			request: new Request('https://arcturus.test/api/daily-challenges/current'),
			url: new URL('https://arcturus.test/api/daily-challenges/current'),
		} as never);

		expect(response.status).toBe(500);
		expect(await json(response)).toEqual({ error: 'INTERNAL_ERROR' });
	});

	test('dailyChallengeJsonError maps a non-ServiceError to a 500 INTERNAL_ERROR', async () => {
		const response = dailyChallengeJsonError(new Error('boom'));

		expect(response.status).toBe(500);
		expect(await json(response)).toEqual({ error: 'INTERNAL_ERROR' });
		expect(response.headers.get('cache-control')).toBe('no-store');
	});

	test('dailyChallengeJsonError maps a non-Error thrown value to a 500 INTERNAL_ERROR', async () => {
		const response = dailyChallengeJsonError('string error');

		expect(response.status).toBe(500);
		expect(await json(response)).toEqual({ error: 'INTERNAL_ERROR' });
	});
});

describe('dailyChallengeHttpHandlers default factory', () => {
	test('start surfaces INTERNAL_ERROR when DB is missing', async () => {
		const { dailyChallengeHttpHandlers } = await import('./http');

		const response = await dailyChallengeHttpHandlers.start({
			locals: {
				user: { id: USER_ID },
				runtime: { env: { DB: undefined } },
			},
			request: new Request('https://arcturus.test/api/daily-challenges/current/attempts', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(START_BODY),
			}),
		} as never);

		expect(response.status).toBe(500);
		expect(await json(response)).toEqual({ error: 'INTERNAL_ERROR' });
	});

	test('resume surfaces UNAUTHORIZED when no user is present', async () => {
		const { dailyChallengeHttpHandlers } = await import('./http');

		const response = await dailyChallengeHttpHandlers.resume({
			locals: { runtime: { env: { DB: { binding: 'db' } } } },
			params: { attemptId: ATTEMPT_ID },
		} as never);

		expect(response.status).toBe(401);
		expect(await json(response)).toEqual({ error: 'UNAUTHORIZED' });
	});
});

function createMockD1(changes: number): D1Database {
	const bound = {
		run: async () => ({ meta: { changes } }),
		bind: () => bound,
	};
	const stmt = {
		run: async () => ({ meta: { changes } }),
		bind: () => bound,
	};
	return {
		prepare: () => stmt,
	} as never;
}

describe('daily challenge HTTP rate limiter factories', () => {
	test('createDailyChallengeStartRateLimiter returns allowed with a continuation statement', async () => {
		const db = createMockD1(1);
		const limiter = createDailyChallengeStartRateLimiter(db);

		const result = await limiter(USER_ID, 1000);

		expect(result.kind).toBe('allowed');
		if (result.kind === 'allowed') {
			expect(result.statement).toBeDefined();
			expect(result.retryAfter).toBeGreaterThan(0);
		}
	});

	test('createDailyChallengeStartRateLimiter returns rate-limited with retryAfter', async () => {
		const db = createMockD1(0);
		const limiter = createDailyChallengeStartRateLimiter(db);

		const result = await limiter(USER_ID, 1000);

		expect(result.kind).toBe('rate-limited');
		if (result.kind === 'rate-limited') {
			expect(result.retryAfter).toBeGreaterThan(0);
		}
	});

	test('createDailyChallengeCommandRateLimiter returns allowed with a continuation statement', async () => {
		const db = createMockD1(1);
		const limiter = createDailyChallengeCommandRateLimiter(db);

		const result = await limiter(USER_ID, 1000);

		expect(result.kind).toBe('allowed');
		if (result.kind === 'allowed') {
			expect(result.statement).toBeDefined();
			expect(result.retryAfter).toBeGreaterThan(0);
		}
	});

	test('createDailyChallengeCommandRateLimiter returns rate-limited with retryAfter', async () => {
		const db = createMockD1(0);
		const limiter = createDailyChallengeCommandRateLimiter(db);

		const result = await limiter(USER_ID, 1000);

		expect(result.kind).toBe('rate-limited');
		if (result.kind === 'rate-limited') {
			expect(result.retryAfter).toBeGreaterThan(0);
		}
	});

	test('createDailyChallengeResumeRateLimiter returns allowed without a continuation statement', async () => {
		const db = createMockD1(1);
		const limiter = createDailyChallengeResumeRateLimiter(db);

		const result = await limiter(USER_ID, 1000);

		expect(result.kind).toBe('allowed');
	});

	test('createDailyChallengeResumeRateLimiter returns rate-limited with retryAfter', async () => {
		const db = createMockD1(0);
		const limiter = createDailyChallengeResumeRateLimiter(db);

		const result = await limiter(USER_ID, 1000);

		expect(result.kind).toBe('rate-limited');
		if (result.kind === 'rate-limited') {
			expect(result.retryAfter).toBeGreaterThan(0);
		}
	});
});
