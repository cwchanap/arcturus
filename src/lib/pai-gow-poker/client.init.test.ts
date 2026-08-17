import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { initPaiGowPokerClient } from './client';
import { WAGER_OPTIONS } from './game';

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
const originalFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const originalCustomEvent = Object.getOwnPropertyDescriptor(globalThis, 'CustomEvent');
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
	if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
	else delete (globalThis as typeof globalThis & { window?: unknown }).window;
	if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
	else delete (globalThis as typeof globalThis & { document?: unknown }).document;
	if (originalFetch) Object.defineProperty(globalThis, 'fetch', originalFetch);
	else delete (globalThis as typeof globalThis & { fetch?: unknown }).fetch;
	if (originalLocalStorage) Object.defineProperty(globalThis, 'localStorage', originalLocalStorage);
	else delete (globalThis as typeof globalThis & { localStorage?: unknown }).localStorage;
	if (originalCustomEvent) Object.defineProperty(globalThis, 'CustomEvent', originalCustomEvent);
	else delete (globalThis as typeof globalThis & { CustomEvent?: unknown }).CustomEvent;
});

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

function buildPaiGowDOM(options: { guestMode?: boolean; initialBalance?: number }): HTMLElement {
	const initialBalance = options.initialBalance ?? 1000;
	const root = document.createElement('main');
	root.id = 'pai-gow-root';
	root.dataset.userId = options.guestMode === false ? 'test-user' : 'anonymous';
	root.dataset.guestMode = options.guestMode === false ? 'false' : 'true';
	root.dataset.initialBalance = String(initialBalance);

	const balance = document.createElement('div');
	balance.id = 'chip-balance';
	balance.textContent = String(initialBalance);
	root.appendChild(balance);

	const balanceMirror = document.createElement('span');
	balanceMirror.setAttribute('data-chip-balance', '');
	balanceMirror.textContent = `${initialBalance} chips`;
	root.appendChild(balanceMirror);

	const status = document.createElement('div');
	status.id = 'pai-gow-status';
	root.appendChild(status);

	const playerRow = document.createElement('div');
	playerRow.id = 'pai-gow-player-cards';
	for (let index = 0; index < 7; index += 1) {
		const button = document.createElement('button');
		button.type = 'button';
		button.id = `pai-gow-player-card-${index}`;
		button.dataset.cardIndex = String(index);
		button.dataset.low = 'false';
		button.setAttribute('aria-pressed', 'false');
		button.appendChild(makeCardSlot(`pai-gow-player-slot-${index}`));
		playerRow.appendChild(button);
	}
	root.appendChild(playerRow);

	for (const hand of ['high', 'low'] as const) {
		const count = hand === 'high' ? 5 : 2;
		for (let index = 0; index < count; index += 1) {
			root.appendChild(makeCardSlot(`pai-gow-dealer-${hand}-slot-${index}`));
		}
	}

	for (const wager of WAGER_OPTIONS) {
		const button = document.createElement('button');
		button.type = 'button';
		button.dataset.wager = String(wager);
		button.setAttribute('aria-pressed', String(wager === WAGER_OPTIONS[0]));
		button.textContent = String(wager);
		root.appendChild(button);
	}

	for (const [id, label] of [
		['deal-button', 'Deal'],
		['auto-arrange-button', 'Auto Arrange'],
		['reset-button', 'Reset'],
		['confirm-button', 'Confirm'],
		['new-round-button', 'New Round'],
	] as const) {
		const button = document.createElement('button');
		button.id = id;
		button.type = 'button';
		button.textContent = label;
		root.appendChild(button);
	}

	const recoveryHost = document.createElement('div');
	recoveryHost.id = 'pai-gow-recovery-host';
	root.appendChild(recoveryHost);
	document.body.appendChild(root);
	return root;
}

interface MockResponse {
	ok: boolean;
	status: number;
	json: () => Promise<unknown>;
}

function response(status: number, body: unknown): MockResponse {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: async () => body,
	};
}

function installFetch(handler?: () => Promise<MockResponse>): { calls: string[] } {
	const calls: string[] = [];
	(globalThis as typeof globalThis & { fetch: typeof fetch }).fetch = (async (
		url: string | URL | Request,
	) => {
		const urlString = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
		calls.push(urlString);
		return handler ? handler() : response(404, {});
	}) as unknown as typeof fetch;
	return { calls };
}

async function waitFor(predicate: () => boolean, maxTicks = 100): Promise<void> {
	for (let tick = 0; tick < maxTicks; tick += 1) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	throw new Error('Timed out waiting for DOM update');
}

function button(index: number): HTMLButtonElement {
	return document.getElementById(`pai-gow-player-card-${index}`) as HTMLButtonElement;
}

function status(): HTMLElement {
	return document.getElementById('pai-gow-status') as HTMLElement;
}

function dealButton(): HTMLButtonElement {
	return document.getElementById('deal-button') as HTMLButtonElement;
}

function autoArrangeButton(): HTMLButtonElement {
	return document.getElementById('auto-arrange-button') as HTMLButtonElement;
}

function confirmButton(): HTMLButtonElement {
	return document.getElementById('confirm-button') as HTMLButtonElement;
}

function newRoundButton(): HTMLButtonElement {
	return document.getElementById('new-round-button') as HTMLButtonElement;
}

function dealerSlotStates(): string[] {
	return [
		...Array.from({ length: 5 }, (_, index) => `pai-gow-dealer-high-slot-${index}`),
		...Array.from({ length: 2 }, (_, index) => `pai-gow-dealer-low-slot-${index}`),
	].map((id) => document.getElementById(id)?.dataset.slotState ?? 'missing');
}

describe('initPaiGowPokerClient', () => {
	test('keeps card buttons stable, exposes selection state, and caps Low at two cards', () => {
		localStorage.clear();
		installFetch();
		const originalRandom = Math.random;
		Math.random = () => 0;
		const root = buildPaiGowDOM({ guestMode: true });
		try {
			initPaiGowPokerClient();
			dealButton().click();

			const playerRow = document.getElementById('pai-gow-player-cards');
			const first = button(0);
			const second = button(1);
			const third = button(2);
			const firstParent = first.parentElement;
			first.focus();
			first.click();
			expect(first.parentElement).toBe(firstParent);
			expect(first.isConnected).toBe(true);
			expect(first.getAttribute('aria-pressed')).toBe('true');
			expect(first.dataset.low).toBe('true');
			expect(first.classList.contains('pai-gow-low-selected')).toBe(true);
			expect(document.activeElement).toBe(first);
			expect(status().textContent).toBe('Choose two cards for the Low hand.');

			second.click();
			expect(second.parentElement).toBe(playerRow);
			expect(second.getAttribute('aria-pressed')).toBe('true');
			expect(second.dataset.low).toBe('true');
			expect(status().textContent).toBe('High: Straight Flush · Low: High Card');

			third.click();
			expect(third.getAttribute('aria-pressed')).toBe('false');
			expect(third.dataset.low).toBe('false');
			expect(
				[...document.querySelectorAll<HTMLButtonElement>('#pai-gow-player-cards > button')].filter(
					(cardButton) => cardButton.dataset.low === 'true',
				),
			).toHaveLength(2);
			expect(first.parentElement).toBe(firstParent);
		} finally {
			Math.random = originalRandom;
			root.remove();
		}
	});

	test('shows the exact foul copy for an invalid split', () => {
		localStorage.clear();
		installFetch();
		const originalRandom = Math.random;
		Math.random = () => 0.1;
		const root = buildPaiGowDOM({ guestMode: true });
		try {
			initPaiGowPokerClient();
			dealButton().click();
			button(1).click();
			button(4).click();
			expect(status().textContent).toBe('High hand must rank at least as high as Low hand');
		} finally {
			Math.random = originalRandom;
			root.remove();
		}
	});

	test('keeps the dealer face-down before Confirm and reveals the Push after Confirm', () => {
		localStorage.clear();
		installFetch();
		const originalRandom = Math.random;
		Math.random = () => 0;
		const root = buildPaiGowDOM({ guestMode: true });
		try {
			initPaiGowPokerClient();
			dealButton().click();
			expect(dealerSlotStates()).toEqual([
				'facedown',
				'facedown',
				'facedown',
				'facedown',
				'facedown',
				'facedown',
				'facedown',
			]);

			autoArrangeButton().click();
			expect(status().textContent).toBe('High: Straight Flush · Low: High Card');
			confirmButton().click();
			expect(status().textContent).toContain('Push');
			expect(dealerSlotStates()).toEqual(['card', 'card', 'card', 'card', 'card', 'card', 'card']);
		} finally {
			Math.random = originalRandom;
			root.remove();
		}
	});

	test('blocks New Round while an authenticated settlement is pending', async () => {
		localStorage.clear();
		let resolveSettlement!: (result: MockResponse) => void;
		const pendingSettlement = new Promise<MockResponse>((resolve) => {
			resolveSettlement = resolve;
		});
		installFetch(() => pendingSettlement);
		const originalRandom = Math.random;
		Math.random = () => 0;
		const root = buildPaiGowDOM({ guestMode: false });
		try {
			initPaiGowPokerClient();
			dealButton().click();
			autoArrangeButton().click();
			confirmButton().click();
			expect(newRoundButton().hidden).toBe(false);
			expect(newRoundButton().disabled).toBe(true);

			resolveSettlement(response(200, { balance: 1000, duplicate: false }));
			await waitFor(() => !newRoundButton().disabled);
			newRoundButton().click();
			expect(newRoundButton().hidden).toBe(true);
		} finally {
			Math.random = originalRandom;
			root.remove();
		}
	});

	test('keeps New Round blocked and shows recovery after a failed settlement', async () => {
		localStorage.clear();
		installFetch(async () => response(503, { error: 'offline' }));
		const originalRandom = Math.random;
		Math.random = () => 0;
		const root = buildPaiGowDOM({ guestMode: false });
		try {
			initPaiGowPokerClient();
			dealButton().click();
			autoArrangeButton().click();
			confirmButton().click();
			await waitFor(() => {
				const recovery = document.getElementById('pai-gow-poker-settlement-recovery');
				return recovery?.classList.contains('hidden') === false;
			});
			expect(newRoundButton().disabled).toBe(true);
		} finally {
			Math.random = originalRandom;
			root.remove();
		}
	});
});
