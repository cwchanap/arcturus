import { describe, expect, test } from 'bun:test';
import {
	BlackjackRunError,
	blackjackRunPublicStateSchema,
	type BlackjackRunCommand,
	type BlackjackRunPublicState,
	type BlackjackRunStart,
} from '../../lib/blackjack-run/protocol';
import type { BlackjackRunService } from './service';
import {
	BLACKJACK_RUN_ERROR_STATUS,
	blackjackRunJsonError,
	createBlackjackRunHttpHandlers,
	type BlackjackRunHttpErrorCode,
} from './http';
import { BlackjackRunServiceError } from './service';

const USER_ID = 'blackjack-run-http-user';
const RUN_ID = 'HwcHHwcHHwcHHwcHHwcHHw';
const PERIOD_KEY = '2027-01-15';
const START_BODY = { mode: 'ranked', requestId: 'request-00000001', wager: 100 } as const;

function activeRoundFixture() {
	return {
		phase: 'player-turn',
		playerHands: [
			{
				cards: [
					{ rank: '9', suit: 'hearts' },
					{ rank: 'A', suit: 'clubs' },
				],
				wager: 100,
				value: { value: 20, isSoft: true, isBust: false },
			},
		],
		activeHandIndex: 0,
		dealer: {
			cards: [{ rank: '7', suit: 'hearts' }],
			value: { value: 7, isSoft: false, isBust: false },
		},
		committedWager: 100,
		availableActions: ['hit', 'stand'],
		outcome: null,
	} as const;
}

function rankedActiveState(): BlackjackRunPublicState {
	return {
		mode: 'ranked',
		runId: RUN_ID,
		status: 'active',
		expiresAt: 1_800_000_900,
		balance: 900,
		nextSequence: 0,
		...activeRoundFixture(),
	};
}

function dailyActiveState(): BlackjackRunPublicState {
	return {
		mode: 'daily',
		runId: RUN_ID,
		status: 'active',
		terminalReason: null,
		eligible: true,
		expiresAt: 1_800_001_800,
		nextCommandSequence: 0,
		availableBankroll: 1000,
		roundsCompleted: 0,
		activeRound: { ...activeRoundFixture() },
		rank: null,
		percentile: null,
	};
}

interface ServiceCalls {
	start: unknown[];
	current: unknown[];
	get: unknown[];
	command: unknown[];
	currentDaily: unknown[];
	leaderboard: unknown[];
}

function fakeService(
	overrides: Partial<BlackjackRunService> = {},
): BlackjackRunService & { calls: ServiceCalls } {
	const calls: ServiceCalls = {
		start: [],
		current: [],
		get: [],
		command: [],
		currentDaily: [],
		leaderboard: [],
	};
	return {
		calls,
		async start(userId, input) {
			calls.start.push({ userId, input });
			return overrides.start?.(userId, input) ?? rankedActiveState();
		},
		async current(userId, mode) {
			calls.current.push({ userId, mode });
			return overrides.current?.(userId, mode) ?? rankedActiveState();
		},
		async get(userId, runId) {
			calls.get.push({ userId, runId });
			return overrides.get?.(userId, runId) ?? rankedActiveState();
		},
		async command(userId, runId, command) {
			calls.command.push({ userId, runId, command });
			return overrides.command?.(userId, runId, command) ?? rankedActiveState();
		},
		async expire(runId) {
			return overrides.expire?.(runId) ?? rankedActiveState();
		},
		async currentDaily(userId) {
			calls.currentDaily.push({ userId });
			return overrides.currentDaily?.(userId) ?? dailyActiveState();
		},
		async leaderboard(periodKey, userId, limit) {
			calls.leaderboard.push({ periodKey, userId, limit });
			return (
				overrides.leaderboard?.(periodKey, userId, limit) ?? {
					entries: [
						{
							rank: 1,
							userId: 'leaderboard-user',
							playerName: 'Leader',
							dailyEndingBankroll: 1200,
							dailyRoundsCompleted: 10,
							settledAt: 1_800_001_000,
						},
					],
					currentUser: null,
				}
			);
		},
	};
}

function makeRequest(path: string, body?: unknown): Request {
	if (body === undefined) return new Request(`https://arcturus.test${path}`);
	return new Request(`https://arcturus.test${path}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body),
	});
}

interface ContextOptions {
	userId?: string | null;
	request?: Request;
	runId?: string;
	periodKey?: string;
}

function context({
	userId = USER_ID,
	request = makeRequest('/api/blackjack-runs'),
	runId = RUN_ID,
	periodKey = PERIOD_KEY,
}: ContextOptions = {}) {
	return {
		locals: {
			user: userId === null ? null : { id: userId },
			runtime: {
				env: {
					DB: { binding: 'db' },
				},
			},
		},
		params: { runId, periodKey },
		request,
		url: new URL(request.url),
	} as never;
}

async function json(response: Response): Promise<Record<string, unknown>> {
	return (await response.json()) as Record<string, unknown>;
}

describe('blackjack run HTTP authentication and strict parsing', () => {
	test('start/current/get/command return 401 before parsing or constructing the service', async () => {
		let factoryCalls = 0;
		const handlers = createBlackjackRunHttpHandlers({
			createService() {
				factoryCalls += 1;
				return fakeService();
			},
		});

		const start = await handlers.start(
			context({ userId: null, request: makeRequest('/api/blackjack-runs', { invalid: true }) }),
		);
		const current = await handlers.current(
			context({ userId: null, request: makeRequest('/api/blackjack-runs/current?mode=ranked') }),
		);
		const get = await handlers.get(context({ userId: null }));
		const command = await handlers.command(
			context({
				userId: null,
				request: makeRequest('/api/blackjack-runs/HwcHHwcHHwcHHwcHHwcHHw/commands', {
					sequence: 0,
					command: 'hit',
				}),
			}),
		);

		expect([start.status, current.status, get.status, command.status]).toEqual([
			401, 401, 401, 401,
		]);
		expect(await json(start)).toEqual({ error: 'UNAUTHORIZED' });
		expect(factoryCalls).toBe(0);
	});

	test('daily current and leaderboard are guest-readable', async () => {
		const service = fakeService();
		const handlers = createBlackjackRunHttpHandlers({
			createService: () => service,
		});

		const daily = await handlers.currentDaily(context({ userId: null }));
		const leaderboard = await handlers.leaderboard(
			context({
				userId: null,
				request: makeRequest('/api/blackjack-daily/2027-01-15/leaderboard'),
			}),
		);

		expect(daily.status).toBe(200);
		expect(leaderboard.status).toBe(200);
		expect(service.calls.currentDaily).toEqual([{ userId: null }]);
		expect(service.calls.leaderboard).toEqual([{ periodKey: PERIOD_KEY, userId: null, limit: 50 }]);
	});

	test('leaderboard response strips the internal userId from every entry', async () => {
		// The fake service returns entries carrying `userId` (the internal
		// account identifier the repository row exposes); the HTTP projection
		// must drop it before serializing to an unauthenticated guest.
		const service = fakeService();
		const handlers = createBlackjackRunHttpHandlers({
			createService: () => service,
		});

		const guestResponse = await handlers.leaderboard(
			context({
				userId: null,
				request: makeRequest('/api/blackjack-daily/2027-01-15/leaderboard'),
			}),
		);
		const authedResponse = await handlers.leaderboard(
			context({
				request: makeRequest('/api/blackjack-daily/2027-01-15/leaderboard'),
			}),
		);

		expect(guestResponse.status).toBe(200);
		expect(authedResponse.status).toBe(200);

		const guestBody = (await guestResponse.json()) as { entries: Record<string, unknown>[] };
		const authedBody = (await authedResponse.json()) as { entries: Record<string, unknown>[] };

		for (const entry of [...guestBody.entries, ...authedBody.entries]) {
			expect(entry).not.toHaveProperty('userId');
			expect(Object.keys(entry).sort()).toEqual([
				'dailyEndingBankroll',
				'dailyRoundsCompleted',
				'playerName',
				'rank',
				'settledAt',
			]);
		}
		expect(guestBody.entries).toEqual([
			{
				rank: 1,
				playerName: 'Leader',
				dailyEndingBankroll: 1200,
				dailyRoundsCompleted: 10,
				settledAt: 1_800_001_000,
			},
		]);
	});

	test('a guest without an attempt receives a RUN_NOT_FOUND guest surface', async () => {
		const handlers = createBlackjackRunHttpHandlers({
			createService: () =>
				fakeService({
					currentDaily: async () => {
						throw new BlackjackRunServiceError('RUN_NOT_FOUND');
					},
				}),
		});

		const response = await handlers.currentDaily(context({ userId: null }));

		expect(response.status).toBe(404);
		expect(await json(response)).toEqual({ error: 'RUN_NOT_FOUND' });
	});

	test('start rejects unknown fields and distinguishes a structurally valid invalid wager', async () => {
		const service = fakeService();
		const handlers = createBlackjackRunHttpHandlers({
			createService: () => service,
		});

		const unknown = await handlers.start(
			context({ request: makeRequest('/api/blackjack-runs', { ...START_BODY, clientScore: 21 }) }),
		);
		const badWager = await handlers.start(
			context({ request: makeRequest('/api/blackjack-runs', { ...START_BODY, wager: 9 }) }),
		);

		expect(unknown.status).toBe(400);
		expect(await json(unknown)).toEqual({ error: 'INVALID_REQUEST' });
		expect(badWager.status).toBe(400);
		expect(await json(badWager)).toEqual({ error: 'INVALID_WAGER' });
		expect(service.calls.start).toHaveLength(0);
	});

	test('command rejects unknown fields and non-integer sequences as INVALID_COMMAND', async () => {
		const service = fakeService();
		const handlers = createBlackjackRunHttpHandlers({
			createService: () => service,
		});

		const injected = await handlers.command(
			context({
				request: makeRequest(`/api/blackjack-runs/${RUN_ID}/commands`, {
					sequence: 0,
					command: 'hit',
					payout: 1000,
				}),
			}),
		);
		const fractional = await handlers.command(
			context({
				request: makeRequest(`/api/blackjack-runs/${RUN_ID}/commands`, {
					sequence: 0.5,
					command: 'hit',
				}),
			}),
		);

		expect(injected.status).toBe(400);
		expect(await json(injected)).toEqual({ error: 'INVALID_COMMAND' });
		expect(fractional.status).toBe(400);
		expect(await json(fractional)).toEqual({ error: 'INVALID_COMMAND' });
		expect(service.calls.command).toHaveLength(0);
	});

	test('malformed JSON is a stable INVALID_REQUEST response', async () => {
		const handlers = createBlackjackRunHttpHandlers({
			createService: () => fakeService(),
		});

		const malformed = makeRequest('/api/blackjack-runs');
		Object.defineProperty(malformed, 'json', {
			value: async () => {
				throw new SyntaxError('bad json');
			},
		});
		const response = await handlers.start(context({ request: malformed }));

		expect(response.status).toBe(400);
		expect(await json(response)).toEqual({ error: 'INVALID_REQUEST' });
	});

	test('current requires an explicit known mode', async () => {
		const service = fakeService();
		const handlers = createBlackjackRunHttpHandlers({
			createService: () => service,
		});

		const missing = await handlers.current(
			context({ request: makeRequest('/api/blackjack-runs/current') }),
		);
		const unknown = await handlers.current(
			context({ request: makeRequest('/api/blackjack-runs/current?mode=casual') }),
		);

		expect(missing.status).toBe(400);
		expect(await json(missing)).toEqual({ error: 'INVALID_REQUEST' });
		expect(unknown.status).toBe(400);
		expect(await json(unknown)).toEqual({ error: 'INVALID_REQUEST' });
		expect(service.calls.current).toHaveLength(0);
	});

	test('get and command validate the run id shape', async () => {
		const service = fakeService();
		const handlers = createBlackjackRunHttpHandlers({
			createService: () => service,
		});

		const get = await handlers.get(context({ runId: 'not-a-run-id' }));
		const command = await handlers.command(
			context({
				runId: 'not-a-run-id',
				request: makeRequest('/api/blackjack-runs/not-a-run-id/commands', {
					sequence: 0,
					command: 'hit',
				}),
			}),
		);

		expect(get.status).toBe(400);
		expect(command.status).toBe(400);
		expect(await json(get)).toEqual({ error: 'INVALID_REQUEST' });
		expect(service.calls.get).toHaveLength(0);
		expect(service.calls.command).toHaveLength(0);
	});

	test('leaderboard validates the period key shape and limit', async () => {
		const service = fakeService();
		const handlers = createBlackjackRunHttpHandlers({
			createService: () => service,
		});

		const badPeriod = await handlers.leaderboard(
			context({
				periodKey: '2027-13-99',
				request: makeRequest('/api/blackjack-daily/2027-13-99/leaderboard'),
			}),
		);
		const badLimit = await handlers.leaderboard(
			context({
				request: makeRequest('/api/blackjack-daily/2027-01-15/leaderboard?limit=abc'),
			}),
		);
		const limited = await handlers.leaderboard(
			context({
				request: makeRequest('/api/blackjack-daily/2027-01-15/leaderboard?limit=5'),
			}),
		);

		expect(badPeriod.status).toBe(400);
		expect(badLimit.status).toBe(400);
		expect(limited.status).toBe(200);
		expect(service.calls.leaderboard).toEqual([
			{ periodKey: PERIOD_KEY, userId: USER_ID, limit: 5 },
		]);
	});

	test('valid handlers pass only authenticated identity and strict bodies', async () => {
		const service = fakeService();
		const handlers = createBlackjackRunHttpHandlers({
			createService: () => service,
		});

		expect(
			(await handlers.start(context({ request: makeRequest('/api/blackjack-runs', START_BODY) })))
				.status,
		).toBe(200);
		expect(
			(
				await handlers.current(
					context({ request: makeRequest('/api/blackjack-runs/current?mode=daily') }),
				)
			).status,
		).toBe(200);
		expect((await handlers.get(context({}))).status).toBe(200);
		expect(
			(
				await handlers.command(
					context({
						request: makeRequest(`/api/blackjack-runs/${RUN_ID}/commands`, {
							sequence: 0,
							command: 'hit',
						}),
					}),
				)
			).status,
		).toBe(200);

		expect(service.calls.start).toEqual([
			{ userId: USER_ID, input: { mode: 'ranked', requestId: 'request-00000001', wager: 100 } },
		]);
		expect(service.calls.current).toEqual([{ userId: USER_ID, mode: 'daily' }]);
		expect(service.calls.get).toEqual([{ userId: USER_ID, runId: RUN_ID }]);
		expect(service.calls.command).toEqual([
			{ userId: USER_ID, runId: RUN_ID, command: { sequence: 0, command: 'hit' } },
		]);
	});
});

describe('blackjack run HTTP stable error contract', () => {
	const coreCodes = new Set<BlackjackRunHttpErrorCode>([
		'INVALID_ACTION',
		'SEQUENCE_MISMATCH',
		'ATTEMPT_COMPLETE',
		'INVALID_COMMAND',
		'INVALID_WAGER',
		'INSUFFICIENT_CHALLENGE_BANKROLL',
	]);

	test.each(Object.entries(BLACKJACK_RUN_ERROR_STATUS) as [BlackjackRunHttpErrorCode, number][])(
		'maps %s to HTTP %d with a stable body',
		async (code, status) => {
			const error = coreCodes.has(code)
				? new BlackjackRunError(code)
				: new BlackjackRunServiceError(code);

			const response = blackjackRunJsonError(error);

			expect(response.status).toBe(status);
			// SETTLEMENT_CONFLICT is the sole retryable error; it carries an
			// explicit retryable hint so clients do not hardcode error lists.
			if (code === 'SETTLEMENT_CONFLICT') {
				expect(await json(response)).toEqual({ error: code, retryable: true });
			} else {
				expect(await json(response)).toEqual({ error: code });
			}
			expect(response.headers.get('content-type')).toBe('application/json');
			expect(response.headers.get('cache-control')).toBe('no-store');
		},
	);

	test('includes expectedSequence only on SEQUENCE_MISMATCH', async () => {
		const sequence = blackjackRunJsonError(
			new BlackjackRunError('SEQUENCE_MISMATCH', { expectedSequence: 7 }),
		);

		expect(sequence.status).toBe(409);
		expect(await json(sequence)).toEqual({
			error: 'SEQUENCE_MISMATCH',
			expectedSequence: 7,
		});
	});

	test('maps retryable SETTLEMENT_CONFLICT to 409 with a retryable hint', async () => {
		const service = fakeService({
			command: async () => {
				throw new BlackjackRunServiceError('SETTLEMENT_CONFLICT');
			},
		});
		const handlers = createBlackjackRunHttpHandlers({
			createService: () => service,
		});

		const response = await handlers.command(
			context({
				request: makeRequest(`/api/blackjack-runs/${RUN_ID}/commands`, {
					sequence: 0,
					command: 'hit',
				}),
			}),
		);

		expect(response.status).toBe(409);
		expect(await json(response)).toEqual({
			error: 'SETTLEMENT_CONFLICT',
			retryable: true,
		});
	});

	test('owner and non-owner misses are indistinguishable 404 responses', async () => {
		const handlers = createBlackjackRunHttpHandlers({
			createService: () =>
				fakeService({
					get: async () => {
						throw new BlackjackRunServiceError('RUN_NOT_FOUND');
					},
				}),
		});

		const ownerMiss = await handlers.get(context({ userId: USER_ID }));
		const otherMiss = await handlers.get(context({ userId: 'another-user' }));

		expect(ownerMiss.status).toBe(404);
		expect(otherMiss.status).toBe(404);
		expect(await json(ownerMiss)).toEqual({ error: 'RUN_NOT_FOUND' });
		expect(await json(otherMiss)).toEqual({ error: 'RUN_NOT_FOUND' });
	});
});

describe('blackjack run HTTP response contract', () => {
	test('success responses serialize against the closed public state schema', async () => {
		const handlers = createBlackjackRunHttpHandlers({
			createService: () => fakeService(),
		});

		const start = await handlers.start(
			context({ request: makeRequest('/api/blackjack-runs', START_BODY) }),
		);
		const current = await handlers.current(
			context({ request: makeRequest('/api/blackjack-runs/current?mode=ranked') }),
		);
		const get = await handlers.get(context({}));
		const command = await handlers.command(
			context({
				request: makeRequest(`/api/blackjack-runs/${RUN_ID}/commands`, {
					sequence: 0,
					command: 'hit',
				}),
			}),
		);
		const daily = await handlers.currentDaily(context({}));

		const bodies = [start, current, get, command, daily].map((response) => response.json());
		for (const body of await Promise.all(bodies)) {
			const parsed = blackjackRunPublicStateSchema.safeParse(body);
			expect(parsed.success).toBe(true);
		}
		for (const response of [start, current, get, command, daily]) {
			expect(response.headers.get('cache-control')).toBe('no-store');
		}
	});

	test('unhandled errors map to a 500 INTERNAL_ERROR', async () => {
		const response = blackjackRunJsonError(new Error('boom'));

		expect(response.status).toBe(500);
		expect(await json(response)).toEqual({ error: 'INTERNAL_ERROR' });
		expect(response.headers.get('content-type')).toBe('application/json');
		expect(response.headers.get('cache-control')).toBe('no-store');
	});

	test('a missing DB binding surfaces INTERNAL_ERROR', async () => {
		const handlers = createBlackjackRunHttpHandlers({
			createService: () => fakeService(),
		});

		const response = await handlers.start({
			locals: {
				user: { id: USER_ID },
				runtime: { env: {} },
			},
			request: makeRequest('/api/blackjack-runs', START_BODY),
		} as never);

		expect(response.status).toBe(500);
		expect(await json(response)).toEqual({ error: 'INTERNAL_ERROR' });
	});
});

describe('blackjackRunHttpHandlers default factory', () => {
	test('current surfaces UNAUTHORIZED when no user is present', async () => {
		const { blackjackRunHttpHandlers } = await import('./http');

		const response = await blackjackRunHttpHandlers.current(
			context({ userId: null, request: makeRequest('/api/blackjack-runs/current?mode=ranked') }),
		);

		expect(response.status).toBe(401);
		expect(await json(response)).toEqual({ error: 'UNAUTHORIZED' });
	});
});
