import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import {
	buildRoundSettlementCommand,
	createPublicGameSettlementController,
	type PublicGameSettlementController,
} from './public-game-settlement';
import type { SettleRoundResult } from './types';

describe('buildRoundSettlementCommand', () => {
	test.each([
		[-10, { wins: 0, losses: 1, biggestWin: 0 }],
		[0, { wins: 0, losses: 0, biggestWin: 0 }],
		[25, { wins: 1, losses: 0, biggestWin: 25 }],
	] as const)('builds one net round for %i', (netDelta, stats) => {
		expect(buildRoundSettlementCommand('video-poker', 'round-1', netDelta)).toEqual({
			settlementId: 'round-1',
			game: 'video-poker',
			delta: netDelta,
			stats: { rounds: 1, ...stats },
		});
	});
});

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
// Fetch helpers
// ---------------------------------------------------------------------------
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

/** Records the raw request bodies sent to /api/wallet/settle. */
function installFetch(config: FetchConfig = {}): { commands: string[] } {
	const commands: string[] = [];
	let call = 0;
	(globalThis as typeof globalThis & { fetch: typeof fetch }).fetch = (async (
		url: string | URL | Request,
		init?: RequestInit,
	) => {
		if (String(url) === '/api/wallet/settle') {
			call += 1;
			if (init?.body) commands.push(String(init.body));
			const settlement = config.settlement;
			if (typeof settlement === 'function') return settlement(call);
			return settlement ?? makeResponse(200, { balance: 1000, duplicate: false });
		}
		return makeResponse(404, {});
	}) as unknown as typeof fetch;
	return { commands };
}

function installDeferredSettlement(fail: boolean): {
	commands: string[];
	resolve: (result: SettleRoundResult) => void;
} {
	const commands: string[] = [];
	let resolveNext: ((result: SettleRoundResult) => void) | null = null;
	(globalThis as typeof globalThis & { fetch: typeof fetch }).fetch = (async (
		url: string | URL | Request,
		init?: RequestInit,
	) => {
		if (String(url) === '/api/wallet/settle' && init?.body) commands.push(String(init.body));
		if (fail && commands.length === 1) throw new Error('INTERNAL_ERROR');
		return new Promise<MockResponse>((resolve) => {
			resolveNext = (result) =>
				resolve(makeResponse(200, { balance: result.balance, duplicate: false }));
		});
	}) as unknown as typeof fetch;
	return {
		commands,
		resolve: (result) => resolveNext?.(result),
	};
}

// ---------------------------------------------------------------------------
// Controller fixture
// ---------------------------------------------------------------------------
const GAME_KEY = 'video-poker';

function buildRoot(options: {
	guestMode?: boolean;
	userId?: string;
	initialBalance?: number;
}): HTMLElement {
	const root = document.createElement('main');
	root.dataset.userId = options.userId ?? 'anonymous';
	root.dataset.guestMode = options.guestMode === false ? 'false' : 'true';
	root.dataset.initialBalance = String(options.initialBalance ?? 1000);

	const balance = document.createElement('div');
	balance.id = 'chip-balance';
	root.appendChild(balance);

	const mirror = document.createElement('span');
	mirror.setAttribute('data-chip-balance', '');
	root.appendChild(mirror);

	const recoveryHost = document.createElement('div');
	recoveryHost.id = `${GAME_KEY}-recovery-host`;
	root.appendChild(recoveryHost);

	document.body.appendChild(root);
	return root;
}

function makeController(
	root: HTMLElement,
	hooks: {
		render?: () => void;
		onAdoptBalance?: (balance: number) => void;
		onResetRound?: () => void;
	} = {},
): PublicGameSettlementController {
	return createPublicGameSettlementController({
		gameKey: GAME_KEY,
		root,
		recoveryHost: document.getElementById(`${GAME_KEY}-recovery-host`),
		resetLabel: 'Reset hand',
		messages: {
			failed: 'Settlement failed. Retry or reset before starting another hand.',
			retrying: 'Retrying settlement...',
			retryFailed: 'Settlement failed again. Retry or reset the hand.',
			retryLabel: 'Retry settlement',
		},
		render: hooks.render ?? (() => {}),
		onAdoptBalance: hooks.onAdoptBalance ?? (() => {}),
		onResetRound: hooks.onResetRound ?? (() => {}),
	});
}

function flush(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

function recoveryContainer(): HTMLElement | null {
	return document.getElementById(`${GAME_KEY}-settlement-recovery`);
}

function retryButton(): HTMLButtonElement | null {
	return document.getElementById(`${GAME_KEY}-retry-settlement`) as HTMLButtonElement | null;
}

function resetButton(): HTMLButtonElement | null {
	return document.getElementById(`${GAME_KEY}-reset-settlement`) as HTMLButtonElement | null;
}

// ---------------------------------------------------------------------------
// Controller tests
// ---------------------------------------------------------------------------
describe('createPublicGameSettlementController', () => {
	test('guest root -> startingBalance uses persisted bankroll when present', () => {
		localStorage.clear();
		localStorage.setItem(`${GAME_KEY}-bankroll:anonymous`, '500');
		const root = buildRoot({ guestMode: true, userId: 'anonymous', initialBalance: 1000 });
		try {
			const settlement = makeController(root);
			expect(settlement.isGuestMode).toBe(true);
			expect(settlement.clientUserId).toBe('anonymous');
			expect(settlement.startingBalance).toBe(500);
		} finally {
			root.remove();
		}
	});

	test('syncBalance(990) updates #chip-balance and every [data-chip-balance] mirror', () => {
		localStorage.clear();
		const root = buildRoot({ guestMode: true, initialBalance: 1000 });
		try {
			const settlement = makeController(root);
			settlement.syncBalance(990);
			expect((document.getElementById('chip-balance') as HTMLElement).textContent).toBe('990');
			const mirror = root.querySelector<HTMLElement>('[data-chip-balance]');
			expect(mirror?.textContent).toBe('990 chips');
		} finally {
			root.remove();
		}
	});

	test('guest completeRound(-10, 990) persists the bankroll and never calls fetch', async () => {
		localStorage.clear();
		const { commands } = installFetch();
		const root = buildRoot({ guestMode: true, userId: 'anonymous', initialBalance: 1000 });
		try {
			const settlement = makeController(root);
			await settlement.completeRound(-10, 990);
			expect(localStorage.getItem(`${GAME_KEY}-bankroll:anonymous`)).toBe('990');
			expect(commands).toHaveLength(0);
			expect(settlement.isBlocked).toBe(false);
		} finally {
			root.remove();
		}
	});

	test('auth success -> exact sign-derived command, onAdoptBalance(server balance), achievement-earned dispatch', async () => {
		localStorage.clear();
		const achievements = [{ id: 'vp-win', name: 'Video Poker Master', icon: '♠' }];
		const { commands } = installFetch({
			settlement: makeResponse(200, {
				balance: 1234,
				duplicate: false,
				newAchievements: achievements,
			}),
		});
		const adopted: number[] = [];
		const events: Array<{ achievements: unknown[] }> = [];
		const onAchievement = (event: Event): void => {
			events.push((event as CustomEvent).detail as { achievements: unknown[] });
		};
		window.addEventListener('achievement-earned', onAchievement);

		const root = buildRoot({ guestMode: false, userId: 'u_vp', initialBalance: 1000 });
		try {
			const settlement = makeController(root, {
				onAdoptBalance: (balance) => adopted.push(balance),
			});
			await settlement.completeRound(25, 1025);

			expect(commands).toHaveLength(1);
			expect(JSON.parse(commands[0] ?? '{}')).toEqual({
				settlementId: expect.stringMatching(/^video-poker-/),
				game: 'video-poker',
				delta: 25,
				stats: { rounds: 1, wins: 1, losses: 0, biggestWin: 25 },
			});
			expect(adopted).toEqual([1234]);
			expect(events).toHaveLength(1);
			expect(events[0]?.achievements).toEqual(achievements);
			expect(settlement.statusMessage).toBeNull();
			expect(settlement.isBlocked).toBe(false);
			expect(recoveryContainer()?.classList.contains('hidden')).toBe(true);
		} finally {
			window.removeEventListener('achievement-earned', onAchievement);
			root.remove();
		}
	});

	test('auth failure -> statusMessage = failed, recovery visible, isBlocked = true', async () => {
		localStorage.clear();
		installFetch({ settlement: () => makeResponse(500, { error: 'INTERNAL_ERROR' }) });
		const root = buildRoot({ guestMode: false, userId: 'u_vp', initialBalance: 1000 });
		try {
			const settlement = makeController(root);
			await settlement.completeRound(-10, 990);

			expect(settlement.statusMessage).toBe(
				'Settlement failed. Retry or reset before starting another hand.',
			);
			expect(settlement.isBlocked).toBe(true);
			expect(recoveryContainer()?.classList.contains('hidden')).toBe(false);
			expect(retryButton()).not.toBeNull();
			expect(resetButton()).not.toBeNull();
		} finally {
			root.remove();
		}
	});

	test('Retry -> same command body, Retry+Reset disabled while in flight, returned balance adopted', async () => {
		localStorage.clear();
		const { commands, resolve } = installDeferredSettlement(true);
		const adopted: number[] = [];
		const root = buildRoot({ guestMode: false, userId: 'u_vp', initialBalance: 1000 });
		try {
			const settlement = makeController(root, {
				onAdoptBalance: (balance) => adopted.push(balance),
			});
			await settlement.completeRound(-10, 990);
			expect(settlement.statusMessage).not.toBeNull();
			expect(commands).toHaveLength(1);

			retryButton()!.click();
			// In flight: both recovery buttons disabled, retrying status shown.
			expect(retryButton()?.disabled).toBe(true);
			expect(resetButton()?.disabled).toBe(true);
			expect(settlement.statusMessage).toBe('Retrying settlement...');

			resolve({ balance: 1100, duplicate: false });
			await flush();

			expect(commands).toHaveLength(2);
			expect(JSON.parse(commands[1] ?? '{}')).toEqual(JSON.parse(commands[0] ?? '{}'));
			expect(adopted).toEqual([1100]);
			expect(settlement.statusMessage).toBeNull();
			expect(settlement.isBlocked).toBe(false);
			expect(recoveryContainer()?.classList.contains('hidden')).toBe(true);
			expect(retryButton()?.disabled).toBe(false);
			expect(resetButton()?.disabled).toBe(false);
		} finally {
			root.remove();
		}
	});

	test('Reset -> gate cleared, last server balance adopted, onResetRound called, recovery hidden', async () => {
		localStorage.clear();
		installFetch({ settlement: () => makeResponse(500, { error: 'INTERNAL_ERROR' }) });
		const adopted: number[] = [];
		let resets = 0;
		const root = buildRoot({ guestMode: false, userId: 'u_vp', initialBalance: 1000 });
		try {
			const settlement = makeController(root, {
				onAdoptBalance: (balance) => adopted.push(balance),
				onResetRound: () => {
					resets += 1;
				},
			});
			await settlement.completeRound(-10, 990);
			expect(settlement.isBlocked).toBe(true);

			resetButton()!.click();

			expect(adopted).toEqual([1000]); // last server-synced balance (never adopted)
			expect(resets).toBe(1);
			expect(settlement.isBlocked).toBe(false);
			expect(settlement.statusMessage).toBeNull();
			expect(recoveryContainer()?.classList.contains('hidden')).toBe(true);
		} finally {
			root.remove();
		}
	});

	test('retry failure -> retryFailed message, recovery stays visible', async () => {
		localStorage.clear();
		installFetch({ settlement: () => makeResponse(500, { error: 'INTERNAL_ERROR' }) });
		const root = buildRoot({ guestMode: false, userId: 'u_vp', initialBalance: 1000 });
		try {
			const settlement = makeController(root);
			await settlement.completeRound(-10, 990);
			retryButton()!.click();
			await flush();

			expect(settlement.statusMessage).toBe('Settlement failed again. Retry or reset the hand.');
			expect(recoveryContainer()?.classList.contains('hidden')).toBe(false);
			expect(retryButton()?.disabled).toBe(false);
		} finally {
			root.remove();
		}
	});

	test('messages.retryLabel labels the recovery retry button', () => {
		localStorage.clear();
		const root = buildRoot({ guestMode: true, initialBalance: 1000 });
		try {
			createPublicGameSettlementController({
				gameKey: GAME_KEY,
				root,
				recoveryHost: document.getElementById(`${GAME_KEY}-recovery-host`),
				resetLabel: 'Reset hand',
				messages: {
					failed: 'failed',
					retrying: 'retrying',
					retryFailed: 'retry failed',
					retryLabel: 'Try again',
				},
				render: () => {},
				onAdoptBalance: () => {},
				onResetRound: () => {},
			});
			expect(retryButton()?.textContent).toBe('Try again');
		} finally {
			root.remove();
		}
	});
});
