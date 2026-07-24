// src/lib/keno/kenoClient.test.ts
//
// Spec: docs/superpowers/specs/2026-07-21-keno-design.md §Testing — kenoClient.test.ts
// Covers the outbox drain loop end-to-end via initKenoClient with mocked fetch,
// DOM events, and instant timers. 7 cases (a–g) per spec, plus the chip-race
// regression test for issue #1 (result.netDelta vs game.getBalance() - balanceBefore).

import { Window } from 'happy-dom';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { initKenoClient } from './kenoClient';
import type { PendingReceipt } from './outbox';

// ---------------------------------------------------------------------------
// happy-dom globals (same pattern as KenoUIRenderer.test.ts)
// ---------------------------------------------------------------------------
const origWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const origDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
const origFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
const origSetTimeout = Object.getOwnPropertyDescriptor(globalThis, 'setTimeout');
const origLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const origSessionStorage = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
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
	Object.defineProperty(globalThis, 'localStorage', {
		configurable: true,
		writable: true,
		value: happyWindow.localStorage,
	});
	Object.defineProperty(globalThis, 'sessionStorage', {
		configurable: true,
		writable: true,
		value: happyWindow.sessionStorage,
	});
	// Mock setTimeout to 0ms so animation/retry sleeps are instant.
	const realSetTimeout = (origSetTimeout?.value ?? setTimeout) as typeof setTimeout;
	Object.defineProperty(globalThis, 'setTimeout', {
		configurable: true,
		writable: true,
		value: ((cb: TimerHandler, _ms?: number) => realSetTimeout(cb, 0)) as typeof setTimeout,
	});
});

afterAll(() => {
	happyWindow.close();
	restore(origWindow, 'window');
	restore(origDocument, 'document');
	restore(origFetch, 'fetch');
	restore(origSetTimeout, 'setTimeout');
	restore(origLocalStorage, 'localStorage');
	restore(origSessionStorage, 'sessionStorage');
});

function restore(desc: PropertyDescriptor | undefined, key: string): void {
	if (desc) Object.defineProperty(globalThis, key, desc);
	else Reflect.deleteProperty(globalThis, key);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
type FetchCall = { url: string; body: Record<string, unknown> };
type MockResponse = {
	status: number;
	body: Record<string, unknown>;
	retryAfter?: string;
};

function makeRes(r: MockResponse): {
	ok: boolean;
	status: number;
	headers: { get: (k: string) => string | null };
	json: () => Promise<Record<string, unknown>>;
} {
	return {
		ok: r.status === 200,
		status: r.status,
		headers: { get: (k: string) => (k === 'Retry-After' ? (r.retryAfter ?? null) : null) },
		json: async () => r.body,
	};
}

type Deferred = { promise: Promise<MockResponse>; resolve: (r: MockResponse) => void };

function deferred(): Deferred {
	let resolve!: (r: MockResponse) => void;
	const promise = new Promise<MockResponse>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

/**
 * Install a fetch mock. Each call to fetch consumes the next entry in `responses`.
 * If an entry is a Promise, fetch blocks until the promise resolves.
 * After responses are exhausted, fetch returns a default 200 { balance: 1000 }.
 */
function installFetch(responses: (MockResponse | Promise<MockResponse>)[]): { calls: FetchCall[] } {
	const calls: FetchCall[] = [];
	let idx = 0;
	const fetchImpl = async (url: string, init: RequestInit) => {
		calls.push({ url, body: JSON.parse(init.body as string) });
		const entry = responses[idx];
		idx++;
		const r = entry instanceof Promise ? await entry : (entry as MockResponse);
		return makeRes(r);
	};
	Object.defineProperty(globalThis, 'fetch', {
		configurable: true,
		writable: true,
		value: fetchImpl,
	});
	return { calls };
}

/** Wait N macrotask ticks (setTimeout is mocked to 0ms, so this is fast). */
async function flush(ticks = 3): Promise<void> {
	for (let i = 0; i < ticks; i++) {
		await new Promise<void>((r) => setTimeout(r, 0));
	}
}

const USER_ID = 'test-user';
const FIXED_TAB_ID = 'test-tab';
const TAB_ID_KEY = 'arcturus:keno:tab-id';
const OUTBOX_KEY = `arcturus:keno:outbox:${USER_ID}:${FIXED_TAB_ID}`;
const SETTINGS_KEY = `arcturus:keno:settings:${USER_ID}`;

function makeReceipt(over: Partial<PendingReceipt> = {}): PendingReceipt {
	return {
		syncId: 's-test',
		previousBalance: 1000,
		delta: 100,
		gameType: 'keno',
		outcome: 'win',
		handCount: 1,
		biggestWinCandidate: 100,
		...over,
	};
}

/** Build a DOM fixture matching keno.astro's data-testid contract. */
function makeKenoRoot(opts: { guestMode?: string; initialBalance?: string } = {}): HTMLElement {
	const root = document.createElement('div');
	root.id = 'keno-root';
	root.setAttribute('data-testid', 'keno-root');
	root.setAttribute('data-user-id', USER_ID);
	root.setAttribute('data-guest-mode', opts.guestMode ?? 'false');
	root.setAttribute('data-initial-balance', opts.initialBalance ?? '1000');
	root.innerHTML = `
		<span data-testid="chip-balance">0</span>
		<span data-testid="game-status"></span>
		<span data-testid="last-result"></span>
		<div id="keno-grid" data-testid="keno-grid"></div>
		<span data-testid="spot-count">0/10</span>
		<span data-testid="current-bet">1</span>
		<div id="bet-chips" data-testid="bet-chips">
			<button class="bet-chip" data-bet="1">1</button>
			<button class="bet-chip" data-bet="2">2</button>
			<button class="bet-chip" data-bet="5">5</button>
		</div>
		<button id="btn-quickpick" data-testid="btn-quickpick">Quick Pick</button>
		<button id="btn-clear" data-testid="btn-clear">Clear</button>
		<button id="btn-repeat" data-testid="btn-repeat">Repeat</button>
		<button id="btn-draw" data-testid="btn-draw" disabled>Draw</button>
		<div id="recent-tickets" data-testid="recent-tickets"></div>
		<div id="paytable-body" data-testid="paytable-body"></div>
		<button id="btn-settings" data-testid="btn-settings">Settings</button>
		<div id="settings-modal" data-testid="settings-modal" class="hidden">
			<button id="btn-settings-close" data-testid="btn-settings-close">&times;</button>
			<div id="speed-options" data-testid="speed-options">
				<button class="speed-opt" data-speed="slow">Slow</button>
				<button class="speed-opt" data-speed="normal">Normal</button>
				<button class="speed-opt" data-speed="fast">Fast</button>
			</div>
			<input type="checkbox" id="setting-sound" data-testid="setting-sound" checked />
		</div>
		<button id="btn-paytable" data-testid="btn-paytable">Paytable</button>
		<div id="paytable-modal" data-testid="paytable-modal" class="hidden">
			<button id="btn-paytable-close" data-testid="btn-paytable-close">&times;</button>
			<div id="paytable-modal-body" data-testid="paytable-modal-body"></div>
		</div>
		<div id="achievement-toast" data-testid="achievement-toast" class="hidden"></div>
	`;
	document.body.appendChild(root);
	return root;
}

function clickQuickPick(): void {
	document.getElementById('btn-quickpick')!.click();
}

function clickDraw(): void {
	document.getElementById('btn-draw')!.click();
}

/** Parse the netDelta from the recent-tickets DOM (format: "8p 3hit +219"). */
function parseRecentNetDelta(): number {
	const row = document.querySelector('#recent-tickets .recent-ticket');
	if (!row) throw new Error('no recent-ticket row found');
	const text = row.textContent ?? '';
	const match = text.match(/([+-]?\d+)\s*$/);
	if (!match) throw new Error(`cannot parse netDelta from: "${text}"`);
	return Number(match[1]);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('kenoClient sync state machine', () => {
	let root: HTMLElement;

	beforeEach(() => {
		localStorage.clear();
		sessionStorage.clear();
		sessionStorage.setItem(TAB_ID_KEY, FIXED_TAB_ID);
		localStorage.setItem(SETTINGS_KEY, JSON.stringify({ animationSpeed: 'fast' }));
		root = makeKenoRoot();
	});

	afterEach(() => {
		root.remove();
	});

	describe('(a) two rapid draws drain serially', () => {
		test('second receipt rebases on BALANCE_MISMATCH when enqueued before first commits', async () => {
			// Use a deferred for the first fetch so receipt #2 is enqueued
			// before receipt #1's sync completes (the enqueue-time-capture race).
			const d1 = deferred();
			const { calls } = installFetch([
				d1.promise, // fetch #1: receipt #1 (blocked until we resolve)
				{ status: 409, body: { error: 'BALANCE_MISMATCH', currentBalance: 995 } }, // fetch #2: receipt #2 stale prevBalance
				{ status: 200, body: { balance: 990 } }, // fetch #3: receipt #2 rebased
			]);

			initKenoClient();
			await flush();

			// Draw #1
			clickQuickPick();
			clickDraw();
			await flush(); // animation completes, receipt #1 enqueued, fetch #1 pending (d1)

			// Draw #2 (receipt #2 enqueued with stale previousBalance = 1000)
			clickDraw();
			await flush(); // animation completes, receipt #2 enqueued

			// Resolve fetch #1 → 200 → serverSyncedBalance updated → drain continues to receipt #2
			d1.resolve({ status: 200, body: { balance: 995 } });
			await flush(5);

			expect(calls.length).toBeGreaterThanOrEqual(3);
			// Receipt #1: previousBalance = 1000 (initial serverSyncedBalance)
			expect(calls[0].body.previousBalance).toBe(1000);
			// Receipt #2 first attempt: previousBalance = 1000 (stale — enqueue-time capture)
			expect(calls[1].body.previousBalance).toBe(1000);
			expect(calls[1].body.error).toBeUndefined(); // body is the request, not response
			// Receipt #2 rebased: previousBalance = 995 (server's currentBalance from 409)
			expect(calls[2].body.previousBalance).toBe(995);
			// Deltas are per-draw (result.netDelta), not cumulative — each draw's
			// delta is independent (random RNG). The chip-race regression test
			// below verifies the delta is result.netDelta, not a balance diff.
			expect(calls[0].body.syncId).not.toBe(calls[1].body.syncId);
			expect(calls[1].body.syncId).toBe(calls[2].body.syncId); // same receipt rebased
		});
	});

	describe('(b) 429 re-queues same 7-field payload', () => {
		test('retries identical 7 fields after Retry-After; never sends statsDelta', async () => {
			localStorage.setItem(OUTBOX_KEY, JSON.stringify([makeReceipt({ syncId: 's-429' })]));
			const { calls } = installFetch([
				{ status: 429, body: { error: 'RATE_LIMITED' }, retryAfter: '0' },
				{ status: 200, body: { balance: 1100 } },
			]);

			initKenoClient();
			await flush(5);

			expect(calls).toHaveLength(2);
			// Same 7 fields resent
			expect(calls[1].body).toEqual({
				syncId: 's-429',
				previousBalance: 1000,
				delta: 100,
				gameType: 'keno',
				outcome: 'win',
				handCount: 1,
				biggestWinCandidate: 100,
			});
			// NEVER sends statsDelta/winsIncrement/lossesIncrement
			expect(calls[1].body.statsDelta).toBeUndefined();
			expect(calls[1].body.winsIncrement).toBeUndefined();
			expect(calls[1].body.lossesIncrement).toBeUndefined();
		});
	});

	describe('(c) BALANCE_MISMATCH rebases and resubmits', () => {
		test('previousBalance := currentBalance, same syncId+delta retained, delta not lost', async () => {
			localStorage.setItem(OUTBOX_KEY, JSON.stringify([makeReceipt({ syncId: 's-mismatch' })]));
			const { calls } = installFetch([
				{ status: 409, body: { error: 'BALANCE_MISMATCH', currentBalance: 1050 } },
				{ status: 200, body: { balance: 1150 } },
			]);

			initKenoClient();
			await flush(5);

			expect(calls).toHaveLength(2);
			expect(calls[0].body.previousBalance).toBe(1000);
			// Rebased: previousBalance = 1050 (server's currentBalance), same syncId + delta
			expect(calls[1].body).toEqual({
				syncId: 's-mismatch',
				previousBalance: 1050,
				delta: 100,
				gameType: 'keno',
				outcome: 'win',
				handCount: 1,
				biggestWinCandidate: 100,
			});
		});
	});

	describe('(d) network failure leaves receipt at head and retries', () => {
		test('does NOT adopt local balance; retries identical payload', async () => {
			localStorage.setItem(OUTBOX_KEY, JSON.stringify([makeReceipt({ syncId: 's-net' })]));
			let attempt = 0;
			const calls: FetchCall[] = [];
			globalThis.fetch = (async (url: string, init: RequestInit) => {
				calls.push({ url, body: JSON.parse(init.body as string) });
				attempt++;
				if (attempt === 1) throw new Error('network down');
				return makeRes({ status: 200, body: { balance: 1100 } });
			}) as typeof fetch;

			initKenoClient();
			await flush(5);

			expect(calls).toHaveLength(2);
			// Same payload retried — no local balance adoption
			expect(calls[1].body).toEqual(calls[0].body);
		});
	});

	describe('(e) terminal 4xx drops receipt, no loop', () => {
		test('DELTA_EXCEEDS_LIMIT drops and surfaces error; does not retry', async () => {
			localStorage.setItem(OUTBOX_KEY, JSON.stringify([makeReceipt({ syncId: 's-term' })]));
			const { calls } = installFetch([
				{ status: 400, body: { error: 'DELTA_EXCEEDS_LIMIT', currentBalance: 1000 } },
			]);

			initKenoClient();
			await flush(5);

			expect(calls).toHaveLength(1); // no retry
			// Toast surfaced
			const toast = document.getElementById('achievement-toast');
			expect(toast?.textContent).toContain('DELTA_EXCEEDS_LIMIT');
			// Outbox cleared
			expect(JSON.parse(localStorage.getItem(OUTBOX_KEY) ?? '[]')).toEqual([]);
		});
	});

	describe('(f) persisted outbox re-drains on load', () => {
		test('resumed receipt is synced via drainPersisted on init', async () => {
			localStorage.setItem(
				OUTBOX_KEY,
				JSON.stringify([makeReceipt({ syncId: 's-resumed', delta: 50 })]),
			);
			const { calls } = installFetch([{ status: 200, body: { balance: 1050 } }]);

			initKenoClient();
			await flush(5);

			expect(calls).toHaveLength(1);
			expect(calls[0].body.syncId).toBe('s-resumed');
			expect(calls[0].body.delta).toBe(50);
			// Outbox cleared after successful drain
			expect(JSON.parse(localStorage.getItem(OUTBOX_KEY) ?? '[]')).toEqual([]);
		});
	});

	describe('(f2) per-tab outbox namespace absorbs orphaned receipts from closed tabs', () => {
		test('orphaned key from a different tabId is absorbed and deleted on load', async () => {
			// Seed an orphaned outbox key under a DIFFERENT tabId (simulating a closed tab)
			const orphanKey = `arcturus:keno:outbox:${USER_ID}:dead-tab`;
			localStorage.setItem(
				orphanKey,
				JSON.stringify([makeReceipt({ syncId: 's-orphan', delta: 25 })]),
			);
			const { calls } = installFetch([{ status: 200, body: { balance: 1025 } }]);

			initKenoClient();
			await flush(5);

			// Orphan receipt was drained
			expect(calls).toHaveLength(1);
			expect(calls[0].body.syncId).toBe('s-orphan');
			expect(calls[0].body.delta).toBe(25);
			// Orphan key was deleted; current tab key is empty
			expect(localStorage.getItem(orphanKey)).toBeNull();
			expect(JSON.parse(localStorage.getItem(OUTBOX_KEY) ?? '[]')).toEqual([]);
		});

		test('current tab key is not deleted on load (only orphans are)', async () => {
			localStorage.setItem(
				OUTBOX_KEY,
				JSON.stringify([makeReceipt({ syncId: 's-current-tab', delta: 10 })]),
			);
			const { calls } = installFetch([{ status: 200, body: { balance: 1010 } }]);

			initKenoClient();
			await flush(5);

			expect(calls).toHaveLength(1);
			expect(calls[0].body.syncId).toBe('s-current-tab');
			// Current tab key still exists (now empty after drain)
			expect(localStorage.getItem(OUTBOX_KEY)).not.toBeNull();
		});
	});

	describe('(g) guest mode skips all fetches', () => {
		test('no fetch calls; balance persists to localStorage', async () => {
			root.remove();
			root = makeKenoRoot({ guestMode: 'true', initialBalance: '500' });
			const calls: FetchCall[] = [];
			globalThis.fetch = (() => {
				calls.push({ url: 'should-not-be-called', body: {} });
				return Promise.resolve(makeRes({ status: 200, body: { balance: 0 } }));
			}) as typeof fetch;

			initKenoClient();
			clickQuickPick();
			clickDraw();
			await flush(5);

			expect(calls).toHaveLength(0);
			// Guest bankroll persisted
			const bankroll = localStorage.getItem(`keno-bankroll:${USER_ID}`);
			expect(bankroll).not.toBeNull();
			expect(Number(bankroll)).toBeGreaterThanOrEqual(0);
		});
	});

	describe('chip-race regression: result.netDelta not game.getBalance() - balanceBefore', () => {
		test('concurrent setGameBalance during reveal does not inflate delta', async () => {
			// Pre-populate a resumed receipt that, when synced, calls setGameBalance(1500)
			// during the live draw's reveal animation await.
			localStorage.setItem(
				OUTBOX_KEY,
				JSON.stringify([makeReceipt({ syncId: 's-old', previousBalance: 1000, delta: 500 })]),
			);

			// Fetch #1 (resumed receipt) blocks on a deferred so it resolves
			// DURING the live draw's await sleep(). Fetch #2 (live draw) returns 200.
			const d1 = deferred();
			const { calls } = installFetch([
				d1.promise, // fetch #1: resumed receipt (blocked)
				{ status: 200, body: { balance: 1500 } }, // fetch #2: live draw
			]);

			initKenoClient();
			await flush(); // drainPersisted starts, fetch #1 pending (d1)

			// Live draw
			clickQuickPick();
			clickDraw();
			// commitDraw: game.draw() runs, then await sleep(0) yields.
			// Resolve the resumed receipt's fetch → 200 → setGameBalance(1500)
			// fires during the animation await.
			d1.resolve({ status: 200, body: { balance: 1500 } });
			await flush(5);

			// The resumed receipt's delta is 500 (pre-populated).
			expect(calls[0].body.delta).toBe(500);

			// The live draw's delta must be result.netDelta (payout - bet),
			// NOT game.getBalance() - balanceBefore = 1500 - 1000 = 500.
			// Read the actual netDelta from the recent-tickets DOM.
			const expectedNetDelta = parseRecentNetDelta();
			expect(calls[1].body.delta).toBe(expectedNetDelta);

			// The inflation bug would have produced delta = 500 (the reconciliation
			// amount). Assert it's NOT 500 — proving the fix uses netDelta.
			// (With bet=1, no paytable multiplier produces netDelta=500, since
			// that would require multiplier=501, which doesn't exist.)
			expect(calls[1].body.delta).not.toBe(500);
		});
	});

	describe('loadOutbox error handling', () => {
		test('corrupted outbox JSON falls back to empty array without throwing', async () => {
			localStorage.setItem(OUTBOX_KEY, '{corrupted json');
			const { calls } = installFetch([{ status: 200, body: { balance: 1000 } }]);
			expect(() => initKenoClient()).not.toThrow();
			await flush(3);
			// Outbox loaded as empty → no fetch calls during drainPersisted
			expect(calls).toHaveLength(0);
		});
	});

	describe('settings modal UI', () => {
		test('settings button click shows the modal', () => {
			installFetch([{ status: 200, body: { balance: 1000 } }]);
			initKenoClient();
			const modal = document.querySelector<HTMLElement>('[data-testid="settings-modal"]')!;
			expect(modal.classList.contains('hidden')).toBe(true);
			(document.getElementById('btn-settings') as HTMLButtonElement).click();
			expect(modal.classList.contains('hidden')).toBe(false);
		});

		test('settings close button hides the modal', () => {
			installFetch([{ status: 200, body: { balance: 1000 } }]);
			initKenoClient();
			const modal = document.querySelector<HTMLElement>('[data-testid="settings-modal"]')!;
			(document.getElementById('btn-settings') as HTMLButtonElement).click();
			expect(modal.classList.contains('hidden')).toBe(false);
			(document.getElementById('btn-settings-close') as HTMLButtonElement).click();
			expect(modal.classList.contains('hidden')).toBe(true);
		});

		test('speed option click updates settings and UI', () => {
			installFetch([{ status: 200, body: { balance: 1000 } }]);
			initKenoClient();
			const slowBtn = document.querySelector<HTMLButtonElement>('.speed-opt[data-speed="slow"]')!;
			slowBtn.click();
			const stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}');
			expect(stored.animationSpeed).toBe('slow');
		});

		test('invalid speed value is ignored', () => {
			installFetch([{ status: 200, body: { balance: 1000 } }]);
			initKenoClient();
			const slowBtn = document.querySelector<HTMLButtonElement>('.speed-opt[data-speed="slow"]')!;
			slowBtn.dataset.speed = 'invalid';
			slowBtn.click();
			// Settings should remain 'fast' (from beforeEach)
			const stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}');
			expect(stored.animationSpeed).toBe('fast');
		});

		test('clicking modal overlay (e.target === modal) closes the modal', () => {
			installFetch([{ status: 200, body: { balance: 1000 } }]);
			initKenoClient();
			const modal = document.querySelector<HTMLElement>('[data-testid="settings-modal"]')!;
			(document.getElementById('btn-settings') as HTMLButtonElement).click();
			expect(modal.classList.contains('hidden')).toBe(false);
			modal.click(); // e.target === settingsModal
			expect(modal.classList.contains('hidden')).toBe(true);
		});
	});

	describe('grid cell interactions', () => {
		test('clicking an empty cell selects it', () => {
			installFetch([{ status: 200, body: { balance: 1000 } }]);
			initKenoClient();
			const cell = document.querySelector<HTMLButtonElement>('button.keno-cell[data-number="5"]')!;
			expect(cell.classList.contains('selected')).toBe(false);
			cell.click();
			expect(cell.classList.contains('selected')).toBe(true);
		});

		test('clicking a selected cell deselects it', () => {
			installFetch([{ status: 200, body: { balance: 1000 } }]);
			initKenoClient();
			const cell = document.querySelector<HTMLButtonElement>('button.keno-cell[data-number="5"]')!;
			cell.click();
			expect(cell.classList.contains('selected')).toBe(true);
			cell.click();
			expect(cell.classList.contains('selected')).toBe(false);
		});

		test('drawInFlight blocks cell clicks', async () => {
			installFetch([{ status: 200, body: { balance: 1000 } }]);
			initKenoClient();
			clickQuickPick();
			clickDraw(); // sets drawInFlight = true, yields at await sleep
			// Find a cell that is NOT selected (quickPick selects 8 of 40)
			const unselected = Array.from(
				document.querySelectorAll<HTMLButtonElement>('button.keno-cell:not(.selected)'),
			)[0];
			unselected!.click();
			expect(unselected!.classList.contains('selected')).toBe(false);
			await flush(5);
		});

		test('MAX_SPOTS blocks 11th pick', () => {
			installFetch([{ status: 200, body: { balance: 1000 } }]);
			initKenoClient();
			// Select 10 cells (MAX_SPOTS)
			for (let n = 1; n <= 10; n++) {
				document.querySelector<HTMLButtonElement>(`button.keno-cell[data-number="${n}"]`)!.click();
			}
			expect(document.querySelectorAll('button.keno-cell.selected')).toHaveLength(10);
			// Try 11th — silently ignored
			const cell11 = document.querySelector<HTMLButtonElement>(
				'button.keno-cell[data-number="11"]',
			)!;
			cell11.click();
			expect(cell11.classList.contains('selected')).toBe(false);
			expect(document.querySelectorAll('button.keno-cell.selected')).toHaveLength(10);
		});
	});

	describe('bet chip interaction', () => {
		test('clicking a bet chip updates the bet', () => {
			installFetch([{ status: 200, body: { balance: 1000 } }]);
			initKenoClient();
			const chip5 = document.querySelector<HTMLButtonElement>('.bet-chip[data-bet="5"]')!;
			chip5.click();
			expect(document.querySelector<HTMLElement>('[data-testid="current-bet"]')?.textContent).toBe(
				'5',
			);
		});

		test('drawInFlight blocks bet chip clicks', async () => {
			installFetch([{ status: 200, body: { balance: 1000 } }]);
			initKenoClient();
			clickQuickPick();
			clickDraw();
			const chip5 = document.querySelector<HTMLButtonElement>('.bet-chip[data-bet="5"]')!;
			chip5.click();
			expect(document.querySelector<HTMLElement>('[data-testid="current-bet"]')?.textContent).toBe(
				'1',
			);
			await flush(5);
		});
	});

	describe('clear button', () => {
		test('clicking clear removes all picks', () => {
			installFetch([{ status: 200, body: { balance: 1000 } }]);
			initKenoClient();
			document.querySelector<HTMLButtonElement>('button.keno-cell[data-number="5"]')!.click();
			document.querySelector<HTMLButtonElement>('button.keno-cell[data-number="10"]')!.click();
			expect(document.querySelectorAll('button.keno-cell.selected').length).toBeGreaterThan(0);
			(document.getElementById('btn-clear') as HTMLButtonElement).click();
			expect(document.querySelectorAll('button.keno-cell.selected')).toHaveLength(0);
		});

		test('drawInFlight blocks clear', async () => {
			installFetch([{ status: 200, body: { balance: 1000 } }]);
			initKenoClient();
			clickQuickPick();
			clickDraw();
			(document.getElementById('btn-clear') as HTMLButtonElement).click();
			expect(document.querySelectorAll('button.keno-cell.selected').length).toBeGreaterThan(0);
			await flush(5);
		});
	});

	describe('repeat button', () => {
		test('repeats last ticket picks after a draw', async () => {
			installFetch([{ status: 200, body: { balance: 1000 } }]);
			initKenoClient();
			clickQuickPick();
			const picksBefore = Array.from(document.querySelectorAll('button.keno-cell.selected'))
				.map((c) => Number(c.dataset.number))
				.sort((a, b) => a - b);
			clickDraw();
			await flush(5);
			// Clear picks, then repeat
			(document.getElementById('btn-clear') as HTMLButtonElement).click();
			expect(document.querySelectorAll('button.keno-cell.selected')).toHaveLength(0);
			(document.getElementById('btn-repeat') as HTMLButtonElement).click();
			const picksAfter = Array.from(document.querySelectorAll('button.keno-cell.selected'))
				.map((c) => Number(c.dataset.number))
				.sort((a, b) => a - b);
			expect(picksAfter).toEqual(picksBefore);
		});

		test('repeat with no previous ticket is a no-op', () => {
			installFetch([{ status: 200, body: { balance: 1000 } }]);
			initKenoClient();
			(document.getElementById('btn-repeat') as HTMLButtonElement).click();
			expect(document.querySelectorAll('button.keno-cell.selected')).toHaveLength(0);
		});

		test('drawInFlight blocks repeat', async () => {
			installFetch([{ status: 200, body: { balance: 1000 } }]);
			initKenoClient();
			clickQuickPick();
			clickDraw();
			(document.getElementById('btn-repeat') as HTMLButtonElement).click();
			// Picks unchanged — repeat was blocked
			expect(document.querySelectorAll('button.keno-cell.selected').length).toBeGreaterThan(0);
			await flush(5);
		});
	});

	describe('drainPersisted error handling', () => {
		test('persist failure is best-effort: resumed receipt still drains to the server', async () => {
			localStorage.setItem(OUTBOX_KEY, JSON.stringify([makeReceipt({ syncId: 's-resume-fail' })]));
			const { calls } = installFetch([{ status: 200, body: { balance: 1100 } }]);
			initKenoClient();
			// Override setItem to throw — dropHead's persist will throw after the 200
			// response. Persistence is best-effort (crash recovery only), so the drain
			// must NOT abort: the receipt was already sent and the server settled it.
			// happy-dom puts setItem on the prototype, so direct assignment is a no-op;
			// Object.defineProperty on the instance creates an own override.
			const origSetItem = localStorage.setItem;
			const errors: string[] = [];
			const origConsoleError = console.error;
			console.error = (...args: unknown[]) => {
				errors.push(String(args[0]));
			};
			Object.defineProperty(localStorage, 'setItem', {
				configurable: true,
				writable: true,
				value: () => {
					throw new Error('storage full');
				},
			});
			try {
				await flush(5);
				// The resumed receipt reached the server despite persist throwing.
				expect(calls).toHaveLength(1);
				expect(calls[0].body.syncId).toBe('s-resume-fail');
				// The outbox logged its best-effort persist warning.
				expect(errors.some((e) => e.includes('keno: outbox persist failed'))).toBe(true);
			} finally {
				Object.defineProperty(localStorage, 'setItem', {
					configurable: true,
					writable: true,
					value: origSetItem,
				});
				console.error = origConsoleError;
			}
		});
	});

	describe('settlement drain error handling', () => {
		test('persist failure is best-effort: live draw settlement still reaches the server', async () => {
			const { calls } = installFetch([{ status: 200, body: { balance: 1000 } }]);
			initKenoClient();
			clickQuickPick();
			clickDraw();
			// Override setItem to throw before the settlement drain runs (after the
			// reveal animation await yields back to the test). The drain must continue
			// so the chip delta is sent; persistence is only for crash recovery.
			const origSetItem = localStorage.setItem;
			const errors: string[] = [];
			const origConsoleError = console.error;
			console.error = (...args: unknown[]) => {
				errors.push(String(args[0]));
			};
			Object.defineProperty(localStorage, 'setItem', {
				configurable: true,
				writable: true,
				value: () => {
					throw new Error('storage full');
				},
			});
			try {
				await flush(5);
				// The live draw's settlement reached the server despite persist throwing.
				expect(calls).toHaveLength(1);
				expect(calls[0].body.gameType).toBe('keno');
				// The outbox logged its best-effort persist warning.
				expect(errors.some((e) => e.includes('keno: outbox persist failed'))).toBe(true);
			} finally {
				Object.defineProperty(localStorage, 'setItem', {
					configurable: true,
					writable: true,
					value: origSetItem,
				});
				console.error = origConsoleError;
			}
		});
	});

	describe('commitDraw error handling', () => {
		test('non-fail error (no code) is logged to console.error', async () => {
			installFetch([{ status: 200, body: { balance: 1000 } }]);
			initKenoClient();
			clickQuickPick();
			// Make Math.random throw to trigger a non-coded TypeError in commitDraw's
			// syncId generation (line 183), before game.draw() is reached.
			const origRandom = Math.random;
			const errors: string[] = [];
			const origConsoleError = console.error;
			console.error = (...args: unknown[]) => {
				errors.push(String(args[0]));
			};
			Math.random = (() => {
				throw new TypeError('random broken');
			}) as typeof Math.random;
			try {
				clickDraw();
				await flush(5);
				expect(errors.some((e) => e.includes('keno: commitDraw failed'))).toBe(true);
			} finally {
				Math.random = origRandom;
				console.error = origConsoleError;
			}
		});
	});
});
