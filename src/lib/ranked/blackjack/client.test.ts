import { describe, expect, mock, test } from 'bun:test';
import type { RankedBlackjackAction } from '../protocol';
import {
	buildRankedBlackjackStorageKeys,
	createRankedBlackjackClient,
	type RankedBlackjackClientDeps,
	type RankedBlackjackRenderer,
	type RankedBlackjackResponseV1,
} from './client';

const SESSION_ID = 'abcdefghijklmnopqrstuv';
const USER_ID = 'test-user-1';
const keys = buildRankedBlackjackStorageKeys(USER_ID);

function activeSessionValue(sessionId: string, requestId: string | null = null): string {
	return JSON.stringify({ sessionId, requestId });
}

function activeResponse(
	overrides: Partial<RankedBlackjackResponseV1> = {},
): RankedBlackjackResponseV1 {
	return {
		sessionId: SESSION_ID,
		status: 'active',
		gameType: 'blackjack',
		rulesetVersion: 'blackjack-ranked-v1',
		seedCommitment: 'seed-commitment',
		expiresAt: 1_800_000_900,
		nextSequence: 0,
		balance: 900,
		state: {
			phase: 'player-turn',
			playerHands: [
				{
					cards: [
						{ rank: 'A', suit: 'clubs' },
						{ rank: '9', suit: 'hearts' },
					],
					wager: 100,
					value: { value: 20, isSoft: true, isBust: false },
				},
			],
			activeHandIndex: 0,
			dealer: {
				cards: [{ rank: '7', suit: 'spades' }],
				value: { value: 7, isSoft: false, isBust: false },
			},
			committedWager: 100,
			nextSequence: 0,
			availableActions: ['hit', 'stand'],
			outcome: null,
		},
		receipt: null,
		...overrides,
	};
}

function terminalResponse(): RankedBlackjackResponseV1 {
	return {
		...activeResponse(),
		status: 'settled',
		balance: 1100,
		nextSequence: 1,
		state: {
			...activeResponse().state,
			phase: 'complete',
			nextSequence: 1,
			availableActions: [],
			outcome: {
				result: 'win',
				hands: [{ handIndex: 0, result: 'win', wager: 100, payout: 200 }],
				committedWager: 100,
				payout: 200,
				gameNetDelta: 100,
			},
		},
		receipt: {
			sessionId: SESSION_ID,
			gameType: 'blackjack',
			rulesetVersion: 'blackjack-ranked-v1',
			seedCommitment: 'seed-commitment',
			configHash: 'config-hash',
			actionLogHash: 'action-log-hash',
			outcome: {
				result: 'win',
				hands: [{ handIndex: 0, result: 'win', wager: 100, payout: 200 }],
				committedWager: 100,
				payout: 200,
				gameNetDelta: 100,
			},
			initialWager: 100,
			committedWager: 100,
			payout: 200,
			gameNetDelta: 100,
			rewardDelta: 100,
			balanceAfter: 1100,
			statsEffects: {
				sessionsPlayed: 1,
				totalWins: 1,
				totalLosses: 0,
				totalPushes: 0,
				totalForfeits: 0,
				netProfit: 100,
				biggestWin: 100,
			},
			achievementEffects: ['ranked_debut'],
			rewardEffects: [{ rewardId: 'ranked_debut_100', chipAmount: 100 }],
			settledAt: 1_800_000_100,
			receiptHash: 'receipt-hash',
		},
	};
}

function jsonResponse(body: RankedBlackjackResponseV1, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	});
}

class RecordingStorage {
	readonly values = new Map<string, string>();
	readonly events: Array<['set' | 'remove', string, string?]> = [];

	getItem(key: string): string | null {
		return this.values.get(key) ?? null;
	}

	setItem(key: string, value: string): void {
		this.values.set(key, value);
		this.events.push(['set', key, value]);
	}

	removeItem(key: string): void {
		this.values.delete(key);
		this.events.push(['remove', key]);
	}
}

function createRenderer(events: string[] = []): RankedBlackjackRenderer & {
	responses: RankedBlackjackResponseV1[];
	pending: boolean[];
	countdowns: number[];
	errors: string[];
} {
	return {
		responses: [],
		pending: [],
		countdowns: [],
		errors: [],
		bind() {},
		getWager: () => 100,
		render(response) {
			if (response) this.responses.push(response);
			events.push(response?.receipt ? 'render-terminal' : 'render');
		},
		setPending(pending) {
			this.pending.push(pending);
			events.push(`pending:${pending}`);
		},
		renderCountdown(seconds) {
			this.countdowns.push(seconds);
		},
		renderError(message) {
			this.errors.push(message);
		},
	};
}

function createHarness({
	userId = USER_ID,
	fetch: fetchImplementation = async () => jsonResponse(activeResponse()),
	storage = new RecordingStorage(),
	renderer = createRenderer(),
	createRequestId = () => 'request-00000001',
	now = () => 1_800_000_000_000,
	setInterval: setIntervalImplementation = () => 1,
	clearInterval: clearIntervalImplementation = () => {},
}: Partial<RankedBlackjackClientDeps> & {
	storage?: RecordingStorage;
	renderer?: ReturnType<typeof createRenderer>;
} = {}) {
	const fetchMock = mock(fetchImplementation as typeof fetch);
	const client = createRankedBlackjackClient({
		userId,
		fetch: fetchMock,
		storage,
		renderer,
		createRequestId,
		now,
		setInterval: setIntervalImplementation,
		clearInterval: clearIntervalImplementation,
	});
	return { client, fetchMock, storage, renderer };
}

describe('ranked Blackjack recovery client', () => {
	test('persists the start request before fetch and the session after success', async () => {
		const storage = new RecordingStorage();
		const fetchImplementation = mock(async () => {
			expect(storage.events[0]?.slice(0, 2)).toEqual(['set', keys.startRequest]);
			return jsonResponse(activeResponse());
		});
		const { client } = createHarness({ fetch: fetchImplementation, storage });

		await client.start(100);

		expect(storage.getItem(keys.activeSession)).toBe(
			activeSessionValue(SESSION_ID, 'request-00000001'),
		);
		expect(storage.events.map(([operation, key]) => [operation, key])).toEqual([
			['set', keys.startRequest],
			['set', keys.activeSession],
			['remove', keys.startRequest],
		]);
	});

	test('reuses the exact persisted start payload after an uncertain prior start and reload', async () => {
		const storage = new RecordingStorage();
		const first = createHarness({
			storage,
			createRequestId: () => 'request-00000001',
			fetch: async () => {
				throw new TypeError('network');
			},
		});
		await first.client.start(100);

		expect(storage.getItem(keys.startRequest)).toBe(
			JSON.stringify({ requestId: 'request-00000001', wager: 100 }),
		);

		let postedBody: string | undefined;
		const reloaded = createHarness({
			storage,
			createRequestId: () => 'request-00000002',
			fetch: async (_url, init) => {
				postedBody = String(init?.body);
				return jsonResponse(activeResponse());
			},
		});
		await reloaded.client.initialize();

		await reloaded.client.start(200);

		expect(JSON.parse(postedBody ?? '')).toEqual({
			requestId: 'request-00000001',
			gameType: 'blackjack',
			rulesetVersion: 'blackjack-ranked-v1',
			wager: 100,
		});
	});

	test('clears a definitively missing stored session so reload and start controls recover', async () => {
		const storage = new RecordingStorage();
		storage.values.set(keys.activeSession, SESSION_ID);
		const renderer = createRenderer();
		const { client } = createHarness({
			storage,
			renderer,
			fetch: async () =>
				new Response(JSON.stringify({ error: 'SESSION_NOT_FOUND' }), {
					status: 404,
					headers: { 'content-type': 'application/json' },
				}),
		});

		await client.initialize();

		expect(storage.getItem(keys.activeSession)).toBeNull();
		expect(renderer.pending).toEqual([true, false]);
		expect(renderer.errors).toEqual(['session not found']);

		const reloadEvents: string[] = [];
		const reloaded = createHarness({
			storage,
			renderer: createRenderer(reloadEvents),
			fetch: async () => {
				throw new Error('reload must not fetch a cleared session');
			},
		});
		await reloaded.client.initialize();

		expect(reloaded.fetchMock).toHaveBeenCalledTimes(0);
		expect(reloadEvents).toEqual(['render']);
	});

	test('resumes a stored session before start can be enabled on reload', async () => {
		const events: string[] = [];
		const storage = new RecordingStorage();
		storage.values.set(keys.activeSession, SESSION_ID);
		const renderer = createRenderer(events);
		const { client, fetchMock } = createHarness({ storage, renderer });

		await client.initialize();

		expect(events.slice(0, 3)).toEqual(['pending:true', 'render', 'pending:false']);
		expect(fetchMock.mock.calls[0]?.[0]).toBe(`/api/ranked/sessions/${SESSION_ID}`);
		expect(renderer.responses.at(-1)?.status).toBe('active');
	});

	test('keeps controls blocked when reload recovery remains uncertain', async () => {
		const storage = new RecordingStorage();
		storage.values.set(keys.activeSession, SESSION_ID);
		const renderer = createRenderer();
		const { client } = createHarness({
			storage,
			renderer,
			fetch: async () => {
				throw new TypeError('network');
			},
		});

		await client.initialize();

		expect(renderer.pending).toEqual([true]);
		expect(renderer.errors).toEqual(['network']);
		expect(storage.getItem(keys.activeSession)).toBe(SESSION_ID);
	});

	test.each([
		['server error', 500, 'INTERNAL_ERROR'],
		['authentication response', 401, 'UNAUTHORIZED'],
	])('keeps reload blocked for unresolved %s', async (_label, status, code) => {
		const storage = new RecordingStorage();
		storage.values.set(keys.activeSession, SESSION_ID);
		const renderer = createRenderer();
		const { client } = createHarness({
			storage,
			renderer,
			fetch: async () =>
				new Response(JSON.stringify({ error: code }), {
					status,
					headers: { 'content-type': 'application/json' },
				}),
		});

		await client.initialize();

		expect(storage.getItem(keys.activeSession)).toBe(SESSION_ID);
		expect(renderer.pending).toEqual([true]);
	});

	test('clears a definitively rejected start so a lower wager after reload uses a fresh request', async () => {
		const storage = new RecordingStorage();
		const bodies: string[] = [];
		const first = createHarness({
			storage,
			createRequestId: () => 'request-00000001',
			fetch: async (_url, init) => {
				bodies.push(String(init?.body));
				return new Response(JSON.stringify({ error: 'INSUFFICIENT_BALANCE' }), {
					status: 409,
					headers: { 'content-type': 'application/json' },
				});
			},
		});

		await first.client.start(1000);

		expect(storage.getItem(keys.startRequest)).toBeNull();
		expect(storage.events.map(([operation, key]) => [operation, key])).toEqual([
			['set', keys.startRequest],
			['remove', keys.startRequest],
		]);

		const reloaded = createHarness({
			storage,
			createRequestId: () => 'request-00000002',
			fetch: async (_url, init) => {
				bodies.push(String(init?.body));
				return jsonResponse(activeResponse());
			},
		});
		await reloaded.client.initialize();
		await reloaded.client.start(10);

		expect(bodies.map((body) => JSON.parse(body))).toEqual([
			{
				requestId: 'request-00000001',
				gameType: 'blackjack',
				rulesetVersion: 'blackjack-ranked-v1',
				wager: 1000,
			},
			{
				requestId: 'request-00000002',
				gameType: 'blackjack',
				rulesetVersion: 'blackjack-ranked-v1',
				wager: 10,
			},
		]);
		expect(storage.getItem(keys.activeSession)).toBe(
			activeSessionValue(SESSION_ID, 'request-00000002'),
		);
	});

	test('retries the identical uncertain action once then resumes authoritative state', async () => {
		const storage = new RecordingStorage();
		storage.values.set(keys.activeSession, SESSION_ID);
		const bodies: string[] = [];
		const actionResponses: Array<Response | Error> = [
			new TypeError('network'),
			new TypeError('network'),
		];
		let getCount = 0;
		const fetchImplementation = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
			if (init === undefined) {
				getCount += 1;
				return jsonResponse(activeResponse({ nextSequence: getCount === 1 ? 0 : 1 }));
			}
			if (typeof init?.body === 'string') bodies.push(init.body);
			const response = actionResponses.shift();
			if (response instanceof Error) throw response;
			if (response) return response;
			return jsonResponse(activeResponse({ nextSequence: 1 }));
		});
		const { client, fetchMock, renderer } = createHarness({ fetch: fetchImplementation, storage });
		await client.initialize();
		fetchMock.mockClear();
		bodies.length = 0;
		actionResponses.splice(
			0,
			actionResponses.length,
			new TypeError('network'),
			new TypeError('network'),
		);

		await client.act('stand');

		expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
			`/api/ranked/sessions/${SESSION_ID}/actions`,
			`/api/ranked/sessions/${SESSION_ID}/actions`,
			`/api/ranked/sessions/${SESSION_ID}`,
		]);
		expect(bodies).toEqual([
			JSON.stringify({ sequence: 0, action: 'stand' }),
			JSON.stringify({ sequence: 0, action: 'stand' }),
		]);
		expect(renderer.pending.at(-1)).toBe(false);
	});

	test('keeps stale actions blocked after POST, POST, and authoritative GET all remain uncertain', async () => {
		const storage = new RecordingStorage();
		storage.values.set(keys.activeSession, SESSION_ID);
		let phase: 'initialize' | 'failed-recovery' | 'successful-retry' = 'initialize';
		const fetchImplementation = mock(async (_url: RequestInfo | URL, init?: RequestInit) => {
			if (phase === 'initialize' && init === undefined) return jsonResponse(activeResponse());
			if (phase === 'successful-retry') {
				return jsonResponse(activeResponse({ nextSequence: 1 }));
			}
			throw new TypeError('network');
		});
		const renderer = createRenderer();
		const { client, fetchMock } = createHarness({
			storage,
			renderer,
			fetch: fetchImplementation,
		});
		await client.initialize();
		fetchMock.mockClear();
		renderer.pending.length = 0;
		phase = 'failed-recovery';

		await client.act('stand');

		expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
			`/api/ranked/sessions/${SESSION_ID}/actions`,
			`/api/ranked/sessions/${SESSION_ID}/actions`,
			`/api/ranked/sessions/${SESSION_ID}`,
		]);
		expect(renderer.pending).toEqual([true, false]);
		expect(storage.getItem(keys.activeSession)).toBe(SESSION_ID);

		await client.act('hit');
		expect(fetchMock).toHaveBeenCalledTimes(3);

		phase = 'successful-retry';
		await client.act('stand');

		expect(fetchMock).toHaveBeenCalledTimes(4);
		expect(fetchMock.mock.calls[3]?.[0]).toBe(`/api/ranked/sessions/${SESSION_ID}/actions`);
		expect(renderer.pending.at(-1)).toBe(false);
		expect(renderer.responses.at(-1)?.nextSequence).toBe(1);
	});

	test('retains unresolved action recovery through a later certain error until authoritative success', async () => {
		const storage = new RecordingStorage();
		storage.values.set(keys.activeSession, SESSION_ID);
		let phase: 'initialize' | 'uncertain' | 'rate-limited' | 'success' = 'initialize';
		const bodies: string[] = [];
		const fetchImplementation = mock(async (_url: RequestInfo | URL, init?: RequestInit) => {
			if (typeof init?.body === 'string') bodies.push(init.body);
			if (phase === 'initialize' && init === undefined) return jsonResponse(activeResponse());
			if (phase === 'rate-limited') {
				return new Response(JSON.stringify({ error: 'RATE_LIMITED' }), {
					status: 429,
					headers: { 'content-type': 'application/json' },
				});
			}
			if (phase === 'success') return jsonResponse(activeResponse({ nextSequence: 1 }));
			throw new TypeError('network');
		});
		const renderer = createRenderer();
		const { client, fetchMock } = createHarness({
			storage,
			renderer,
			fetch: fetchImplementation,
		});
		await client.initialize();
		fetchMock.mockClear();
		renderer.pending.length = 0;
		bodies.length = 0;
		phase = 'uncertain';

		await client.act('stand');
		const unresolvedBody = JSON.stringify({ sequence: 0, action: 'stand' });
		expect(renderer.pending).toEqual([true, false]);

		phase = 'rate-limited';
		await client.act('stand');

		expect(fetchMock).toHaveBeenCalledTimes(4);
		expect(fetchMock.mock.calls[3]?.[0]).toBe(`/api/ranked/sessions/${SESSION_ID}/actions`);
		expect(bodies).toEqual([unresolvedBody, unresolvedBody, unresolvedBody]);
		expect(renderer.pending).toEqual([true, false, true, false]);

		await client.act('hit');
		expect(fetchMock).toHaveBeenCalledTimes(4);

		phase = 'success';
		await client.act('stand');

		expect(fetchMock).toHaveBeenCalledTimes(5);
		expect(fetchMock.mock.calls[4]?.[0]).toBe(`/api/ranked/sessions/${SESSION_ID}/actions`);
		expect(bodies).toEqual([unresolvedBody, unresolvedBody, unresolvedBody, unresolvedBody]);
		expect(renderer.pending.at(-1)).toBe(false);
		expect(renderer.responses.at(-1)?.nextSequence).toBe(1);
	});

	test('does not replay an action after a certain client error response', async () => {
		const storage = new RecordingStorage();
		storage.values.set(keys.activeSession, SESSION_ID);
		const fetchImplementation = mock(async (_url: RequestInfo | URL, init?: RequestInit) => {
			if (init === undefined) return jsonResponse(activeResponse());
			return new Response(JSON.stringify({ error: 'INVALID_ACTION' }), {
				status: 400,
				headers: { 'content-type': 'application/json' },
			});
		});
		const renderer = createRenderer();
		const { client } = createHarness({ storage, renderer, fetch: fetchImplementation });
		await client.initialize();
		fetchImplementation.mockClear();

		await client.act('stand');

		expect(fetchImplementation).toHaveBeenCalledTimes(1);
		expect(renderer.errors).toEqual(['invalid action']);
	});

	test('allows only one action request in flight', async () => {
		const storage = new RecordingStorage();
		storage.values.set(keys.activeSession, SESSION_ID);
		let release: ((response: Response) => void) | undefined;
		const fetchImplementation = mock((_: RequestInfo | URL, init?: RequestInit) => {
			if (init === undefined) return Promise.resolve(jsonResponse(activeResponse()));
			return new Promise<Response>((resolve) => {
				release = resolve;
			});
		});
		const renderer = createRenderer();
		const client = createRankedBlackjackClient({
			userId: USER_ID,
			fetch: fetchImplementation as typeof fetch,
			storage,
			renderer,
			createRequestId: () => 'request-00000001',
			now: () => 1_800_000_000_000,
			setInterval: () => 1,
			clearInterval: () => {},
		});
		await client.initialize();
		fetchImplementation.mockClear();

		const first = client.act('stand');
		const second = client.act('hit');

		expect(fetchImplementation).toHaveBeenCalledTimes(1);
		release?.(jsonResponse(activeResponse({ nextSequence: 1 })));
		await Promise.all([first, second]);
	});

	test('replaces the displayed balance with every authoritative ranked response', async () => {
		const storage = new RecordingStorage();
		storage.values.set(keys.activeSession, SESSION_ID);
		const renderer = createRenderer();
		const { client } = createHarness({
			storage,
			renderer,
			fetch: async () => jsonResponse(activeResponse({ balance: 377 })),
		});

		await client.initialize();

		expect(renderer.responses.at(-1)?.balance).toBe(377);
	});

	test('rejects a malformed negative authoritative balance instead of displaying it', async () => {
		const storage = new RecordingStorage();
		storage.values.set(keys.activeSession, SESSION_ID);
		const renderer = createRenderer();
		const { client } = createHarness({
			storage,
			renderer,
			fetch: async () => jsonResponse(activeResponse({ balance: -1 })),
		});

		await client.initialize();

		expect(renderer.responses).toEqual([]);
		expect(renderer.errors).toEqual(['Ranked response was malformed']);
	});

	test('rejects a valid envelope with state missing dealer and playerHands before rendering', async () => {
		// A response with a valid top-level envelope but an empty state
		// object would previously pass readResponse (the state schema was
		// z.object({}).passthrough()) and then throw inside the renderer
		// when it accessed state.dealer.cards / state.playerHands. The
		// render exception was treated as an uncertain failure, leaving
		// pending=true permanently. The structured state schema now rejects
		// this payload in readResponse so it never reaches the renderer.
		const storage = new RecordingStorage();
		storage.values.set(keys.activeSession, SESSION_ID);
		const renderer = createRenderer();
		const malformedEnvelope = {
			sessionId: SESSION_ID,
			status: 'active',
			gameType: 'blackjack',
			rulesetVersion: 'blackjack-ranked-v1',
			seedCommitment: 'seed-commitment',
			expiresAt: 1_800_000_900,
			nextSequence: 0,
			balance: 900,
			state: {},
			receipt: null,
		};
		const { client } = createHarness({
			storage,
			renderer,
			fetch: async () =>
				new Response(JSON.stringify(malformedEnvelope), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				}),
		});

		await client.initialize();

		// The malformed state never reaches the renderer.
		expect(renderer.responses).toEqual([]);
		expect(renderer.errors).toEqual(['Ranked response was malformed']);
	});

	test('rejects a state with a malformed dealer hand value before rendering', async () => {
		// The dealer.value field must be a structured hand-value object,
		// not a bare number. The schema rejects this before the renderer
		// can throw on value.isBust access.
		const storage = new RecordingStorage();
		storage.values.set(keys.activeSession, SESSION_ID);
		const renderer = createRenderer();
		const malformed = activeResponse({
			state: {
				...activeResponse().state,
				dealer: {
					cards: [{ rank: '7', suit: 'spades' }],
					value: 7 as unknown as { value: number; isSoft: boolean; isBust: boolean },
				},
			},
		});
		const { client } = createHarness({
			storage,
			renderer,
			fetch: async () => jsonResponse(malformed),
		});

		await client.initialize();

		expect(renderer.responses).toEqual([]);
		expect(renderer.errors).toEqual(['Ranked response was malformed']);
	});

	test('clears terminal references only after the receipt has rendered', async () => {
		const events: string[] = [];
		const storage = new RecordingStorage();
		storage.values.set(keys.startRequest, '{"requestId":"request-00000001","wager":100}');
		storage.values.set(keys.activeSession, activeSessionValue(SESSION_ID, 'request-00000001'));
		const originalRemove = storage.removeItem.bind(storage);
		storage.removeItem = (key) => {
			events.push(`remove:${key}`);
			originalRemove(key);
		};
		const renderer = createRenderer(events);
		const { client } = createHarness({
			storage,
			renderer,
			fetch: async () => jsonResponse(terminalResponse()),
		});

		await client.initialize();

		expect(events).toEqual([
			'pending:true',
			'render-terminal',
			`remove:${keys.activeSession}`,
			`remove:${keys.startRequest}`,
			'pending:false',
		]);
	});

	test('a countdown reaching zero does not settle or clear the active session locally', async () => {
		const storage = new RecordingStorage();
		storage.values.set(keys.activeSession, SESSION_ID);
		const renderer = createRenderer();
		let intervalTick: (() => void) | undefined;
		const { client, fetchMock } = createHarness({
			storage,
			renderer,
			now: () => 1_800_001_000_000,
			setInterval: (callback) => {
				intervalTick = callback;
				return 1;
			},
		});

		await client.initialize();
		intervalTick?.();

		expect(renderer.countdowns.at(-1)).toBe(0);
		expect(storage.getItem(keys.activeSession)).toBe(SESSION_ID);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(renderer.responses.at(-1)?.status).toBe('active');
	});

	test('serializes the server-provided next sequence and action without local rules', async () => {
		const storage = new RecordingStorage();
		storage.values.set(keys.activeSession, SESSION_ID);
		const sent: Array<{ sequence: number; action: RankedBlackjackAction }> = [];
		const { client } = createHarness({
			storage,
			fetch: async (_url, init) => {
				if (init === undefined) return jsonResponse(activeResponse({ nextSequence: 8 }));
				sent.push(JSON.parse(String(init?.body)));
				return jsonResponse(activeResponse({ nextSequence: 8 }));
			},
		});
		await client.initialize();
		sent.length = 0;

		await client.act('split');

		expect(sent).toEqual([{ sequence: 8, action: 'split' }]);
	});

	test("does not resume another user's active session after sign-in on the same browser", async () => {
		const storage = new RecordingStorage();
		const userAKeys = buildRankedBlackjackStorageKeys('user-a');
		// User A left an active session and start request in localStorage.
		storage.values.set(
			userAKeys.activeSession,
			activeSessionValue('user-a-session', 'user-a-request'),
		);
		storage.values.set(
			userAKeys.startRequest,
			JSON.stringify({ requestId: 'user-a-request', wager: 500 }),
		);

		// User B signs in — their client uses a different userId namespace.
		const renderer = createRenderer();
		const { client, fetchMock } = createHarness({
			userId: 'user-b',
			storage,
			renderer,
			fetch: async () => {
				throw new Error("user B must not fetch user A's session");
			},
		});

		await client.initialize();

		// User B's keys are empty; no fetch should occur.
		expect(fetchMock).toHaveBeenCalledTimes(0);
		// render(null) was called but doesn't push to responses array.
		expect(renderer.responses).toEqual([]);
		// User A's records remain untouched (not cleared by user B's client).
		expect(storage.getItem(userAKeys.activeSession)).not.toBeNull();
		expect(storage.getItem(userAKeys.startRequest)).not.toBeNull();
	});

	test("does not reuse another user's start request wager when starting a new session", async () => {
		const storage = new RecordingStorage();
		const userAKeys = buildRankedBlackjackStorageKeys('user-a');
		storage.values.set(
			userAKeys.startRequest,
			JSON.stringify({ requestId: 'user-a-request', wager: 500 }),
		);

		let postedBody: string | undefined;
		const { client } = createHarness({
			userId: 'user-b',
			storage,
			createRequestId: () => 'user-b-request',
			fetch: async (_url, init) => {
				postedBody = String(init?.body);
				return jsonResponse(activeResponse());
			},
		});

		await client.start(50);

		const body = JSON.parse(postedBody ?? '');
		expect(body.requestId).toBe('user-b-request');
		expect(body.wager).toBe(50);
	});

	test("a delayed terminal response for S1 does not delete another tab's active session S2", async () => {
		const storage = new RecordingStorage();
		// Tab 2 has already started S2 and stored it as the active session.
		storage.values.set(keys.activeSession, activeSessionValue('session-2', 'request-2'));
		storage.values.set(keys.startRequest, JSON.stringify({ requestId: 'request-2', wager: 100 }));

		// Simulate tab 1's delayed terminal response for S1 arriving after
		// tab 2 has already stored S2. The response carries sessionId='session-1'
		// while storage holds 'session-2'. accept() must not clear S2's records.
		const mismatchedTerminal = {
			...terminalResponse(),
			sessionId: 'session-1',
		};
		const mismatchedClient = createRankedBlackjackClient({
			userId: USER_ID,
			fetch: async () => jsonResponse(mismatchedTerminal),
			storage,
			renderer: createRenderer(),
			createRequestId: () => 'request-1',
			now: () => 1_800_000_000_000,
			setInterval: () => 1,
			clearInterval: () => {},
		});
		await mismatchedClient.initialize();

		// S2's records must survive S1's terminal response.
		expect(storage.getItem(keys.activeSession)).toBe(activeSessionValue('session-2', 'request-2'));
		expect(storage.getItem(keys.startRequest)).toBe(
			JSON.stringify({ requestId: 'request-2', wager: 100 }),
		);
	});

	test("a delayed definitive start error for R1 does not delete another tab's start request R2", async () => {
		const storage = new RecordingStorage();
		// Tab 1 has already stored its start request R1.
		storage.values.set(keys.startRequest, JSON.stringify({ requestId: 'request-1', wager: 50 }));

		const { client } = createHarness({
			storage,
			createRequestId: () => 'request-1',
			fetch: async () => {
				// While tab 1's fetch is in-flight, tab 2 overwrites the
				// shared start request key with R2.
				storage.values.set(
					keys.startRequest,
					JSON.stringify({ requestId: 'request-2', wager: 100 }),
				);
				return new Response(JSON.stringify({ error: 'INSUFFICIENT_BALANCE' }), {
					status: 409,
					headers: { 'content-type': 'application/json' },
				});
			},
		});

		await client.start(50);

		// R2's start request must survive R1's definitive error.
		expect(storage.getItem(keys.startRequest)).toBe(
			JSON.stringify({ requestId: 'request-2', wager: 100 }),
		);
	});
});
