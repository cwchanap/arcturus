import { describe, expect, mock, test } from 'bun:test';
import {
	buildDailyChallengeStorageKeys,
	createDailyChallengeClient,
	type DailyChallengeClientDeps,
	type DailyChallengeRenderer,
	type DailyChallengeAttemptPublicStateV1,
} from './client';

const ATTEMPT_ID = 'abcdefghijklmnopqrstuv';
const CHALLENGE_ID = 'challenge_12345678';
const REQUEST_ID = 'request_1234567890';
const USER_ID = 'test-user-1';
const PERIOD_KEY = '2026-03-14';
const NEXT_PERIOD_KEY = '2026-03-15';
const keys = buildDailyChallengeStorageKeys(USER_ID, PERIOD_KEY);

const activeRoundFixture = {
	phase: 'player-turn',
	playerHands: [
		{
			cards: [
				{ rank: 'A', suit: 'hearts' },
				{ rank: '9', suit: 'diamonds' },
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
	availableActions: ['hit', 'stand'],
	outcome: null,
};

function activeAttempt(
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
		activeRound: activeRoundFixture,
		rank: null,
		percentile: null,
		receipt: null,
		expiresAt: 1_742_000_000,
		...overrides,
	};
}

function terminalAttempt(
	overrides: Partial<DailyChallengeAttemptPublicStateV1> = {},
): DailyChallengeAttemptPublicStateV1 {
	return {
		...activeAttempt(),
		status: 'completed',
		nextCommandSequence: 40,
		availableBankroll: 1200,
		roundsCompleted: 10,
		activeRound: null,
		rank: 3,
		percentile: 95.5,
		receipt: {
			attemptId: ATTEMPT_ID,
			challengeId: CHALLENGE_ID,
			periodKey: PERIOD_KEY,
			challengeRulesetVersion: 'blackjack-daily-v1',
			gameRulesetVersion: 'blackjack-ranked-v1',
			scoreVersion: 'blackjack-daily-score-v1',
			configHash: 'a'.repeat(64),
			rankedSeedCommitment: 'b'.repeat(64),
			actionLogHash: 'c'.repeat(64),
			endingBankroll: 1200,
			roundsCompleted: 10,
			eligible: true,
			terminalReason: 'completed',
			durationSeconds: 600,
			settledAt: 1_742_001_000,
			receiptHash: 'd'.repeat(64),
		},
		...overrides,
	};
}

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

function createRenderer(events: string[] = []): DailyChallengeRenderer & {
	responses: DailyChallengeAttemptPublicStateV1[];
	pending: boolean[];
	errors: string[];
} {
	return {
		responses: [],
		pending: [],
		errors: [],
		render(response) {
			if (response) this.responses.push(response);
			events.push(response?.receipt ? 'render-terminal' : 'render');
		},
		setPending(pending) {
			this.pending.push(pending);
			events.push(`pending:${pending}`);
		},
		renderError(message) {
			this.errors.push(message);
		},
	};
}

function createHarness({
	userId = USER_ID,
	periodKey = PERIOD_KEY,
	fetch: fetchImplementation = async () => jsonResponse(activeAttempt()),
	storage = new RecordingStorage(),
	renderer = createRenderer(),
	createRequestId = () => REQUEST_ID,
}: Partial<DailyChallengeClientDeps> & {
	storage?: RecordingStorage;
	renderer?: ReturnType<typeof createRenderer>;
} = {}) {
	const fetchMock = mock(fetchImplementation as typeof fetch);
	const client = createDailyChallengeClient({
		userId,
		periodKey,
		fetch: fetchMock,
		storage,
		renderer,
		createRequestId,
	});
	return { client, fetchMock, storage, renderer };
}

function storedActiveAttempt(attemptId = ATTEMPT_ID, startRequestId = REQUEST_ID): string {
	return JSON.stringify({
		attemptId,
		periodKey: PERIOD_KEY,
		startRequestId,
	});
}

function storedStartIntent(requestId = REQUEST_ID, periodKey = PERIOD_KEY): string {
	return JSON.stringify({ requestId, periodKey });
}

describe('daily challenge recovery client — storage keys', () => {
	test('namespaces start and attempt keys by user and period', () => {
		expect(buildDailyChallengeStorageKeys(USER_ID, PERIOD_KEY)).toEqual({
			startRequest: `arcturus:daily-challenge:start:${USER_ID}:${PERIOD_KEY}`,
			activeAttempt: `arcturus:daily-challenge:attempt:${USER_ID}:${PERIOD_KEY}`,
		});
	});
});

describe('daily challenge recovery client — start request id lifecycle', () => {
	test('mints a fresh request id per logical start and persists it before fetch', async () => {
		const storage = new RecordingStorage();
		const bodies: string[] = [];
		const fetchImplementation = mock(async (_url: RequestInfo | URL, init?: RequestInit) => {
			expect(storage.events[0]?.slice(0, 2)).toEqual(['set', keys.startRequest]);
			bodies.push(String(init?.body));
			// Server echoes the caller's request id back as startRequestId.
			return jsonResponse(activeAttempt({ startRequestId: 'fresh_request_id_1' }));
		});
		const { client } = createHarness({
			storage,
			fetch: fetchImplementation,
			createRequestId: () => 'fresh_request_id_1',
		});

		await client.start();

		expect(bodies).toEqual([JSON.stringify({ requestId: 'fresh_request_id_1' })]);
		expect(storage.getItem(keys.startRequest)).toBeNull();
		expect(storage.getItem(keys.activeAttempt)).toBe(
			storedActiveAttempt(ATTEMPT_ID, 'fresh_request_id_1'),
		);
		expect(storage.events.map(([op, key]) => [op, key])).toEqual([
			['set', keys.startRequest],
			['set', keys.activeAttempt],
			['remove', keys.startRequest],
		]);
	});

	test('reuses the same request id on an uncertain start retry', async () => {
		const storage = new RecordingStorage();
		const first = createHarness({
			storage,
			createRequestId: () => 'request_retry_same_1',
			fetch: async () => {
				throw new TypeError('network down');
			},
		});
		await first.client.start();

		expect(storage.getItem(keys.startRequest)).toBe(storedStartIntent('request_retry_same_1'));

		const bodies: string[] = [];
		const reloaded = createHarness({
			storage,
			createRequestId: () => 'would_be_fresh_but_reuse',
			fetch: async (_url, init) => {
				bodies.push(String(init?.body));
				return jsonResponse(activeAttempt());
			},
		});
		await reloaded.client.start();

		expect(bodies).toEqual([JSON.stringify({ requestId: 'request_retry_same_1' })]);
	});

	test('clears a definitively rejected start so a later start mints fresh', async () => {
		const storage = new RecordingStorage();
		const first = createHarness({
			storage,
			createRequestId: () => 'rejected_request_id',
			fetch: async () => errorResponse('RANKED_ENTRY_CLOSED', 409),
		});
		await first.client.start();

		expect(storage.getItem(keys.startRequest)).toBeNull();

		const bodies: string[] = [];
		const second = createHarness({
			storage,
			createRequestId: () => 'fresh_after_rejection',
			fetch: async (_url, init) => {
				bodies.push(String(init?.body));
				return jsonResponse(activeAttempt());
			},
		});
		await second.client.start();

		expect(bodies).toEqual([JSON.stringify({ requestId: 'fresh_after_rejection' })]);
	});

	test('persists the server-returned startRequestId, not the caller losing id', async () => {
		const storage = new RecordingStorage();
		const winnerId = 'winner_request_id_123';
		const { client } = createHarness({
			storage,
			createRequestId: () => 'caller_loser_request',
			fetch: async () => jsonResponse(activeAttempt({ startRequestId: winnerId })),
		});

		await client.start();

		expect(storage.getItem(keys.activeAttempt)).toBe(storedActiveAttempt(ATTEMPT_ID, winnerId));
		expect(storage.getItem(keys.startRequest)).toBeNull();
	});

	test('does not reuse another period start intent when the period rolls over', async () => {
		const storage = new RecordingStorage();
		// Yesterday's intent lives under yesterday's key.
		const yesterdayKeys = buildDailyChallengeStorageKeys(USER_ID, NEXT_PERIOD_KEY);
		storage.values.set(
			yesterdayKeys.startRequest,
			storedStartIntent('yesterday_request_id', NEXT_PERIOD_KEY),
		);

		const bodies: string[] = [];
		const { client } = createHarness({
			storage,
			periodKey: PERIOD_KEY,
			createRequestId: () => 'today_fresh_request_id',
			fetch: async (_url, init) => {
				bodies.push(String(init?.body));
				return jsonResponse(activeAttempt());
			},
		});

		await client.start();

		expect(bodies).toEqual([JSON.stringify({ requestId: 'today_fresh_request_id' })]);
		// Yesterday's intent is untouched (different key namespace).
		expect(storage.getItem(yesterdayKeys.startRequest)).toBe(
			storedStartIntent('yesterday_request_id', NEXT_PERIOD_KEY),
		);
	});

	test('mints a fresh request id when a stored intent under the current key is stale', async () => {
		const storage = new RecordingStorage();
		// A start intent was persisted under TODAY's key but embeds a stale period.
		storage.values.set(keys.startRequest, storedStartIntent(REQUEST_ID, NEXT_PERIOD_KEY));

		const bodies: string[] = [];
		const { client } = createHarness({
			storage,
			periodKey: PERIOD_KEY,
			createRequestId: () => 'fresh_after_stale_period',
			fetch: async (_url, init) => {
				bodies.push(String(init?.body));
				return jsonResponse(activeAttempt());
			},
		});

		await client.start();

		expect(bodies).toEqual([JSON.stringify({ requestId: 'fresh_after_stale_period' })]);
		expect(storage.getItem(keys.startRequest)).toBeNull();
	});
});

describe('daily challenge recovery client — initialize resume', () => {
	test('resumes a stored active attempt on initialize', async () => {
		const events: string[] = [];
		const storage = new RecordingStorage();
		storage.values.set(keys.activeAttempt, storedActiveAttempt());
		const renderer = createRenderer(events);
		const { client, fetchMock } = createHarness({ storage, renderer });

		await client.initialize();

		expect(events.slice(0, 3)).toEqual(['pending:true', 'render', 'pending:false']);
		expect(fetchMock.mock.calls[0]?.[0]).toBe(`/api/daily-challenge-attempts/${ATTEMPT_ID}`);
		expect(renderer.responses.at(-1)?.status).toBe('active');
	});

	test('renders null and does not fetch when no active attempt is stored', async () => {
		const events: string[] = [];
		const storage = new RecordingStorage();
		const renderer = createRenderer(events);
		const { client, fetchMock } = createHarness({ storage, renderer });

		await client.initialize();

		expect(fetchMock).toHaveBeenCalledTimes(0);
		expect(events).toEqual(['render']);
		expect(renderer.responses).toEqual([]);
	});

	test('clears storage when a resumed attempt is terminal', async () => {
		const storage = new RecordingStorage();
		storage.values.set(keys.activeAttempt, storedActiveAttempt());
		storage.values.set(keys.startRequest, storedStartIntent());
		const { client } = createHarness({
			storage,
			fetch: async () => jsonResponse(terminalAttempt()),
		});

		await client.initialize();

		expect(storage.getItem(keys.activeAttempt)).toBeNull();
		expect(storage.getItem(keys.startRequest)).toBeNull();
	});
});

describe('daily challenge recovery client — command recovery', () => {
	test('retries an uncertain command once then resumes authoritative state', async () => {
		const storage = new RecordingStorage();
		storage.values.set(keys.activeAttempt, storedActiveAttempt());
		const bodies: string[] = [];
		const actionResponses: Array<Response | Error> = [
			new TypeError('network'),
			new TypeError('network'),
		];
		let getCount = 0;
		const fetchImplementation = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
			if (init?.method !== 'POST') {
				getCount += 1;
				return jsonResponse(activeAttempt({ nextCommandSequence: getCount === 1 ? 0 : 1 }));
			}
			if (typeof init?.body === 'string') bodies.push(init.body);
			const next = actionResponses.shift();
			if (next instanceof Error) throw next;
			if (next) return next;
			return jsonResponse(activeAttempt({ nextCommandSequence: 1 }));
		});
		const { client, fetchMock, renderer } = createHarness({
			fetch: fetchImplementation,
			storage,
		});
		await client.initialize();
		fetchMock.mockClear();
		bodies.length = 0;
		actionResponses.splice(
			0,
			actionResponses.length,
			new TypeError('network'),
			new TypeError('network'),
		);

		await client.command({ command: 'stand' });

		expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
			`/api/daily-challenge-attempts/${ATTEMPT_ID}/commands`,
			`/api/daily-challenge-attempts/${ATTEMPT_ID}/commands`,
			`/api/daily-challenge-attempts/${ATTEMPT_ID}`,
		]);
		expect(bodies).toEqual([
			JSON.stringify({ sequence: 0, command: 'stand' }),
			JSON.stringify({ sequence: 0, command: 'stand' }),
		]);
		expect(renderer.pending.at(-1)).toBe(false);
	});

	test('resumes immediately once on 409 ATTEMPT_COMPLETE and renders the terminal receipt', async () => {
		const storage = new RecordingStorage();
		storage.values.set(keys.activeAttempt, storedActiveAttempt());
		const calls: string[] = [];
		let resumedOnce = false;
		const fetchImplementation = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
			if (init?.method === 'POST') {
				calls.push('command');
				return errorResponse('ATTEMPT_COMPLETE', 409);
			}
			calls.push('resume');
			if (!resumedOnce) {
				resumedOnce = true;
				return jsonResponse(activeAttempt());
			}
			return jsonResponse(terminalAttempt());
		});
		const events: string[] = [];
		const renderer = createRenderer(events);
		const { client, fetchMock } = createHarness({ fetch: fetchImplementation, storage, renderer });
		await client.initialize();
		fetchMock.mockClear();
		events.length = 0;
		calls.length = 0;

		await client.command({ command: 'stand' });

		// Only ONE command POST, then exactly ONE resume GET.
		expect(calls).toEqual(['command', 'resume']);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(events).toContain('render-terminal');
		expect(renderer.responses.at(-1)?.status).toBe('completed');
	});

	test('does not retry a definitive validation error and surfaces it', async () => {
		const storage = new RecordingStorage();
		storage.values.set(keys.activeAttempt, storedActiveAttempt());
		const fetchImplementation = mock(async (_url: RequestInfo | URL, init?: RequestInit) => {
			if (init?.method !== 'POST') return jsonResponse(activeAttempt());
			return errorResponse('SEQUENCE_MISMATCH', 409, { expectedSequence: 0 });
		});
		const renderer = createRenderer();
		const { client, fetchMock } = createHarness({ fetch: fetchImplementation, storage, renderer });
		await client.initialize();
		fetchMock.mockClear();

		await client.command({ command: 'stand' });

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(renderer.errors.length).toBe(1);
	});

	test('does not retry a definitive INVALID_COMMAND error', async () => {
		const storage = new RecordingStorage();
		storage.values.set(keys.activeAttempt, storedActiveAttempt());
		const fetchImplementation = mock(async (_url: RequestInfo | URL, init?: RequestInit) => {
			if (init?.method !== 'POST') return jsonResponse(activeAttempt());
			return errorResponse('INVALID_COMMAND', 400);
		});
		const renderer = createRenderer();
		const { client, fetchMock } = createHarness({ fetch: fetchImplementation, storage, renderer });
		await client.initialize();
		fetchMock.mockClear();

		await client.command({ command: 'stand' });

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(renderer.errors.length).toBe(1);
	});

	test('accepts a successful command and renders the next authoritative state', async () => {
		const storage = new RecordingStorage();
		storage.values.set(keys.activeAttempt, storedActiveAttempt());
		const bodies: string[] = [];
		const fetchImplementation = mock(async (_url: RequestInfo | URL, init?: RequestInit) => {
			if (init?.method !== 'POST') return jsonResponse(activeAttempt());
			bodies.push(String(init?.body));
			return jsonResponse(activeAttempt({ nextCommandSequence: 1 }));
		});
		const renderer = createRenderer();
		const { client } = createHarness({ fetch: fetchImplementation, storage, renderer });
		await client.initialize();
		bodies.length = 0;

		await client.command({ command: 'stand' });

		expect(bodies).toEqual([JSON.stringify({ sequence: 0, command: 'stand' })]);
		expect(renderer.responses.at(-1)?.nextCommandSequence).toBe(1);
	});

	test('clears active storage when a command returns a terminal receipt', async () => {
		const storage = new RecordingStorage();
		storage.values.set(keys.activeAttempt, storedActiveAttempt());
		storage.values.set(keys.startRequest, storedStartIntent());
		const { client } = createHarness({
			storage,
			fetch: async (_url, init) => {
				if (init?.method !== 'POST') return jsonResponse(activeAttempt());
				return jsonResponse(terminalAttempt());
			},
		});
		await client.initialize();

		await client.command({ command: 'stand' });

		expect(storage.getItem(keys.activeAttempt)).toBeNull();
		expect(storage.getItem(keys.startRequest)).toBeNull();
	});

	test('does not send a command when there is no active attempt', async () => {
		const storage = new RecordingStorage();
		const { client, fetchMock } = createHarness({ storage });
		await client.initialize();

		await client.command({ command: 'stand' });

		expect(fetchMock).toHaveBeenCalledTimes(0);
	});
});

describe('daily challenge recovery client — cross-tab compare-and-remove', () => {
	test('a delayed terminal for attempt A does not delete another tab attempt B storage', async () => {
		const storage = new RecordingStorage();
		const attemptIdA = 'tabA000000000000000000';
		const attemptIdB = 'tabB000000000000000000';
		const requestA = 'requestA0000000000';
		const requestB = 'requestB0000000000';
		// Tab B has already stored attempt B.
		storage.values.set(keys.activeAttempt, storedActiveAttempt(attemptIdB, requestB));
		storage.values.set(keys.startRequest, storedStartIntent(requestB));

		// Tab A's delayed terminal response arrives carrying attempt A id.
		const mismatchedTerminal = terminalAttempt({ attemptId: attemptIdA, startRequestId: requestA });
		const { client } = createHarness({
			storage,
			fetch: async () => jsonResponse(mismatchedTerminal),
		});
		await client.initialize();

		// Attempt B's storage survives attempt A's terminal.
		expect(storage.getItem(keys.activeAttempt)).toBe(storedActiveAttempt(attemptIdB, requestB));
		expect(storage.getItem(keys.startRequest)).toBe(storedStartIntent(requestB));
	});

	test('a delayed definitive start error for R1 does not delete another tab R2 intent', async () => {
		const storage = new RecordingStorage();
		storage.values.set(keys.startRequest, storedStartIntent('request_R1'));

		const { client } = createHarness({
			storage,
			createRequestId: () => 'request_R1',
			fetch: async () => {
				// While R1's fetch is in-flight, tab R2 overwrites the shared key.
				storage.values.set(keys.startRequest, storedStartIntent('request_R2'));
				return errorResponse('RANKED_ENTRY_CLOSED', 409);
			},
		});

		await client.start();

		// R2's intent survives R1's definitive error.
		expect(storage.getItem(keys.startRequest)).toBe(storedStartIntent('request_R2'));
	});
});

describe('daily challenge recovery client — payload validation defense-in-depth', () => {
	test('treats a malformed 2xx attempt response as uncertain and resumes', async () => {
		const storage = new RecordingStorage();
		storage.values.set(keys.activeAttempt, storedActiveAttempt());
		const malformed = activeAttempt();
		// Remove a required field to make the schema reject it.
		(malformed as Record<string, unknown>).availableBankroll = -1;
		const fetchImplementation = mock(async (_url: RequestInfo | URL, init?: RequestInit) => {
			if (init?.method !== 'POST') return jsonResponse(activeAttempt({ nextCommandSequence: 1 }));
			// POST returns a malformed 2xx.
			return jsonResponse(malformed);
		});
		const { client, fetchMock } = createHarness({ fetch: fetchImplementation, storage });
		await client.initialize();
		fetchMock.mockClear();

		await client.command({ command: 'stand' });

		// POST (malformed 2xx, uncertain) -> retry POST -> resume GET.
		expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
			`/api/daily-challenge-attempts/${ATTEMPT_ID}/commands`,
			`/api/daily-challenge-attempts/${ATTEMPT_ID}/commands`,
			`/api/daily-challenge-attempts/${ATTEMPT_ID}`,
		]);
	});

	test('rejects a live ranked seed leaking in a 2xx attempt response', async () => {
		const storage = new RecordingStorage();
		storage.values.set(keys.activeAttempt, storedActiveAttempt());
		const leaking = { ...activeAttempt(), rankedSeed: 'never-leak' };
		const fetchImplementation = mock(async (_url: RequestInfo | URL, init?: RequestInit) => {
			if (init?.method !== 'POST') return jsonResponse(activeAttempt({ nextCommandSequence: 1 }));
			return jsonResponse(leaking);
		});
		const renderer = createRenderer();
		const { client, fetchMock } = createHarness({ fetch: fetchImplementation, storage, renderer });
		await client.initialize();
		fetchMock.mockClear();

		await client.command({ command: 'stand' });

		// Treated as uncertain: retry, then resume. Never rendered.
		expect(fetchMock.mock.calls.map(([url]) => String(url))).toHaveLength(3);
		expect(renderer.responses.at(-1)?.nextCommandSequence).toBe(1);
	});
});
