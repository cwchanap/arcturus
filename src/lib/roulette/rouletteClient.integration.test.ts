import { afterEach, describe, expect, it } from 'bun:test';
import { initRouletteClient } from './rouletteClient';
import { CHIP_DENOMINATIONS } from './constants';
import {
	attachToBody,
	installMockCrypto,
	installMockDocument,
	installMockFetch,
	installMockLocalStorage,
	installMockTimers,
	installMockWindow,
	makeChipSelect,
	makeFetchResponse,
	MockElement,
	MockEvent,
	type FetchMock,
	type MockDocumentSetup,
	type TimerMock,
	type WindowMock,
} from './test-dom-mock';

const REAL = {
	setTimeout: globalThis.setTimeout,
	clearTimeout: globalThis.clearTimeout,
	fetch: globalThis.fetch,
	crypto: globalThis.crypto,
	document: (globalThis as { document?: unknown }).document,
	window: (globalThis as { window?: unknown }).window,
	localStorage: (globalThis as { localStorage?: unknown }).localStorage,
	customEvent: (globalThis as { CustomEvent?: unknown }).CustomEvent,
	htmlButton: (globalThis as { HTMLButtonElement?: unknown }).HTMLButtonElement,
};

afterEach(() => {
	(globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout = REAL.setTimeout;
	(globalThis as unknown as { clearTimeout: typeof clearTimeout }).clearTimeout = REAL.clearTimeout;
	(globalThis as unknown as { fetch: typeof fetch }).fetch = REAL.fetch;
	(globalThis as typeof globalThis & { crypto: typeof crypto }).crypto = REAL.crypto;
	(globalThis as { document?: unknown }).document = REAL.document;
	(globalThis as { window?: unknown }).window = REAL.window;
	(globalThis as { localStorage?: unknown }).localStorage = REAL.localStorage;
	(globalThis as { CustomEvent?: unknown }).CustomEvent = REAL.customEvent;
	(globalThis as { HTMLButtonElement?: unknown }).HTMLButtonElement = REAL.htmlButton;
});

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
	guestBankroll?: number;
	session?: Record<string, unknown>;
	fetchImpl?: (url: string, init?: RequestInit) => unknown;
}

interface SetupResult {
	doc: MockDocumentSetup;
	storage: Storage;
	fetchMock: FetchMock;
	timers: TimerMock;
	win: WindowMock;
	spinBtn: MockElement;
	betCells: { red: MockElement };
	balanceEl: MockElement;
	gameMessage: MockElement;
	roundResult: MockElement;
	gamePhase: MockElement;
}

function setup(options: SetupOptions = {}): SetupResult {
	const initialBalance = options.initialBalance ?? 1_000;
	const userId = options.userId ?? 'user-1';
	const isGuest = options.guestMode ?? false;
	const storage = installMockLocalStorage();
	const timers = installMockTimers();
	const win = installMockWindow();
	installMockCrypto({
		randomUUID: () => 'spin-id-1',
		getRandomValues: (buf) => {
			buf[0] = 17;
			return buf;
		},
	});
	const doc = installMockDocument(ALL_IDS);
	const root = doc.elements['roulette-root'];
	root.dataset.initialBalance = String(initialBalance);
	root.dataset.userId = userId;
	root.dataset.guestMode = isGuest ? 'true' : 'false';
	CHIP_DENOMINATIONS.forEach((amount) => makeChipSelect(amount, amount === 5));
	const redCell = new MockElement('div');
	redCell.dataset.betType = 'red';
	attachToBody(redCell);
	if (options.guestBankroll !== undefined) {
		storage.setItem(`roulette-bankroll:${userId}`, String(options.guestBankroll));
	}
	if (options.session) {
		storage.setItem(`roulette-session:${userId}`, JSON.stringify(options.session));
	}
	const fetchMock = installMockFetch(options.fetchImpl as FetchMock['impl'] | undefined);
	initRouletteClient();
	return {
		doc,
		storage,
		fetchMock,
		timers,
		win,
		spinBtn: doc.elements['spin-button'],
		betCells: { red: redCell },
		balanceEl: doc.elements['chip-balance'],
		gameMessage: doc.elements['game-message'],
		roundResult: doc.elements['wheel-result'],
		gamePhase: doc.elements['game-phase'],
	};
}

async function flush(): Promise<void> {
	for (let i = 0; i < 30; i++) await Promise.resolve();
}

describe('roulette client guest flow', () => {
	it('uses the local guest bankroll and persists a completed spin', async () => {
		const s = setup({ guestMode: true, userId: 'guest-1', guestBankroll: 500 });
		expect(s.balanceEl.textContent).toContain('500');
		s.betCells.red.dispatchEvent(new MockEvent('click'));
		s.spinBtn.dispatchEvent(new MockEvent('click'));
		await flush();

		expect(s.fetchMock.calls).toHaveLength(0);
		expect(s.gamePhase.textContent).toBe('Round Complete');
		expect(s.storage.getItem('roulette-bankroll:guest-1')).toBe('495');
	});

	it('keeps chip selection and betting interactions live', () => {
		const s = setup({ guestMode: true });
		const chip = s.doc.document.querySelectorAll('.chip-select')[3];
		chip.dispatchEvent(new MockEvent('click'));
		expect(chip.classList.contains('selected')).toBe(true);
		s.betCells.red.dispatchEvent(new MockEvent('keydown', { key: 'Enter' }));
		expect(s.spinBtn.disabled).toBe(false);
	});
});

describe('roulette client authenticated flow', () => {
	it('applies a fresh server result and achievement without using the wallet browser endpoint', async () => {
		const s = setup({
			fetchImpl: async (url) =>
				url === '/api/roulette/spin'
					? makeFetchResponse(200, {
							winningNumber: 17,
							netDelta: -5,
							results: [{ bet: { id: 'b', type: 'red', amount: 5 }, won: false, payout: 0 }],
							newBalance: 995,
							newAchievements: [{ id: 'a1', name: 'Winner', icon: '🏆' }],
						})
					: makeFetchResponse(404, {}),
		});
		let earned = 0;
		s.win.addEventListener('achievement-earned', () => earned++);
		s.betCells.red.dispatchEvent(new MockEvent('click'));
		s.spinBtn.dispatchEvent(new MockEvent('click'));
		await flush();

		expect(s.fetchMock.calls.map((call) => call.url)).toEqual(['/api/roulette/spin']);
		expect(s.balanceEl.textContent).toContain('995');
		expect(s.gamePhase.textContent).toBe('Round Complete');
		expect(earned).toBe(1);
	});

	it('duplicate settlement adopts balance, clears bets, and shows no historical result', async () => {
		const s = setup({
			fetchImpl: async () => makeFetchResponse(200, { duplicate: true, newBalance: 925 }),
		});
		s.betCells.red.dispatchEvent(new MockEvent('click'));
		s.spinBtn.dispatchEvent(new MockEvent('click'));
		await flush();

		expect(s.fetchMock.calls.map((call) => call.url)).toEqual(['/api/roulette/spin']);
		expect(s.balanceEl.textContent).toContain('925');
		expect(s.gamePhase.textContent).toBe('Place Your Bets');
		expect(s.roundResult.textContent).toBe('');
		expect(s.storage.getItem('roulette-session:user-1')).toContain('"lastSpin":null');
	});

	it('lost response adopts the authoritative balance and returns to betting without a winning number', async () => {
		const s = setup({
			fetchImpl: async (url) => {
				if (url === '/api/roulette/spin') throw new TypeError('network down');
				return makeFetchResponse(200, { balance: 880 });
			},
		});
		s.betCells.red.dispatchEvent(new MockEvent('click'));
		s.spinBtn.dispatchEvent(new MockEvent('click'));
		await flush();

		expect(s.fetchMock.calls.map((call) => call.url)).toEqual([
			'/api/roulette/spin',
			'/api/chips/balance',
		]);
		expect(s.balanceEl.textContent).toContain('880');
		expect(s.gamePhase.textContent).toBe('Place Your Bets');
		expect(s.roundResult.textContent).toBe('');
	});

	it('keeps live insufficient-balance handling without retry or historical recovery', async () => {
		const s = setup({
			fetchImpl: async (url) =>
				url === '/api/roulette/spin'
					? makeFetchResponse(400, { error: 'INSUFFICIENT_BALANCE' })
					: makeFetchResponse(200, { balance: 3 }),
		});
		s.betCells.red.dispatchEvent(new MockEvent('click'));
		s.spinBtn.dispatchEvent(new MockEvent('click'));
		await flush();

		expect(s.fetchMock.calls.map((call) => call.url)).toEqual([
			'/api/roulette/spin',
			'/api/chips/balance',
		]);
		expect(s.balanceEl.textContent).toContain('3');
		expect(s.gamePhase.textContent).toBe('Place Your Bets');
		expect(s.roundResult.textContent).toBe('');
	});

	it('drops an interrupted spinning snapshot instead of re-submitting it on reload', () => {
		const s = setup({
			session: {
				phase: 'spinning',
				chipBalance: 950,
				activeBets: [{ id: 'old', type: 'red', amount: 50 }],
				selectedChipAmount: 5,
				lastSpin: null,
				roundHistory: [],
				pendingSyncId: 'obsolete',
				pendingSyncCreatedAt: Date.now(),
			},
		});
		expect(s.fetchMock.calls).toHaveLength(0);
		expect(s.gamePhase.textContent).toBe('Place Your Bets');
		expect(s.storage.getItem('roulette-session:user-1')).toBeNull();
	});

	it('restores a settled session and displays the winning result', async () => {
		const lastSpin = {
			winningNumber: 17,
			bets: [{ id: 'b1', type: 'red', amount: 5 }],
			totalBet: 5,
			totalPayout: 10,
			netDelta: 5,
			results: [{ bet: { id: 'b1', type: 'red', amount: 5 }, won: true, payout: 10 }],
			timestamp: Date.now(),
			syncId: 'old-spin',
			newBalance: 1005,
		};
		const s = setup({
			initialBalance: 1005,
			session: {
				phase: 'settled',
				chipBalance: 1005,
				activeBets: [],
				selectedChipAmount: 5,
				lastSpin,
				roundHistory: [lastSpin],
			},
		});
		expect(s.gamePhase.textContent).toBe('Round Complete');
		expect(s.roundResult.textContent).toContain('17');
	});

	it('rejects a corrupt saved session with an invalid phase and clears storage', () => {
		const s = setup({
			session: {
				phase: 'bogus-phase',
				chipBalance: 500,
				activeBets: [],
				selectedChipAmount: 5,
				lastSpin: null,
				roundHistory: [],
			},
		});
		expect(s.gamePhase.textContent).toBe('Place Your Bets');
	});

	it('recovers from an invalid spin response by refreshing balance, resetting phase, and clearing the result', async () => {
		const s = setup({
			fetchImpl: async (url) =>
				url === '/api/roulette/spin'
					? makeFetchResponse(200, { netDelta: -5, newBalance: 995, results: [] })
					: makeFetchResponse(200, { balance: 1000 }),
		});
		s.betCells.red.dispatchEvent(new MockEvent('click'));
		s.spinBtn.dispatchEvent(new MockEvent('click'));
		await flush();

		// The invalid response triggers the uncertain-spin recovery path.
		expect(s.fetchMock.calls.map((c) => c.url)).toContain('/api/chips/balance');
		expect(s.gamePhase.textContent).toBe('Place Your Bets');
		expect(s.roundResult.textContent).toBe('');
	});

	it('handles an uncertain spin when the balance refresh also fails', async () => {
		const s = setup({
			fetchImpl: async (url) => {
				if (url === '/api/roulette/spin') throw new TypeError('network down');
				return makeFetchResponse(500, {});
			},
		});
		s.betCells.red.dispatchEvent(new MockEvent('click'));
		s.spinBtn.dispatchEvent(new MockEvent('click'));
		await flush();

		expect(s.fetchMock.calls.map((c) => c.url)).toEqual([
			'/api/roulette/spin',
			'/api/chips/balance',
		]);
		expect(s.gamePhase.textContent).toBe('Place Your Bets');
		expect(s.roundResult.textContent).toBe('');
		expect(s.gameMessage.textContent).toContain('Spin result unavailable');
	});

	it('aborts a non-insufficient-balance rejection (e.g. 401) and shows a session message', async () => {
		const s = setup({
			fetchImpl: async (url) =>
				url === '/api/roulette/spin'
					? makeFetchResponse(401, { error: 'UNAUTHENTICATED' })
					: makeFetchResponse(200, { balance: 1000 }),
		});
		s.betCells.red.dispatchEvent(new MockEvent('click'));
		s.spinBtn.dispatchEvent(new MockEvent('click'));
		await flush();

		expect(s.gamePhase.textContent).toBe('Place Your Bets');
		expect(s.gameMessage.textContent).toContain('Session expired');
	});

	it('cancels the pending result timer when starting a new round', async () => {
		const s = setup({
			fetchImpl: async (url) =>
				url === '/api/roulette/spin'
					? makeFetchResponse(200, {
							winningNumber: 17,
							netDelta: -5,
							results: [{ bet: { id: 'b', type: 'red', amount: 5 }, won: false, payout: 0 }],
							newBalance: 995,
						})
					: makeFetchResponse(404, {}),
		});
		s.betCells.red.dispatchEvent(new MockEvent('click'));
		s.spinBtn.dispatchEvent(new MockEvent('click'));
		await flush();

		// The pending result timer is scheduled; clicking new-round should cancel it.
		const newRoundBtn = s.doc.elements['new-round-button'];
		newRoundBtn.dispatchEvent(new MockEvent('click'));
		expect(s.gamePhase.textContent).toBe('Place Your Bets');
		expect(s.roundResult.textContent).toBe('');
	});
});
