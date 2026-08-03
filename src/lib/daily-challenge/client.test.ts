import { describe, expect, mock, test } from 'bun:test';
import { decodeCanonicalBase64Url } from '../ranked/canonical';
import {
	DailyChallengeServiceError,
	type DailyChallengeCommandV1,
	type DailyChallengeHistoryResponse,
	type DailyChallengeLeaderboardResponse,
	type DailyChallengePublicResponse,
} from './protocol';
import type { DailyChallengeReplayV1 } from './replay';
import type {
	DailyChallengeAction,
	DailyChallengeRendererHandlers,
	DailyChallengeReplayScenario,
} from './ui';
import {
	buildDailyChallengeStorageKeys,
	createDailyChallengeClient,
	createDailyChallengeLocalReplayController,
	initDailyChallengeHistoryPage,
	initDailyChallengePage,
	type DailyChallengeAttemptPublicStateV1,
	type DailyChallengeClient,
	type DailyChallengeClientCommand,
	type DailyChallengeClientDeps,
	type DailyChallengeLocalReplayController,
	type DailyChallengeLocalReplayControllerDeps,
	type DailyChallengeRenderer,
} from './client';

const ATTEMPT_ID = 'abcdefghijklmnopqrstuv';
const CHALLENGE_ID = 'challenge_12345678';
const REQUEST_ID = 'request_1234567890';
const USER_ID = 'test-user-1';
const PERIOD_KEY = '2026-03-14';
const NEXT_PERIOD_KEY = '2026-03-15';
const keys = buildDailyChallengeStorageKeys(USER_ID, PERIOD_KEY);
const PRACTICE_SEED = 'AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyAhIiMkJSYn';
const RANKED_SEED = 'AwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gISIjJCUmJygpKis';

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
	localReplays: Array<DailyChallengeReplayV1 | null>;
} {
	return {
		responses: [],
		pending: [],
		errors: [],
		localReplays: [],
		bind() {},
		renderChallenge() {},
		renderAttempt(response) {
			if (response) this.responses.push(response);
			events.push(response?.receipt ? 'render-terminal' : 'render');
		},
		renderLeaderboard() {},
		renderHistory() {},
		renderLocalReplay(replay) {
			this.localReplays.push(replay);
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

describe('daily challenge recovery client — discovered attempt adoption', () => {
	test('adopting an active attempt stores it and renders without fetching', () => {
		const storage = new RecordingStorage();
		storage.values.set(keys.startRequest, storedStartIntent());
		const { client, fetchMock } = createHarness({ storage });

		client.adopt(activeAttempt());

		expect(fetchMock).toHaveBeenCalledTimes(0);
		expect(storage.getItem(keys.activeAttempt)).toBe(storedActiveAttempt());
		expect(storage.getItem(keys.startRequest)).toBeNull();
	});

	test('adopting a terminal attempt renders the receipt and clears storage', () => {
		const storage = new RecordingStorage();
		storage.values.set(keys.activeAttempt, storedActiveAttempt());
		storage.values.set(keys.startRequest, storedStartIntent());
		const events: string[] = [];
		const { client, storage: adoptedStorage } = createHarness({
			storage,
			renderer: createRenderer(events),
		});

		client.adopt(terminalAttempt());

		expect(events).toEqual(['render-terminal']);
		expect(adoptedStorage.getItem(keys.activeAttempt)).toBeNull();
		expect(adoptedStorage.getItem(keys.startRequest)).toBeNull();
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
		const fetchImplementation = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
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
		const fetchImplementation = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
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

	test('recovers a SEQUENCE_MISMATCH by resuming authoritative attempt state', async () => {
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

		// One command POST rejected with SEQUENCE_MISMATCH, then one resume GET
		// to reconcile the client with the authoritative attempt state.
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(renderer.errors.length).toBe(0);
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

	test('a ranked forfeit submits the forfeit command and renders the ineligible terminal receipt', async () => {
		const storage = new RecordingStorage();
		storage.values.set(keys.activeAttempt, storedActiveAttempt());
		const bodies: string[] = [];
		const renderer = createRenderer();
		const { client } = createHarness({
			storage,
			renderer,
			fetch: async (_url, init) => {
				if (init?.method !== 'POST') return jsonResponse(activeAttempt());
				bodies.push(String(init?.body));
				return jsonResponse(
					terminalAttempt({
						status: 'forfeited',
						nextCommandSequence: 1,
						availableBankroll: 900,
						roundsCompleted: 0,
						rank: null,
						percentile: null,
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
							endingBankroll: 900,
							roundsCompleted: 0,
							eligible: false,
							terminalReason: 'forfeited',
							durationSeconds: 120,
							settledAt: 1_742_001_000,
							receiptHash: 'd'.repeat(64),
						},
					}),
				);
			},
		});
		await client.initialize();

		await client.command({ command: 'forfeit' });

		expect(bodies).toEqual([JSON.stringify({ sequence: 0, command: 'forfeit' })]);
		const terminal = renderer.responses.at(-1);
		expect(terminal?.status).toBe('forfeited');
		expect(terminal?.receipt?.terminalReason).toBe('forfeited');
		expect(terminal?.receipt?.eligible).toBe(false);
		expect(storage.getItem(keys.activeAttempt)).toBeNull();
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
		// Set the value outside the valid range so schema validation rejects it.
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

describe('daily challenge local replay controller', () => {
	function challengeFixture(
		overrides: Partial<DailyChallengePublicResponse> = {},
	): DailyChallengePublicResponse {
		return {
			periodKey: PERIOD_KEY,
			challengeKind: 'blackjack-daily',
			challengeRulesetVersion: 'blackjack-daily-v1',
			gameRulesetVersion: 'blackjack-ranked-v1',
			scoreVersion: 'blackjack-daily-score-v1',
			startsAt: 1_742_000_000,
			rankedEntryClosesAt: 1_742_086_200,
			endsAt: 1_742_086_400,
			configHash: 'a'.repeat(64),
			rankedSeedCommitment: 'b'.repeat(64),
			practiceSeed: PRACTICE_SEED,
			revealedRankedSeed: null,
			attempt: null,
			...overrides,
		};
	}

	function replayFixture(overrides: Partial<DailyChallengeReplayV1> = {}): DailyChallengeReplayV1 {
		return {
			availableBankroll: 750,
			roundsCompleted: 1,
			rounds: [],
			activeRound: null,
			activeRoundPublic: null,
			nextCommandSequence: 1,
			status: 'active',
			terminalReason: null,
			eligible: null,
			...overrides,
		};
	}

	function createControllerHarness(challenge: DailyChallengePublicResponse = challengeFixture()): {
		controller: ReturnType<typeof createDailyChallengeLocalReplayController>;
		renderer: ReturnType<typeof createRenderer>;
		loadReplay: ReturnType<typeof mock>;
		captured: Array<{ seed: Uint8Array; commands: DailyChallengeCommandV1[] }>;
	} {
		const renderer = createRenderer();
		const captured: Array<{ seed: Uint8Array; commands: DailyChallengeCommandV1[] }> = [];
		const loadReplay = mock(async () => ({
			replayDailyChallenge(
				_config: unknown,
				seed: Uint8Array,
				commands: DailyChallengeCommandV1[],
			) {
				captured.push({ seed, commands: commands.map((entry) => ({ ...entry })) });
				return replayFixture();
			},
		}));
		const controller = createDailyChallengeLocalReplayController({
			challenge,
			renderer,
			loadReplay,
		});
		return { controller, renderer, loadReplay, captured };
	}

	test('practice scenario selection prepares the local run without importing replay', async () => {
		const { controller, renderer, loadReplay, captured } = createControllerHarness();

		await controller.selectScenario('practice-scenario');

		expect(loadReplay).toHaveBeenCalledTimes(0);
		expect(captured).toEqual([]);
		expect(renderer.localReplays.at(-1)).toBeNull();
	});

	test('start-round lazily loads the pure replay and renders the sequenced result', async () => {
		const { controller, renderer, loadReplay, captured } = createControllerHarness();

		await controller.selectScenario('practice-scenario');
		await controller.startRound(250);

		expect(loadReplay).toHaveBeenCalledTimes(1);
		expect(captured).toHaveLength(1);
		expect(captured[0]?.commands).toEqual([{ sequence: 0, command: 'start-round', wager: 250 }]);
		expect(captured[0]?.seed).toEqual(decodeCanonicalBase64Url(PRACTICE_SEED));
		expect(renderer.localReplays.at(-1)).toEqual(replayFixture());
	});

	test('action and forfeit append sequenced commands to the run', async () => {
		const { controller, captured } = createControllerHarness();

		await controller.selectScenario('practice-scenario');
		await controller.startRound(250);
		await controller.action('hit');
		await controller.forfeit();

		expect(captured.at(-1)?.commands).toEqual([
			{ sequence: 0, command: 'start-round', wager: 250 },
			{ sequence: 1, command: 'hit' },
			{ sequence: 2, command: 'forfeit' },
		]);
	});

	test('restart clears the command log and re-sequences from zero', async () => {
		const { controller, captured } = createControllerHarness();

		await controller.selectScenario('practice-scenario');
		await controller.startRound(250);
		await controller.restart();
		await controller.startRound(50);

		expect(captured.at(-1)?.commands).toEqual([{ sequence: 0, command: 'start-round', wager: 50 }]);
	});

	test('a failing replay reports an error and does not commit the command', async () => {
		const renderer = createRenderer();
		const loadReplay = mock(async () => ({
			replayDailyChallenge() {
				throw new DailyChallengeServiceError('INVALID_WAGER');
			},
		}));
		const controller = createDailyChallengeLocalReplayController({
			challenge: challengeFixture(),
			renderer,
			loadReplay,
		});

		await controller.selectScenario('practice-scenario');
		await controller.startRound(250);

		expect(renderer.errors).toEqual(['INVALID_WAGER']);
		expect(renderer.localReplays.at(-1)).toBeNull();
	});

	test('commands before a scenario is selected never load or run replay', async () => {
		const { controller, renderer, loadReplay } = createControllerHarness();

		await controller.startRound(100);

		expect(loadReplay).toHaveBeenCalledTimes(0);
		expect(renderer.localReplays).toEqual([]);
		expect(renderer.errors).toEqual(['Select a practice scenario first.']);
	});

	test('exact-ranked replay is unavailable on a live challenge', async () => {
		const { controller, renderer, loadReplay } = createControllerHarness();

		await controller.selectScenario('exact-ranked-scenario');

		expect(loadReplay).toHaveBeenCalledTimes(0);
		expect(renderer.localReplays).toEqual([]);
		expect(renderer.errors).toHaveLength(1);
	});

	test('exact-ranked replay uses the revealed ranked seed after close', async () => {
		const { controller, captured } = createControllerHarness(
			challengeFixture({ revealedRankedSeed: RANKED_SEED }),
		);

		await controller.selectScenario('exact-ranked-scenario');
		await controller.startRound(100);

		expect(captured[0]?.seed).toEqual(decodeCanonicalBase64Url(RANKED_SEED));
	});
});

function createPageRenderer(): {
	renderer: DailyChallengeRenderer;
	challenges: DailyChallengePublicResponse[];
	leaderboards: DailyChallengeLeaderboardResponse[];
	histories: DailyChallengeHistoryResponse[];
	errors: string[];
	bound: { handlers: DailyChallengeRendererHandlers | null };
} {
	const challenges: DailyChallengePublicResponse[] = [];
	const leaderboards: DailyChallengeLeaderboardResponse[] = [];
	const histories: DailyChallengeHistoryResponse[] = [];
	const errors: string[] = [];
	const bound: { handlers: DailyChallengeRendererHandlers | null } = { handlers: null };
	const renderer: DailyChallengeRenderer = {
		bind(handlers) {
			bound.handlers = handlers;
		},
		renderChallenge(challenge) {
			challenges.push(challenge);
		},
		renderAttempt() {},
		renderLeaderboard(leaderboard) {
			leaderboards.push(leaderboard);
		},
		renderHistory(history) {
			histories.push(history);
		},
		renderLocalReplay() {},
		setPending() {},
		renderError(message) {
			errors.push(message);
		},
	};
	return { renderer, challenges, leaderboards, histories, errors, bound };
}

function createPageClientHarness(): {
	created: Array<Pick<DailyChallengeClientDeps, 'userId' | 'periodKey'>>;
	commands: DailyChallengeClientCommand[];
	starts: number;
	initialized: number;
	adopted: DailyChallengeAttemptPublicStateV1[];
	createClient: (deps: DailyChallengeClientDeps) => DailyChallengeClient;
} {
	const created: Array<Pick<DailyChallengeClientDeps, 'userId' | 'periodKey'>> = [];
	const commands: DailyChallengeClientCommand[] = [];
	const adopted: DailyChallengeAttemptPublicStateV1[] = [];
	const state = { starts: 0, initialized: 0 };
	const harness = {
		created,
		commands,
		adopted,
		createClient: (() => {
			throw new Error('unused');
		}) as (deps: DailyChallengeClientDeps) => DailyChallengeClient,
		get starts(): number {
			return state.starts;
		},
		get initialized(): number {
			return state.initialized;
		},
	};
	harness.createClient = ((deps: DailyChallengeClientDeps) => {
		created.push({ userId: deps.userId, periodKey: deps.periodKey });
		return {
			async initialize() {
				state.initialized++;
			},
			adopt(attempt) {
				adopted.push(attempt);
			},
			async start() {
				state.starts++;
			},
			async command(command) {
				commands.push(command);
			},
		};
	}) as (deps: DailyChallengeClientDeps) => DailyChallengeClient;
	return harness;
}

function createPageLocalHarness(): {
	scenarios: DailyChallengeReplayScenario[];
	startRounds: number[];
	actions: DailyChallengeAction[];
	forfeits: number;
	restarts: number;
	createLocalReplayController: (
		deps: DailyChallengeLocalReplayControllerDeps,
	) => DailyChallengeLocalReplayController;
} {
	const scenarios: DailyChallengeReplayScenario[] = [];
	const startRounds: number[] = [];
	const actions: DailyChallengeAction[] = [];
	const state = { forfeits: 0, restarts: 0 };
	const harness = {
		scenarios,
		startRounds,
		actions,
		createLocalReplayController: (() => {
			throw new Error('unused');
		}) as (deps: DailyChallengeLocalReplayControllerDeps) => DailyChallengeLocalReplayController,
		get forfeits(): number {
			return state.forfeits;
		},
		get restarts(): number {
			return state.restarts;
		},
	};
	harness.createLocalReplayController = ((_deps: DailyChallengeLocalReplayControllerDeps) => ({
		async selectScenario(scenario) {
			scenarios.push(scenario);
		},
		async startRound(wager) {
			startRounds.push(wager);
		},
		async action(action) {
			actions.push(action);
		},
		async forfeit() {
			state.forfeits++;
		},
		async restart() {
			state.restarts++;
		},
	})) as (deps: DailyChallengeLocalReplayControllerDeps) => DailyChallengeLocalReplayController;
	return harness;
}

describe('daily challenge page bootstrap — initDailyChallengePage', () => {
	function challengeFixture(
		overrides: Partial<DailyChallengePublicResponse> = {},
	): DailyChallengePublicResponse {
		return {
			periodKey: PERIOD_KEY,
			challengeKind: 'blackjack-daily',
			challengeRulesetVersion: 'blackjack-daily-v1',
			gameRulesetVersion: 'blackjack-ranked-v1',
			scoreVersion: 'blackjack-daily-score-v1',
			startsAt: 1_742_000_000,
			rankedEntryClosesAt: 1_742_086_200,
			endsAt: 1_742_086_400,
			configHash: 'a'.repeat(64),
			rankedSeedCommitment: 'b'.repeat(64),
			practiceSeed: PRACTICE_SEED,
			revealedRankedSeed: null,
			attempt: null,
			...overrides,
		};
	}

	function leaderboardFixture(
		overrides: Partial<DailyChallengeLeaderboardResponse> = {},
	): DailyChallengeLeaderboardResponse {
		return {
			periodKey: PERIOD_KEY,
			entries: [
				{
					rank: 1,
					playerName: 'Alice',
					endingBankroll: 2000,
					roundsCompleted: 10,
					durationSeconds: 300,
					settledAt: 1_742_001_000,
				},
			],
			currentUser: null,
			...overrides,
		};
	}

	function historyFixture(
		overrides: Partial<DailyChallengeHistoryResponse> = {},
	): DailyChallengeHistoryResponse {
		return {
			entries: [
				{
					periodKey: PERIOD_KEY,
					challengeRulesetVersion: 'blackjack-daily-v1',
					topEndingBankroll: 1500,
					participantCount: 42,
					userResult: {
						endingBankroll: 1200,
						roundsCompleted: 10,
						terminalReason: 'completed',
						eligible: true,
						settledAt: 1_742_001_000,
					},
				},
			],
			...overrides,
		};
	}

	function currentPageFetch(url: RequestInfo | URL): Response {
		const path = String(url);
		if (path === '/api/daily-challenges/current') return jsonResponse(challengeFixture());
		if (path === `/api/daily-challenges/${PERIOD_KEY}/leaderboard`) {
			return jsonResponse(leaderboardFixture());
		}
		if (path === '/api/daily-challenges/history?limit=7') {
			return jsonResponse(historyFixture());
		}
		return jsonResponse({ error: 'CHALLENGE_NOT_FOUND' }, 404);
	}

	test('a guest fetches current, renders it, and resolves leaderboard and history by periodKey', async () => {
		const urls: string[] = [];
		const fetchImpl = mock(async (url: RequestInfo | URL) => {
			urls.push(String(url));
			return currentPageFetch(url);
		});
		const { renderer, challenges, leaderboards, histories, bound } = createPageRenderer();
		const { created, createClient } = createPageClientHarness();
		const { createLocalReplayController } = createPageLocalHarness();
		const root = { dataset: { userId: 'guest' } } as HTMLElement;

		await initDailyChallengePage(root, {
			fetch: fetchImpl,
			createRenderer: () => renderer,
			createClient,
			createLocalReplayController,
		});

		expect(challenges).toEqual([challengeFixture()]);
		expect(urls).toHaveLength(3);
		expect(urls).toContain('/api/daily-challenges/current');
		expect(urls).toContain(`/api/daily-challenges/${PERIOD_KEY}/leaderboard`);
		expect(urls).toContain('/api/daily-challenges/history?limit=7');
		expect(leaderboards).toEqual([leaderboardFixture()]);
		expect(histories).toEqual([historyFixture()]);
		expect(created).toEqual([]);
		expect(bound.handlers).not.toBeNull();
	});

	test('an authenticated visitor creates a ranked client and practice actions stay local', async () => {
		const fetchImpl = mock(async (url: RequestInfo | URL) => currentPageFetch(url));
		const { renderer, bound } = createPageRenderer();
		const clientHarness = createPageClientHarness();
		const replayHarness = createPageLocalHarness();
		const root = { dataset: { userId: USER_ID } } as HTMLElement;

		await initDailyChallengePage(root, {
			fetch: fetchImpl,
			createRenderer: () => renderer,
			createClient: clientHarness.createClient,
			createLocalReplayController: replayHarness.createLocalReplayController,
		});

		expect(clientHarness.created).toEqual([{ userId: USER_ID, periodKey: PERIOD_KEY }]);
		expect(clientHarness.initialized).toBe(1);

		const handlers = bound.handlers;
		expect(handlers).not.toBeNull();
		handlers?.onStartRound(250);
		handlers?.onAction('stand');
		handlers?.onForfeit();
		handlers?.onRestartPractice();
		handlers?.onSelectReplayScenario('practice-scenario');
		expect(replayHarness.startRounds).toEqual([250]);
		expect(replayHarness.actions).toEqual(['stand']);
		expect(replayHarness.forfeits).toBe(1);
		expect(replayHarness.restarts).toBe(1);
		expect(replayHarness.scenarios).toEqual(['practice-scenario']);
		expect(clientHarness.commands).toEqual([]);
		expect(clientHarness.starts).toBe(0);
	});

	test('an authenticated visitor with a discovered attempt adopts it without initializing', async () => {
		const attempt = activeAttempt();
		const fetchImpl = mock(async (url: RequestInfo | URL) => {
			if (String(url) === '/api/daily-challenges/current') {
				return jsonResponse(challengeFixture({ attempt }));
			}
			return currentPageFetch(url);
		});
		const { renderer } = createPageRenderer();
		const clientHarness = createPageClientHarness();
		const { createLocalReplayController } = createPageLocalHarness();
		const root = { dataset: { userId: USER_ID } } as HTMLElement;

		await initDailyChallengePage(root, {
			fetch: fetchImpl,
			createRenderer: () => renderer,
			createClient: clientHarness.createClient,
			createLocalReplayController,
		});

		expect(clientHarness.initialized).toBe(0);
		expect(clientHarness.adopted).toEqual([attempt]);
	});

	test('an authenticated visitor adopts a terminal discovered attempt without fetching resume', async () => {
		const terminal = terminalAttempt();
		const fetchImpl = mock(async (url: RequestInfo | URL) => {
			if (String(url) === '/api/daily-challenges/current') {
				return jsonResponse(challengeFixture({ attempt: terminal }));
			}
			return currentPageFetch(url);
		});
		const { renderer } = createPageRenderer();
		const clientHarness = createPageClientHarness();
		const { createLocalReplayController } = createPageLocalHarness();
		const root = { dataset: { userId: USER_ID } } as HTMLElement;

		await initDailyChallengePage(root, {
			fetch: fetchImpl,
			createRenderer: () => renderer,
			createClient: clientHarness.createClient,
			createLocalReplayController,
		});

		expect(clientHarness.initialized).toBe(0);
		expect(clientHarness.adopted).toEqual([terminal]);
	});

	test('ranked mode dispatches writes to the ranked client', async () => {
		const fetchImpl = mock(async (url: RequestInfo | URL) => currentPageFetch(url));
		const { renderer, bound } = createPageRenderer();
		const clientHarness = createPageClientHarness();
		const replayHarness = createPageLocalHarness();
		const root = { dataset: { userId: USER_ID } } as HTMLElement;

		await initDailyChallengePage(root, {
			fetch: fetchImpl,
			createRenderer: () => renderer,
			createClient: clientHarness.createClient,
			createLocalReplayController: replayHarness.createLocalReplayController,
		});

		const handlers = bound.handlers;
		handlers?.onStartRanked();
		handlers?.onSelectMode('ranked');
		handlers?.onStartRound(100);
		handlers?.onAction('double-down');
		handlers?.onForfeit();

		expect(clientHarness.starts).toBe(1);
		expect(clientHarness.commands).toEqual([
			{ command: 'start-round', wager: 100 },
			{ command: 'double-down' },
			{ command: 'forfeit' },
		]);
		expect(replayHarness.startRounds).toEqual([]);
		expect(replayHarness.actions).toEqual([]);

		handlers?.onSelectMode('practice');
		handlers?.onStartRound(50);
		expect(replayHarness.startRounds).toEqual([50]);
	});

	test('a failing current fetch surfaces an error and never fetches side data', async () => {
		const fetchImpl = mock(async () => jsonResponse({ error: 'INTERNAL_ERROR' }, 500));
		const { renderer, errors } = createPageRenderer();
		const { created, createClient } = createPageClientHarness();
		const { createLocalReplayController } = createPageLocalHarness();
		const root = { dataset: { userId: USER_ID } } as HTMLElement;

		await initDailyChallengePage(root, {
			fetch: fetchImpl,
			createRenderer: () => renderer,
			createClient,
			createLocalReplayController,
		});

		expect(errors).toHaveLength(1);
		expect(created).toEqual([]);
	});

	test('createBrowserRequestId uses crypto.randomUUID when createRequestId is not provided', async () => {
		const fetchImpl = mock(async (url: RequestInfo | URL) => currentPageFetch(url));
		const { renderer } = createPageRenderer();
		const { createLocalReplayController } = createPageLocalHarness();
		const root = { dataset: { userId: USER_ID } } as HTMLElement;
		let capturedCreateRequestId: (() => string) | null = null;
		const createClient = (deps: DailyChallengeClientDeps): DailyChallengeClient => {
			capturedCreateRequestId = deps.createRequestId;
			return {
				async initialize() {},
				adopt() {},
				async start() {},
				async command() {},
			};
		};

		await initDailyChallengePage(root, {
			fetch: fetchImpl,
			createRenderer: () => renderer,
			createClient,
			createLocalReplayController,
		});

		expect(capturedCreateRequestId).not.toBeNull();
		const id = capturedCreateRequestId!();
		expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
	});

	test('createBrowserRequestId falls back to a random string when crypto.randomUUID is unavailable', async () => {
		const fetchImpl = mock(async (url: RequestInfo | URL) => currentPageFetch(url));
		const { renderer } = createPageRenderer();
		const { createLocalReplayController } = createPageLocalHarness();
		const root = { dataset: { userId: USER_ID } } as HTMLElement;
		let capturedCreateRequestId: (() => string) | null = null;
		const createClient = (deps: DailyChallengeClientDeps): DailyChallengeClient => {
			capturedCreateRequestId = deps.createRequestId;
			return {
				async initialize() {},
				adopt() {},
				async start() {},
				async command() {},
			};
		};

		const originalCryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
		Object.defineProperty(globalThis, 'crypto', {
			value: {},
			configurable: true,
			writable: true,
		});
		try {
			await initDailyChallengePage(root, {
				fetch: fetchImpl,
				createRenderer: () => renderer,
				createClient,
				createLocalReplayController,
			});

			expect(capturedCreateRequestId).not.toBeNull();
			const id = capturedCreateRequestId!();
			expect(id).toMatch(/^dc-/);
		} finally {
			if (originalCryptoDescriptor) {
				Object.defineProperty(globalThis, 'crypto', originalCryptoDescriptor);
			}
		}
	});
});

describe('daily challenge page bootstrap — initDailyChallengeHistoryPage', () => {
	function challengeFixture(
		overrides: Partial<DailyChallengePublicResponse> = {},
	): DailyChallengePublicResponse {
		return {
			periodKey: PERIOD_KEY,
			challengeKind: 'blackjack-daily',
			challengeRulesetVersion: 'blackjack-daily-v1',
			gameRulesetVersion: 'blackjack-ranked-v1',
			scoreVersion: 'blackjack-daily-score-v1',
			startsAt: 1_742_000_000,
			rankedEntryClosesAt: 1_742_086_200,
			endsAt: 1_742_086_400,
			configHash: 'a'.repeat(64),
			rankedSeedCommitment: 'b'.repeat(64),
			practiceSeed: PRACTICE_SEED,
			revealedRankedSeed: null,
			attempt: null,
			...overrides,
		};
	}

	function historyPageFetch(url: RequestInfo | URL): Response {
		const path = String(url);
		if (path === `/api/daily-challenges/${PERIOD_KEY}`) {
			return jsonResponse(challengeFixture({ revealedRankedSeed: RANKED_SEED }));
		}
		if (path === `/api/daily-challenges/${PERIOD_KEY}/leaderboard`) {
			return jsonResponse({
				periodKey: PERIOD_KEY,
				entries: [
					{
						rank: 1,
						playerName: 'Alice',
						endingBankroll: 2000,
						roundsCompleted: 10,
						durationSeconds: 300,
						settledAt: 1_742_001_000,
					},
				],
				currentUser: null,
			});
		}
		return jsonResponse({ error: 'CHALLENGE_NOT_FOUND' }, 404);
	}

	test('fetches the closed detail and renders challenge, metadata, and leaderboard', async () => {
		const urls: string[] = [];
		const fetchImpl = mock(async (url: RequestInfo | URL) => {
			urls.push(String(url));
			return historyPageFetch(url);
		});
		const { renderer, challenges, leaderboards, bound } = createPageRenderer();
		const { startRounds, createLocalReplayController } = createPageLocalHarness();
		const root = {
			dataset: { periodKey: PERIOD_KEY },
			querySelector: () => null,
		} as unknown as HTMLElement;

		await initDailyChallengeHistoryPage(root, {
			fetch: fetchImpl,
			createRenderer: () => renderer,
			createLocalReplayController,
		});

		expect(urls).toEqual([
			`/api/daily-challenges/${PERIOD_KEY}`,
			`/api/daily-challenges/${PERIOD_KEY}/leaderboard`,
		]);
		expect(challenges).toEqual([challengeFixture({ revealedRankedSeed: RANKED_SEED })]);
		expect(leaderboards).toHaveLength(1);

		const handlers = bound.handlers;
		expect(handlers).not.toBeNull();
		handlers?.onStartRanked();
		handlers?.onStartRound(100);
		expect(startRounds).toEqual([100]);
	});

	test('a missing period key never fetches anything', async () => {
		const fetchImpl = mock(async (url: RequestInfo | URL) => historyPageFetch(url));
		const { renderer } = createPageRenderer();
		const { createLocalReplayController } = createPageLocalHarness();
		const root = { dataset: { userId: 'guest' } } as HTMLElement;

		await initDailyChallengeHistoryPage(root, {
			fetch: fetchImpl,
			createRenderer: () => renderer,
			createLocalReplayController,
		});

		expect(fetchImpl).toHaveBeenCalledTimes(0);
	});

	test('a live un-revealed detail renders reveal metadata through the real renderer metadata query', async () => {
		const fetchImpl = mock(async (url: RequestInfo | URL) => {
			const path = String(url);
			if (path === `/api/daily-challenges/${PERIOD_KEY}`) {
				return jsonResponse(challengeFixture({ revealedRankedSeed: null }));
			}
			if (path === `/api/daily-challenges/${PERIOD_KEY}/leaderboard`) {
				return jsonResponse({ periodKey: PERIOD_KEY, entries: [], currentUser: null });
			}
			return jsonResponse({ error: 'CHALLENGE_NOT_FOUND' }, 404);
		});
		const revealStatus: string[] = [];
		const commitment: string[] = [];
		const { renderer, challenges } = createPageRenderer();
		const { createLocalReplayController } = createPageLocalHarness();
		const root = {
			dataset: { periodKey: PERIOD_KEY },
			querySelector(selector: string): HTMLElement | null {
				if (selector === '[data-testid="daily-challenge-reveal-status"]') {
					return {
						set textContent(value: string) {
							revealStatus.push(value);
						},
					} as HTMLElement;
				}
				if (selector === '[data-testid="daily-challenge-commitment"]') {
					return {
						set textContent(value: string) {
							commitment.push(value);
						},
					} as HTMLElement;
				}
				return null;
			},
		} as unknown as HTMLElement;

		await initDailyChallengeHistoryPage(root, {
			fetch: fetchImpl,
			createRenderer: () => renderer,
			createLocalReplayController,
		});

		expect(challenges).toHaveLength(1);
		expect(revealStatus).toEqual(['Ranked seed not yet revealed']);
		expect(commitment).toEqual(['b'.repeat(64)]);
	});

	test('a failing challenge detail fetch surfaces an error and skips the leaderboard', async () => {
		const fetchImpl = mock(async () => jsonResponse({ error: 'CHALLENGE_NOT_FOUND' }, 404));
		const { renderer, errors, leaderboards } = createPageRenderer();
		const { createLocalReplayController } = createPageLocalHarness();
		const root = {
			dataset: { periodKey: PERIOD_KEY },
			querySelector: () => null,
		} as unknown as HTMLElement;

		await initDailyChallengeHistoryPage(root, {
			fetch: fetchImpl,
			createRenderer: () => renderer,
			createLocalReplayController,
		});

		expect(errors).toHaveLength(1);
		expect(leaderboards).toHaveLength(0);
	});

	test('bound handlers dispatch start-round, action, forfeit, and restart to the replay controller', async () => {
		const fetchImpl = mock(async (url: RequestInfo | URL) => historyPageFetch(url));
		const { renderer, bound } = createPageRenderer();
		const replayHarness = createPageLocalHarness();
		const root = {
			dataset: { periodKey: PERIOD_KEY },
			querySelector: () => null,
		} as unknown as HTMLElement;

		await initDailyChallengeHistoryPage(root, {
			fetch: fetchImpl,
			createRenderer: () => renderer,
			createLocalReplayController: replayHarness.createLocalReplayController,
		});

		const handlers = bound.handlers;
		expect(handlers).not.toBeNull();
		handlers?.onStartRound(100);
		handlers?.onAction('hit');
		handlers?.onForfeit();
		handlers?.onRestartPractice();
		handlers?.onSelectReplayScenario('practice-scenario');
		expect(replayHarness.startRounds).toEqual([100]);
		expect(replayHarness.actions).toEqual(['hit']);
		expect(replayHarness.forfeits).toBe(1);
		expect(replayHarness.restarts).toBe(1);
		expect(replayHarness.scenarios).toEqual(['practice-scenario']);
	});
});
