import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { BlackjackRunClient, BlackjackRunClientCommand } from './client';
import { DAILY_RUN_CONFIG, replayDailyRun } from './daily';
import type { BlackjackAction, BlackjackRunPublicState } from './protocol';
import {
	createDailyRunRenderer,
	initDailyChallengePage,
	type DailyLeaderboardView,
	type DailyRunRenderer,
	type DailyRunState,
} from './daily-ui';

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
const originalFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
const happyWindow = new Window();

beforeAll(() => {
	Object.defineProperty(globalThis, 'window', {
		configurable: true,
		writable: true,
		value: happyWindow,
	});
	Object.defineProperty(globalThis, 'document', {
		configurable: true,
		writable: true,
		value: happyWindow.document,
	});
});

afterAll(() => {
	happyWindow.close();
	if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
	else Reflect.deleteProperty(globalThis, 'window');
	if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
	else Reflect.deleteProperty(globalThis, 'document');
});

const PERIOD_KEY = '2026-08-13';
const RUN_ID = 'abcdefghijklmnopqrstuv';
const SEED_A = new Uint8Array(32).fill(0x11);
const SEED_B = new Uint8Array(32).fill(0x22);

const CURRENCY = new Intl.NumberFormat('en-US', {
	style: 'currency',
	currency: 'USD',
	minimumFractionDigits: 0,
	maximumFractionDigits: 0,
});

function formatCurrency(value: number): string {
	return CURRENCY.format(value);
}

function roundLabel(roundsCompleted: number): string {
	const roundCount = DAILY_RUN_CONFIG.roundCount;
	return `Round ${Math.min(roundsCompleted + 1, roundCount)} of ${roundCount}`;
}

// --- state fixtures ---

function activeRoundFixture(
	availableActions: readonly BlackjackAction[] = ['hit', 'stand'],
): NonNullable<DailyRunState['activeRound']> {
	return {
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
		availableActions: [...availableActions],
		outcome: null,
	};
}

function dailyState(overrides: Partial<DailyRunState> = {}): DailyRunState {
	return {
		mode: 'daily',
		runId: RUN_ID,
		status: 'active',
		terminalReason: null,
		eligible: null,
		expiresAt: 1_800_000_900,
		nextCommandSequence: 0,
		availableBankroll: 1000,
		roundsCompleted: 0,
		activeRound: null,
		rank: null,
		percentile: null,
		...overrides,
	};
}

const LEADERBOARD_PAYLOAD = {
	entries: [
		{
			rank: 1,
			userId: 'user-1',
			playerName: 'Alice',
			dailyEndingBankroll: 1200,
			dailyRoundsCompleted: 10,
			settledAt: 1_785_628_800,
		},
		{
			rank: 2,
			userId: 'user-2',
			playerName: 'Bob',
			dailyEndingBankroll: 980,
			dailyRoundsCompleted: 10,
			settledAt: 1_785_628_900,
		},
	],
	currentUser: null as { rank: number; totalEligible: number; percentile: number } | null,
};

const EMPTY_LEADERBOARD: DailyLeaderboardView = { entries: [], currentUser: null };

// --- DOM fixtures ---

function makeRoot(authenticated: boolean): HTMLElement {
	const root = document.createElement('main');
	root.id = 'daily-challenge-root';
	root.dataset.periodKey = PERIOD_KEY;
	root.dataset.userId = authenticated ? 'u_testuser' : 'guest';
	root.innerHTML = `
		<span data-testid="daily-challenge-close"></span>
		<button data-testid="daily-challenge-mode-practice">Practice</button>
		<button data-testid="daily-challenge-mode-ranked">Ranked</button>
		<a data-testid="daily-challenge-sign-in-cta" hidden>Sign in to play Ranked</a>
		<div data-testid="daily-challenge-practice-notices" hidden></div>
		<div data-testid="daily-challenge-ranked-notices" hidden></div>
		<section data-testid="daily-challenge-controls" hidden>
			<span data-testid="daily-challenge-bankroll">—</span>
			<span data-testid="daily-challenge-committed-wager">—</span>
			<span data-testid="daily-challenge-round-progress">—</span>
			<div data-testid="daily-challenge-dealer-hand"></div>
			<span data-testid="daily-challenge-dealer-value">?</span>
			<div data-testid="daily-challenge-player-hands"></div>
			<p data-testid="daily-challenge-status"></p>
			<input data-testid="daily-challenge-wager" type="number" value="100">
			<button data-testid="daily-challenge-start-ranked">Start Ranked</button>
			<button data-testid="daily-challenge-start-round">Start Round</button>
			<button data-testid="daily-challenge-action-hit">Hit</button>
			<button data-testid="daily-challenge-action-stand">Stand</button>
			<button data-testid="daily-challenge-action-double-down">Double Down</button>
			<button data-testid="daily-challenge-action-split">Split</button>
			<button data-testid="daily-challenge-forfeit">Forfeit</button>
			<button data-testid="daily-challenge-forfeit-confirm" hidden>Confirm Forfeit</button>
			<button data-testid="daily-challenge-forfeit-cancel" hidden>Cancel</button>
			<button data-testid="daily-challenge-restart-practice">Restart Practice</button>
			<section data-testid="daily-challenge-receipt" hidden>
				<span data-testid="daily-challenge-receipt-eligibility"></span>
				<span data-testid="daily-challenge-receipt-bankroll"></span>
				<span data-testid="daily-challenge-receipt-rounds"></span>
				<span data-testid="daily-challenge-rank"></span>
				<span data-testid="daily-challenge-percentile"></span>
			</section>
		</section>
		<p data-testid="daily-challenge-current-standing" hidden></p>
		<ol data-testid="daily-challenge-leaderboard-rows"></ol>
	`;
	document.body.appendChild(root);
	return root;
}

function get(root: HTMLElement, testId: string): HTMLElement {
	const element = root.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
	if (!element) throw new Error(`missing element ${testId}`);
	return element;
}

function button(root: HTMLElement, testId: string): HTMLButtonElement {
	return get(root, testId) as HTMLButtonElement;
}

const flush = async (): Promise<void> => {
	await new Promise((resolve) => setTimeout(resolve, 0));
};

// --- fetch fixture ---

interface FetchLog {
	url: string;
	method: string;
}

let fetchLog: FetchLog[];

function installFetch(leaderboardPayload: unknown = LEADERBOARD_PAYLOAD): void {
	fetchLog = [];
	const fetchImpl = mock((input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
		fetchLog.push({ url, method: init?.method ?? 'GET' });
		if (url === '/api/blackjack-daily/current') {
			return Promise.resolve(
				new Response(JSON.stringify({ error: 'RUN_NOT_FOUND' }), {
					status: 404,
					headers: { 'content-type': 'application/json' },
				}),
			);
		}
		if (url.endsWith('/leaderboard')) {
			return Promise.resolve(
				new Response(JSON.stringify(leaderboardPayload), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				}),
			);
		}
		return Promise.resolve(
			new Response(JSON.stringify({ error: 'RUN_NOT_FOUND' }), {
				status: 404,
				headers: { 'content-type': 'application/json' },
			}),
		);
	});
	globalThis.fetch = fetchImpl as typeof fetch;
}

beforeEach(() => {
	installFetch();
});

afterEach(() => {
	if (originalFetch) Object.defineProperty(globalThis, 'fetch', originalFetch);
	else Reflect.deleteProperty(globalThis, 'fetch');
	for (const element of Array.from(document.body.children)) {
		element.remove();
	}
	happyWindow.localStorage.clear();
});

// --- client fixture ---

interface MockClientCalls {
	loadCurrent: Array<'ranked' | 'daily'>;
	startDaily: string[];
	command: Array<[string, BlackjackRunClientCommand]>;
}

function createMockClient(
	options: {
		loadCurrent?: BlackjackRunPublicState | null;
		/** Sequential responses for startDaily and command, in call order. */
		states?: DailyRunState[];
	} = {},
): BlackjackRunClient & { calls: MockClientCalls } {
	const calls: MockClientCalls = { loadCurrent: [], startDaily: [], command: [] };
	const queue = [...(options.states ?? [])];
	const next = (): DailyRunState => queue.shift() ?? dailyState();
	return {
		calls,
		loadCurrent: mock((mode: 'ranked' | 'daily') => {
			calls.loadCurrent.push(mode);
			return Promise.resolve((options.loadCurrent ?? null) as BlackjackRunPublicState | null);
		}),
		loadRun: mock(() => Promise.resolve(dailyState() as BlackjackRunPublicState)),
		startRanked: mock(() => Promise.resolve(dailyState() as BlackjackRunPublicState)),
		startDaily: mock((periodKey: string) => {
			calls.startDaily.push(periodKey);
			return Promise.resolve(next());
		}),
		command: mock((runId: string, command: BlackjackRunClientCommand) => {
			calls.command.push([runId, command]);
			return Promise.resolve(next());
		}),
	};
}

/** createSeed stub vending SEED_A then SEED_B then alternating. */
function createSeedQueue(spy: { count: number }): () => Uint8Array {
	return () => {
		const seed = spy.count % 2 === 0 ? SEED_A : SEED_B;
		spy.count += 1;
		return seed;
	};
}

const postedRequests = (): FetchLog[] => fetchLog.filter((entry) => entry.method === 'POST');

describe('daily page — guest bootstrap and local practice', () => {
	test('renders practice with the sign-in CTA from the 404 guest current surface', async () => {
		const root = makeRoot(false);
		const seedSpy = { count: 0 };

		await initDailyChallengePage(root, { createSeed: createSeedQueue(seedSpy) });

		expect(get(root, 'daily-challenge-sign-in-cta').hidden).toBe(false);
		expect(get(root, 'daily-challenge-mode-practice').hidden).toBe(false);
		expect(get(root, 'daily-challenge-mode-ranked').hidden).toBe(true);
		expect(get(root, 'daily-challenge-start-ranked').hidden).toBe(true);
		expect(get(root, 'daily-challenge-practice-notices').hidden).toBe(false);
		expect(get(root, 'daily-challenge-ranked-notices').hidden).toBe(true);
		expect(get(root, 'daily-challenge-controls').hidden).toBe(false);

		// Local practice starts immediately at the configured bankroll.
		expect(get(root, 'daily-challenge-bankroll').textContent).toBe(
			formatCurrency(DAILY_RUN_CONFIG.startingBankroll),
		);
		expect(get(root, 'daily-challenge-committed-wager').textContent).toBe('\u2014');
		expect(get(root, 'daily-challenge-round-progress').textContent).toBe(roundLabel(0));

		// The Task 5 guest surface was actually queried.
		expect(
			fetchLog.some(
				(entry) => entry.url === '/api/blackjack-daily/current' && entry.method === 'GET',
			),
		).toBe(true);
		// Leaderboard rows render for guests.
		const rows = root.querySelectorAll('[data-testid="daily-challenge-leaderboard-row"]');
		expect(rows).toHaveLength(2);
		expect(rows[0]?.textContent).toBe(`#1 Alice ${formatCurrency(1200)}`);
		expect(rows[1]?.textContent).toBe(`#2 Bob ${formatCurrency(980)}`);
		expect(get(root, 'daily-challenge-current-standing').hidden).toBe(true);
	});

	test('practice plays entirely locally: no run POSTs, no legacy endpoints, no localStorage', async () => {
		const root = makeRoot(false);
		const seedSpy = { count: 0 };
		await initDailyChallengePage(root, { createSeed: createSeedQueue(seedSpy) });

		(get(root, 'daily-challenge-wager') as HTMLInputElement).value = '10';
		button(root, 'daily-challenge-start-round').click();
		await flush();

		const afterStart = replayDailyRun(SEED_A, [{ sequence: 0, command: 'start-round', wager: 10 }]);
		expect(get(root, 'daily-challenge-bankroll').textContent).toBe(
			formatCurrency(afterStart.availableBankroll),
		);
		expect(get(root, 'daily-challenge-committed-wager').textContent).toBe(
			afterStart.activeRoundPublic
				? formatCurrency(afterStart.activeRoundPublic.committedWager)
				: '\u2014',
		);
		expect(button(root, 'daily-challenge-action-stand').disabled).toBe(
			!afterStart.activeRoundPublic?.availableActions.includes('stand'),
		);

		if (afterStart.activeRoundPublic?.availableActions.includes('stand')) {
			button(root, 'daily-challenge-action-stand').click();
			await flush();
			const afterStand = replayDailyRun(SEED_A, [
				{ sequence: 0, command: 'start-round', wager: 10 },
				{ sequence: 1, command: 'stand' },
			]);
			expect(get(root, 'daily-challenge-bankroll').textContent).toBe(
				formatCurrency(afterStand.availableBankroll),
			);
			expect(get(root, 'daily-challenge-round-progress').textContent).toBe(
				roundLabel(afterStand.roundsCompleted),
			);
		}

		expect(postedRequests()).toHaveLength(0);
		expect(fetchLog.some((entry) => entry.url.includes('/api/daily-challenges'))).toBe(false);
		expect(happyWindow.localStorage.length).toBe(0);
	});

	test('restart practice regenerates a fresh browser seed and clears local commands', async () => {
		const root = makeRoot(false);
		const seedSpy = { count: 0 };
		await initDailyChallengePage(root, { createSeed: createSeedQueue(seedSpy) });

		(get(root, 'daily-challenge-wager') as HTMLInputElement).value = '10';
		button(root, 'daily-challenge-start-round').click();
		await flush();
		expect(button(root, 'daily-challenge-restart-practice').disabled).toBe(false);

		button(root, 'daily-challenge-restart-practice').click();
		await flush();

		expect(seedSpy.count).toBe(2);
		expect(get(root, 'daily-challenge-bankroll').textContent).toBe(
			formatCurrency(DAILY_RUN_CONFIG.startingBankroll),
		);
		expect(get(root, 'daily-challenge-round-progress').textContent).toBe(roundLabel(0));
		expect(get(root, 'daily-challenge-committed-wager').textContent).toBe('\u2014');

		// The restarted scenario is driven by the NEW seed (SEED_B).
		(get(root, 'daily-challenge-wager') as HTMLInputElement).value = '10';
		button(root, 'daily-challenge-start-round').click();
		await flush();
		const fromSeedB = replayDailyRun(SEED_B, [{ sequence: 0, command: 'start-round', wager: 10 }]);
		const fromSeedA = replayDailyRun(SEED_A, [{ sequence: 0, command: 'start-round', wager: 10 }]);
		expect(get(root, 'daily-challenge-bankroll').textContent).toBe(
			formatCurrency(fromSeedB.availableBankroll),
		);
		// Guard the guard: with these fixtures the two seeds must deal
		// different scenarios, otherwise this test proves nothing.
		expect(JSON.stringify(fromSeedB.activeRoundPublic?.dealer.cards)).not.toBe(
			JSON.stringify(fromSeedA.activeRoundPublic?.dealer.cards),
		);
		const dealerCards = root.querySelectorAll('[data-testid="daily-challenge-dealer-card"]');
		expect(dealerCards).toHaveLength(fromSeedB.activeRoundPublic?.dealer.cards.length ?? 0);
		expect(postedRequests()).toHaveLength(0);
	});

	test('surfaces an error when the guest current endpoint fails unexpectedly', async () => {
		const root = makeRoot(false);
		globalThis.fetch = mock(() =>
			Promise.resolve(new Response(JSON.stringify({ error: 'INTERNAL_ERROR' }), { status: 500 })),
		) as typeof fetch;

		await initDailyChallengePage(root, { createSeed: createSeedQueue({ count: 0 }) });

		expect(get(root, 'daily-challenge-status').textContent).toContain('internal error');
		// Practice remains playable offline.
		expect(get(root, 'daily-challenge-bankroll').textContent).toBe(
			formatCurrency(DAILY_RUN_CONFIG.startingBankroll),
		);
	});

	test('rejects a root without a valid period key', async () => {
		const root = makeRoot(false);
		delete root.dataset.periodKey;
		await expect(initDailyChallengePage(root)).rejects.toThrow(TypeError);
		root.dataset.periodKey = 'not-a-date';
		await expect(initDailyChallengePage(root)).rejects.toThrow(TypeError);
	});
});

describe('daily page — authenticated ranked flow', () => {
	test('loads the current attempt through the run client and routes commands to it', async () => {
		const root = makeRoot(true);
		const client = createMockClient({
			loadCurrent: dailyState({
				status: 'active',
				availableBankroll: 900,
				roundsCompleted: 1,
				nextCommandSequence: 2,
				activeRound: activeRoundFixture(),
			}),
		});

		await initDailyChallengePage(root, { client });

		expect(client.calls.loadCurrent).toEqual(['daily']);
		// An existing attempt auto-switches the page into ranked mode.
		expect(get(root, 'daily-challenge-ranked-notices').hidden).toBe(false);
		expect(get(root, 'daily-challenge-start-ranked').hidden).toBe(true);
		expect(get(root, 'daily-challenge-bankroll').textContent).toBe(formatCurrency(900));
		expect(get(root, 'daily-challenge-committed-wager').textContent).toBe(formatCurrency(100));
		expect(get(root, 'daily-challenge-round-progress').textContent).toBe(roundLabel(1));
		expect(button(root, 'daily-challenge-action-stand').disabled).toBe(false);
		expect(button(root, 'daily-challenge-action-hit').disabled).toBe(false);
		expect(button(root, 'daily-challenge-action-split').disabled).toBe(true);

		button(root, 'daily-challenge-action-stand').click();
		await flush();

		expect(client.calls.command).toEqual([[RUN_ID, { command: 'stand' }]]);
		expect(postedRequests()).toHaveLength(0);
	});

	test('start, start-round, and stand drive the run client to a ranked terminal receipt', async () => {
		const root = makeRoot(true);
		const client = createMockClient({
			loadCurrent: null,
			states: [
				dailyState(), // startDaily response
				dailyState({
					availableBankroll: 900,
					roundsCompleted: 0,
					nextCommandSequence: 1,
					activeRound: activeRoundFixture(),
				}), // start-round response
				dailyState({
					status: 'completed',
					terminalReason: 'completed',
					eligible: true,
					availableBankroll: 1150,
					roundsCompleted: 10,
					nextCommandSequence: 21,
					activeRound: null,
					rank: 1,
					percentile: 100,
				}), // stand response
			],
		});

		await initDailyChallengePage(root, { client });

		// Idle ranked surface for a signed-in user without an attempt.
		button(root, 'daily-challenge-mode-ranked').click();
		expect(get(root, 'daily-challenge-sign-in-cta').hidden).toBe(true);
		expect(button(root, 'daily-challenge-start-ranked').disabled).toBe(false);
		expect(get(root, 'daily-challenge-status').textContent).toBe(
			'Start your ranked attempt to begin.',
		);

		button(root, 'daily-challenge-start-ranked').click();
		await flush();
		expect(client.calls.startDaily).toEqual([PERIOD_KEY]);
		expect(get(root, 'daily-challenge-start-ranked').hidden).toBe(true);

		button(root, 'daily-challenge-start-round').click();
		await flush();
		expect(client.calls.command).toEqual([[RUN_ID, { command: 'start-round', wager: 100 }]]);
		expect(get(root, 'daily-challenge-committed-wager').textContent).toBe(formatCurrency(100));

		button(root, 'daily-challenge-action-stand').click();
		await flush();
		expect(client.calls.command).toEqual([
			[RUN_ID, { command: 'start-round', wager: 100 }],
			[RUN_ID, { command: 'stand' }],
		]);

		const receipt = get(root, 'daily-challenge-receipt');
		expect(receipt.hidden).toBe(false);
		expect(get(root, 'daily-challenge-receipt-eligibility').textContent).toBe(
			'Eligible for ranking',
		);
		expect(get(root, 'daily-challenge-receipt-bankroll').textContent).toBe(formatCurrency(1150));
		expect(get(root, 'daily-challenge-receipt-rounds').textContent).toBe(
			`${DAILY_RUN_CONFIG.roundCount} of ${DAILY_RUN_CONFIG.roundCount} rounds`,
		);
		expect(get(root, 'daily-challenge-rank').hidden).toBe(false);
		expect(get(root, 'daily-challenge-rank').textContent).toBe('#1');
		expect(get(root, 'daily-challenge-percentile').hidden).toBe(false);
		expect(get(root, 'daily-challenge-percentile').textContent).toBe('100th percentile');

		// A terminal attempt cannot restart the same period.
		expect(button(root, 'daily-challenge-start-ranked').hidden).toBe(false);
		expect(button(root, 'daily-challenge-start-ranked').disabled).toBe(true);
		button(root, 'daily-challenge-start-ranked').click();
		await flush();
		expect(client.calls.startDaily).toHaveLength(1);
	});

	test('forfeit routes through the client after confirmation and renders ineligible', async () => {
		const root = makeRoot(true);
		const client = createMockClient({
			loadCurrent: null,
			states: [
				dailyState(),
				dailyState({
					availableBankroll: 900,
					nextCommandSequence: 1,
					activeRound: activeRoundFixture(),
				}),
				dailyState({
					status: 'forfeited',
					terminalReason: 'forfeited',
					eligible: false,
					availableBankroll: 900,
					roundsCompleted: 0,
					nextCommandSequence: 2,
					activeRound: null,
					rank: null,
					percentile: null,
				}),
			],
		});

		await initDailyChallengePage(root, { client });
		button(root, 'daily-challenge-mode-ranked').click();
		button(root, 'daily-challenge-start-ranked').click();
		await flush();
		button(root, 'daily-challenge-start-round').click();
		await flush();

		button(root, 'daily-challenge-forfeit').click();
		expect(get(root, 'daily-challenge-forfeit-confirm').hidden).toBe(false);
		expect(get(root, 'daily-challenge-forfeit-cancel').hidden).toBe(false);

		button(root, 'daily-challenge-forfeit-cancel').click();
		expect(get(root, 'daily-challenge-forfeit-confirm').hidden).toBe(true);
		expect(client.calls.command).toHaveLength(1);

		button(root, 'daily-challenge-forfeit').click();
		button(root, 'daily-challenge-forfeit-confirm').click();
		await flush();

		expect(client.calls.command).toEqual([
			[RUN_ID, { command: 'start-round', wager: 100 }],
			[RUN_ID, { command: 'forfeit' }],
		]);
		expect(get(root, 'daily-challenge-receipt').hidden).toBe(false);
		expect(get(root, 'daily-challenge-receipt-eligibility').textContent).toBe(
			'Not eligible for ranking',
		);
		expect(get(root, 'daily-challenge-rank').hidden).toBe(true);
		expect(get(root, 'daily-challenge-percentile').hidden).toBe(true);
		expect(button(root, 'daily-challenge-start-ranked').disabled).toBe(true);
	});

	test('practice stays local while a ranked attempt exists and mode switches re-render each view', async () => {
		const root = makeRoot(true);
		const client = createMockClient({
			loadCurrent: dailyState({
				status: 'active',
				availableBankroll: 750,
				roundsCompleted: 2,
				nextCommandSequence: 3,
				activeRound: activeRoundFixture(),
			}),
		});
		const seedSpy = { count: 0 };

		await initDailyChallengePage(root, { client, createSeed: createSeedQueue(seedSpy) });
		expect(get(root, 'daily-challenge-bankroll').textContent).toBe(formatCurrency(750));

		// Switch to practice: the local scenario renders, stays at bankroll 1000.
		button(root, 'daily-challenge-mode-practice').click();
		expect(get(root, 'daily-challenge-practice-notices').hidden).toBe(false);
		expect(get(root, 'daily-challenge-bankroll').textContent).toBe(
			formatCurrency(DAILY_RUN_CONFIG.startingBankroll),
		);

		// A practice round never touches the run client.
		(get(root, 'daily-challenge-wager') as HTMLInputElement).value = '10';
		button(root, 'daily-challenge-start-round').click();
		await flush();
		expect(client.calls.command).toHaveLength(0);
		expect(get(root, 'daily-challenge-bankroll').textContent).toBe(
			formatCurrency(
				replayDailyRun(SEED_A, [{ sequence: 0, command: 'start-round', wager: 10 }])
					.availableBankroll,
			),
		);

		// Switch back: the ranked attempt re-renders.
		button(root, 'daily-challenge-mode-ranked').click();
		expect(get(root, 'daily-challenge-bankroll').textContent).toBe(formatCurrency(750));
		expect(get(root, 'daily-challenge-committed-wager').textContent).toBe(formatCurrency(100));
	});

	test('renders the current-user standing with rank, totalEligible, and percentile', async () => {
		installFetch({
			entries: LEADERBOARD_PAYLOAD.entries,
			currentUser: { rank: 2, totalEligible: 3, percentile: 67 },
		});
		const root = makeRoot(true);
		const client = createMockClient({ loadCurrent: null });

		await initDailyChallengePage(root, { client });

		const standing = get(root, 'daily-challenge-current-standing');
		expect(standing.hidden).toBe(false);
		expect(standing.textContent).toBe('#2 · 67% · 3 eligible');
	});

	test('practice terminal states render a status and leave the ranked receipt hidden', async () => {
		const root = makeRoot(false);
		await initDailyChallengePage(root, { createSeed: createSeedQueue({ count: 0 }) });

		button(root, 'daily-challenge-forfeit').click();
		button(root, 'daily-challenge-forfeit-confirm').click();
		await flush();

		expect(get(root, 'daily-challenge-status').textContent).toBe('Practice forfeited.');
		expect(get(root, 'daily-challenge-receipt').hidden).toBe(true);
		// The forfeited local scenario must restart before playing again.
		(get(root, 'daily-challenge-wager') as HTMLInputElement).value = '10';
		button(root, 'daily-challenge-start-round').click();
		await flush();
		expect(get(root, 'daily-challenge-status').textContent).toContain('restart');
	});
});

describe('daily run renderer — direct DOM behavior', () => {
	let root: HTMLElement;
	let renderer: DailyRunRenderer;

	beforeEach(() => {
		root = makeRoot(true);
		renderer = createDailyRunRenderer(root);
	});

	test('disables every control while pending', () => {
		renderer.renderRanked(
			dailyState({
				activeRound: activeRoundFixture(['hit', 'stand']),
			}),
		);

		renderer.setPending(true);
		// Every game control locks while a run request is in flight; the mode
		// switch stays usable (matching the legacy daily UI).
		const controlIds = [
			'daily-challenge-start-ranked',
			'daily-challenge-start-round',
			'daily-challenge-action-hit',
			'daily-challenge-action-stand',
			'daily-challenge-action-double-down',
			'daily-challenge-action-split',
			'daily-challenge-forfeit',
			'daily-challenge-restart-practice',
		];
		for (const testId of controlIds) {
			expect(button(root, testId).disabled, testId).toBe(true);
		}
		expect((get(root, 'daily-challenge-wager') as HTMLInputElement).disabled).toBe(true);
		expect(root.dataset.pending).toBe('true');

		renderer.setPending(false);
		expect(button(root, 'daily-challenge-action-stand').disabled).toBe(false);
	});

	test('rejects out-of-range wagers without notifying handlers', () => {
		const seen: number[] = [];
		renderer.bind({
			onSelectMode: () => {},
			onStartRanked: () => {},
			onStartRound: (wager) => seen.push(wager),
			onAction: () => {},
			onForfeit: () => {},
			onRestartPractice: () => {},
		});

		(get(root, 'daily-challenge-wager') as HTMLInputElement).value = '5';
		button(root, 'daily-challenge-start-round').click();
		(get(root, 'daily-challenge-wager') as HTMLInputElement).value = '1001';
		button(root, 'daily-challenge-start-round').click();
		expect(seen).toHaveLength(0);
		expect(get(root, 'daily-challenge-status').textContent).toContain(
			'whole number between 10 and 1,000',
		);

		(get(root, 'daily-challenge-wager') as HTMLInputElement).value = '10';
		button(root, 'daily-challenge-start-round').click();
		expect(seen).toEqual([10]);
	});

	test('renders only the public dealer projection with no hole-card DOM', () => {
		renderer.renderPractice(
			replayDailyRun(SEED_A, [{ sequence: 0, command: 'start-round', wager: 10 }]),
		);
		const dealerCards = root.querySelectorAll('[data-testid="daily-challenge-dealer-card"]');
		expect(dealerCards.length).toBeLessThanOrEqual(1);
		expect(root.querySelector('[aria-label*="face down" i]')).toBeNull();
	});
});
