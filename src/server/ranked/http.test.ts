import { describe, expect, test } from 'bun:test';
import {
	RANKED_ERROR_STATUS,
	RankedServiceError,
	type RankedErrorCode,
} from '../../lib/ranked/protocol';
import type { RankedCoordinator, RankedCoordinatorResponse } from './coordinator';
import { createRankedHttpHandlers, rankedJsonError } from './http';

const USER_ID = 'ranked-http-user';
const SESSION_ID = 'BwcHBwcHBwcHBwcHBwcHBw';
const START_BODY = {
	requestId: 'request-00000001',
	gameType: 'blackjack',
	rulesetVersion: 'blackjack-ranked-v1',
	wager: 100,
};

function publicResponse(): RankedCoordinatorResponse {
	return {
		sessionId: SESSION_ID,
		status: 'active',
		gameType: 'blackjack',
		rulesetVersion: 'blackjack-ranked-v1',
		seedCommitment: 'public-seed-commitment',
		expiresAt: 1_800_000_900,
		nextSequence: 0,
		balance: 900,
		state: {
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
			nextSequence: 0,
			availableActions: ['hit', 'stand'],
			outcome: null,
		},
		receipt: null,
	};
}

interface CoordinatorCalls {
	start: unknown[];
	resume: unknown[];
	act: unknown[];
	expire: unknown[];
}

function fakeCoordinator(
	overrides: Partial<RankedCoordinator> = {},
): RankedCoordinator & { calls: CoordinatorCalls } {
	const calls: CoordinatorCalls = { start: [], resume: [], act: [], expire: [] };
	return {
		calls,
		async start(input) {
			calls.start.push(input);
			return overrides.start?.(input) ?? publicResponse();
		},
		async resume(input) {
			calls.resume.push(input);
			return overrides.resume?.(input) ?? publicResponse();
		},
		async act(input) {
			calls.act.push(input);
			return overrides.act?.(input) ?? publicResponse();
		},
		async expire(input) {
			calls.expire.push(input);
			return overrides.expire?.(input) ?? publicResponse();
		},
	};
}

function context({
	userId = USER_ID,
	body,
	sessionId = SESSION_ID,
}: {
	userId?: string | null;
	body?: unknown;
	sessionId?: string;
}) {
	return {
		locals: {
			user: userId === null ? null : { id: userId },
			runtime: {
				env: {
					DB: { binding: 'db' },
					arcturus: { binding: 'namespace' },
				},
			},
		},
		params: { sessionId },
		request: new Request('https://arcturus.test/api/ranked', {
			method: body === undefined ? 'GET' : 'POST',
			headers: body === undefined ? undefined : { 'content-type': 'application/json' },
			body: body === undefined ? undefined : JSON.stringify(body),
		}),
	} as never;
}

async function json(response: Response): Promise<Record<string, unknown>> {
	return (await response.json()) as Record<string, unknown>;
}

describe('ranked HTTP authentication and strict parsing', () => {
	test('all handlers authenticate before parsing or constructing the coordinator', async () => {
		let factoryCalls = 0;
		const handlers = createRankedHttpHandlers({
			createCoordinator() {
				factoryCalls += 1;
				return fakeCoordinator();
			},
		});

		const start = await handlers.start(context({ userId: null, body: { invalid: true } }));
		const resume = await handlers.resume(context({ userId: null }));
		const action = await handlers.action(
			context({ userId: null, body: { sequence: 0, action: 'hit' } }),
		);

		expect([start.status, resume.status, action.status]).toEqual([401, 401, 401]);
		expect(await json(start)).toEqual({ error: 'UNAUTHORIZED' });
		expect(factoryCalls).toBe(0);
	});

	test('start rejects unknown fields and distinguishes a structurally valid invalid wager', async () => {
		const coordinator = fakeCoordinator();
		const handlers = createRankedHttpHandlers({
			createCoordinator: () => coordinator,
		});

		const unknown = await handlers.start(context({ body: { ...START_BODY, clientScore: 21 } }));
		const badWager = await handlers.start(context({ body: { ...START_BODY, wager: 9 } }));

		expect(unknown.status).toBe(400);
		expect(await json(unknown)).toEqual({ error: 'INVALID_REQUEST' });
		expect(badWager.status).toBe(400);
		expect(await json(badWager)).toEqual({ error: 'INVALID_WAGER' });
		expect(coordinator.calls.start).toHaveLength(0);
	});

	test('missing and non-numeric wagers are malformed requests, not ruleset-range errors', async () => {
		const handlers = createRankedHttpHandlers({
			createCoordinator: () => fakeCoordinator(),
		});
		const { wager: _wager, ...missingWager } = START_BODY;

		const missing = await handlers.start(context({ body: missingWager }));
		const stringValue = await handlers.start(context({ body: { ...START_BODY, wager: '100' } }));

		expect(await json(missing)).toEqual({ error: 'INVALID_REQUEST' });
		expect(await json(stringValue)).toEqual({ error: 'INVALID_REQUEST' });
	});

	test('malformed JSON is a stable INVALID_REQUEST response', async () => {
		const handlers = createRankedHttpHandlers({
			createCoordinator: () => fakeCoordinator(),
		});
		const malformed = context({ body: START_BODY }) as {
			request: Request;
		};
		malformed.request = new Request('https://arcturus.test/api/ranked', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: '{',
		});

		const response = await handlers.start(malformed as never);

		expect(response.status).toBe(400);
		expect(await json(response)).toEqual({ error: 'INVALID_REQUEST' });
	});

	test('action rejects sequence ambiguity and unknown terminal fields', async () => {
		const coordinator = fakeCoordinator();
		const handlers = createRankedHttpHandlers({
			createCoordinator: () => coordinator,
		});

		const fractional = await handlers.action(context({ body: { sequence: 0.5, action: 'hit' } }));
		const injected = await handlers.action(
			context({ body: { sequence: 0, action: 'stand', payout: 1000 } }),
		);

		expect(fractional.status).toBe(400);
		expect(injected.status).toBe(400);
		expect(await json(fractional)).toEqual({ error: 'INVALID_REQUEST' });
		expect(await json(injected)).toEqual({ error: 'INVALID_REQUEST' });
		expect(coordinator.calls.act).toHaveLength(0);
	});

	test('valid handlers pass only authenticated identity, strict bodies, and route session IDs', async () => {
		const coordinator = fakeCoordinator();
		const seenBindings: unknown[] = [];
		const handlers = createRankedHttpHandlers({
			createCoordinator(bindings) {
				seenBindings.push(bindings);
				return coordinator;
			},
		});

		expect((await handlers.start(context({ body: START_BODY }))).status).toBe(200);
		expect((await handlers.resume(context({}))).status).toBe(200);
		expect((await handlers.action(context({ body: { sequence: 0, action: 'hit' } }))).status).toBe(
			200,
		);

		expect(coordinator.calls.start).toEqual([{ userId: USER_ID, body: START_BODY }]);
		expect(coordinator.calls.resume).toEqual([{ userId: USER_ID, sessionId: SESSION_ID }]);
		expect(coordinator.calls.act).toEqual([
			{
				userId: USER_ID,
				sessionId: SESSION_ID,
				body: { sequence: 0, action: 'hit' },
			},
		]);
		expect(seenBindings).toEqual([
			{ db: { binding: 'db' }, namespace: { binding: 'namespace' } },
			{ db: { binding: 'db' }, namespace: { binding: 'namespace' } },
			{ db: { binding: 'db' }, namespace: { binding: 'namespace' } },
		]);
	});
});

describe('ranked HTTP stable response contract', () => {
	const mappedCodes = Object.entries(RANKED_ERROR_STATUS) as [RankedErrorCode, number][];

	test.each(mappedCodes)('maps %s to HTTP %d without unstable details', async (code, status) => {
		const response = rankedJsonError(new RankedServiceError(code));

		expect(response.status).toBe(status);
		expect(await json(response)).toEqual({ error: code });
		expect(response.headers.get('content-type')).toBe('application/json');
	});

	test('includes expectedSequence and Retry-After only on typed stable errors', async () => {
		const sequence = rankedJsonError(
			new RankedServiceError('SEQUENCE_MISMATCH', { expectedSequence: 7 }),
		);
		const rate = rankedJsonError(new RankedServiceError('RATE_LIMITED', { retryAfter: 23 }));
		const balance = rankedJsonError(new RankedServiceError('ACCOUNT_BALANCE_CHANGED'));

		expect(await json(sequence)).toEqual({
			error: 'SEQUENCE_MISMATCH',
			expectedSequence: 7,
		});
		expect(sequence.headers.has('Retry-After')).toBe(false);
		expect(await json(rate)).toEqual({ error: 'RATE_LIMITED' });
		expect(rate.headers.get('Retry-After')).toBe('23');
		expect(balance.status).toBe(409);
		expect(await json(balance)).toEqual({ error: 'ACCOUNT_BALANCE_CHANGED' });
	});

	test('owner and non-owner misses are indistinguishable 404 responses', async () => {
		const handlers = createRankedHttpHandlers({
			createCoordinator: () =>
				fakeCoordinator({
					resume: async () => {
						throw new RankedServiceError('SESSION_NOT_FOUND');
					},
				}),
		});

		const ownerMiss = await handlers.resume(context({ userId: USER_ID }));
		const otherMiss = await handlers.resume(context({ userId: 'another-user' }));

		expect(ownerMiss.status).toBe(404);
		expect(otherMiss.status).toBe(404);
		expect(await json(ownerMiss)).toEqual({ error: 'SESSION_NOT_FOUND' });
		expect(await json(otherMiss)).toEqual({ error: 'SESSION_NOT_FOUND' });
	});

	test('serializes only the coordinator public projection without seed, deck, or hole cards', async () => {
		const secretSeed = 'AgMEBQYHCAkKCwwNDg8QERITFBUWFxgZGhscHR4fICE';
		const hiddenHoleCard = '"rank":"J","suit":"clubs"';
		const handlers = createRankedHttpHandlers({
			createCoordinator: () => fakeCoordinator(),
		});

		const response = await handlers.resume(context({}));
		const serialized = await response.text();

		expect(serialized).not.toContain(secretSeed);
		expect(serialized).not.toContain('deckCursor');
		expect(serialized).not.toContain(hiddenHoleCard);
		expect(serialized).toContain('"seedCommitment":"public-seed-commitment"');
		expect(serialized).toContain('"balance":900');
	});
});

describe('ranked HTTP error fallbacks', () => {
	test('coordinatorFor returns INTERNAL_ERROR when the DB binding is missing', async () => {
		const handlers = createRankedHttpHandlers({
			createCoordinator: () => fakeCoordinator(),
		});

		const response = await handlers.start({
			locals: {
				user: { id: USER_ID },
				runtime: { env: {} },
			},
			request: new Request('https://arcturus.test/api/ranked', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(START_BODY),
			}),
		} as never);

		expect(response.status).toBe(500);
		expect(await json(response)).toEqual({ error: 'INTERNAL_ERROR' });
	});

	test('rankedJsonError maps a non-RankedServiceError to a 500 INTERNAL_ERROR', async () => {
		const response = rankedJsonError(new Error('boom'));
		expect(response.status).toBe(500);
		expect(await json(response)).toEqual({ error: 'INTERNAL_ERROR' });
		expect(response.headers.get('content-type')).toBe('application/json');
		expect(response.headers.get('cache-control')).toBe('no-store');
	});

	test('rankedJsonError maps a non-Error thrown value to a 500 INTERNAL_ERROR', async () => {
		const response = rankedJsonError('string error');
		expect(response.status).toBe(500);
		expect(await json(response)).toEqual({ error: 'INTERNAL_ERROR' });
	});

	test('action handler surfaces INTERNAL_ERROR when the DB binding is missing', async () => {
		const handlers = createRankedHttpHandlers({
			createCoordinator: () => fakeCoordinator(),
		});

		const response = await handlers.action({
			locals: {
				user: { id: USER_ID },
				runtime: { env: {} },
			},
			params: { sessionId: SESSION_ID },
			request: new Request('https://arcturus.test/api/ranked', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ sequence: 0, action: 'hit' }),
			}),
		} as never);

		expect(response.status).toBe(500);
		expect(await json(response)).toEqual({ error: 'INTERNAL_ERROR' });
	});
});

describe('rankedHttpHandlers default factory', () => {
	test('start surfaces INTERNAL_ERROR when DB is missing', async () => {
		// Importing the default handlers exercises the production coordinator
		// factory wiring (createRankedRepository + createRankedCoordinator).
		const { rankedHttpHandlers } = await import('./http');

		const response = await rankedHttpHandlers.start({
			locals: {
				user: { id: USER_ID },
				runtime: { env: { arcturus: undefined } },
			},
			request: new Request('https://arcturus.test/api/ranked', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(START_BODY),
			}),
		} as never);

		expect(response.status).toBe(500);
		expect(await json(response)).toEqual({ error: 'INTERNAL_ERROR' });
	});

	test('resume surfaces UNAUTHORIZED when no user is present', async () => {
		const { rankedHttpHandlers } = await import('./http');

		const response = await rankedHttpHandlers.resume({
			locals: { runtime: { env: { DB: { binding: 'db' } } } },
			params: { sessionId: SESSION_ID },
		} as never);

		expect(response.status).toBe(401);
		expect(await json(response)).toEqual({ error: 'UNAUTHORIZED' });
	});
});
