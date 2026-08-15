import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import {
	createBlackjackRunClient,
	BlackjackRunClientError,
	type BlackjackRunClient,
} from './client';
import type { BlackjackRunPublicState } from './protocol';

const RUN_ID = 'abcdefghijklmnopqrstuv';
const REQUEST_ID = 'request-1234567890abcdef';

let fetchImpl: ReturnType<
	typeof mock<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>
>;

// Capture the original descriptor so the replacement is restored exactly —
// deleting fetch would leave later suites without a real global fetch.
const originalFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');

beforeEach(() => {
	fetchImpl = mock(() => Promise.resolve(jsonResponse(activeState())));
	globalThis.fetch = fetchImpl as typeof fetch;
});

afterEach(() => {
	if (originalFetch) Object.defineProperty(globalThis, 'fetch', originalFetch);
	else Reflect.deleteProperty(globalThis, 'fetch');
});

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	});
}

function errorResponse(
	code: string,
	status: number,
	extra: Record<string, unknown> = {},
): Response {
	return new Response(JSON.stringify({ error: code, ...extra }), {
		status,
		headers: { 'content-type': 'application/json' },
	});
}

function activeState(overrides: Partial<BlackjackRunPublicState> = {}): BlackjackRunPublicState {
	return {
		mode: 'ranked',
		runId: RUN_ID,
		status: 'active',
		expiresAt: 1_800_000_900,
		balance: 742,
		nextSequence: 3,
		phase: 'player-turn',
		playerHands: [
			{
				cards: [
					{ rank: 'A', suit: 'clubs' },
					{ rank: '9', suit: 'hearts' },
				],
				wager: 100,
				value: { value: 17, isSoft: true, isBust: false },
			},
		],
		activeHandIndex: 0,
		dealer: {
			cards: [{ rank: '7', suit: 'spades' }],
			value: { value: 7, isSoft: false, isBust: false },
		},
		committedWager: 100,
		availableActions: ['hit', 'stand'],
		outcome: null,
		...overrides,
	};
}

function terminalState(overrides: Partial<BlackjackRunPublicState> = {}): BlackjackRunPublicState {
	return {
		...activeState(),
		status: 'settled',
		balance: 942,
		nextSequence: 4,
		phase: 'complete',
		playerHands: [
			{
				cards: [
					{ rank: 'A', suit: 'clubs' },
					{ rank: '9', suit: 'hearts' },
				],
				wager: 100,
				value: { value: 17, isSoft: true, isBust: false },
			},
		],
		dealer: {
			cards: [
				{ rank: '7', suit: 'spades' },
				{ rank: '10', suit: 'hearts' },
			],
			value: { value: 17, isSoft: false, isBust: false },
		},
		availableActions: [],
		outcome: {
			result: 'win',
			hands: [{ handIndex: 0, result: 'win', wager: 100, payout: 200 }],
			committedWager: 100,
			payout: 200,
			gameNetDelta: 100,
		},
		...overrides,
	};
}

function createClient(overrides: { createRequestId?: () => string; timeoutMs?: number } = {}) {
	return createBlackjackRunClient({
		createRequestId: overrides.createRequestId ?? (() => REQUEST_ID),
		timeoutMs: overrides.timeoutMs,
	});
}

function requestUrl(callIndex: number): string {
	return String(fetchImpl.mock.calls[callIndex]?.[0]);
}

function requestInit(callIndex: number): RequestInit | undefined {
	return fetchImpl.mock.calls[callIndex]?.[1];
}

function requestBody(callIndex: number): unknown {
	const init = requestInit(callIndex);
	if (!init || typeof init.body !== 'string') throw new Error('Expected a JSON string body');
	return JSON.parse(init.body) as unknown;
}

describe('blackjack-run client', () => {
	test('loadCurrent("ranked") GETs the current endpoint and parses the ranked state', async () => {
		fetchImpl.mockImplementation(() => Promise.resolve(jsonResponse(activeState())));

		const client = createClient();
		const state = await client.loadCurrent('ranked');

		expect(requestUrl(0)).toBe('/api/blackjack-runs/current?mode=ranked');
		expect(requestInit(0)?.method).toBe('GET');
		expect(state).toEqual(activeState());
	});

	test('loadCurrent resolves null on a definitive RUN_NOT_FOUND', async () => {
		fetchImpl.mockImplementation(() => Promise.resolve(errorResponse('RUN_NOT_FOUND', 404)));

		const client = createClient();
		expect(await client.loadCurrent('ranked')).toBeNull();
	});

	test('loadCurrent surfaces other server errors as client errors', async () => {
		fetchImpl.mockImplementation(() => Promise.resolve(errorResponse('INTERNAL_ERROR', 500)));

		const client = createClient();
		await expect(client.loadCurrent('ranked')).rejects.toThrow('internal error');
		await expect(client.loadCurrent('ranked')).rejects.toMatchObject({
			name: 'BlackjackRunClientError',
			code: 'INTERNAL_ERROR',
			status: 500,
			retryable: false,
		});
	});

	test('loadRun(runId) recovers the exact run by ID', async () => {
		fetchImpl.mockImplementation(() => Promise.resolve(jsonResponse(activeState())));

		const client = createClient();
		const state = await client.loadRun(RUN_ID);

		expect(requestUrl(0)).toBe(`/api/blackjack-runs/${RUN_ID}`);
		expect(state.runId).toBe(RUN_ID);
	});

	test('parses every response through the shared Zod schema and rejects malformed payloads', async () => {
		const { nextSequence: _nextSequence, ...missingSequence } = activeState();
		fetchImpl.mockImplementation(() => Promise.resolve(jsonResponse(missingSequence)));

		const client = createClient();
		await expect(client.loadRun(RUN_ID)).rejects.toThrow('malformed');
	});

	test('rejects unknown fields through the strict schema', async () => {
		fetchImpl.mockImplementation(() =>
			Promise.resolve(jsonResponse({ ...activeState(), receipt: {} })),
		);

		const client = createClient();
		await expect(client.loadRun(RUN_ID)).rejects.toThrow('malformed');
	});

	test('generates one fresh request ID per explicit start and never reuses it', async () => {
		let counter = 0;
		const client = createBlackjackRunClient({
			createRequestId: () => `req${String(++counter).padStart(19, '0')}`,
		});

		await client.startRanked(10);
		await client.startRanked(10);
		await client.startDaily('2026-08-13');

		expect(requestUrl(0)).toBe('/api/blackjack-runs');
		expect(requestBody(0)).toEqual({
			mode: 'ranked',
			requestId: 'req0000000000000000001',
			wager: 10,
		});
		expect(requestBody(1)).toEqual({
			mode: 'ranked',
			requestId: 'req0000000000000000002',
			wager: 10,
		});
		expect(requestBody(2)).toEqual({
			mode: 'daily',
			requestId: 'req0000000000000000003',
			periodKey: '2026-08-13',
		});
	});

	test('a retried explicit start whose previous request committed adopts the active run', async () => {
		fetchImpl
			.mockResolvedValueOnce(errorResponse('ACTIVE_RUN_EXISTS', 409))
			.mockResolvedValueOnce(jsonResponse(activeState({ balance: 732 })));

		const client = createClient();
		const state = await client.startRanked(10);

		expect(requestUrl(1)).toBe('/api/blackjack-runs/current?mode=ranked');
		expect(state.balance).toBe(732);
		expect(state.runId).toBe(RUN_ID);
	});

	test('command stamps the server-provided current sequence', async () => {
		fetchImpl.mockImplementation(() => Promise.resolve(jsonResponse(activeState())));

		const client = createClient();
		await client.loadRun(RUN_ID);
		await client.command(RUN_ID, { command: 'stand' });

		expect(requestUrl(1)).toBe(`/api/blackjack-runs/${RUN_ID}/commands`);
		expect(requestBody(1)).toEqual({ sequence: 3, command: 'stand' });
	});

	test('command rejects without an active run for the requested run id', async () => {
		const client = createClient();
		await client.loadRun(RUN_ID);
		await expect(client.command('differentrunid123456789', { command: 'hit' })).rejects.toThrow(
			'No active blackjack run for command',
		);
	});

	test('a SEQUENCE_MISMATCH command adopts server state via loadRun(runId)', async () => {
		fetchImpl
			.mockResolvedValueOnce(jsonResponse(activeState({ nextSequence: 3 })))
			.mockResolvedValueOnce(errorResponse('SEQUENCE_MISMATCH', 409, { expectedSequence: 4 }))
			.mockResolvedValueOnce(jsonResponse(activeState({ nextSequence: 4, balance: 700 })));

		const client = createClient();
		await client.loadRun(RUN_ID);
		const state = await client.command(RUN_ID, { command: 'hit' });

		expect(requestUrl(2)).toBe(`/api/blackjack-runs/${RUN_ID}`);
		expect(state.nextSequence).toBe(4);
		expect(state.balance).toBe(700);
	});

	test('allows only one request in flight at a time', async () => {
		let resolveFirst!: (response: Response) => void;
		fetchImpl.mockImplementation(
			() =>
				new Promise<Response>((resolve) => {
					resolveFirst = resolve;
				}),
		);

		const client = createClient();
		const first = client.loadCurrent('ranked');

		await expect(client.loadRun(RUN_ID)).rejects.toThrow('already in flight');
		await expect(client.startRanked(10)).rejects.toThrow('already in flight');
		await expect(client.command(RUN_ID, { command: 'stand' })).rejects.toThrow('already in flight');

		resolveFirst(jsonResponse(activeState()));
		expect((await first)?.runId).toBe(RUN_ID);

		// The guard is released after the request settles; an explicit load
		// recovers normally.
		fetchImpl.mockImplementation(() =>
			Promise.resolve(jsonResponse(activeState({ balance: 500 }))),
		);
		expect((await client.loadRun(RUN_ID)).balance).toBe(500);
	});

	test('a timeout surfaces an error, sends no retry, and a later explicit load recovers', async () => {
		fetchImpl.mockImplementation(
			(_input: RequestInfo | URL, init?: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener('abort', () => {
						reject(new DOMException('aborted', 'AbortError'));
					});
				}),
		);

		const client = createClient({ timeoutMs: 20 });
		await expect(client.loadCurrent('ranked')).rejects.toMatchObject({
			name: 'BlackjackRunClientError',
			code: null,
			status: null,
		});
		// No automatic backoff/retry: exactly one request was attempted.
		expect(fetchImpl.mock.calls).toHaveLength(1);

		// Explicit user action (a later load) recovers.
		fetchImpl.mockImplementation(() =>
			Promise.resolve(jsonResponse(activeState({ balance: 300 }))),
		);
		expect((await client.loadRun(RUN_ID)).balance).toBe(300);
	});

	test('a network failure surfaces an error and a later explicit load recovers', async () => {
		fetchImpl.mockRejectedValue(new TypeError('Failed to fetch'));

		const client = createClient();
		await expect(client.loadCurrent('ranked')).rejects.toThrow('Failed to fetch');
		expect(fetchImpl.mock.calls).toHaveLength(1);

		fetchImpl.mockImplementation(() => Promise.resolve(jsonResponse(activeState())));
		expect((await client.loadRun(RUN_ID)).runId).toBe(RUN_ID);
	});

	test('a SETTLEMENT_CONFLICT surfaces as a retryable error without retrying', async () => {
		fetchImpl
			.mockResolvedValueOnce(jsonResponse(activeState()))
			.mockResolvedValueOnce(errorResponse('SETTLEMENT_CONFLICT', 409, { retryable: true }));

		const client = createClient();
		await client.loadRun(RUN_ID);
		await expect(client.command(RUN_ID, { command: 'stand' })).rejects.toMatchObject({
			name: 'BlackjackRunClientError',
			code: 'SETTLEMENT_CONFLICT',
			status: 409,
			retryable: true,
		});
		expect(fetchImpl.mock.calls).toHaveLength(2);

		// Explicit reload recovers.
		fetchImpl.mockImplementation(() => Promise.resolve(jsonResponse(terminalState())));
		const state = await client.loadRun(RUN_ID);
		expect(state.status).toBe('settled');
	});

	test('never touches localStorage and keeps no persisted state', async () => {
		const original = (globalThis as { localStorage?: unknown }).localStorage;
		(globalThis as { localStorage?: unknown }).localStorage = new Proxy(
			{},
			{
				get() {
					throw new Error('localStorage access');
				},
			},
		);
		try {
			const client = createClient();
			await client.loadRun(RUN_ID);
			await client.command(RUN_ID, { command: 'stand' });
			expect(fetchImpl.mock.calls).toHaveLength(2);
		} finally {
			(globalThis as { localStorage?: unknown }).localStorage = original;
		}
	});

	test('terminal state adoption returns a client that accepts further explicit loads', async () => {
		fetchImpl.mockImplementation(() => Promise.resolve(jsonResponse(terminalState())));

		const client = createClient();
		const state = await client.loadRun(RUN_ID);
		expect(state.status).toBe('settled');
		await expect(client.command(RUN_ID, { command: 'stand' })).rejects.toThrow(
			'No active blackjack run for command',
		);
	});
});

describe('BlackjackRunClientError', () => {
	test('carries code, status, retryable and expectedSequence', () => {
		const error = new BlackjackRunClientError('sequence mismatch', {
			code: 'SEQUENCE_MISMATCH',
			status: 409,
			expectedSequence: 7,
		});
		expect(error).toBeInstanceOf(Error);
		expect(error.name).toBe('BlackjackRunClientError');
		expect(error.code).toBe('SEQUENCE_MISMATCH');
		expect(error.status).toBe(409);
		expect(error.retryable).toBe(false);
		expect(error.expectedSequence).toBe(7);
	});
});
