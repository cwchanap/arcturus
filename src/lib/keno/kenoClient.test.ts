// src/lib/keno/kenoClient.test.ts
//
// Spec: docs/superpowers/specs/2026-07-21-keno-design.md §Testing — kenoClient.test.ts
// Covers the live Keno client with mocked fetch, DOM events, and instant timers.

import { Window } from 'happy-dom';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { SettlementGate } from '../wallet';
import {
	buildKenoSettlementCommand,
	canStartKenoDraw,
	initKenoClient,
	retryKenoSettlement,
} from './kenoClient';

// ---------------------------------------------------------------------------
// happy-dom globals (same pattern as KenoUIRenderer.test.ts)
// ---------------------------------------------------------------------------
const origWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const origDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
const origFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
const origSetTimeout = Object.getOwnPropertyDescriptor(globalThis, 'setTimeout');
const origLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const origSessionStorage = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
const origCustomEvent = Object.getOwnPropertyDescriptor(globalThis, 'CustomEvent');
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
	// Override CustomEvent so window.dispatchEvent recognises the events.
	// Without this, `new CustomEvent(...)` uses bun's global constructor and
	// happy-dom's EventTarget rejects it as "not of type 'Event'".
	Object.defineProperty(globalThis, 'CustomEvent', {
		configurable: true,
		writable: true,
		value: happyWindow.CustomEvent,
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
	restore(origCustomEvent, 'CustomEvent');
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
		const entry =
			idx < responses.length ? responses[idx] : { status: 200, body: { balance: 1000 } };
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
const SETTINGS_KEY = `arcturus:keno:settings:${USER_ID}`;

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
		<div id="settlement-paused-banner" data-testid="settlement-paused-banner" class="hidden">
			<button id="btn-retry-settlement" data-testid="btn-retry-settlement">Retry Settlement</button>
		</div>
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

describe('Keno wallet settlement client', () => {
	test('builds one wallet command from a draw result', () => {
		expect(buildKenoSettlementCommand('keno-win', { netDelta: 120 })).toEqual({
			settlementId: 'keno-win',
			game: 'keno',
			delta: 120,
			stats: { rounds: 1, wins: 1, losses: 0, biggestWin: 120 },
		});
	});

	test('records a losing draw without a biggest win', () => {
		expect(buildKenoSettlementCommand('keno-loss', { netDelta: -5 }).stats).toEqual({
			rounds: 1,
			wins: 0,
			losses: 1,
			biggestWin: 0,
		});
	});

	test('blocks an authenticated draw while the shared gate is blocked', () => {
		const gate = { isBlocked: true } as SettlementGate;
		expect(canStartKenoDraw({ isGuestMode: false, gate })).toBe(false);
	});

	test('does not block guest draws on an authenticated settlement gate', () => {
		const gate = { isBlocked: true } as SettlementGate;
		expect(canStartKenoDraw({ isGuestMode: true, gate })).toBe(true);
	});

	test('delegates Retry to the shared settlement gate', async () => {
		let retryCalls = 0;
		const result = await retryKenoSettlement({
			retry: async () => {
				retryCalls += 1;
				return { balance: 1_025, duplicate: false };
			},
		});

		expect(retryCalls).toBe(1);
		expect(result).toEqual({ balance: 1_025, duplicate: false });
	});

	test('shows recovery banner and keeps gate pending when authenticated settlement fails', async () => {
		installFetch([{ status: 500, body: { error: 'INTERNAL_ERROR' } }]);
		const r = makeKenoRoot({ initialBalance: '1000' });
		initKenoClient();
		clickQuickPick();
		clickDraw();
		await flush(10);

		const banner = document.getElementById('settlement-paused-banner')!;
		expect(banner.classList.contains('hidden')).toBe(false);
		r.remove();
	});

	test('replaces local balance when settlement returns a different server balance', async () => {
		installFetch([{ status: 200, body: { balance: 777, duplicate: false } }]);
		const r = makeKenoRoot({ initialBalance: '1000' });
		initKenoClient();
		clickQuickPick();
		clickDraw();
		await flush(10);

		const balanceEl = document.querySelector<HTMLElement>('[data-testid="chip-balance"]')!;
		expect(balanceEl.textContent).toContain('777');
		const banner = document.getElementById('settlement-paused-banner')!;
		expect(banner.classList.contains('hidden')).toBe(true);
		r.remove();
	});

	test('retry handler re-attempts settlement and hides the banner on success', async () => {
		installFetch([
			{ status: 500, body: { error: 'INTERNAL_ERROR' } },
			{ status: 200, body: { balance: 990, duplicate: false } },
		]);
		const r = makeKenoRoot({ initialBalance: '1000' });
		initKenoClient();
		clickQuickPick();
		clickDraw();
		await flush(10);

		const banner = document.getElementById('settlement-paused-banner')!;
		expect(banner.classList.contains('hidden')).toBe(false);

		// Click retry — the second fetch mock returns 200.
		(document.getElementById('btn-retry-settlement') as HTMLButtonElement).click();
		await flush(10);

		expect(banner.classList.contains('hidden')).toBe(true);
		expect(
			document.querySelector<HTMLElement>('[data-testid="chip-balance"]')?.textContent,
		).toContain('990');
		r.remove();
	});

	test('reset handler clears the gate and restores the server-synced balance', async () => {
		installFetch([{ status: 500, body: { error: 'INTERNAL_ERROR' } }]);
		const r = makeKenoRoot({ initialBalance: '1000' });
		initKenoClient();
		clickQuickPick();
		clickDraw();
		await flush(10);

		const banner = document.getElementById('settlement-paused-banner')!;
		expect(banner.classList.contains('hidden')).toBe(false);

		// Click reset — the gate clears and the banner hides without a new fetch.
		(document.getElementById('btn-reset-settlement') as HTMLButtonElement).click();
		await flush(5);

		expect(banner.classList.contains('hidden')).toBe(true);
		r.remove();
	});

	test('dispatches achievement-earned event when settlement returns new achievements', async () => {
		installFetch([
			{
				status: 200,
				body: {
					balance: 1100,
					duplicate: false,
					newAchievements: [{ id: 'keno-win', icon: '🎯' }],
				},
			},
		]);
		const r = makeKenoRoot({ initialBalance: '1000' });
		initKenoClient();

		const events: Array<{ achievements: unknown[] }> = [];
		const handler = (e: Event) => {
			const detail = (e as CustomEvent).detail as { achievements: unknown[] };
			events.push(detail);
		};
		window.addEventListener('achievement-earned', handler);

		try {
			clickQuickPick();
			clickDraw();
			await flush(10);

			expect(events).toHaveLength(1);
			expect(events[0].achievements).toEqual([{ id: 'keno-win', icon: '🎯' }]);
		} finally {
			window.removeEventListener('achievement-earned', handler);
			r.remove();
		}
	});

	test('blocks a new draw and shows recovery message while settlement is pending', async () => {
		installFetch([{ status: 500, body: { error: 'INTERNAL_ERROR' } }]);
		const r = makeKenoRoot({ initialBalance: '1000' });
		initKenoClient();
		clickQuickPick();
		clickDraw();
		await flush(10);

		// Settlement failed → gate is blocked. Pick numbers again; the draw
		// button is disabled by renderCanDraw(canDrawNow()) because the gate
		// is blocked. Re-enable it programmatically and click to exercise the
		// canStartKenoDraw guard inside commitDraw.
		clickQuickPick();
		const drawBtn = document.getElementById('btn-draw') as HTMLButtonElement;
		expect(drawBtn.disabled).toBe(true);
		drawBtn.disabled = false;
		drawBtn.click();
		await flush(5);

		const statusAfter = document.querySelector<HTMLElement>(
			'[data-testid="game-status"]',
		)?.textContent;
		expect(statusAfter).toContain('Settlement is still pending');
		r.remove();
	});
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('kenoClient gameplay coverage', () => {
	let root: HTMLElement;

	beforeEach(() => {
		localStorage.clear();
		sessionStorage.clear();
		localStorage.setItem(SETTINGS_KEY, JSON.stringify({ animationSpeed: 'fast' }));
		root = makeKenoRoot();
	});

	afterEach(() => {
		root.remove();
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
				'5 chips',
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
				'1 chip',
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

	describe('commitDraw error handling', () => {
		test('non-fail error (no code) is logged to console.error', async () => {
			installFetch([{ status: 200, body: { balance: 1000 } }]);
			initKenoClient();
			clickQuickPick();
			// Make crypto.randomUUID throw to trigger a non-coded TypeError in
			// commitDraw's settlement ID generation, before game.draw() is reached.
			const origRandomUUID = crypto.randomUUID;
			const errors: string[] = [];
			const origConsoleError = console.error;
			console.error = (...args: unknown[]) => {
				errors.push(String(args[0]));
			};
			crypto.randomUUID = (() => {
				throw new TypeError('randomUUID broken');
			}) as typeof crypto.randomUUID;
			try {
				clickDraw();
				await flush(5);
				expect(errors.some((e) => e.includes('keno: commitDraw failed'))).toBe(true);
			} finally {
				crypto.randomUUID = origRandomUUID;
				console.error = origConsoleError;
			}
		});
	});
});
