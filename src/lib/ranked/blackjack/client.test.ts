import { describe, expect, mock, test } from 'bun:test';
import type { RankedBlackjackAction } from '../protocol';
import {
	ACTIVE_SESSION_KEY,
	START_REQUEST_KEY,
	createRankedBlackjackClient,
	type RankedBlackjackClientDeps,
	type RankedBlackjackRenderer,
	type RankedBlackjackResponseV1,
} from './client';

const SESSION_ID = 'abcdefghijklmnopqrstuv';

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
	fetch: fetchImplementation = async () => jsonResponse(activeResponse()),
	storage = new RecordingStorage(),
	renderer = createRenderer(),
	now = () => 1_800_000_000_000,
	setInterval: setIntervalImplementation = () => 1,
	clearInterval: clearIntervalImplementation = () => {},
}: Partial<RankedBlackjackClientDeps> & {
	storage?: RecordingStorage;
	renderer?: ReturnType<typeof createRenderer>;
} = {}) {
	const fetchMock = mock(fetchImplementation as typeof fetch);
	const client = createRankedBlackjackClient({
		fetch: fetchMock,
		storage,
		renderer,
		createRequestId: () => 'request-00000001',
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
			expect(storage.events[0]?.slice(0, 2)).toEqual(['set', START_REQUEST_KEY]);
			return jsonResponse(activeResponse());
		});
		const { client } = createHarness({ fetch: fetchImplementation, storage });

		await client.start(100);

		expect(storage.getItem(ACTIVE_SESSION_KEY)).toBe(SESSION_ID);
		expect(storage.events.map(([operation, key]) => [operation, key])).toEqual([
			['set', START_REQUEST_KEY],
			['set', ACTIVE_SESSION_KEY],
		]);
	});

	test('reuses the exact persisted start payload after an uncertain prior start', async () => {
		const storage = new RecordingStorage();
		storage.values.set(
			START_REQUEST_KEY,
			JSON.stringify({ requestId: 'request-00000001', wager: 100 }),
		);
		let postedBody: string | undefined;
		const { client } = createHarness({
			storage,
			fetch: async (_url, init) => {
				postedBody = String(init?.body);
				return jsonResponse(activeResponse());
			},
		});

		await client.start(200);

		expect(JSON.parse(postedBody ?? '')).toEqual({
			requestId: 'request-00000001',
			gameType: 'blackjack',
			rulesetVersion: 'blackjack-ranked-v1',
			wager: 100,
		});
	});

	test('resumes a stored session before start can be enabled on reload', async () => {
		const events: string[] = [];
		const storage = new RecordingStorage();
		storage.values.set(ACTIVE_SESSION_KEY, SESSION_ID);
		const renderer = createRenderer(events);
		const { client, fetchMock } = createHarness({ storage, renderer });

		await client.initialize();

		expect(events.slice(0, 3)).toEqual(['pending:true', 'render', 'pending:false']);
		expect(fetchMock.mock.calls[0]?.[0]).toBe(`/api/ranked/sessions/${SESSION_ID}`);
		expect(renderer.responses.at(-1)?.status).toBe('active');
	});

	test('keeps controls blocked when reload recovery remains uncertain', async () => {
		const storage = new RecordingStorage();
		storage.values.set(ACTIVE_SESSION_KEY, SESSION_ID);
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
		expect(storage.getItem(ACTIVE_SESSION_KEY)).toBe(SESSION_ID);
	});

	test('retries the identical uncertain action once then resumes authoritative state', async () => {
		const storage = new RecordingStorage();
		storage.values.set(ACTIVE_SESSION_KEY, SESSION_ID);
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
		storage.values.set(ACTIVE_SESSION_KEY, SESSION_ID);
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
		expect(renderer.pending).toEqual([true]);
		expect(storage.getItem(ACTIVE_SESSION_KEY)).toBe(SESSION_ID);

		await client.act('hit');
		expect(fetchMock).toHaveBeenCalledTimes(3);

		phase = 'successful-retry';
		await client.act('stand');

		expect(fetchMock).toHaveBeenCalledTimes(4);
		expect(fetchMock.mock.calls[3]?.[0]).toBe(`/api/ranked/sessions/${SESSION_ID}/actions`);
		expect(renderer.pending.at(-1)).toBe(false);
		expect(renderer.responses.at(-1)?.nextSequence).toBe(1);
	});

	test('does not replay an action after a certain client error response', async () => {
		const storage = new RecordingStorage();
		storage.values.set(ACTIVE_SESSION_KEY, SESSION_ID);
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
		storage.values.set(ACTIVE_SESSION_KEY, SESSION_ID);
		let release: ((response: Response) => void) | undefined;
		const fetchImplementation = mock((_: RequestInfo | URL, init?: RequestInit) => {
			if (init === undefined) return Promise.resolve(jsonResponse(activeResponse()));
			return new Promise<Response>((resolve) => {
				release = resolve;
			});
		});
		const renderer = createRenderer();
		const client = createRankedBlackjackClient({
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
		storage.values.set(ACTIVE_SESSION_KEY, SESSION_ID);
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
		storage.values.set(ACTIVE_SESSION_KEY, SESSION_ID);
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

	test('clears terminal references only after the receipt has rendered', async () => {
		const events: string[] = [];
		const storage = new RecordingStorage();
		storage.values.set(START_REQUEST_KEY, '{"requestId":"request-00000001","wager":100}');
		storage.values.set(ACTIVE_SESSION_KEY, SESSION_ID);
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
			`remove:${START_REQUEST_KEY}`,
			`remove:${ACTIVE_SESSION_KEY}`,
			'pending:false',
		]);
	});

	test('a countdown reaching zero does not settle or clear the active session locally', async () => {
		const storage = new RecordingStorage();
		storage.values.set(ACTIVE_SESSION_KEY, SESSION_ID);
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
		expect(storage.getItem(ACTIVE_SESSION_KEY)).toBe(SESSION_ID);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(renderer.responses.at(-1)?.status).toBe('active');
	});

	test('serializes the server-provided next sequence and action without local rules', async () => {
		const storage = new RecordingStorage();
		storage.values.set(ACTIVE_SESSION_KEY, SESSION_ID);
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
});
