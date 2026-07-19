import { afterEach, describe, expect, it } from 'bun:test';
import { initRouletteClient } from './rouletteClient';
import { CHIP_DENOMINATIONS } from './constants';
import {
	attachToBody,
	installMockDocument,
	installMockFetch,
	installMockTimers,
	installMockWindow,
	installMockCrypto,
	installMockLocalStorage,
	makeChipSelect,
	makeFetchResponse,
	MockElement,
	MockEvent,
	type FetchMock,
	type MockDocumentSetup,
	type TimerMock,
	type WindowMock,
} from './test-dom-mock';

// Save originals so afterEach can restore them — the mock installs replace
// globalThis.setTimeout/fetch/crypto/etc. and would leak into subsequent
// test files (e.g. the Miniflare integration tests that need real timers).
const REAL_TIMERS = {
	setTimeout: globalThis.setTimeout,
	clearTimeout: globalThis.clearTimeout,
};
const REAL_FETCH = globalThis.fetch;
const REAL_CRYPTO = globalThis.crypto;
const REAL_DOCUMENT = (globalThis as { document?: unknown }).document;
const REAL_WINDOW = (globalThis as { window?: unknown }).window;
const REAL_LOCAL_STORAGE = (globalThis as { localStorage?: unknown }).localStorage;
const REAL_CUSTOM_EVENT = (globalThis as { CustomEvent?: unknown }).CustomEvent;
const REAL_HTML_BUTTON_ELEMENT = (globalThis as { HTMLButtonElement?: unknown }).HTMLButtonElement;

afterEach(() => {
	(globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout = REAL_TIMERS.setTimeout;
	(globalThis as unknown as { clearTimeout: typeof setTimeout }).clearTimeout =
		REAL_TIMERS.clearTimeout;
	(globalThis as unknown as { fetch: typeof fetch }).fetch = REAL_FETCH;
	(globalThis as typeof globalThis & { crypto: typeof crypto }).crypto = REAL_CRYPTO;
	(globalThis as { document?: unknown }).document = REAL_DOCUMENT;
	(globalThis as { window?: unknown }).window = REAL_WINDOW;
	(globalThis as { localStorage?: unknown }).localStorage = REAL_LOCAL_STORAGE;
	(globalThis as { CustomEvent?: unknown }).CustomEvent = REAL_CUSTOM_EVENT;
	(globalThis as { HTMLButtonElement?: unknown }).HTMLButtonElement = REAL_HTML_BUTTON_ELEMENT;
});

// All element IDs that RouletteUIRenderer + initRouletteClient touch.
const ALL_IDS = [
	'roulette-root',
	'roulette-wheel',
	'wheel-result',
	'chip-balance',
	'total-bet',
	'active-bets',
	'round-history',
	'spin-button',
	'clear-bets-button',
	'new-round-button',
	'game-phase',
	'net-delta',
	'bet-results',
	'game-message',
	'rules-toggle',
	'rules-panel',
	'rules-toggle-icon',
	'achievement-toast',
	'achievement-icon',
	'achievement-name',
];

interface SetupOptions {
	initialBalance?: number;
	userId?: string;
	guestMode?: boolean;
	session?: Record<string, unknown>;
	guestBankroll?: number;
	fetchImpl?: (url: string, init?: RequestInit) => unknown;
}

interface SetupResult {
	doc: MockDocumentSetup;
	storage: Storage;
	fetchMock: FetchMock;
	timers: TimerMock;
	win: WindowMock;
	root: MockElement;
	chipSelects: MockElement[];
	betCells: Record<string, MockElement>;
	spinBtn: MockElement;
	clearBtn: MockElement;
	newRoundBtn: MockElement;
	rulesToggle: MockElement;
	rulesPanel: MockElement;
	rulesToggleIcon: MockElement;
	gameMessage: MockElement;
	activeBetsEl: MockElement;
	balanceEl: MockElement;
}

function setup(options: SetupOptions = {}): SetupResult {
	const initialBalance = options.initialBalance ?? 1000;
	const userId = options.userId ?? 'user1';
	const isGuest = options.guestMode ?? false;

	const storage = installMockLocalStorage();
	const timers = installMockTimers();
	const win = installMockWindow();
	installMockCrypto({
		randomUUID: () => 'test-sync-id',
		getRandomValues: (buf) => {
			buf[0] = 17; // deterministic: 17 % 37 = 17
			return buf;
		},
	});

	const doc = installMockDocument(ALL_IDS);
	const root = doc.elements['roulette-root'];
	root.dataset.initialBalance = String(initialBalance);
	root.dataset.userId = userId;
	root.dataset.guestMode = isGuest ? 'true' : 'false';

	// Chip-select buttons
	const chipSelects = CHIP_DENOMINATIONS.map((d) => makeChipSelect(d, d === 5));

	// Bet table cells
	const redCell = new MockElement('div');
	redCell.dataset.betType = 'red';
	attachToBody(redCell);
	const blackCell = new MockElement('div');
	blackCell.dataset.betType = 'black';
	attachToBody(blackCell);
	const straightCell = new MockElement('div');
	straightCell.dataset.betType = 'straight';
	straightCell.dataset.betTarget = '17';
	attachToBody(straightCell);

	// Guest bankroll
	if (options.guestBankroll !== undefined) {
		storage.setItem(`roulette-bankroll:${userId}`, String(options.guestBankroll));
	}

	// Session snapshot
	if (options.session) {
		storage.setItem(`roulette-session:${userId}`, JSON.stringify(options.session));
	}

	// Default fetch mock returns empty 200
	const fetchMock = installMockFetch(options.fetchImpl as FetchMock['impl'] | undefined);

	initRouletteClient();

	return {
		doc,
		storage,
		fetchMock,
		timers,
		win,
		root,
		chipSelects,
		betCells: { red: redCell, black: blackCell, straight: straightCell },
		spinBtn: doc.elements['spin-button'],
		clearBtn: doc.elements['clear-bets-button'],
		newRoundBtn: doc.elements['new-round-button'],
		rulesToggle: doc.elements['rules-toggle'],
		rulesPanel: doc.elements['rules-panel'],
		rulesToggleIcon: doc.elements['rules-toggle-icon'],
		gameMessage: doc.elements['game-message'],
		activeBetsEl: doc.elements['active-bets'],
		balanceEl: doc.elements['chip-balance'],
	};
}

// Drain microtask queue so async event handlers settle.
async function flush(): Promise<void> {
	for (let i = 0; i < 30; i++) await Promise.resolve();
}

// Make a successful spin response body.
function spinResponseBody(winningNumber = 17, netDelta = -10, newBalance = 990) {
	return {
		winningNumber,
		netDelta,
		results: [{ bet: { id: 'b1', type: 'red', amount: 10 }, won: false, payout: 0 }],
		newBalance,
	};
}

function spinResponseWithAchievements() {
	return {
		winningNumber: 17,
		netDelta: 350,
		results: [
			{ bet: { id: 'b1', type: 'straight', amount: 10, target: 17 }, won: true, payout: 360 },
		],
		newBalance: 1350,
		newAchievements: [{ id: 'a1', name: 'High Roller', icon: '🏆' }],
	};
}

function betEntries(el: MockElement): MockElement[] {
	return el.children.filter((c) => c.id.startsWith('active-bet-'));
}

describe('initRouletteClient — guest mode', () => {
	it('initializes with guest bankroll and restores session', () => {
		const s = setup({ guestMode: true, guestBankroll: 500 });
		expect(s.balanceEl.textContent).toContain('500');
	});

	it('selects a chip denomination on click', () => {
		const s = setup({ guestMode: true });
		s.chipSelects[3].dispatchEvent(new MockEvent('click')); // 25
		expect(s.chipSelects[3].classList.contains('selected')).toBe(true);
		expect(s.chipSelects[1].classList.contains('selected')).toBe(false);
	});

	it('persists selected chip denomination to session on click', () => {
		// Without persisting the chip selection, a reload before any other
		// action restores the default chip (5) instead of the player's pick.
		const s = setup({ guestMode: true, userId: 'user-chip-persist' });
		s.chipSelects[3].dispatchEvent(new MockEvent('click')); // 25
		const raw = s.storage.getItem('roulette-session:user-chip-persist');
		expect(raw).not.toBeNull();
		const parsed = JSON.parse(raw!) as { selectedChipAmount: number };
		expect(parsed.selectedChipAmount).toBe(25);
	});

	it('restores persisted chip denomination on re-init', () => {
		// Simulate a reload: seed localStorage with a session snapshot that
		// carries selectedChipAmount=25, then re-init. The UI should reflect
		// the restored chip, not fall back to the default 5.
		const session = {
			phase: 'betting',
			activeBets: [],
			chipBalance: 1000,
			selectedChipAmount: 25,
			lastSpin: null,
			roundHistory: [],
			pendingSyncId: null,
		};
		const s = setup({ guestMode: true, userId: 'user-chip-restore', session });
		expect(s.chipSelects[3].classList.contains('selected')).toBe(true);
		expect(s.chipSelects[1].classList.contains('selected')).toBe(false);
	});

	it('places a bet via table cell click', () => {
		const s = setup({ guestMode: true });
		s.betCells.red.dispatchEvent(new MockEvent('click'));
		expect(betEntries(s.activeBetsEl).length).toBeGreaterThan(0);
	});

	it('places a bet via keyboard (Enter)', () => {
		const s = setup({ guestMode: true });
		s.betCells.red.dispatchEvent(new MockEvent('keydown', { key: 'Enter' }));
		expect(betEntries(s.activeBetsEl).length).toBeGreaterThan(0);
	});

	it('places a bet via keyboard (Space)', () => {
		const s = setup({ guestMode: true });
		s.betCells.black.dispatchEvent(new MockEvent('keydown', { key: ' ' }));
		expect(betEntries(s.activeBetsEl).length).toBeGreaterThan(0);
	});

	it('does not place a bet when phase is not betting', async () => {
		const s = setup({ guestMode: true });
		s.betCells.red.dispatchEvent(new MockEvent('click'));
		expect(betEntries(s.activeBetsEl).length).toBeGreaterThan(0);
		s.spinBtn.dispatchEvent(new MockEvent('click'));
		await flush();
		const countBefore = betEntries(s.activeBetsEl).length;
		s.betCells.black.dispatchEvent(new MockEvent('click'));
		expect(betEntries(s.activeBetsEl).length).toBe(countBefore);
	});

	it('removes a bet by clicking in active-bets sidebar', () => {
		const s = setup({ guestMode: true });
		s.betCells.red.dispatchEvent(new MockEvent('click'));
		expect(betEntries(s.activeBetsEl).length).toBeGreaterThan(0);
		const entry = betEntries(s.activeBetsEl)[0];
		const event = new MockEvent('click');
		event.target = entry;
		s.activeBetsEl.dispatchEvent(event);
		expect(betEntries(s.activeBetsEl)).toHaveLength(0);
	});

	it('clears all bets on clear-bets-button click', () => {
		const s = setup({ guestMode: true });
		s.betCells.red.dispatchEvent(new MockEvent('click'));
		s.betCells.black.dispatchEvent(new MockEvent('click'));
		expect(betEntries(s.activeBetsEl)).toHaveLength(2);
		s.clearBtn.dispatchEvent(new MockEvent('click'));
		expect(betEntries(s.activeBetsEl)).toHaveLength(0);
	});

	it('spins in guest mode with local settlement', async () => {
		const s = setup({ guestMode: true });
		s.betCells.red.dispatchEvent(new MockEvent('click'));
		s.spinBtn.dispatchEvent(new MockEvent('click'));
		await flush();
		expect(s.newRoundBtn.hidden).toBe(false);
		expect(s.spinBtn.hidden).toBe(true);
		// 17 is black → red bet of 5 loses → balance 1000 - 5 = 995
		expect(s.balanceEl.textContent).toContain('995');
	});

	it('starts a new round on new-round-button click', async () => {
		const s = setup({ guestMode: true });
		s.betCells.red.dispatchEvent(new MockEvent('click'));
		s.spinBtn.dispatchEvent(new MockEvent('click'));
		await flush();
		expect(s.newRoundBtn.hidden).toBe(false);
		s.newRoundBtn.dispatchEvent(new MockEvent('click'));
		expect(s.spinBtn.hidden).toBe(false);
		expect(s.newRoundBtn.hidden).toBe(true);
	});

	it('clears pending result timer on new round', async () => {
		const s = setup({ guestMode: true });
		s.betCells.red.dispatchEvent(new MockEvent('click'));
		s.spinBtn.dispatchEvent(new MockEvent('click'));
		await flush();
		expect(s.timers.pending.length).toBeGreaterThan(0);
		s.newRoundBtn.dispatchEvent(new MockEvent('click'));
		expect(s.timers.pending).toHaveLength(0);
	});

	it('toggles rules panel on rules-toggle click', () => {
		const s = setup({ guestMode: true });
		s.rulesToggle.setAttribute('aria-expanded', 'false');
		s.rulesPanel.hidden = true;
		s.rulesToggle.dispatchEvent(new MockEvent('click'));
		expect(s.rulesToggle.getAttribute('aria-expanded')).toBe('true');
		expect(s.rulesPanel.hidden).toBe(false);
		expect(s.rulesToggleIcon.textContent).toBe('▾');
		s.rulesToggle.dispatchEvent(new MockEvent('click'));
		expect(s.rulesToggle.getAttribute('aria-expanded')).toBe('false');
		expect(s.rulesPanel.hidden).toBe(true);
		expect(s.rulesToggleIcon.textContent).toBe('▸');
	});

	it('shows a message when bet placement fails', () => {
		const s = setup({ guestMode: true, initialBalance: 5 });
		// Select 100 chip (exceeds balance of 5)
		s.chipSelects[5].dispatchEvent(new MockEvent('click')); // 100
		s.betCells.red.dispatchEvent(new MockEvent('click'));
		expect(s.gameMessage.textContent).not.toBe('');
	});

	it('persists guest bankroll after spin', async () => {
		const s = setup({ guestMode: true, userId: 'guest-user' });
		s.betCells.red.dispatchEvent(new MockEvent('click'));
		s.spinBtn.dispatchEvent(new MockEvent('click'));
		await flush();
		const bankroll = s.storage.getItem('roulette-bankroll:guest-user');
		expect(bankroll).toBeDefined();
		expect(Number(bankroll)).toBe(995);
	});

	it('persists session to localStorage', () => {
		const s = setup({ guestMode: true, userId: 'g1' });
		s.betCells.red.dispatchEvent(new MockEvent('click'));
		const raw = s.storage.getItem('roulette-session:g1');
		expect(raw).toBeDefined();
		const parsed = JSON.parse(raw);
		expect(parsed.phase).toBe('betting');
		expect(parsed.activeBets).toHaveLength(1);
	});

	it('flushes result timer to show result after animation', async () => {
		const s = setup({ guestMode: true });
		s.betCells.red.dispatchEvent(new MockEvent('click'));
		s.spinBtn.dispatchEvent(new MockEvent('click'));
		await flush();
		expect(s.timers.pending.length).toBeGreaterThan(0);
		s.timers.flush();
		const resultEl = s.doc.elements['wheel-result'];
		expect(resultEl.textContent).toContain('17');
	});
});

describe('initRouletteClient — auth mode spin success', () => {
	it('settles a spin from the server response', async () => {
		const s = setup({ guestMode: false });
		s.fetchMock.impl = () => makeFetchResponse(200, spinResponseBody(17, -10, 990));
		s.betCells.red.dispatchEvent(new MockEvent('click'));
		s.spinBtn.dispatchEvent(new MockEvent('click'));
		await flush();
		expect(s.fetchMock.calls).toHaveLength(1);
		expect(s.fetchMock.calls[0].url).toBe('/api/roulette/spin');
		expect(s.newRoundBtn.hidden).toBe(false);
		expect(s.balanceEl.textContent).toContain('990');
	});

	it('dispatches achievement-earned event when server returns achievements', async () => {
		const s = setup({ guestMode: false });
		s.fetchMock.impl = () => makeFetchResponse(200, spinResponseWithAchievements());
		const captured: Array<{ achievements: unknown }> = [];
		s.win.addEventListener('achievement-earned', (e) => {
			captured.push((e as { detail: { achievements: unknown } }).detail);
		});
		s.betCells.straight.dispatchEvent(new MockEvent('click'));
		s.spinBtn.dispatchEvent(new MockEvent('click'));
		await flush();
		expect(captured).toHaveLength(1);
		expect(captured[0].achievements).toEqual([{ id: 'a1', name: 'High Roller', icon: '🏆' }]);
	});

	it('persists session after successful spin', async () => {
		const s = setup({ guestMode: false, userId: 'u1' });
		s.fetchMock.impl = () => makeFetchResponse(200, spinResponseBody(17, -10, 990));
		s.betCells.red.dispatchEvent(new MockEvent('click'));
		s.spinBtn.dispatchEvent(new MockEvent('click'));
		await flush();
		const raw = s.storage.getItem('roulette-session:u1');
		expect(raw).toBeDefined();
		const parsed = JSON.parse(raw);
		expect(parsed.phase).toBe('settled');
		expect(parsed.chipBalance).toBe(990);
	});

	it('flushes result timer to show result after animation', async () => {
		const s = setup({ guestMode: false });
		s.fetchMock.impl = () => makeFetchResponse(200, spinResponseBody(17, -10, 990));
		s.betCells.red.dispatchEvent(new MockEvent('click'));
		s.spinBtn.dispatchEvent(new MockEvent('click'));
		await flush();
		expect(s.timers.pending.length).toBeGreaterThan(0);
		s.timers.flush();
		const resultEl = s.doc.elements['wheel-result'];
		expect(resultEl.textContent).toContain('17');
	});
});

describe('initRouletteClient — auth mode spin rejections (non-committed)', () => {
	it('preserves bets on 429 rate limit (no currentBalance)', async () => {
		const s = setup({ guestMode: false });
		s.fetchMock.impl = () => makeFetchResponse(429, { error: 'RATE_LIMITED' });
		s.betCells.red.dispatchEvent(new MockEvent('click'));
		s.spinBtn.dispatchEvent(new MockEvent('click'));
		await flush();
		expect(s.spinBtn.hidden).toBe(false);
		expect(betEntries(s.activeBetsEl).length).toBeGreaterThan(0);
		expect(s.gameMessage.textContent).toContain('wait');
	});

	it('discards bets on 429 rate limit when server balance < totalBet', async () => {
		// Another tab/game reduced the account balance below the stake
		// during the in-flight spin. Preserving the bets would let Clear
		// refund totalBet on top of the stale local balance, displaying
		// chips not in the account.
		const s = setup({ guestMode: false });
		s.fetchMock.impl = (url) => {
			if (url === '/api/chips/balance') return makeFetchResponse(200, { balance: 3 });
			return makeFetchResponse(429, { error: 'RATE_LIMITED' });
		};
		s.betCells.red.dispatchEvent(new MockEvent('click'));
		s.spinBtn.dispatchEvent(new MockEvent('click'));
		await flush();
		expect(s.balanceEl.textContent).toContain('3');
		expect(betEntries(s.activeBetsEl)).toHaveLength(0);
	});

	it('adopts server balance and discards bets on INSUFFICIENT_BALANCE', async () => {
		const s = setup({ guestMode: false });
		s.fetchMock.impl = (url) => {
			if (url === '/api/roulette/spin')
				return makeFetchResponse(400, { error: 'INSUFFICIENT_BALANCE' });
			return makeFetchResponse(200, { balance: 800 });
		};
		s.betCells.red.dispatchEvent(new MockEvent('click'));
		s.spinBtn.dispatchEvent(new MockEvent('click'));
		await flush();
		expect(s.balanceEl.textContent).toContain('800');
		expect(betEntries(s.activeBetsEl)).toHaveLength(0);
		expect(s.gameMessage.textContent).toContain('Insufficient');
	});

	it('falls back to abortSpin when balance fetch fails on INSUFFICIENT_BALANCE', async () => {
		const s = setup({ guestMode: false });
		s.fetchMock.impl = (url) => {
			if (url === '/api/roulette/spin')
				return makeFetchResponse(400, { error: 'INSUFFICIENT_BALANCE' });
			return makeFetchResponse(500, {});
		};
		s.betCells.red.dispatchEvent(new MockEvent('click'));
		s.spinBtn.dispatchEvent(new MockEvent('click'));
		await flush();
		expect(betEntries(s.activeBetsEl).length).toBeGreaterThan(0);
	});

	it('adopts currentBalance and discards bets on MP_ESCROW_ACTIVE', async () => {
		const s = setup({ guestMode: false });
		s.fetchMock.impl = () =>
			makeFetchResponse(409, { error: 'MP_ESCROW_ACTIVE', currentBalance: 700 });
		s.betCells.red.dispatchEvent(new MockEvent('click'));
		s.spinBtn.dispatchEvent(new MockEvent('click'));
		await flush();
		expect(s.balanceEl.textContent).toContain('700');
		expect(betEntries(s.activeBetsEl)).toHaveLength(0);
		expect(s.gameMessage.textContent).toContain('multiplayer poker');
	});

	it('preserves bets on SYNC_ID_REUSE_MISMATCH (no currentBalance)', async () => {
		const s = setup({ guestMode: false });
		s.fetchMock.impl = () => makeFetchResponse(409, { error: 'SYNC_ID_REUSE_MISMATCH' });
		s.betCells.red.dispatchEvent(new MockEvent('click'));
		s.spinBtn.dispatchEvent(new MockEvent('click'));
		await flush();
		expect(betEntries(s.activeBetsEl).length).toBeGreaterThan(0);
		expect(s.gameMessage.textContent).toContain('conflict');
	});

	it('preserves bets on 400 INVALID_BETS (no currentBalance)', async () => {
		const s = setup({ guestMode: false });
		s.fetchMock.impl = () => makeFetchResponse(400, { error: 'INVALID_BETS' });
		s.betCells.red.dispatchEvent(new MockEvent('click'));
		s.spinBtn.dispatchEvent(new MockEvent('click'));
		await flush();
		expect(betEntries(s.activeBetsEl).length).toBeGreaterThan(0);
	});

	it('preserves bets on 401 UNAUTHORIZED', async () => {
		const s = setup({ guestMode: false });
		s.fetchMock.impl = () => makeFetchResponse(401, { error: 'UNAUTHORIZED' });
		s.betCells.red.dispatchEvent(new MockEvent('click'));
		s.spinBtn.dispatchEvent(new MockEvent('click'));
		await flush();
		expect(betEntries(s.activeBetsEl).length).toBeGreaterThan(0);
	});

	it('preserves bets on 403 FORBIDDEN', async () => {
		const s = setup({ guestMode: false });
		s.fetchMock.impl = () => makeFetchResponse(403, { error: 'FORBIDDEN' });
		s.betCells.red.dispatchEvent(new MockEvent('click'));
		s.spinBtn.dispatchEvent(new MockEvent('click'));
		await flush();
		expect(betEntries(s.activeBetsEl).length).toBeGreaterThan(0);
	});
});

describe('initRouletteClient — auth mode spin retry', () => {
	it('retries on TypeError (network failure) and succeeds', async () => {
		const s = setup({ guestMode: false });
		let callCount = 0;
		s.fetchMock.impl = () => {
			callCount++;
			if (callCount === 1) throw new TypeError('fetch failed');
			return makeFetchResponse(200, spinResponseBody(17, -10, 990));
		};
		s.betCells.red.dispatchEvent(new MockEvent('click'));
		s.spinBtn.dispatchEvent(new MockEvent('click'));
		await flush();
		s.timers.flush(); // flush the wheel-animation timer to render the result
		expect(s.fetchMock.calls).toHaveLength(2);
		expect(s.newRoundBtn.hidden).toBe(false);
		expect(s.balanceEl.textContent).toContain('990');
	});

	it('refreshes UI immediately after a successful retry (before animation timer)', async () => {
		// The retry path must update the renderer as soon as the settlement is
		// applied, mirroring the normal and recovery paths. During the 4s wheel
		// animation the DOM should already reflect the 'settled' phase, updated
		// balance, and cleared active bets — not the stale 'spinning' state.
		const s = setup({ guestMode: false });
		let callCount = 0;
		s.fetchMock.impl = () => {
			callCount++;
			if (callCount === 1) throw new TypeError('fetch failed');
			return makeFetchResponse(200, spinResponseBody(17, -10, 990));
		};
		s.betCells.red.dispatchEvent(new MockEvent('click'));
		s.spinBtn.dispatchEvent(new MockEvent('click'));
		await flush();
		// BEFORE flushing the animation timer — the UI must already show the
		// settled balance and phase, not the pre-spin spinning state.
		expect(s.balanceEl.textContent).toContain('990');
		expect(s.newRoundBtn.hidden).toBe(false);
		expect(betEntries(s.activeBetsEl).length).toBe(0);
		s.timers.flush();
		expect(s.fetchMock.calls).toHaveLength(2);
	});

	it('retries on 500 server error and succeeds', async () => {
		const s = setup({ guestMode: false });
		let callCount = 0;
		s.fetchMock.impl = () => {
			callCount++;
			if (callCount === 1) return makeFetchResponse(500, { error: 'INTERNAL_ERROR' });
			return makeFetchResponse(200, spinResponseBody(17, -10, 990));
		};
		s.betCells.red.dispatchEvent(new MockEvent('click'));
		s.spinBtn.dispatchEvent(new MockEvent('click'));
		await flush();
		s.timers.flush();
		expect(s.fetchMock.calls).toHaveLength(2);
		expect(s.newRoundBtn.hidden).toBe(false);
	});

	it('retries on 409 CONCURRENT_MODIFICATION and succeeds', async () => {
		const s = setup({ guestMode: false });
		let callCount = 0;
		s.fetchMock.impl = () => {
			callCount++;
			if (callCount === 1) return makeFetchResponse(409, { error: 'CONCURRENT_MODIFICATION' });
			return makeFetchResponse(200, spinResponseBody(17, -10, 990));
		};
		s.betCells.red.dispatchEvent(new MockEvent('click'));
		s.spinBtn.dispatchEvent(new MockEvent('click'));
		await flush();
		s.timers.flush();
		expect(s.fetchMock.calls).toHaveLength(2);
		expect(s.newRoundBtn.hidden).toBe(false);
	});

	it('retries on 502 and succeeds with achievements', async () => {
		const s = setup({ guestMode: false });
		let callCount = 0;
		s.fetchMock.impl = () => {
			callCount++;
			if (callCount === 1) return makeFetchResponse(502, { error: 'HTTP 502' });
			return makeFetchResponse(200, spinResponseWithAchievements());
		};
		s.betCells.straight.dispatchEvent(new MockEvent('click'));
		s.spinBtn.dispatchEvent(new MockEvent('click'));
		await flush();
		s.timers.flush();
		expect(s.fetchMock.calls).toHaveLength(2);
		expect(s.balanceEl.textContent).toContain('1,350');
	});

	it('retry gets non-committed rejection → preserves bets', async () => {
		const s = setup({ guestMode: false });
		let callCount = 0;
		s.fetchMock.impl = () => {
			callCount++;
			if (callCount === 1) return makeFetchResponse(500, { error: 'INTERNAL_ERROR' });
			return makeFetchResponse(429, { error: 'RATE_LIMITED' });
		};
		s.betCells.red.dispatchEvent(new MockEvent('click'));
		s.spinBtn.dispatchEvent(new MockEvent('click'));
		await flush();
		expect(betEntries(s.activeBetsEl).length).toBeGreaterThan(0);
		expect(s.gameMessage.textContent).toContain('wait');
	});

	it('retry gets non-committed rejection with currentBalance → discards bets', async () => {
		const s = setup({ guestMode: false });
		let callCount = 0;
		s.fetchMock.impl = () => {
			callCount++;
			if (callCount === 1) return makeFetchResponse(500, { error: 'INTERNAL_ERROR' });
			return makeFetchResponse(409, { error: 'MP_ESCROW_ACTIVE', currentBalance: 600 });
		};
		s.betCells.red.dispatchEvent(new MockEvent('click'));
		s.spinBtn.dispatchEvent(new MockEvent('click'));
		await flush();
		expect(s.balanceEl.textContent).toContain('600');
		expect(betEntries(s.activeBetsEl)).toHaveLength(0);
	});

	it('retry gets non-committed rejection without currentBalance, server balance < totalBet → discards bets', async () => {
		// Another tab/game reduced the account balance below the stake
		// during the in-flight spin. The retry receives a definitive
		// rejection (e.g. 429) without currentBalance. Preserving the bets
		// would let Clear refund totalBet on top of the stale local balance,
		// displaying chips the account does not have. Mirror the initial
		// rejection path: fetch the authoritative balance and discard the
		// unaffordable bets.
		const s = setup({ guestMode: false });
		let callCount = 0;
		s.fetchMock.impl = (url) => {
			if (url === '/api/chips/balance') return makeFetchResponse(200, { balance: 3 });
			callCount++;
			if (callCount === 1) return makeFetchResponse(500, { error: 'INTERNAL_ERROR' });
			return makeFetchResponse(429, { error: 'RATE_LIMITED' });
		};
		s.betCells.red.dispatchEvent(new MockEvent('click'));
		s.spinBtn.dispatchEvent(new MockEvent('click'));
		await flush();
		expect(s.balanceEl.textContent).toContain('3');
		expect(betEntries(s.activeBetsEl)).toHaveLength(0);
	});

	it('retry gets non-committed rejection without currentBalance, server balance covers bets → preserves bets rebased to server', async () => {
		// Server balance covers the stake. Preserve the bets so the player
		// can re-spin the same layout, but rebase the local balance to
		// serverBalance - totalBet so a later Clear refunds back to the
		// server balance rather than inflating above it.
		const s = setup({ guestMode: false });
		let callCount = 0;
		s.fetchMock.impl = (url) => {
			if (url === '/api/chips/balance') return makeFetchResponse(200, { balance: 800 });
			callCount++;
			if (callCount === 1) return makeFetchResponse(500, { error: 'INTERNAL_ERROR' });
			return makeFetchResponse(429, { error: 'RATE_LIMITED' });
		};
		s.betCells.red.dispatchEvent(new MockEvent('click'));
		s.spinBtn.dispatchEvent(new MockEvent('click'));
		await flush();
		// serverBalance(800) - totalBet(5) = 795
		expect(s.balanceEl.textContent).toContain('795');
		expect(betEntries(s.activeBetsEl).length).toBeGreaterThan(0);
	});

	it('retry fails with retriable error → balance recovery succeeds', async () => {
		const s = setup({ guestMode: false });
		s.fetchMock.impl = (url) => {
			if (url === '/api/chips/balance') return makeFetchResponse(200, { balance: 950 });
			return makeFetchResponse(500, { error: 'INTERNAL_ERROR' });
		};
		s.betCells.red.dispatchEvent(new MockEvent('click'));
		s.spinBtn.dispatchEvent(new MockEvent('click'));
		await flush();
		expect(s.fetchMock.calls.filter((c) => c.url === '/api/roulette/spin')).toHaveLength(2);
		expect(s.fetchMock.calls.some((c) => c.url === '/api/chips/balance')).toBe(true);
		expect(s.balanceEl.textContent).toContain('950');
		expect(betEntries(s.activeBetsEl)).toHaveLength(0);
		expect(s.gameMessage.textContent).toContain('balance synced');
	});

	it('retry fails and balance recovery fails → refresh message', async () => {
		const s = setup({ guestMode: false });
		s.fetchMock.impl = (url) => {
			if (url === '/api/chips/balance') return makeFetchResponse(500, {});
			return makeFetchResponse(500, { error: 'INTERNAL_ERROR' });
		};
		s.betCells.red.dispatchEvent(new MockEvent('click'));
		s.spinBtn.dispatchEvent(new MockEvent('click'));
		await flush();
		expect(s.gameMessage.textContent).toContain('refresh');
	});

	it('retry throws TypeError → balance recovery succeeds', async () => {
		const s = setup({ guestMode: false });
		s.fetchMock.impl = (url) => {
			if (url === '/api/chips/balance') return makeFetchResponse(200, { balance: 950 });
			throw new TypeError('network failed');
		};
		s.betCells.red.dispatchEvent(new MockEvent('click'));
		s.spinBtn.dispatchEvent(new MockEvent('click'));
		await flush();
		expect(s.balanceEl.textContent).toContain('950');
		expect(betEntries(s.activeBetsEl)).toHaveLength(0);
	});
});

describe('initRouletteClient — auth mode spin ambiguous (2xx + unparseable body)', () => {
	it('marks receivedOkResponse and retries on 2xx with bad JSON', async () => {
		const s = setup({ guestMode: false });
		let callCount = 0;
		s.fetchMock.impl = () => {
			callCount++;
			if (callCount === 1) {
				// 2xx with a body that cannot be parsed as JSON — simulates a
				// truncated/garbled payload where response.json() rejects, the
				// real "unparseable body" path the retry guard defends.
				return {
					ok: true,
					status: 200,
					_json: null,
					json: async () => {
						throw new SyntaxError('Unexpected token in JSON');
					},
				};
			}
			return makeFetchResponse(200, spinResponseBody(17, -10, 990));
		};
		s.betCells.red.dispatchEvent(new MockEvent('click'));
		s.spinBtn.dispatchEvent(new MockEvent('click'));
		await flush();
		expect(s.fetchMock.calls.length).toBeGreaterThanOrEqual(2);
	});
});

describe('initRouletteClient — pending spin recovery', () => {
	function makeSpinningSnapshot(syncId: string, createdAt = Date.now()) {
		return {
			phase: 'spinning',
			chipBalance: 990,
			activeBets: [{ id: 'b1', type: 'red', amount: 10 }],
			selectedChipAmount: 5,
			lastSpin: null,
			roundHistory: [],
			pendingSyncId: syncId,
			pendingSyncCreatedAt: createdAt,
		};
	}

	it('recovers a pending spin successfully', async () => {
		const s = setup({
			guestMode: false,
			session: makeSpinningSnapshot('recovery-sync-id'),
			fetchImpl: () => makeFetchResponse(200, spinResponseBody(17, -10, 990)),
		});
		await flush();
		expect(s.fetchMock.calls).toHaveLength(1);
		expect(s.fetchMock.calls[0].url).toBe('/api/roulette/spin');
		expect(s.newRoundBtn.hidden).toBe(false);
		expect(s.balanceEl.textContent).toContain('990');
	});

	it('recovery replay adopts authoritative currentBalance over historical newBalance', async () => {
		// The replay response carries the historical settled newBalance (990)
		// for the spin result record AND the authoritative currentBalance
		// (1500) reflecting a subsequent win in another tab/game. The client
		// must adopt currentBalance as the live balance so the page doesn't
		// display/bet against stale chips.
		const s = setup({
			guestMode: false,
			session: makeSpinningSnapshot('recovery-sync-id'),
			fetchImpl: () =>
				makeFetchResponse(200, {
					winningNumber: 17,
					netDelta: -10,
					results: [{ bet: { id: 'b1', type: 'red', amount: 10 }, won: false, payout: 0 }],
					newBalance: 990,
					currentBalance: 1500,
				}),
		});
		await flush();
		expect(s.balanceEl.textContent).toContain('1,500');
		expect(s.balanceEl.textContent).not.toContain('990');
	});

	it('recovers with achievements', async () => {
		const s = setup({
			guestMode: false,
			session: makeSpinningSnapshot('recovery-sync-id'),
			fetchImpl: () => makeFetchResponse(200, spinResponseWithAchievements()),
		});
		const captured: Array<{ achievements: unknown }> = [];
		s.win.addEventListener('achievement-earned', (e) => {
			captured.push((e as { detail: { achievements: unknown } }).detail);
		});
		await flush();
		expect(s.balanceEl.textContent).toContain('1,350');
		expect(captured).toHaveLength(1);
		expect(captured[0].achievements).toEqual([{ id: 'a1', name: 'High Roller', icon: '🏆' }]);
	});

	it('recovery non-committed rejection without currentBalance → rebase + abortSpin', async () => {
		const s = setup({
			guestMode: false,
			session: makeSpinningSnapshot('recovery-sync-id'),
			fetchImpl: () => makeFetchResponse(429, { error: 'RATE_LIMITED' }),
		});
		// 429 on recovery triggers a retry past the rate-limit window.
		// Flush timers to fire the retry delay, then flush microtasks so
		// the retry + handleRecoveryRejection completes.
		await flush();
		s.timers.flush();
		await flush();
		expect(s.spinBtn.hidden).toBe(false);
		expect(betEntries(s.activeBetsEl).length).toBeGreaterThan(0);
		expect(s.gameMessage.textContent).toContain('wait');
	});

	it('recovery rejection without currentBalance → discards bets when server balance < totalBet', async () => {
		// Another tab/game reduced the account balance below the restored
		// stake. Preserving the bets would let Clear refund totalBet into
		// chips not in the account (setBalance clamps the rebase to 0).
		const s = setup({
			guestMode: false,
			initialBalance: 5,
			session: makeSpinningSnapshot('recovery-sync-id'),
			fetchImpl: (url) => {
				if (url === '/api/chips/balance') return makeFetchResponse(200, { balance: 5 });
				return makeFetchResponse(429, { error: 'RATE_LIMITED' });
			},
		});
		await flush();
		s.timers.flush();
		await flush();
		expect(s.balanceEl.textContent).toContain('5');
		expect(betEntries(s.activeBetsEl)).toHaveLength(0);
	});

	it('recovery rejection without currentBalance → discards bets when balance fetch fails and restored balance < totalBet', async () => {
		// Balance fetch fails, but the restored balance (balanceOverride)
		// is already below totalBet — guard with it rather than preserving
		// unaffordable bets.
		const s = setup({
			guestMode: false,
			initialBalance: 5,
			session: makeSpinningSnapshot('recovery-sync-id'),
			fetchImpl: (url) => {
				if (url === '/api/chips/balance') return makeFetchResponse(500, {});
				return makeFetchResponse(429, { error: 'RATE_LIMITED' });
			},
		});
		await flush();
		s.timers.flush();
		await flush();
		expect(betEntries(s.activeBetsEl)).toHaveLength(0);
	});

	it('recovery non-committed rejection with currentBalance → discard bets', async () => {
		const s = setup({
			guestMode: false,
			session: makeSpinningSnapshot('recovery-sync-id'),
			fetchImpl: () =>
				makeFetchResponse(400, { error: 'INSUFFICIENT_BALANCE', currentBalance: 850 }),
		});
		await flush();
		expect(s.balanceEl.textContent).toContain('850');
		expect(betEntries(s.activeBetsEl)).toHaveLength(0);
	});

	it('recovery 429 then retry succeeds (committed-spin race) → settles with cached result', async () => {
		// The original in-flight spin committed and set the rate-limit
		// timestamp, but the recovery re-submit's idempotency SELECT raced
		// with the commit and found nothing — so the server returns 429.
		// The recovery path waits out the rate-limit window and retries;
		// the retry's idempotency check now finds the committed row and
		// returns the cached result. Without the 429-retry, the recovery
		// would treat 429 as a non-committed rejection and abandon the
		// committed spin's result/achievement.
		let spinCallCount = 0;
		const s = setup({
			guestMode: false,
			session: makeSpinningSnapshot('recovery-sync-id'),
			fetchImpl: (url) => {
				if (url === '/api/roulette/spin') {
					spinCallCount++;
					if (spinCallCount === 1) {
						return makeFetchResponse(429, { error: 'RATE_LIMITED' }, { 'Retry-After': '2' });
					}
					return makeFetchResponse(200, spinResponseBody(17, 350, 1350));
				}
				return makeFetchResponse(200, { balance: 1350 });
			},
		});
		await flush();
		s.timers.flush();
		await flush();
		expect(spinCallCount).toBe(2);
		expect(s.newRoundBtn.hidden).toBe(false);
		expect(s.balanceEl.textContent).toContain('1,350');
	});

	it('recovery 429 then retry gets second 429 → treats as non-committed rejection', async () => {
		// Both the first attempt and the retry get 429 — the spin genuinely
		// didn't commit (the rate limit was set by a different spin). The
		// retry's 429 is a definitive non-committed rejection, so the
		// recovery path preserves the bets for re-spinning.
		let spinCallCount = 0;
		const s = setup({
			guestMode: false,
			session: makeSpinningSnapshot('recovery-sync-id'),
			fetchImpl: (url) => {
				if (url === '/api/roulette/spin') {
					spinCallCount++;
					return makeFetchResponse(429, { error: 'RATE_LIMITED' });
				}
				return makeFetchResponse(200, { balance: 990 });
			},
		});
		await flush();
		s.timers.flush();
		await flush();
		expect(spinCallCount).toBe(2);
		expect(s.spinBtn.hidden).toBe(false);
		expect(betEntries(s.activeBetsEl).length).toBeGreaterThan(0);
		expect(s.gameMessage.textContent).toContain('wait');
	});

	it('recovery failure → balance recovery succeeds', async () => {
		const s = setup({
			guestMode: false,
			session: makeSpinningSnapshot('recovery-sync-id'),
			fetchImpl: (url) => {
				if (url === '/api/chips/balance') return makeFetchResponse(200, { balance: 980 });
				return makeFetchResponse(500, { error: 'INTERNAL_ERROR' });
			},
		});
		await flush();
		expect(s.balanceEl.textContent).toContain('980');
		expect(betEntries(s.activeBetsEl)).toHaveLength(0);
		expect(s.gameMessage.textContent).toContain('balance synced');
	});

	it('recovery failure → balance recovery fails → retains spinning snapshot', async () => {
		// When both the retry and the balance fetch fail, the recovery path
		// must NOT discardActiveBets — clearing the pendingSyncId would
		// strip the only replay key, permanently losing the winning number
		// and achievement payload if the spin did commit. The snapshot is
		// retained so the next reload re-submits via idempotency replay.
		const s = setup({
			guestMode: false,
			session: makeSpinningSnapshot('recovery-sync-id'),
			fetchImpl: (url) => {
				if (url === '/api/chips/balance') return makeFetchResponse(500, {});
				return makeFetchResponse(500, { error: 'INTERNAL_ERROR' });
			},
		});
		await flush();
		expect(s.gameMessage.textContent).toContain('refresh');
		// Bets retained — not discarded — so a reload can replay the syncId.
		expect(betEntries(s.activeBetsEl).length).toBeGreaterThan(0);
		const stored = JSON.parse(s.storage.getItem('roulette-session:user1') ?? '{}');
		expect(stored.phase).toBe('spinning');
		expect(stored.pendingSyncId).toBe('recovery-sync-id');
	});

	it('recovery retries on 500 and succeeds', async () => {
		let spinCallCount = 0;
		const s = setup({
			guestMode: false,
			session: makeSpinningSnapshot('recovery-sync-id'),
			fetchImpl: (url) => {
				if (url === '/api/roulette/spin') {
					spinCallCount++;
					if (spinCallCount === 1) return makeFetchResponse(500, { error: 'INTERNAL_ERROR' });
					return makeFetchResponse(200, spinResponseBody(17, -10, 990));
				}
				return makeFetchResponse(200, { balance: 990 });
			},
		});
		await flush();
		expect(spinCallCount).toBe(2);
		expect(s.newRoundBtn.hidden).toBe(false);
		expect(s.balanceEl.textContent).toContain('990');
	});

	it('recovery retries on 409 CONCURRENT_MODIFICATION and succeeds', async () => {
		let spinCallCount = 0;
		const s = setup({
			guestMode: false,
			session: makeSpinningSnapshot('recovery-sync-id'),
			fetchImpl: (url) => {
				if (url === '/api/roulette/spin') {
					spinCallCount++;
					if (spinCallCount === 1)
						return makeFetchResponse(409, { error: 'CONCURRENT_MODIFICATION' });
					return makeFetchResponse(200, spinResponseBody(17, -10, 990));
				}
				return makeFetchResponse(200, { balance: 990 });
			},
		});
		await flush();
		expect(spinCallCount).toBe(2);
		expect(s.newRoundBtn.hidden).toBe(false);
		expect(s.balanceEl.textContent).toContain('990');
	});

	it('recovery retry gets non-committed rejection → preserves bets', async () => {
		let spinCallCount = 0;
		const s = setup({
			guestMode: false,
			session: makeSpinningSnapshot('recovery-sync-id'),
			fetchImpl: (url) => {
				if (url === '/api/roulette/spin') {
					spinCallCount++;
					if (spinCallCount === 1) return makeFetchResponse(500, { error: 'INTERNAL_ERROR' });
					return makeFetchResponse(429, { error: 'RATE_LIMITED' });
				}
				return makeFetchResponse(200, { balance: 990 });
			},
		});
		await flush();
		expect(spinCallCount).toBe(2);
		expect(s.spinBtn.hidden).toBe(false);
		expect(betEntries(s.activeBetsEl).length).toBeGreaterThan(0);
		expect(s.gameMessage.textContent).toContain('wait');
	});

	it('recovery retry gets non-committed rejection with currentBalance → discards bets', async () => {
		let spinCallCount = 0;
		const s = setup({
			guestMode: false,
			session: makeSpinningSnapshot('recovery-sync-id'),
			fetchImpl: (url) => {
				if (url === '/api/roulette/spin') {
					spinCallCount++;
					if (spinCallCount === 1) return makeFetchResponse(500, { error: 'INTERNAL_ERROR' });
					return makeFetchResponse(409, { error: 'MP_ESCROW_ACTIVE', currentBalance: 600 });
				}
				return makeFetchResponse(200, { balance: 600 });
			},
		});
		await flush();
		expect(spinCallCount).toBe(2);
		expect(s.balanceEl.textContent).toContain('600');
		expect(betEntries(s.activeBetsEl)).toHaveLength(0);
	});
});

describe('initRouletteClient — bets dropped on refresh', () => {
	it('shows toast when auth user had bets in betting phase on refresh', () => {
		const s = setup({
			guestMode: false,
			session: {
				phase: 'betting',
				chipBalance: 990,
				activeBets: [{ id: 'b1', type: 'red', amount: 10 }],
				selectedChipAmount: 5,
				lastSpin: null,
				roundHistory: [],
			},
		});
		expect(s.gameMessage.textContent).toContain('Bets cleared on refresh');
	});

	it('does not show toast when no bets in session', () => {
		const s = setup({
			guestMode: false,
			session: {
				phase: 'betting',
				chipBalance: 1000,
				activeBets: [],
				selectedChipAmount: 5,
				lastSpin: null,
				roundHistory: [],
			},
		});
		expect(s.gameMessage.textContent).not.toContain('Bets cleared on refresh');
	});

	it('does not show toast for guest mode', () => {
		const s = setup({
			guestMode: true,
			session: {
				phase: 'betting',
				chipBalance: 990,
				activeBets: [{ id: 'b1', type: 'red', amount: 10 }],
				selectedChipAmount: 5,
				lastSpin: null,
				roundHistory: [],
			},
		});
		expect(s.gameMessage.textContent).not.toContain('Bets cleared on refresh');
	});
});

describe('initRouletteClient — settled session restore', () => {
	it('restores a settled session and replays result display', () => {
		const s = setup({
			guestMode: false,
			session: {
				phase: 'settled',
				chipBalance: 990,
				activeBets: [],
				selectedChipAmount: 5,
				lastSpin: {
					winningNumber: 17,
					bets: [{ id: 'b1', type: 'red', amount: 10 }],
					totalBet: 10,
					totalPayout: 0,
					netDelta: -10,
					results: [{ bet: { id: 'b1', type: 'red', amount: 10 }, won: false, payout: 0 }],
					timestamp: Date.now(),
					syncId: 'old-sync',
					newBalance: 990,
				},
				roundHistory: [],
			},
		});
		expect(s.balanceEl.textContent).toContain('1,000');
		expect(s.newRoundBtn.hidden).toBe(false);
		const resultEl = s.doc.elements['wheel-result'];
		expect(resultEl.textContent).toContain('17');
	});
});

describe('initRouletteClient — error edge cases', () => {
	it('throws when roulette-root is missing', () => {
		installMockDocument([]);
		installMockLocalStorage();
		installMockTimers();
		installMockWindow();
		installMockCrypto();
		expect(() => initRouletteClient()).toThrow('roulette-root not found');
	});

	it('uses default balance when dataset.initialBalance is missing', () => {
		const doc = installMockDocument(ALL_IDS);
		installMockLocalStorage();
		installMockTimers();
		installMockWindow();
		installMockCrypto();
		doc.elements['roulette-root'].dataset.userId = 'u1';
		doc.elements['roulette-root'].dataset.guestMode = 'true';
		expect(() => initRouletteClient()).not.toThrow();
	});

	it('handles corrupted session JSON gracefully', () => {
		const storage = installMockLocalStorage();
		storage.setItem('roulette-session:u1', 'not valid json{');
		const doc = installMockDocument(ALL_IDS);
		installMockTimers();
		installMockWindow();
		installMockCrypto();
		doc.elements['roulette-root'].dataset.userId = 'u1';
		doc.elements['roulette-root'].dataset.guestMode = 'false';
		expect(() => initRouletteClient()).not.toThrow();
	});

	it('handles non-object session JSON gracefully', () => {
		const storage = installMockLocalStorage();
		storage.setItem('roulette-session:u1', '"a string"');
		const doc = installMockDocument(ALL_IDS);
		installMockTimers();
		installMockWindow();
		installMockCrypto();
		doc.elements['roulette-root'].dataset.userId = 'u1';
		doc.elements['roulette-root'].dataset.guestMode = 'false';
		expect(() => initRouletteClient()).not.toThrow();
	});
});

describe('initRouletteClient — fetchBalance paths', () => {
	it('fetchBalance returns null on non-ok response (INSUFFICIENT_BALANCE fallback)', async () => {
		const s = setup({ guestMode: false });
		s.fetchMock.impl = (url) => {
			if (url === '/api/roulette/spin')
				return makeFetchResponse(400, { error: 'INSUFFICIENT_BALANCE' });
			return makeFetchResponse(404, {});
		};
		s.betCells.red.dispatchEvent(new MockEvent('click'));
		s.spinBtn.dispatchEvent(new MockEvent('click'));
		await flush();
		expect(betEntries(s.activeBetsEl).length).toBeGreaterThan(0);
	});

	it('fetchBalance returns null when body has no balance field', async () => {
		const s = setup({ guestMode: false });
		s.fetchMock.impl = (url) => {
			if (url === '/api/roulette/spin')
				return makeFetchResponse(400, { error: 'INSUFFICIENT_BALANCE' });
			return makeFetchResponse(200, { noBalance: true });
		};
		s.betCells.red.dispatchEvent(new MockEvent('click'));
		s.spinBtn.dispatchEvent(new MockEvent('click'));
		await flush();
		expect(betEntries(s.activeBetsEl).length).toBeGreaterThan(0);
	});

	it('fetchBalance returns null on network error', async () => {
		const s = setup({ guestMode: false });
		s.fetchMock.impl = (url) => {
			if (url === '/api/roulette/spin')
				return makeFetchResponse(400, { error: 'INSUFFICIENT_BALANCE' });
			throw new TypeError('network failed');
		};
		s.betCells.red.dispatchEvent(new MockEvent('click'));
		s.spinBtn.dispatchEvent(new MockEvent('click'));
		await flush();
		expect(betEntries(s.activeBetsEl).length).toBeGreaterThan(0);
	});
});

describe('initRouletteClient — rules toggle without panel', () => {
	it('does not toggle when rules-panel is missing', () => {
		const ids = ALL_IDS.filter((id) => id !== 'rules-panel');
		installMockDocument(ids);
		installMockLocalStorage();
		installMockTimers();
		installMockWindow();
		installMockCrypto();
		const doc = (globalThis as unknown as { document: MockDocumentSetup['document'] }).document;
		doc.getElementById('roulette-root').dataset.userId = 'u1';
		doc.getElementById('roulette-root').dataset.guestMode = 'true';
		expect(() => initRouletteClient()).not.toThrow();
		// Click rules-toggle — should not throw even without panel
		const toggle = doc.getElementById('rules-toggle');
		expect(() => toggle.dispatchEvent(new MockEvent('click'))).not.toThrow();
	});
});
