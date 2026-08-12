import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { initBlackjackClient } from './blackjackClient';

// ---------------------------------------------------------------------------
// happy-dom globals
// ---------------------------------------------------------------------------
const origWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const origDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
const origFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
const origSetTimeout = Object.getOwnPropertyDescriptor(globalThis, 'setTimeout');
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
	// Mock setTimeout to fire callbacks synchronously after a microtask tick.
	const realSetTimeout = (origSetTimeout?.value ?? setTimeout) as typeof setTimeout;
	Object.defineProperty(globalThis, 'setTimeout', {
		configurable: true,
		writable: true,
		value: ((cb: TimerHandler, _ms?: number) => realSetTimeout(cb, 0)) as typeof setTimeout,
	});
});

afterAll(() => {
	happyWindow.close();
	if (origWindow) Object.defineProperty(globalThis, 'window', origWindow);
	if (origDocument) Object.defineProperty(globalThis, 'document', origDocument);
	if (origFetch) Object.defineProperty(globalThis, 'fetch', origFetch);
	if (origSetTimeout) Object.defineProperty(globalThis, 'setTimeout', origSetTimeout);
	if (origLocalStorage) Object.defineProperty(globalThis, 'localStorage', origLocalStorage);
	if (origCustomEvent) Object.defineProperty(globalThis, 'CustomEvent', origCustomEvent);
});

// ---------------------------------------------------------------------------
// DOM fixture helpers
// ---------------------------------------------------------------------------

function makeCardSlot(): HTMLElement {
	const slot = document.createElement('div');
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

function makeCardContainer(id: string, maxCards: number): HTMLElement {
	const container = document.createElement('div');
	container.id = id;
	container.className = 'flex justify-center gap-2 flex-wrap items-center';
	container.setAttribute('data-card-container', '');
	for (let i = 0; i < maxCards; i++) {
		container.appendChild(makeCardSlot());
	}
	return container;
}

function makeSplitHandsContainer(
	id: string,
	maxHands: number,
	maxCardsPerHand: number,
): HTMLElement {
	const container = document.createElement('div');
	container.id = id;
	container.className = 'hidden flex-wrap justify-center gap-4';
	container.setAttribute('data-split-hands-container', '');
	for (let h = 0; h < maxHands; h++) {
		const handContainer = document.createElement('div');
		handContainer.className = 'hand-container hidden';
		handContainer.setAttribute('data-hand-index', String(h));
		handContainer.setAttribute('data-hand-active', 'false');

		const label = document.createElement('div');
		label.className = 'hand-label';
		label.setAttribute('data-hand-label', '');
		label.textContent = `Hand ${h + 1}`;
		handContainer.appendChild(label);

		const handCards = document.createElement('div');
		handCards.className = 'hand-cards flex gap-2';
		handCards.setAttribute('data-hand-cards', '');
		for (let c = 0; c < maxCardsPerHand; c++) {
			handCards.appendChild(makeCardSlot());
		}
		handContainer.appendChild(handCards);

		const value = document.createElement('div');
		value.className = 'hand-value';
		value.setAttribute('data-hand-value', '');
		value.textContent = '-';
		handContainer.appendChild(value);

		const bet = document.createElement('div');
		bet.className = 'hand-bet';
		bet.setAttribute('data-hand-bet', '');
		bet.textContent = '$0';
		handContainer.appendChild(bet);

		container.appendChild(handContainer);
	}
	return container;
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
			return settlement ?? makeResponse(200, { balance: 950, duplicate: false });
		}
		return makeResponse(404, {});
	}) as unknown as typeof fetch;
	return { calls };
}

function buildBlackjackDOM(options: {
	guestMode?: boolean;
	userId?: string;
	initialBalance?: number;
}): HTMLElement {
	const root = document.createElement('div');
	root.id = 'blackjack-root';
	root.setAttribute('data-user-id', options.userId ?? 'user-1');
	root.dataset.guestMode = options.guestMode ? 'true' : 'false';
	root.dataset.initialBalance = String(options.initialBalance ?? 1000);

	// Player balance display
	const balanceWrapper = document.createElement('div');
	const balanceEl = document.createElement('div');
	balanceEl.id = 'player-balance';
	balanceEl.textContent = `$${(options.initialBalance ?? 1000).toLocaleString()}`;
	balanceWrapper.appendChild(balanceEl);
	root.appendChild(balanceWrapper);

	// Game status — must have a parent for settlement recovery controls
	const statusWrapper = document.createElement('div');
	const statusEl = document.createElement('div');
	statusEl.id = 'game-status';
	statusEl.textContent = 'Place your bet to start';
	statusWrapper.appendChild(statusEl);
	root.appendChild(statusWrapper);

	// Dealer area
	const dealerValue = document.createElement('div');
	dealerValue.id = 'dealer-value';
	dealerValue.textContent = '?';
	root.appendChild(dealerValue);
	root.appendChild(makeCardContainer('dealer-cards', 10));

	// Player area
	const playerValue = document.createElement('div');
	playerValue.id = 'player-value';
	playerValue.textContent = '-';
	root.appendChild(playerValue);

	const singleHandContainer = document.createElement('div');
	singleHandContainer.id = 'player-cards-single';
	singleHandContainer.appendChild(makeCardContainer('player-cards', 10));
	root.appendChild(singleHandContainer);

	root.appendChild(makeSplitHandsContainer('player-cards-split', 4, 10));

	const currentBet = document.createElement('div');
	currentBet.id = 'current-bet';
	currentBet.textContent = 'Current Bet: $0';
	root.appendChild(currentBet);

	// Betting controls
	const bettingControls = document.createElement('div');
	bettingControls.id = 'betting-controls';

	const betAmount = document.createElement('input');
	betAmount.id = 'bet-amount';
	betAmount.type = 'number';
	betAmount.value = '50';
	betAmount.min = '10';
	betAmount.max = '500';
	bettingControls.appendChild(betAmount);

	// Quick bet buttons
	for (const amt of [25, 50, 100, 200]) {
		const quickBtn = document.createElement('button');
		quickBtn.className = 'bet-quick';
		quickBtn.setAttribute('data-amount', String(amt));
		bettingControls.appendChild(quickBtn);
	}

	const btnDeal = document.createElement('button');
	btnDeal.id = 'btn-deal';
	btnDeal.textContent = 'DEAL CARDS';
	bettingControls.appendChild(btnDeal);

	root.appendChild(bettingControls);

	// Game controls
	const gameControls = document.createElement('div');
	gameControls.id = 'game-controls';
	gameControls.className = 'hidden';

	const btnHit = document.createElement('button');
	btnHit.id = 'btn-hit';
	gameControls.appendChild(btnHit);

	const btnStand = document.createElement('button');
	btnStand.id = 'btn-stand';
	gameControls.appendChild(btnStand);

	const btnDouble = document.createElement('button');
	btnDouble.id = 'btn-double';
	gameControls.appendChild(btnDouble);

	const btnSplit = document.createElement('button');
	btnSplit.id = 'btn-split';
	gameControls.appendChild(btnSplit);

	const btnNewRound = document.createElement('button');
	btnNewRound.id = 'btn-new-round';
	btnNewRound.className = 'hidden';
	gameControls.appendChild(btnNewRound);

	root.appendChild(gameControls);

	// AI Rival
	const aiRivalStatus = document.createElement('div');
	aiRivalStatus.id = 'ai-rival-status';
	root.appendChild(aiRivalStatus);

	const btnAiRival = document.createElement('button');
	btnAiRival.id = 'btn-ai-rival';
	const btnAiRivalText = document.createElement('span');
	btnAiRivalText.id = 'btn-ai-rival-text';
	btnAiRivalText.textContent = 'Ask AI Rival';
	btnAiRival.appendChild(btnAiRivalText);
	root.appendChild(btnAiRival);

	const aiAdviceBox = document.createElement('div');
	aiAdviceBox.id = 'ai-advice-box';
	aiAdviceBox.className = 'hidden';
	const aiAdviceAction = document.createElement('div');
	aiAdviceAction.id = 'ai-advice-action';
	const aiAdviceReasoning = document.createElement('div');
	aiAdviceReasoning.id = 'ai-advice-reasoning';
	aiAdviceBox.appendChild(aiAdviceAction);
	aiAdviceBox.appendChild(aiAdviceReasoning);
	root.appendChild(aiAdviceBox);

	// Settings panel
	const btnToggleSettings = document.createElement('button');
	btnToggleSettings.id = 'btn-toggle-settings';
	root.appendChild(btnToggleSettings);

	const settingsPanel = document.createElement('div');
	settingsPanel.id = 'settings-panel';
	settingsPanel.className = 'hidden';
	root.appendChild(settingsPanel);

	const startingChipsInput = document.createElement('input');
	startingChipsInput.id = 'setting-starting-chips';
	startingChipsInput.type = 'number';
	startingChipsInput.value = '1000';
	settingsPanel.appendChild(startingChipsInput);

	const minBetInput = document.createElement('input');
	minBetInput.id = 'setting-min-bet';
	minBetInput.type = 'number';
	minBetInput.value = '10';
	settingsPanel.appendChild(minBetInput);

	const maxBetInput = document.createElement('input');
	maxBetInput.id = 'setting-max-bet';
	maxBetInput.type = 'number';
	maxBetInput.value = '1000';
	settingsPanel.appendChild(maxBetInput);

	const dealerSpeedSelect = document.createElement('select');
	dealerSpeedSelect.id = 'setting-dealer-speed';
	dealerSpeedSelect.value = 'normal';
	settingsPanel.appendChild(dealerSpeedSelect);

	const btnSaveSettings = document.createElement('button');
	btnSaveSettings.id = 'btn-save-settings';
	settingsPanel.appendChild(btnSaveSettings);

	const btnResetSettings = document.createElement('button');
	btnResetSettings.id = 'btn-reset-settings';
	settingsPanel.appendChild(btnResetSettings);

	// Achievement toast
	const achievementToast = document.createElement('div');
	achievementToast.id = 'achievement-toast';
	const achievementIcon = document.createElement('span');
	achievementIcon.id = 'achievement-icon';
	const achievementName = document.createElement('p');
	achievementName.id = 'achievement-name';
	achievementToast.appendChild(achievementIcon);
	achievementToast.appendChild(achievementName);
	root.appendChild(achievementToast);

	document.body.appendChild(root);
	return root;
}

async function flush(ms = 10): Promise<void> {
	for (let i = 0; i < ms; i++) {
		await new Promise((resolve) => {
			const realSetTimeout = (origSetTimeout?.value ?? setTimeout) as typeof setTimeout;
			realSetTimeout(resolve, 0);
		});
	}
}

function clickDeal(): void {
	(document.getElementById('btn-deal') as HTMLButtonElement).click();
}

function clickStand(): void {
	(document.getElementById('btn-stand') as HTMLButtonElement).click();
}

function clickNewRound(): void {
	(document.getElementById('btn-new-round') as HTMLButtonElement).click();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Blackjack client initialization and settlement flow', () => {
	test('initializes in guest mode and persists bankroll locally after a round', async () => {
		installFetch();
		const root = buildBlackjackDOM({ guestMode: true, userId: 'guest-1', initialBalance: 1000 });
		initBlackjackClient();
		await flush(5);

		// Deal and stand to complete a round
		clickDeal();
		await flush(2);
		clickStand();
		await flush(10);

		// The new round button should be visible after round completion
		const btnNewRound = document.getElementById('btn-new-round') as HTMLButtonElement;
		expect(btnNewRound.classList.contains('hidden')).toBe(false);

		// Guest bankroll should be persisted to localStorage
		const stored = localStorage.getItem('blackjack-bankroll:guest-1');
		expect(stored).not.toBeNull();

		root.remove();
	});

	test('guest mode shows local advice without sending local keys to a provider', async () => {
		const root = buildBlackjackDOM({ guestMode: true, userId: 'guest-ai', initialBalance: 1000 });
		localStorage.setItem(
			'arcturus-ai-settings',
			JSON.stringify({ provider: 'openai', model: 'gpt-4o', apiKey: 'stale-guest-key' }),
		);
		const { calls } = installFetch();
		initBlackjackClient();
		await flush(5);

		clickDeal();
		await flush(2);
		(document.getElementById('btn-ai-rival') as HTMLButtonElement).click();
		await flush(2);

		expect(document.getElementById('ai-advice-action')?.textContent).toContain('Recommended:');
		expect(calls.some((call) => call.url.includes('api.openai.com'))).toBe(false);
		root.remove();
	});

	test('round completion does not perform automatic provider traffic', async () => {
		const root = buildBlackjackDOM({ guestMode: false, userId: 'auth-ai', initialBalance: 1000 });
		const { calls } = installFetch();
		initBlackjackClient();
		await flush(5);

		clickDeal();
		await flush(2);
		clickStand();
		await flush(15);

		expect(calls.some((call) => call.url.includes('api.openai.com'))).toBe(false);
		root.remove();
	});

	test('settlement success adopts server balance and hides recovery controls', async () => {
		installFetch({
			settlement: makeResponse(200, { balance: 950, duplicate: false }),
		});
		const root = buildBlackjackDOM({ guestMode: false, userId: 'auth-1', initialBalance: 1000 });
		initBlackjackClient();
		await flush(5);

		clickDeal();
		await flush(2);
		clickStand();
		await flush(15);

		// Balance should reflect the server-settled amount
		const balanceEl = document.getElementById('player-balance') as HTMLElement;
		expect(balanceEl.textContent).toContain('950');

		// Recovery container should be hidden
		const recoveryContainer = document.getElementById('settlement-recovery');
		expect(recoveryContainer?.classList.contains('hidden')).toBe(true);

		root.remove();
	});

	test('settlement failure shows recovery controls with retry/reset buttons', async () => {
		installFetch({
			settlement: makeResponse(500, { error: 'INTERNAL_ERROR' }),
		});
		const root = buildBlackjackDOM({ guestMode: false, userId: 'auth-2', initialBalance: 1000 });
		initBlackjackClient();
		await flush(5);

		clickDeal();
		await flush(2);
		clickStand();
		await flush(15);

		// Recovery container should be visible
		const recoveryContainer = document.getElementById('settlement-recovery');
		expect(recoveryContainer).not.toBeNull();
		expect(recoveryContainer?.classList.contains('hidden')).toBe(false);

		// Status should show the failure message
		const statusEl = document.getElementById('game-status') as HTMLElement;
		expect(statusEl.textContent).toContain('Settlement failed');

		// Retry and reset buttons should exist
		expect(document.getElementById('btn-retry-settlement')).not.toBeNull();
		expect(document.getElementById('btn-reset-settlement')).not.toBeNull();

		root.remove();
	});

	test('retry handler re-attempts settlement and adopts the result on success', async () => {
		let settlementCall = 0;
		installFetch({
			settlement: () => {
				settlementCall += 1;
				return settlementCall === 1
					? makeResponse(500, { error: 'INTERNAL_ERROR' })
					: makeResponse(200, { balance: 960, duplicate: false });
			},
		});
		const root = buildBlackjackDOM({ guestMode: false, userId: 'auth-3', initialBalance: 1000 });
		initBlackjackClient();
		await flush(5);

		clickDeal();
		await flush(2);
		clickStand();
		await flush(15);

		// First settlement failed
		const recoveryContainer = document.getElementById('settlement-recovery');
		expect(recoveryContainer?.classList.contains('hidden')).toBe(false);

		// Click retry
		(document.getElementById('btn-retry-settlement') as HTMLButtonElement).click();
		await flush(15);

		// Recovery should be hidden and balance adopted
		expect(recoveryContainer?.classList.contains('hidden')).toBe(true);
		const balanceEl = document.getElementById('player-balance') as HTMLElement;
		expect(balanceEl.textContent).toContain('960');

		root.remove();
	});

	test('reset handler clears the gate and restores the server-synced balance', async () => {
		installFetch({
			settlement: makeResponse(500, { error: 'INTERNAL_ERROR' }),
		});
		const root = buildBlackjackDOM({ guestMode: false, userId: 'auth-4', initialBalance: 1000 });
		initBlackjackClient();
		await flush(5);

		clickDeal();
		await flush(2);
		clickStand();
		await flush(15);

		const recoveryContainer = document.getElementById('settlement-recovery');
		expect(recoveryContainer?.classList.contains('hidden')).toBe(false);

		// Click reset
		(document.getElementById('btn-reset-settlement') as HTMLButtonElement).click();
		await flush(5);

		// Recovery should be hidden
		expect(recoveryContainer?.classList.contains('hidden')).toBe(true);
		const statusEl = document.getElementById('game-status') as HTMLElement;
		expect(statusEl.textContent).toContain('Settlement reset');

		root.remove();
	});

	test('blocks a new authenticated round while settlement is pending', async () => {
		installFetch({
			settlement: makeResponse(500, { error: 'INTERNAL_ERROR' }),
		});
		const root = buildBlackjackDOM({ guestMode: false, userId: 'auth-5', initialBalance: 1000 });
		initBlackjackClient();
		await flush(5);

		clickDeal();
		await flush(2);
		clickStand();
		await flush(15);

		// Settlement failed → gate is blocked. Click new round.
		clickNewRound();
		await flush(5);

		const statusEl = document.getElementById('game-status') as HTMLElement;
		expect(statusEl.textContent).toContain('Settlement is still pending');

		root.remove();
	});

	test('dispatches achievement-earned event when settlement returns new achievements', async () => {
		installFetch({
			settlement: makeResponse(200, {
				balance: 1050,
				duplicate: false,
				newAchievements: [{ id: 'bj-win', name: 'Blackjack Master', icon: '🃏' }],
			}),
		});
		const root = buildBlackjackDOM({ guestMode: false, userId: 'auth-6', initialBalance: 1000 });

		const events: Array<{ achievements: unknown[] }> = [];
		const handler = (e: Event) => {
			const detail = (e as CustomEvent).detail as { achievements: unknown[] };
			events.push(detail);
		};
		window.addEventListener('achievement-earned', handler);

		try {
			initBlackjackClient();
			await flush(5);

			clickDeal();
			await flush(2);
			clickStand();
			await flush(15);

			expect(events).toHaveLength(1);
			expect(events[0].achievements).toEqual([
				{ id: 'bj-win', name: 'Blackjack Master', icon: '🃏' },
			]);
		} finally {
			window.removeEventListener('achievement-earned', handler);
			root.remove();
		}
	});

	test('quick bet buttons update the bet amount input', async () => {
		installFetch();
		const root = buildBlackjackDOM({ guestMode: true, userId: 'guest-2', initialBalance: 1000 });
		initBlackjackClient();
		await flush(5);

		const betAmountInput = document.getElementById('bet-amount') as HTMLInputElement;
		const quickButtons = root.querySelectorAll<HTMLButtonElement>('.bet-quick');
		expect(quickButtons.length).toBeGreaterThan(0);

		// Click the 100 quick bet button
		const hundredBtn = Array.from(quickButtons).find(
			(b) => b.getAttribute('data-amount') === '100',
		);
		hundredBtn?.click();
		expect(betAmountInput.value).toBe('100');

		root.remove();
	});

	test('settings panel toggle shows and hides the panel', async () => {
		installFetch();
		const root = buildBlackjackDOM({ guestMode: true, userId: 'guest-3', initialBalance: 1000 });
		initBlackjackClient();
		await flush(5);

		const settingsPanel = document.getElementById('settings-panel') as HTMLElement;
		expect(settingsPanel.classList.contains('hidden')).toBe(true);

		(document.getElementById('btn-toggle-settings') as HTMLButtonElement).click();
		expect(settingsPanel.classList.contains('hidden')).toBe(false);

		(document.getElementById('btn-toggle-settings') as HTMLButtonElement).click();
		expect(settingsPanel.classList.contains('hidden')).toBe(true);

		root.remove();
	});

	test('save settings validates bet limits and shows an error for invalid values', async () => {
		installFetch();
		const root = buildBlackjackDOM({ guestMode: true, userId: 'guest-4', initialBalance: 1000 });
		initBlackjackClient();
		await flush(5);

		const minBetInput = document.getElementById('setting-min-bet') as HTMLInputElement;
		const maxBetInput = document.getElementById('setting-max-bet') as HTMLInputElement;
		// Set min >= max to trigger validation error
		minBetInput.value = '500';
		maxBetInput.value = '100';

		(document.getElementById('btn-save-settings') as HTMLButtonElement).click();

		const statusEl = document.getElementById('game-status') as HTMLElement;
		expect(statusEl.textContent).toContain('Minimum bet must be less than maximum bet');

		root.remove();
	});

	test('reset settings restores defaults and updates the status', async () => {
		installFetch();
		const root = buildBlackjackDOM({ guestMode: true, userId: 'guest-5', initialBalance: 1000 });
		initBlackjackClient();
		await flush(5);

		(document.getElementById('btn-reset-settings') as HTMLButtonElement).click();

		const statusEl = document.getElementById('game-status') as HTMLElement;
		expect(statusEl.textContent).toContain('Settings reset to defaults');

		root.remove();
	});

	test('deal button rejects a bet exceeding the balance', async () => {
		installFetch();
		const root = buildBlackjackDOM({ guestMode: true, userId: 'guest-6', initialBalance: 100 });
		initBlackjackClient();
		await flush(5);

		const betAmountInput = document.getElementById('bet-amount') as HTMLInputElement;
		betAmountInput.value = '500'; // exceeds 100 balance

		clickDeal();
		await flush(2);

		const statusEl = document.getElementById('game-status') as HTMLElement;
		expect(statusEl.textContent).toContain('Insufficient balance');

		root.remove();
	});

	test('deal button rejects a bet outside the configured limits', async () => {
		installFetch();
		const root = buildBlackjackDOM({ guestMode: true, userId: 'guest-7', initialBalance: 1000 });
		initBlackjackClient();
		await flush(5);

		const betAmountInput = document.getElementById('bet-amount') as HTMLInputElement;
		betAmountInput.value = '5'; // below min bet of 10

		clickDeal();
		await flush(2);

		const statusEl = document.getElementById('game-status') as HTMLElement;
		expect(statusEl.textContent).toContain('Bet must be between');

		root.remove();
	});
});
