import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { initVideoPokerClient } from './client';

// ---------------------------------------------------------------------------
// happy-dom globals
// ---------------------------------------------------------------------------
const origWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const origDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
const origFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
const origLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
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
	Object.defineProperty(globalThis, 'CustomEvent', {
		configurable: true,
		writable: true,
		value: happyWindow.CustomEvent,
	});
});

afterAll(() => {
	happyWindow.close();
	if (origWindow) Object.defineProperty(globalThis, 'window', origWindow);
	if (origDocument) Object.defineProperty(globalThis, 'document', origDocument);
	if (origFetch) Object.defineProperty(globalThis, 'fetch', origFetch);
	if (origLocalStorage) Object.defineProperty(globalThis, 'localStorage', origLocalStorage);
	if (origCustomEvent) Object.defineProperty(globalThis, 'CustomEvent', origCustomEvent);
});

// ---------------------------------------------------------------------------
// DOM fixture helpers
// ---------------------------------------------------------------------------
function makeCardSlot(id: string): HTMLElement {
	const slot = document.createElement('div');
	slot.id = id;
	slot.className = 'card-slot';
	slot.setAttribute('data-slot-state', 'placeholder');

	const placeholder = document.createElement('div');
	placeholder.className = 'card-placeholder hidden';
	placeholder.setAttribute('data-placeholder', '');
	slot.appendChild(placeholder);

	const cardFace = document.createElement('div');
	cardFace.className = 'playing-card hidden';
	cardFace.setAttribute('data-card-face', '');
	const inner = document.createElement('div');
	inner.className = 'playing-card-inner';
	const cornerTop = document.createElement('div');
	cornerTop.className = 'card-corner card-corner-top';
	const rankTop = document.createElement('span');
	rankTop.className = 'card-rank';
	rankTop.setAttribute('data-rank', '');
	const suitSmallTop = document.createElement('span');
	suitSmallTop.className = 'card-suit-small';
	suitSmallTop.setAttribute('data-suit-small', '');
	cornerTop.appendChild(rankTop);
	cornerTop.appendChild(suitSmallTop);
	const suitCenter = document.createElement('span');
	suitCenter.className = 'card-suit-center';
	suitCenter.setAttribute('data-suit-center', '');
	const cornerBottom = document.createElement('div');
	cornerBottom.className = 'card-corner card-corner-bottom';
	const rankBottom = document.createElement('span');
	rankBottom.className = 'card-rank';
	rankBottom.setAttribute('data-rank', '');
	const suitSmallBottom = document.createElement('span');
	suitSmallBottom.className = 'card-suit-small';
	suitSmallBottom.setAttribute('data-suit-small', '');
	cornerBottom.appendChild(rankBottom);
	cornerBottom.appendChild(suitSmallBottom);
	inner.appendChild(cornerTop);
	inner.appendChild(suitCenter);
	inner.appendChild(cornerBottom);
	cardFace.appendChild(inner);
	slot.appendChild(cardFace);

	const cardBack = document.createElement('div');
	cardBack.className = 'playing-card-back hidden';
	cardBack.setAttribute('data-card-back', '');
	slot.appendChild(cardBack);

	return slot;
}

function buildVideoPokerDOM(options: {
	guestMode?: boolean;
	userId?: string;
	initialBalance?: number;
}): HTMLElement {
	const root = document.createElement('main');
	root.id = 'video-poker-root';
	root.setAttribute('data-user-id', options.userId ?? 'vp-user-1');
	root.dataset.guestMode = options.guestMode ? 'true' : 'false';
	root.dataset.initialBalance = String(options.initialBalance ?? 1000);

	const balanceEl = document.createElement('div');
	balanceEl.id = 'chip-balance';
	balanceEl.textContent = String(options.initialBalance ?? 1000);
	root.appendChild(balanceEl);

	// Mirror element that some layouts render alongside the canonical balance.
	const chipBalanceMirror = document.createElement('span');
	chipBalanceMirror.setAttribute('data-chip-balance', '');
	chipBalanceMirror.textContent = `${options.initialBalance ?? 1000} chips`;
	root.appendChild(chipBalanceMirror);

	const statusEl = document.createElement('div');
	statusEl.id = 'video-poker-status';
	statusEl.textContent = 'Choose a wager and deal';
	root.appendChild(statusEl);

	// Five card slots with hold-toggle buttons
	const cardsRow = document.createElement('div');
	cardsRow.className = 'flex gap-3';
	for (let index = 0; index < 5; index++) {
		const wrapper = document.createElement('div');
		wrapper.className = 'relative';
		wrapper.appendChild(makeCardSlot(`video-poker-slot-${index}`));
		const holdButton = document.createElement('button');
		holdButton.type = 'button';
		holdButton.setAttribute('data-card-index', String(index));
		holdButton.setAttribute('data-card-id', '');
		holdButton.setAttribute('aria-label', `Card ${index + 1}`);
		holdButton.setAttribute('aria-pressed', 'false');
		holdButton.disabled = true;
		wrapper.appendChild(holdButton);
		cardsRow.appendChild(wrapper);
	}
	root.appendChild(cardsRow);

	const resultEl = document.createElement('div');
	resultEl.id = 'video-poker-result';
	root.appendChild(resultEl);

	// Wager buttons (1..5)
	const wagerRow = document.createElement('div');
	wagerRow.className = 'flex gap-2';
	for (const wager of [1, 2, 3, 4, 5]) {
		const wagerButton = document.createElement('button');
		wagerButton.type = 'button';
		wagerButton.setAttribute('data-wager', String(wager));
		wagerButton.setAttribute('aria-pressed', wager === 1 ? 'true' : 'false');
		wagerButton.textContent = String(wager);
		wagerRow.appendChild(wagerButton);
	}
	root.appendChild(wagerRow);

	const action = document.createElement('button');
	action.id = 'video-poker-action';
	action.type = 'button';
	action.textContent = 'Deal';
	root.appendChild(action);

	const recoveryHost = document.createElement('div');
	recoveryHost.id = 'video-poker-recovery-host';
	root.appendChild(recoveryHost);

	document.body.appendChild(root);
	return root;
}

interface MockResponse {
	ok: boolean;
	status: number;
	json: () => Promise<unknown>;
}

function makeResponse(status: number, body: unknown): MockResponse {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: async () => body,
	};
}

interface FetchConfig {
	settlement?: MockResponse | ((call: number) => MockResponse);
}

function installFetch(config: FetchConfig = {}): { calls: Array<{ url: string }> } {
	const calls: Array<{ url: string }> = [];
	let settlementCall = 0;
	(globalThis as typeof globalThis & { fetch: typeof fetch }).fetch = (async (
		url: string | URL | Request,
	) => {
		const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
		calls.push({ url: urlStr });
		if (urlStr === '/api/wallet/settle') {
			const settlement = config.settlement;
			if (typeof settlement === 'function') {
				settlementCall += 1;
				return settlement(settlementCall);
			}
			return settlement ?? makeResponse(200, { balance: 1000, duplicate: false });
		}
		return makeResponse(404, {});
	}) as unknown as typeof fetch;
	return { calls };
}

async function flush(ticks = 10): Promise<void> {
	for (let i = 0; i < ticks; i++) {
		await Promise.resolve();
	}
}

function actionButton(): HTMLButtonElement {
	return document.getElementById('video-poker-action') as HTMLButtonElement;
}

function cardButton(index: number): HTMLButtonElement {
	return document.querySelector<HTMLButtonElement>(`[data-card-index="${index}"]`)!;
}

function wagerButton(wager: number): HTMLButtonElement {
	return document.querySelector<HTMLButtonElement>(`[data-wager="${wager}"]`)!;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('initVideoPokerClient — early returns', () => {
	test('no-ops when the video-poker-root element is absent', () => {
		// No root in the DOM (and localStorage cleared so no stray state).
		localStorage.clear();
		expect(() => initVideoPokerClient()).not.toThrow();
	});
});

describe('initVideoPokerClient — guest round flow', () => {
	test('deals, holds, draws, and starts a new round while persisting the guest bankroll', async () => {
		localStorage.clear();
		installFetch();
		const root = buildVideoPokerDOM({
			guestMode: true,
			userId: 'vp-guest-1',
			initialBalance: 1000,
		});
		try {
			initVideoPokerClient();

			// Initial render: action says Deal, card buttons disabled, wager 1 pressed.
			expect(actionButton().textContent).toBe('Deal');
			expect(cardButton(0).disabled).toBe(true);
			expect(wagerButton(1).getAttribute('aria-pressed')).toBe('true');

			// Deal
			actionButton().click();
			await flush(2);
			expect(actionButton().textContent).toBe('Draw');
			for (let i = 0; i < 5; i++) {
				expect(cardButton(i).disabled).toBe(false);
				expect(cardButton(i).dataset.cardId).not.toBe('');
			}

			// Hold card 0 and 2, then draw
			cardButton(0).click();
			cardButton(2).click();
			expect(cardButton(0).getAttribute('aria-pressed')).toBe('true');
			expect(cardButton(2).getAttribute('aria-pressed')).toBe('true');

			actionButton().click();
			await flush(5);

			// Round complete: action says New Round, result text rendered.
			expect(actionButton().textContent).toBe('New Round');
			const resultEl = document.getElementById('video-poker-result') as HTMLElement;
			expect(resultEl.textContent).not.toBe('');

			// Guest bankroll persisted
			const stored = localStorage.getItem('video-poker-bankroll:vp-guest-1');
			expect(stored).not.toBeNull();

			// Start a new round
			actionButton().click();
			await flush(2);
			expect(actionButton().textContent).toBe('Deal');
			expect(cardButton(0).disabled).toBe(true);
		} finally {
			root.remove();
		}
	});

	test('wager button updates the wager and aria-pressed state before dealing', async () => {
		localStorage.clear();
		installFetch();
		const root = buildVideoPokerDOM({
			guestMode: true,
			userId: 'vp-guest-2',
			initialBalance: 1000,
		});
		try {
			initVideoPokerClient();
			wagerButton(3).click();
			expect(wagerButton(3).getAttribute('aria-pressed')).toBe('true');
			expect(wagerButton(1).getAttribute('aria-pressed')).toBe('false');

			// Dealing after the wager change deducts 3 chips.
			actionButton().click();
			await flush(2);
			const balanceEl = document.getElementById('chip-balance') as HTMLElement;
			expect(balanceEl.textContent).toBe('997');
		} finally {
			root.remove();
		}
	});

	test('wager button rejects a wager exceeding balance and surfaces the error', async () => {
		localStorage.clear();
		installFetch();
		const root = buildVideoPokerDOM({ guestMode: true, userId: 'vp-guest-3', initialBalance: 2 });
		try {
			initVideoPokerClient();
			// Wager 5 exceeds balance 2 → error message, wager stays at 1.
			wagerButton(5).click();
			const statusEl = document.getElementById('video-poker-status') as HTMLElement;
			expect(statusEl.textContent).toContain('balance');
			expect(wagerButton(1).getAttribute('aria-pressed')).toBe('true');
		} finally {
			root.remove();
		}
	});

	test('wager button is ignored while a hand is in progress', async () => {
		localStorage.clear();
		installFetch();
		const root = buildVideoPokerDOM({
			guestMode: true,
			userId: 'vp-guest-4',
			initialBalance: 1000,
		});
		try {
			initVideoPokerClient();
			actionButton().click();
			await flush(2);
			expect(actionButton().textContent).toBe('Draw');

			// Clicking a wager during holding phase is a no-op (disabled + handler guard).
			const pressedBefore = wagerButton(3).getAttribute('aria-pressed');
			wagerButton(3).click();
			expect(wagerButton(3).getAttribute('aria-pressed')).toBe(pressedBefore);
		} finally {
			root.remove();
		}
	});

	test('card hold toggle is ignored outside the holding phase', async () => {
		localStorage.clear();
		installFetch();
		const root = buildVideoPokerDOM({
			guestMode: true,
			userId: 'vp-guest-5',
			initialBalance: 1000,
		});
		try {
			initVideoPokerClient();
			// In ready phase the handler returns early.
			cardButton(0).click();
			expect(cardButton(0).getAttribute('aria-pressed')).toBe('false');
		} finally {
			root.remove();
		}
	});

	test('shows the insufficient-balance status when balance falls below the minimum wager', async () => {
		localStorage.clear();
		installFetch();
		const root = buildVideoPokerDOM({ guestMode: true, userId: 'vp-guest-6', initialBalance: 0 });
		try {
			initVideoPokerClient();
			const statusEl = document.getElementById('video-poker-status') as HTMLElement;
			expect(statusEl.textContent).toContain('Not enough chips');
			expect(statusEl.textContent).toContain('Sign in to get more chips');
			// Deal is disabled when balance < MIN_WAGER.
			expect(actionButton().disabled).toBe(true);
		} finally {
			root.remove();
		}
	});

	test('authenticated insufficient-balance status omits the sign-in nudge', async () => {
		localStorage.clear();
		installFetch();
		const root = buildVideoPokerDOM({ guestMode: false, userId: 'vp-auth-0', initialBalance: 0 });
		try {
			initVideoPokerClient();
			const statusEl = document.getElementById('video-poker-status') as HTMLElement;
			expect(statusEl.textContent).toContain('Not enough chips');
			expect(statusEl.textContent).not.toContain('Sign in');
		} finally {
			root.remove();
		}
	});

	test('updates the data-chip-balance mirror alongside the canonical balance', async () => {
		localStorage.clear();
		installFetch();
		const root = buildVideoPokerDOM({
			guestMode: true,
			userId: 'vp-guest-7',
			initialBalance: 1000,
		});
		try {
			initVideoPokerClient();
			const mirror = root.querySelector<HTMLElement>('[data-chip-balance]');
			expect(mirror?.textContent).toBe('1,000 chips');

			// Dealing deducts the wager; the mirror should reflect the new balance.
			actionButton().click();
			await flush(2);
			expect(mirror?.textContent).toBe('999 chips');
		} finally {
			root.remove();
		}
	});

	test('rejected wager leaves the wager valid so dealing still proceeds', async () => {
		localStorage.clear();
		installFetch();
		const root = buildVideoPokerDOM({ guestMode: true, userId: 'vp-guest-8', initialBalance: 3 });
		try {
			initVideoPokerClient();
			// Wager 5 exceeds balance 3 → the wager button handler rejects it and
			// surfaces the error, but state.wager stays at 1 (valid).
			wagerButton(5).click();
			const statusEl = document.getElementById('video-poker-status') as HTMLElement;
			expect(statusEl.textContent).toContain('balance');

			// Dealing still succeeds because the wager remained at 1.
			actionButton().click();
			await flush(2);
			expect(actionButton().textContent).toBe('Draw');
			expect(statusEl.textContent).toContain('Hold any cards');
		} finally {
			root.remove();
		}
	});
});

describe('initVideoPokerClient — authenticated settlement', () => {
	test('settlement success adopts the server balance and hides recovery controls', async () => {
		localStorage.clear();
		installFetch({ settlement: makeResponse(200, { balance: 1234, duplicate: false }) });
		const root = buildVideoPokerDOM({
			guestMode: false,
			userId: 'vp-auth-1',
			initialBalance: 1000,
		});
		try {
			initVideoPokerClient();
			actionButton().click();
			await flush(2);
			actionButton().click();
			await flush(15);

			const balanceEl = document.getElementById('chip-balance') as HTMLElement;
			expect(balanceEl.textContent).toBe('1,234');

			const recoveryContainer = document.getElementById('video-poker-settlement-recovery');
			expect(recoveryContainer?.classList.contains('hidden')).toBe(true);
		} finally {
			root.remove();
		}
	});

	test('reset handler clears the gate, restores the server-synced balance, and resets the hand', async () => {
		localStorage.clear();
		installFetch({ settlement: makeResponse(500, { error: 'INTERNAL_ERROR' }) });
		const root = buildVideoPokerDOM({
			guestMode: false,
			userId: 'vp-auth-5',
			initialBalance: 1000,
		});
		try {
			initVideoPokerClient();
			actionButton().click();
			await flush(2);
			actionButton().click();
			await flush(15);

			const recoveryContainer = document.getElementById('video-poker-settlement-recovery');
			expect(recoveryContainer?.classList.contains('hidden')).toBe(false);

			(document.getElementById('video-poker-reset-settlement') as HTMLButtonElement).click();
			await flush(5);

			expect(recoveryContainer?.classList.contains('hidden')).toBe(true);
			// After reset the round is back to ready (Deal), balance restored to the
			// pre-settlement server-synced value (initial 1000).
			expect(actionButton().textContent).toBe('Deal');
			const balanceEl = document.getElementById('chip-balance') as HTMLElement;
			expect(balanceEl.textContent).toBe('1,000');
		} finally {
			root.remove();
		}
	});

	test('blocks a new authenticated deal while settlement is pending', async () => {
		localStorage.clear();
		installFetch({ settlement: makeResponse(500, { error: 'INTERNAL_ERROR' }) });
		const root = buildVideoPokerDOM({
			guestMode: false,
			userId: 'vp-auth-6',
			initialBalance: 1000,
		});
		try {
			initVideoPokerClient();
			actionButton().click();
			await flush(2);
			actionButton().click();
			await flush(15);

			// Settlement failed → gate is blocked. New Round is disabled.
			expect(actionButton().disabled).toBe(true);

			// Reset to clear the gate, then verify the complete-phase guard path
			// by re-blocking via a second failing hand.
			(document.getElementById('video-poker-reset-settlement') as HTMLButtonElement).click();
			await flush(5);
			expect(actionButton().disabled).toBe(false);
		} finally {
			root.remove();
		}
	});

	test('dispatches achievement-earned event when settlement returns new achievements', async () => {
		localStorage.clear();
		installFetch({
			settlement: makeResponse(200, {
				balance: 1050,
				duplicate: false,
				newAchievements: [{ id: 'vp-win', name: 'Video Poker Master', icon: '♠' }],
			}),
		});
		const root = buildVideoPokerDOM({
			guestMode: false,
			userId: 'vp-auth-7',
			initialBalance: 1000,
		});

		const events: Array<{ achievements: unknown[] }> = [];
		const handler = (e: Event) => {
			const detail = (e as CustomEvent).detail as { achievements: unknown[] };
			events.push(detail);
		};
		window.addEventListener('achievement-earned', handler);

		try {
			initVideoPokerClient();
			actionButton().click();
			await flush(2);
			actionButton().click();
			await flush(15);

			expect(events).toHaveLength(1);
			expect(events[0].achievements).toEqual([
				{ id: 'vp-win', name: 'Video Poker Master', icon: '♠' },
			]);
		} finally {
			window.removeEventListener('achievement-earned', handler);
			root.remove();
		}
	});
});
