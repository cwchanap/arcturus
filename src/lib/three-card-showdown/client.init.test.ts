import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { initThreeCardShowdownClient } from './client';
import { ANTE_OPTIONS } from './game';

// ---------------------------------------------------------------------------
// happy-dom globals (same pattern as video-poker/client.init.test.ts)
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
// DOM fixture helpers (mirror the real page contract in three-card-showdown.astro)
// ---------------------------------------------------------------------------
function makeCardSlot(id: string): HTMLElement {
	const slot = document.createElement('div');
	slot.id = id;
	slot.className = 'card-slot';
	slot.setAttribute('data-card-slot', '');
	slot.setAttribute('data-slot-state', 'placeholder');

	const placeholder = document.createElement('div');
	placeholder.className = 'card-placeholder';
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

function buildThreeCardShowdownDOM(options: {
	guestMode?: boolean;
	userId?: string;
	initialBalance?: number;
}): HTMLElement {
	const root = document.createElement('main');
	root.id = 'three-card-showdown-root';
	root.setAttribute('data-user-id', options.userId ?? 'anonymous');
	root.dataset.guestMode = options.guestMode ? 'true' : 'false';
	root.dataset.initialBalance = String(options.initialBalance ?? 1000);

	const balanceEl = document.createElement('div');
	balanceEl.id = 'chip-balance';
	balanceEl.textContent = String(options.initialBalance ?? 1000);
	root.appendChild(balanceEl);

	// Mirror element that the shared layout header renders alongside the canonical balance.
	const chipBalanceMirror = document.createElement('span');
	chipBalanceMirror.setAttribute('data-chip-balance', '');
	chipBalanceMirror.textContent = `${options.initialBalance ?? 1000} chips`;
	root.appendChild(chipBalanceMirror);

	const statusEl = document.createElement('div');
	statusEl.id = 'three-card-showdown-status';
	statusEl.textContent = 'Choose an ante, then deal.';
	root.appendChild(statusEl);

	const resultEl = document.createElement('div');
	resultEl.id = 'three-card-showdown-result';
	root.appendChild(resultEl);

	for (const side of ['dealer', 'player'] as const) {
		for (let index = 0; index < 3; index += 1) {
			root.appendChild(makeCardSlot(`three-card-showdown-${side}-slot-${index}`));
		}
	}

	for (const ante of ANTE_OPTIONS) {
		const anteButton = document.createElement('button');
		anteButton.type = 'button';
		anteButton.setAttribute('data-ante', String(ante));
		anteButton.setAttribute('aria-pressed', String(ante === ANTE_OPTIONS[0]));
		anteButton.textContent = String(ante);
		root.appendChild(anteButton);
	}

	const dealBtn = document.createElement('button');
	dealBtn.id = 'three-card-showdown-deal';
	dealBtn.type = 'button';
	dealBtn.textContent = 'Deal';
	root.appendChild(dealBtn);

	const foldBtn = document.createElement('button');
	foldBtn.id = 'three-card-showdown-fold';
	foldBtn.type = 'button';
	foldBtn.textContent = 'Fold';
	foldBtn.hidden = true;
	root.appendChild(foldBtn);

	const playBtn = document.createElement('button');
	playBtn.id = 'three-card-showdown-play';
	playBtn.type = 'button';
	playBtn.textContent = 'Play';
	playBtn.hidden = true;
	root.appendChild(playBtn);

	const newRoundBtn = document.createElement('button');
	newRoundBtn.id = 'three-card-showdown-new-round';
	newRoundBtn.type = 'button';
	newRoundBtn.textContent = 'New Round';
	newRoundBtn.hidden = true;
	root.appendChild(newRoundBtn);

	const recoveryHost = document.createElement('div');
	recoveryHost.id = 'three-card-showdown-recovery-host';
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

/** Records every fetch call so guest flows can prove zero wallet traffic. */
function installFetch(): { calls: Array<{ url: string }> } {
	const calls: Array<{ url: string }> = [];
	(globalThis as typeof globalThis & { fetch: typeof fetch }).fetch = (async (
		url: string | URL | Request,
	) => {
		const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
		calls.push({ url: urlStr });
		return makeResponse(404, {});
	}) as unknown as typeof fetch;
	return { calls };
}

function statusEl(): HTMLElement {
	return document.getElementById('three-card-showdown-status') as HTMLElement;
}

function balanceEl(): HTMLElement {
	return document.getElementById('chip-balance') as HTMLElement;
}

function resultEl(): HTMLElement {
	return document.getElementById('three-card-showdown-result') as HTMLElement;
}

function anteButton(ante: number): HTMLButtonElement {
	return document.querySelector<HTMLButtonElement>(`[data-ante="${ante}"]`)!;
}

function dealButton(): HTMLButtonElement {
	return document.getElementById('three-card-showdown-deal') as HTMLButtonElement;
}

function foldButton(): HTMLButtonElement {
	return document.getElementById('three-card-showdown-fold') as HTMLButtonElement;
}

function playButton(): HTMLButtonElement {
	return document.getElementById('three-card-showdown-play') as HTMLButtonElement;
}

function newRoundButton(): HTMLButtonElement {
	return document.getElementById('three-card-showdown-new-round') as HTMLButtonElement;
}

function slotStates(side: 'dealer' | 'player'): string[] {
	return [0, 1, 2].map(
		(index) =>
			document
				.getElementById(`three-card-showdown-${side}-slot-${index}`)
				?.getAttribute('data-slot-state') ?? 'missing',
	);
}

function dealerRank(index: number): string | null {
	const rank = document.querySelector<HTMLElement>(
		`#three-card-showdown-dealer-slot-${index} [data-rank]`,
	);
	return rank?.textContent ?? null;
}

// ---------------------------------------------------------------------------
// Tests — deterministic contract (Math.random = 0) deals player 3♥4♥5♥ and
// dealer 6♥7♥8♥; the dealer's straight flush beats the player's, so Play
// loses both wagers (ante 10 → -20 net) and Fold loses one ante (-10).
// ---------------------------------------------------------------------------
describe('initThreeCardShowdownClient — guest round flow', () => {
	test('guest play: deterministic dealer win settles locally and never calls fetch', async () => {
		localStorage.clear();
		const { calls } = installFetch();
		const origRandom = Math.random;
		Math.random = () => 0;
		const root = buildThreeCardShowdownDOM({
			guestMode: true,
			userId: 'anonymous',
			initialBalance: 1000,
		});
		try {
			initThreeCardShowdownClient();

			// Before Deal: balance 1000, ante 1 pressed, all slots placeholders.
			expect(balanceEl().textContent).toBe('1,000');
			expect(anteButton(1).getAttribute('aria-pressed')).toBe('true');
			expect(slotStates('dealer')).toEqual(['placeholder', 'placeholder', 'placeholder']);
			expect(slotStates('player')).toEqual(['placeholder', 'placeholder', 'placeholder']);

			// Ante 10, then Deal: ante deducted, player cards visible, dealer facedown.
			anteButton(10).click();
			expect(anteButton(10).getAttribute('aria-pressed')).toBe('true');
			expect(anteButton(1).getAttribute('aria-pressed')).toBe('false');
			dealButton().click();
			expect(balanceEl().textContent).toBe('990');
			expect(slotStates('player')).toEqual(['card', 'card', 'card']);
			expect(slotStates('dealer')).toEqual(['facedown', 'facedown', 'facedown']);
			expect(statusEl().textContent).toBe('Dealt. Fold or play your hand.');

			// Play: dealer wins both wagers, dealer revealed, balance 980.
			playButton().click();
			expect(resultEl().textContent).toBe('Dealer wins · −20 chips');
			expect(balanceEl().textContent).toBe('980');
			expect(slotStates('dealer')).toEqual(['card', 'card', 'card']);
			expect(dealerRank(0)).toBe('6');
			expect(dealerRank(1)).toBe('7');
			expect(dealerRank(2)).toBe('8');
			expect(newRoundButton().hidden).toBe(false);
			expect(statusEl().textContent).toBe('Round complete. Start a new round when ready.');

			// Guest bankroll persisted under the shared guest key; zero wallet traffic.
			expect(localStorage.getItem('three-card-showdown-bankroll:anonymous')).toBe('980');
			expect(calls).toEqual([]);
		} finally {
			Math.random = origRandom;
			root.remove();
		}
	});

	test('guest fold: loses one ante locally and reveals the dealer at complete', async () => {
		localStorage.clear();
		const { calls } = installFetch();
		const origRandom = Math.random;
		Math.random = () => 0;
		const root = buildThreeCardShowdownDOM({
			guestMode: true,
			userId: 'anonymous',
			initialBalance: 1000,
		});
		try {
			initThreeCardShowdownClient();

			anteButton(10).click();
			dealButton().click();
			expect(balanceEl().textContent).toBe('990');

			// Fold: only the ante is lost, the dealer hand is revealed at complete.
			foldButton().click();
			expect(resultEl().textContent).toBe('Fold · −10 chips');
			expect(balanceEl().textContent).toBe('990');
			expect(slotStates('dealer')).toEqual(['card', 'card', 'card']);
			expect(slotStates('player')).toEqual(['card', 'card', 'card']);
			expect(localStorage.getItem('three-card-showdown-bankroll:anonymous')).toBe('990');
			expect(calls).toEqual([]);
		} finally {
			Math.random = origRandom;
			root.remove();
		}
	});

	test('rejects an unaffordable ante without throwing and keeps ante 1 selected', () => {
		localStorage.clear();
		installFetch();
		const root = buildThreeCardShowdownDOM({
			guestMode: true,
			userId: 'anonymous',
			initialBalance: 150,
		});
		try {
			initThreeCardShowdownClient();

			expect(anteButton(1).getAttribute('aria-pressed')).toBe('true');
			expect(() => anteButton(100).click()).not.toThrow();
			expect(statusEl().textContent).toBe('Ante plus Play wager exceeds available balance');
			expect(anteButton(1).getAttribute('aria-pressed')).toBe('true');
			expect(anteButton(100).getAttribute('aria-pressed')).toBe('false');
		} finally {
			root.remove();
		}
	});
});
