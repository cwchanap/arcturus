import { describe, expect, test, beforeEach, afterEach, mock } from 'bun:test';
import { Window as DOMWindow } from 'happy-dom';
import type { Card, Player } from './types';
import {
	createPlayer,
	createAIPlayer,
	getHighestBet,
	getCallAmount,
	getActivePlayers,
	isBettingRoundComplete,
	resetPlayerForNewHand,
	placeBet,
	foldPlayer,
} from './index';
import { PokerGame, buildPokerSettlementCommand } from './PokerGame';
import { clearLLMCache } from './llmAIStrategy';
import type { GameSettingsManager } from './GameSettingsManager';
import type { AIRivalAssistant, AiMove } from './AIRivalAssistant';
import { DEFAULT_SETTINGS } from './types';
import { DEFAULT_GUEST_GAME_BALANCE } from '../public-game-session';
import type { SettlementGate, SettleRoundResult } from '../wallet';

let windowListeners: Record<string, (() => void) | undefined> = {};

// Mock DOM for PokerGame constructor
function mockPokerGameDOM() {
	interface MockElement {
		addEventListener: (event: string, handler?: () => void) => void;
		click: () => void;
		close?: () => void;
		dataset?: Record<string, string>;
		innerHTML?: string;
		textContent?: string;
		textContentSet?: string;
		classList?: { add: () => void; remove: () => void; toggle: () => void };
		querySelector?: () => MockElement | null;
		querySelectorAll?: () => MockElement[];
		disabled?: boolean;
		hidden?: boolean;
		checked?: boolean;
		value?: string;
	}

	const elements: Record<string, MockElement> = {};

	(global as unknown as { document: unknown }).document = {
		getElementById: (id: string) => {
			if (id === 'poker-history' || id.startsWith('poker-seat-')) return null;
			if (!elements[id]) {
				const listeners: Record<string, (() => void) | undefined> = {};
				elements[id] = {
					addEventListener: (event: string, handler?: () => void) => {
						listeners[event] = handler;
					},
					click: () => {
						listeners['click']?.();
					},
					close: () => {},
					dataset: {},
					innerHTML: '',
					textContent: '',
					classList: { add: () => {}, remove: () => {}, toggle: () => {} },
					querySelector: () => null,
					querySelectorAll: () => [],
					disabled: false,
					hidden: false,
					checked: false,
					value: '0',
				};
			}
			elements[id].dataset ??= {};
			elements[id].classList ??= { add: () => {}, remove: () => {}, toggle: () => {} };
			elements[id].querySelector ??= () => null;
			elements[id].querySelectorAll ??= () => [];
			return elements[id];
		},
		querySelector: () => null,
		querySelectorAll: () => [],
	};

	(global as unknown as { HTMLButtonElement: unknown }).HTMLButtonElement = class {};
	windowListeners = {};
	(globalThis as typeof globalThis & { window: Window & typeof globalThis }).window = {
		dispatchEvent: () => true,
		addEventListener: (event: string, handler: EventListenerOrEventListenerObject) => {
			windowListeners[event] = handler as () => void;
		},
	} as unknown as Window & typeof globalThis;
	(globalThis as typeof globalThis & { CustomEvent: typeof CustomEvent }).CustomEvent = class<T> {
		type: string;
		detail: T | null;

		constructor(type: string, eventInitDict?: CustomEventInit<T>) {
			this.type = type;
			this.detail = eventInitDict?.detail ?? null;
		}
	} as typeof CustomEvent;

	return elements;
}

// Helper to create a card
function card(value: string, suit: Card['suit'], rank: number): Card {
	return { value, suit, rank };
}

const realSetTimeout = setTimeout;

async function flushAsyncWork() {
	await new Promise((resolve) => realSetTimeout(resolve, 0));
}

type ScheduledTimer = {
	id: number;
	delay: number;
	cleared: boolean;
	callback: () => void;
};

function mockTrackedTimers() {
	const originalSetTimeout = globalThis.setTimeout;
	const originalClearTimeout = globalThis.clearTimeout;
	const scheduledTimers: ScheduledTimer[] = [];
	let nextTimerId = 1;

	globalThis.setTimeout = ((callback: () => void, delay?: number) => {
		const timer = {
			id: nextTimerId++,
			delay: typeof delay === 'number' ? delay : 0,
			cleared: false,
			callback: () => {
				if (!timer.cleared) {
					callback();
				}
			},
		};
		scheduledTimers.push(timer);
		return timer.id as unknown as ReturnType<typeof setTimeout>;
	}) as unknown as typeof setTimeout;

	globalThis.clearTimeout = ((timeoutId?: ReturnType<typeof setTimeout>) => {
		const timer = scheduledTimers.find((entry) => entry.id === (timeoutId as unknown as number));
		if (timer) {
			timer.cleared = true;
		}
	}) as unknown as typeof clearTimeout;

	return {
		scheduledTimers,
		restore() {
			globalThis.setTimeout = originalSetTimeout;
			globalThis.clearTimeout = originalClearTimeout;
		},
	};
}

function createPendingSettlementGate(): {
	gate: SettlementGate;
	release: (result: SettleRoundResult) => void;
} {
	let blocked = false;
	let pending: ReturnType<typeof buildPokerSettlementCommand> | null = null;
	let release!: (result: SettleRoundResult) => void;
	const settlement = new Promise<SettleRoundResult>((resolve) => {
		release = resolve;
	});

	return {
		gate: {
			get pending() {
				return pending;
			},
			get isBlocked() {
				return blocked;
			},
			async settle(command) {
				blocked = true;
				pending = command;
				try {
					return await settlement;
				} finally {
					blocked = false;
					pending = null;
				}
			},
			retry: async () => null,
			reset() {
				blocked = false;
				pending = null;
			},
		},
		release,
	};
}

describe('PokerGame Core Logic', () => {
	beforeEach(() => {
		mockPokerGameDOM();
		(globalThis as typeof globalThis & { localStorage: Storage }).localStorage = {
			getItem: () => null,
			setItem: () => {},
			removeItem: () => {},
			clear: () => {},
			key: () => null,
			length: 0,
		};
		(globalThis as typeof globalThis & { fetch: typeof fetch }).fetch = mock(async () => {
			return {
				ok: true,
				status: 200,
				json: async () => ({ balance: 500 }),
			};
		}) as unknown as typeof fetch;
	});

	describe('Player management', () => {
		test('creates correct player structure', () => {
			const player = createPlayer(0, 'Alice', 500);
			expect(player.id).toBe(0);
			expect(player.name).toBe('Alice');
			expect(player.chips).toBe(500);
			expect(player.isAI).toBe(false);
		});

		test('creates AI players with correct flag', () => {
			const aiPlayer = createAIPlayer(1, 'Bot', 500);
			expect(aiPlayer.isAI).toBe(true);
		});
	});

	describe('Betting mechanics', () => {
		test('calculates highest bet correctly', () => {
			const players = [
				{ ...createPlayer(0, 'Alice', 500), currentBet: 50 },
				{ ...createPlayer(1, 'Bob', 500), currentBet: 100 },
				{ ...createPlayer(2, 'Charlie', 500), currentBet: 75 },
			];

			expect(getHighestBet(players)).toBe(100);
		});

		test('calculates call amount correctly', () => {
			const player = { ...createPlayer(0, 'Alice', 500), currentBet: 30 };
			const highestBet = 100;

			expect(getCallAmount(player, highestBet)).toBe(70);
		});

		test('handles all-in betting', () => {
			const player = createPlayer(0, 'Alice', 50);
			const result = placeBet(player, 100); // More than chips

			expect(result.chips).toBe(0);
			expect(result.currentBet).toBe(50); // Capped at available
			expect(result.isAllIn).toBe(true);
		});

		test('tracks bets across multiple actions', () => {
			let player = createPlayer(0, 'Alice', 500);
			player = placeBet(player, 50);
			player = placeBet(player, 50);

			expect(player.currentBet).toBe(100);
			expect(player.totalBet).toBe(100);
			expect(player.chips).toBe(400);
		});
	});

	describe('Betting round completion', () => {
		test('detects incomplete round when player hasnt acted', () => {
			const players = [
				{ ...createPlayer(0, 'Alice', 500), hasActed: true, currentBet: 50 },
				{ ...createPlayer(1, 'Bob', 500), hasActed: false, currentBet: 50 },
			];

			expect(isBettingRoundComplete(players)).toBe(false);
		});

		test('detects incomplete round when bets not matched', () => {
			const players = [
				{ ...createPlayer(0, 'Alice', 500), hasActed: true, currentBet: 50 },
				{ ...createPlayer(1, 'Bob', 500), hasActed: true, currentBet: 100 },
			];

			expect(isBettingRoundComplete(players)).toBe(false);
		});

		test('detects complete round when all matched and acted', () => {
			const players = [
				{ ...createPlayer(0, 'Alice', 500), hasActed: true, currentBet: 100 },
				{ ...createPlayer(1, 'Bob', 500), hasActed: true, currentBet: 100 },
			];

			expect(isBettingRoundComplete(players)).toBe(true);
		});

		test('handles all-in players in completion check', () => {
			const players = [
				{ ...createPlayer(0, 'Alice', 500), hasActed: true, currentBet: 100 },
				{ ...createPlayer(1, 'Bob', 0), isAllIn: true, hasActed: true, currentBet: 50 },
			];

			expect(isBettingRoundComplete(players)).toBe(true);
		});

		test('ignores folded players in completion check', () => {
			const players = [
				{ ...createPlayer(0, 'Alice', 500), hasActed: true, currentBet: 100 },
				{ ...createPlayer(1, 'Bob', 500), folded: true, currentBet: 0 },
				{ ...createPlayer(2, 'Charlie', 500), hasActed: true, currentBet: 100 },
			];

			expect(isBettingRoundComplete(players)).toBe(true);
		});
	});

	describe('Player state management', () => {
		test('folding player sets correct flags', () => {
			const player = createPlayer(0, 'Alice', 500);
			const folded = foldPlayer(player);

			expect(folded.folded).toBe(true);
			expect(folded.hasActed).toBe(true);
			expect(folded.chips).toBe(500); // Chips preserved
		});

		test('resetting player clears hand state', () => {
			const player = {
				...createPlayer(0, 'Alice', 300),
				hand: [card('A', 'hearts', 14), card('K', 'spades', 13)],
				currentBet: 50,
				totalBet: 100,
				folded: true,
				hasActed: true,
			};

			const reset = resetPlayerForNewHand(player);

			expect(reset.chips).toBe(300); // Preserved
			expect(reset.hand).toEqual([]);
			expect(reset.currentBet).toBe(0);
			expect(reset.totalBet).toBe(0);
			expect(reset.folded).toBe(false);
			expect(reset.hasActed).toBe(false);
		});
	});

	describe('Active player filtering', () => {
		test('returns only non-folded players', () => {
			const players = [
				createPlayer(0, 'Alice', 500),
				{ ...createPlayer(1, 'Bob', 500), folded: true },
				createPlayer(2, 'Charlie', 500),
			];

			const active = getActivePlayers(players);

			expect(active.length).toBe(2);
			expect(active[0].name).toBe('Alice');
			expect(active[1].name).toBe('Charlie');
		});

		test('handles all players folded', () => {
			const players = [
				{ ...createPlayer(0, 'Alice', 500), folded: true },
				{ ...createPlayer(1, 'Bob', 500), folded: true },
			];

			expect(getActivePlayers(players).length).toBe(0);
		});

		test('handles no players folded', () => {
			const players = [createPlayer(0, 'Alice', 500), createPlayer(1, 'Bob', 500)];

			expect(getActivePlayers(players).length).toBe(2);
		});
	});

	describe('Blind mechanics', () => {
		test('blinds rotate after each hand', () => {
			// Dealer index should increment mod player count
			const players = [
				createPlayer(0, 'Alice', 500),
				createPlayer(1, 'Bob', 500),
				createPlayer(2, 'Charlie', 500),
			];

			// Initial dealer at index 0
			let dealerIdx = 0;
			// After one hand
			dealerIdx = (dealerIdx + 1) % players.length;
			expect(dealerIdx).toBe(1);

			// After second hand
			dealerIdx = (dealerIdx + 1) % players.length;
			expect(dealerIdx).toBe(2);

			// Wraps around
			dealerIdx = (dealerIdx + 1) % players.length;
			expect(dealerIdx).toBe(0);
		});
	});

	describe('Win condition scenarios', () => {
		test('single active player wins by default', () => {
			const players = [
				createPlayer(0, 'Alice', 500),
				{ ...createPlayer(1, 'Bob', 500), folded: true },
				{ ...createPlayer(2, 'Charlie', 500), folded: true },
			];

			const active = getActivePlayers(players);

			expect(active.length).toBe(1);
			expect(active[0].name).toBe('Alice');
		});

		test('multiple active players go to showdown', () => {
			const players = [
				createPlayer(0, 'Alice', 500),
				createPlayer(1, 'Bob', 500),
				{ ...createPlayer(2, 'Charlie', 500), folded: true },
			];

			const active = getActivePlayers(players);

			expect(active.length).toBe(2);
		});
	});

	describe('Edge cases', () => {
		test('handles empty player list', () => {
			const players: Player[] = [];

			expect(getActivePlayers(players).length).toBe(0);
			expect(getHighestBet(players)).toBe(0);
		});

		test('handles single player', () => {
			const players = [createPlayer(0, 'Alice', 500)];

			expect(getActivePlayers(players).length).toBe(1);
		});

		test('prevents negative chip counts', () => {
			const player = createPlayer(0, 'Alice', 50);
			const result = placeBet(player, 100);

			expect(result.chips).toBe(0); // Not negative
		});
	});
});

describe('PokerGame bankroll and auto-deal guards', () => {
	test('initializes AI configs with persisted per-opponent difficulties', () => {
		const elements = mockPokerGameDOM();
		elements['player-balance'] = {
			addEventListener: () => {},
			dataset: { balance: '500' },
			innerHTML: '',
			textContent: '$500',
			classList: { add: () => {}, remove: () => {}, toggle: () => {} },
			value: '0',
		};

		(globalThis as typeof globalThis & { localStorage: Storage }).localStorage = {
			getItem: (key: string) =>
				key === 'poker_game_settings'
					? JSON.stringify({
							...DEFAULT_SETTINGS,
							aiPersonality1: 'tight-passive',
							aiPersonality2: 'loose-aggressive',
							aiDifficulty1: 'easy',
							aiDifficulty2: 'hard',
						})
					: null,
			setItem: () => {},
			removeItem: () => {},
			clear: () => {},
			key: () => null,
			length: 0,
		};

		const game = new PokerGame() as unknown as {
			aiConfigs: Map<number, { personality: string; difficulty: string }>;
		};

		expect(game.aiConfigs.get(1)).toMatchObject({
			personality: 'tight-passive',
			difficulty: 'easy',
		});
		expect(game.aiConfigs.get(2)).toMatchObject({
			personality: 'loose-aggressive',
			difficulty: 'hard',
		});
	});

	test('initializes the human stack from the server-rendered balance', () => {
		const elements = mockPokerGameDOM();
		elements['player-balance'] = {
			addEventListener: () => {},
			dataset: {},
			innerHTML: '',
			textContent: '40',
			classList: { add: () => {}, remove: () => {}, toggle: () => {} },
			value: '0',
		};

		const game = new PokerGame() as unknown as { players: Player[] };

		expect(game.players[0].chips).toBe(40);
		expect(game.players[1].chips).toBe(500);
		expect(game.players[2].chips).toBe(500);
	});

	test('initializes the human stack from the raw balance attribute when display text is localized', () => {
		const elements = mockPokerGameDOM();
		elements['player-balance'] = {
			addEventListener: () => {},
			dataset: { balance: '1000' },
			innerHTML: '',
			textContent: '$1.000',
			classList: { add: () => {}, remove: () => {}, toggle: () => {} },
			value: '0',
		};

		const game = new PokerGame() as unknown as { players: Player[]; serverSyncedBalance: number };

		expect(game.serverSyncedBalance).toBe(1000);
		expect(game.players[0].chips).toBe(1000);
	});

	test('parses locale-formatted textContent when data-balance attribute is absent', () => {
		const elements = mockPokerGameDOM();
		elements['player-balance'] = {
			addEventListener: () => {},
			// No dataset.balance — forces fallback to textContent
			dataset: {},
			innerHTML: '',
			textContent: '$1,000',
			classList: { add: () => {}, remove: () => {}, toggle: () => {} },
			value: '0',
		};

		const game = new PokerGame() as unknown as { players: Player[]; serverSyncedBalance: number };

		expect(game.serverSyncedBalance).toBe(1000);
		expect(game.players[0].chips).toBe(1000);
	});

	test('guest mode stays playable and skips account wallet settlement', async () => {
		const elements = mockPokerGameDOM();
		elements['poker-root'] = {
			addEventListener: () => {},
			dataset: { guestMode: 'true' },
			innerHTML: '',
			textContent: '',
			classList: { add: () => {}, remove: () => {}, toggle: () => {} },
			value: '0',
		};
		elements['player-balance'] = {
			addEventListener: () => {},
			dataset: {
				balance: '1000',
				balanceAvailable: 'true',
				guestMode: 'true',
				userId: '',
			},
			innerHTML: '',
			textContent: '$1,000',
			classList: { add: () => {}, remove: () => {}, toggle: () => {} },
			value: '0',
		};

		(globalThis as typeof globalThis & { localStorage: Storage }).localStorage = {
			getItem: () => null,
			setItem: () => {},
			removeItem: () => {},
			clear: () => {},
			key: () => null,
			length: 0,
		};

		const fetchCalls: string[] = [];
		const originalFetch = globalThis.fetch;
		const fetchMock = mock(async (input: string | URL | Request) => {
			const url =
				typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
			fetchCalls.push(url);
			return {
				ok: false,
				status: 401,
				json: async () => ({ error: 'UNAUTHORIZED' }),
			};
		}) as unknown as typeof fetch;
		(globalThis as typeof globalThis & { fetch: typeof fetch }).fetch = fetchMock;

		try {
			const game = new PokerGame() as unknown as {
				players: Player[];
				humanChipsBefore: number;
				hasServerSyncedBalance: boolean;
				settleHand: (outcome: 'win' | 'loss' | 'push') => void;
			};

			expect(game.hasServerSyncedBalance).toBe(true);
			expect(game.players[0].chips).toBe(1000);

			game.humanChipsBefore = 1000;
			game.players[0] = { ...game.players[0], chips: 1050 };
			game.settleHand('win');

			await flushAsyncWork();

			expect(fetchCalls).not.toContain('/api/wallet/settle');
			expect(game.humanChipsBefore).toBe(0);
			expect(game.players[0].chips).toBe(1050);
		} finally {
			(globalThis as typeof globalThis & { fetch: typeof fetch }).fetch = originalFetch;
		}
	});

	test('authenticated beforeunload does not submit an active-hand settlement', async () => {
		const elements = mockPokerGameDOM();
		(globalThis as typeof globalThis & { localStorage: Storage }).localStorage = {
			getItem: () => null,
			setItem: () => {},
			removeItem: () => {},
			clear: () => {},
			key: () => null,
			length: 0,
		};
		(globalThis as typeof globalThis & { fetch: typeof fetch }).fetch = mock(async () => ({
			ok: true,
			status: 200,
			json: async () => ({ settings: null }),
		})) as unknown as typeof fetch;
		elements['player-balance'] = {
			addEventListener: () => {},
			dataset: { balance: '1000', balanceAvailable: 'true', userId: 'unload-user' },
			innerHTML: '',
			textContent: '$1,000',
			classList: { add: () => {}, remove: () => {}, toggle: () => {} },
			value: '0',
		};

		const settlements: unknown[] = [];
		const gate: SettlementGate = {
			pending: null,
			isBlocked: false,
			settle: async (command) => {
				settlements.push(command);
				return { balance: 900, duplicate: false };
			},
			retry: async () => null,
			reset: () => {},
		};
		const game = new PokerGame(undefined, gate) as unknown as {
			players: Player[];
			humanChipsBefore: number;
		};
		game.humanChipsBefore = 1000;
		game.players[0] = { ...game.players[0], chips: 900 };

		windowListeners.beforeunload?.();
		await flushAsyncWork();

		expect(settlements).toHaveLength(0);
		expect(game.humanChipsBefore).toBe(1000);
	});

	test('guest beforeunload persists the local bankroll without wallet settlement', () => {
		const elements = mockPokerGameDOM();
		(globalThis as typeof globalThis & { fetch: typeof fetch }).fetch = mock(async () => ({
			ok: true,
			status: 200,
			json: async () => ({ settings: null }),
		})) as unknown as typeof fetch;
		elements['poker-root'] = {
			addEventListener: () => {},
			dataset: { guestMode: 'true' },
			innerHTML: '',
			textContent: '',
			classList: { add: () => {}, remove: () => {}, toggle: () => {} },
			value: '0',
		};
		elements['player-balance'] = {
			addEventListener: () => {},
			dataset: {
				balance: '1000',
				balanceAvailable: 'true',
				guestMode: 'true',
				userId: 'unload-guest',
			},
			innerHTML: '',
			textContent: '$1,000',
			classList: { add: () => {}, remove: () => {}, toggle: () => {} },
			value: '0',
		};
		const storage: Record<string, string> = {};
		(globalThis as typeof globalThis & { localStorage: Storage }).localStorage = {
			getItem: (key: string) => storage[key] ?? null,
			setItem: (key: string, value: string) => {
				storage[key] = value;
			},
			removeItem: () => {},
			clear: () => {},
			key: () => null,
			length: 0,
		};

		const game = new PokerGame() as unknown as { players: Player[] };
		game.players[0] = { ...game.players[0], chips: 725 };

		windowListeners.beforeunload?.();

		expect(storage['poker-bankroll:unload-guest']).toBe('725');
	});

	test('guest mode syncs #player-balance DOM to the restored bankroll on init', () => {
		const elements = mockPokerGameDOM();
		elements['poker-root'] = {
			addEventListener: () => {},
			dataset: { guestMode: 'true' },
			innerHTML: '',
			textContent: '',
			classList: { add: () => {}, remove: () => {}, toggle: () => {} },
			value: '0',
		};
		// Server-rendered DOM still shows the default $1,000 guest balance.
		const balanceEl = {
			addEventListener: () => {},
			dataset: {
				balance: '1000',
				balanceAvailable: 'true',
				guestMode: 'true',
				userId: 'guest-abc',
			},
			innerHTML: '',
			textContent: '$1,000',
			classList: { add: () => {}, remove: () => {}, toggle: () => {} },
			value: '0',
		};
		elements['player-balance'] = balanceEl;

		// Restored guest bankroll is $850, differing from the server-rendered $1,000.
		const storage: Record<string, string> = { 'poker-bankroll:guest-abc': '850' };
		(globalThis as typeof globalThis & { localStorage: Storage }).localStorage = {
			getItem: (key: string) => (key in storage ? storage[key] : null),
			setItem: (key: string, value: string) => {
				storage[key] = value;
			},
			removeItem: (key: string) => {
				delete storage[key];
			},
			clear: () => {
				for (const k of Object.keys(storage)) delete storage[k];
			},
			key: () => null,
			length: 0,
		};

		const game = new PokerGame() as unknown as { players: Player[] };

		expect(game.players[0].chips).toBe(850);
		// DOM must be reconciled to the restored stack immediately, not left stale.
		expect(balanceEl.textContent).toBe('850 chips');
	});

	test('keeps poker non-playable when the server balance is unavailable', async () => {
		const elements = mockPokerGameDOM();
		elements['player-balance'] = {
			addEventListener: () => {},
			dataset: { balance: '', balanceAvailable: 'false' },
			innerHTML: '',
			textContent: 'Unavailable',
			classList: { add: () => {}, remove: () => {}, toggle: () => {} },
			disabled: false,
			value: '0',
		};

		const game = new PokerGame() as unknown as {
			players: Player[];
			serverSyncedBalance: number;
			humanChipsBefore: number;
			dealNewHand: () => Promise<void>;
		};

		expect(game.serverSyncedBalance).toBe(0);
		expect(game.players[0].chips).toBe(0);
		expect(elements['btn-deal']?.disabled).toBe(true);
		expect(elements['game-status']?.textContent).toContain('Unable to load your chip balance');

		await game.dealNewHand();

		expect(game.humanChipsBefore).toBe(0);
		expect(elements['game-status']?.textContent).toContain('Unable to load your chip balance');
	});

	test('preserves the account-backed human stack when applying a pending chip reset', async () => {
		const elements = mockPokerGameDOM();
		elements['player-balance'] = {
			addEventListener: () => {},
			dataset: {},
			innerHTML: '',
			textContent: '500',
			classList: { add: () => {}, remove: () => {}, toggle: () => {} },
			value: '0',
		};

		const game = new PokerGame() as unknown as {
			players: Player[];
			pendingChipReset: boolean;
			serverSyncedBalance: number;
			humanChipsBefore: number;
			processAITurn: () => Promise<void>;
			dealNewHand: () => Promise<void>;
		};

		game.processAITurn = async () => {};
		game.serverSyncedBalance = 75;
		game.players[0] = { ...game.players[0], chips: 75 };
		game.pendingChipReset = true;

		await game.dealNewHand();

		expect(game.humanChipsBefore).toBe(75);
		expect(game.players[0].chips).toBe(75); // Human is no longer the big blind in six-max.
	});

	test('does not restore a busted human player to free starting chips', async () => {
		const elements = mockPokerGameDOM();
		elements['player-balance'] = {
			addEventListener: () => {},
			innerHTML: '',
			textContent: '0',
			classList: { add: () => {}, remove: () => {}, toggle: () => {} },
			value: '0',
		};

		const game = new PokerGame() as unknown as {
			players: Player[];
			serverSyncedBalance: number;
			humanChipsBefore: number;
			processAITurn: () => Promise<void>;
			dealNewHand: () => Promise<void>;
		};

		game.processAITurn = async () => {};
		game.serverSyncedBalance = 0;
		game.players[0] = { ...game.players[0], chips: 0 };

		await game.dealNewHand();

		expect(game.players[0].chips).toBe(0);
		expect(game.humanChipsBefore).toBe(0);
	});

	test('guest rebuy resets bankroll to default and deals a new hand', async () => {
		const elements = mockPokerGameDOM();
		elements['poker-root'] = {
			addEventListener: () => {},
			dataset: { guestMode: 'true' },
			innerHTML: '',
			textContent: '',
			classList: { add: () => {}, remove: () => {}, toggle: () => {} },
			value: '0',
		};
		elements['player-balance'] = {
			addEventListener: () => {},
			dataset: {
				balance: '0',
				balanceAvailable: 'true',
				guestMode: 'true',
				userId: 'guest-bust',
			},
			innerHTML: '',
			textContent: '$0',
			classList: { add: () => {}, remove: () => {}, toggle: () => {} },
			value: '0',
		};

		const storage: Record<string, string> = {};
		(globalThis as typeof globalThis & { localStorage: Storage }).localStorage = {
			getItem: (key: string) => (key in storage ? storage[key] : null),
			setItem: (key: string, value: string) => {
				storage[key] = value;
			},
			removeItem: (key: string) => {
				delete storage[key];
			},
			clear: () => {
				for (const k of Object.keys(storage)) delete storage[k];
			},
			key: () => null,
			length: 0,
		};

		const game = new PokerGame() as unknown as {
			players: Player[];
			serverSyncedBalance: number;
			humanChipsBefore: number;
			isGuestMode: boolean;
			processAITurn: () => Promise<void>;
			dealNewHand: () => Promise<void>;
			rebuyBustedGuest: () => Promise<void>;
		};

		game.processAITurn = async () => {};
		game.serverSyncedBalance = 0;
		game.players[0] = { ...game.players[0], chips: 0 };

		// Busted guest deals → Game Over, rebuy button shown.
		await game.dealNewHand();
		expect(game.players[0].chips).toBe(0);
		expect(elements['btn-rebuy']?.hidden).toBe(false);

		// Rebuy restores the default guest balance and deals. Blinds are
		// posted during the deal, so chips will be slightly below the reset
		// amount — the key assertions are the bankroll reset and that the
		// player is no longer busted.
		await game.rebuyBustedGuest();
		expect(game.serverSyncedBalance).toBe(DEFAULT_GUEST_GAME_BALANCE);
		expect(game.players[0].chips).toBeGreaterThan(0);
		expect(storage['poker-bankroll:guest-bust']).toBe(String(DEFAULT_GUEST_GAME_BALANCE));
		expect(elements['btn-rebuy']?.hidden).toBe(true);
	});

	test('guest settlement keeps serverSyncedBalance in step with the persisted bankroll', () => {
		// Regression: the guest branch of settleHand persisted the new bankroll
		// to localStorage but left serverSyncedBalance at the page-load baseline.
		// A guest who busted from $1,000 to $0 was then silently revived by
		// dealNewHand() (which uses getEffectiveServerBalance() for eliminated
		// players), bypassing the game-over / rebuy path. Saving settings would
		// also reset them to the stale baseline.
		const elements = mockPokerGameDOM();
		elements['poker-root'] = {
			addEventListener: () => {},
			dataset: { guestMode: 'true' },
			innerHTML: '',
			textContent: '',
			classList: { add: () => {}, remove: () => {}, toggle: () => {} },
			value: '0',
		};
		elements['player-balance'] = {
			addEventListener: () => {},
			dataset: {
				balance: '1000',
				balanceAvailable: 'true',
				guestMode: 'true',
				userId: 'guest-sync',
			},
			innerHTML: '',
			textContent: '$1,000',
			classList: { add: () => {}, remove: () => {}, toggle: () => {} },
			value: '0',
		};

		const storage: Record<string, string> = {};
		(globalThis as typeof globalThis & { localStorage: Storage }).localStorage = {
			getItem: (key: string) => (key in storage ? storage[key] : null),
			setItem: (key: string, value: string) => {
				storage[key] = value;
			},
			removeItem: (key: string) => {
				delete storage[key];
			},
			clear: () => {
				for (const k of Object.keys(storage)) delete storage[k];
			},
			key: () => null,
			length: 0,
		};

		const game = new PokerGame() as unknown as {
			players: Player[];
			serverSyncedBalance: number;
			isGuestMode: boolean;
			settleHand: (outcome: 'win' | 'loss' | 'push') => void;
		};

		// Guest loaded with the default $1,000 baseline.
		expect(game.serverSyncedBalance).toBe(1000);

		// Guest loses the whole stack.
		game.players[0] = { ...game.players[0], chips: 0 };
		game.settleHand('loss');

		// The in-memory baseline must track the persisted bankroll so the next
		// dealNewHand() sees an effective balance of $0 and routes to game-over.
		expect(game.serverSyncedBalance).toBe(0);
		expect(storage['poker-bankroll:guest-sync']).toBe('0');
	});

	test('ignores a stale auto-deal callback after a manual deal starts a fresh hand', async () => {
		const elements = mockPokerGameDOM();
		elements['player-balance'] = {
			addEventListener: () => {},
			innerHTML: '',
			textContent: '500',
			classList: { add: () => {}, remove: () => {}, toggle: () => {} },
			value: '0',
		};

		const chipUpdateBodies: Array<Record<string, unknown>> = [];
		const fetchMock = mock(async (input: string | URL | Request, init?: RequestInit) => {
			const url =
				typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

			chipUpdateBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
			return {
				ok: true,
				status: 200,
				json: async () => ({ balance: 500 }),
			};
		}) as unknown as typeof fetch;
		(globalThis as typeof globalThis & { fetch: typeof fetch }).fetch = fetchMock;

		const timers = mockTrackedTimers();

		try {
			const game = new PokerGame() as unknown as {
				players: Player[];
				pot: number;
				humanChipsBefore: number;
				nextPhase: () => void;
				processAITurn: () => Promise<void>;
				dealNewHand: () => Promise<void>;
			};

			game.processAITurn = async () => {};
			game.humanChipsBefore = 500;
			game.pot = 150;
			game.players[0] = { ...game.players[0], chips: 350, folded: false };
			game.players = game.players.map((player) => ({ ...player, folded: player.id !== 0 }));

			game.nextPhase();
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();

			expect(chipUpdateBodies).toHaveLength(1);

			const staleAutoDeal = timers.scheduledTimers.find(
				(timer) => timer.delay === 3000 && !timer.cleared,
			);
			expect(staleAutoDeal).toBeDefined();

			await game.dealNewHand();
			await Promise.resolve();
			await Promise.resolve();

			expect(chipUpdateBodies).toHaveLength(1);
			expect(game.humanChipsBefore).toBe(500);

			staleAutoDeal?.callback();
			await Promise.resolve();
			await Promise.resolve();

			expect(chipUpdateBodies).toHaveLength(1);
			expect(game.humanChipsBefore).toBe(500);
		} finally {
			timers.restore();
		}
	});

	test('ignores a stale next-phase callback after a manual deal starts a fresh hand', async () => {
		const elements = mockPokerGameDOM();
		elements['player-balance'] = {
			addEventListener: () => {},
			innerHTML: '',
			textContent: '500',
			classList: { add: () => {}, remove: () => {}, toggle: () => {} },
			value: '0',
		};

		const timers = mockTrackedTimers();

		try {
			const game = new PokerGame() as unknown as {
				players: Player[];
				currentPlayerIndex: number;
				communityCards: Card[];
				gamePhase: string;
				processAITurn: () => Promise<void>;
				advanceTurn: () => void;
				dealNewHand: () => Promise<void>;
			};

			game.processAITurn = async () => {};
			game.currentPlayerIndex = 0;
			game.players = game.players.map((player) => ({
				...player,
				folded: false,
				hasActed: true,
				currentBet: 10,
			}));

			game.advanceTurn();

			const staleNextPhase = timers.scheduledTimers.find(
				(timer) => timer.delay === 1000 && !timer.cleared,
			);
			expect(staleNextPhase).toBeDefined();

			await game.dealNewHand();
			await Promise.resolve();
			await Promise.resolve();

			expect(game.gamePhase).toBe('preflop');
			expect(game.communityCards).toHaveLength(0);

			staleNextPhase?.callback();
			await Promise.resolve();
			await Promise.resolve();

			expect(game.gamePhase).toBe('preflop');
			expect(game.communityCards).toHaveLength(0);
		} finally {
			timers.restore();
		}
	});

	test('ignores a stale AI delay callback after a manual deal starts a fresh hand', async () => {
		const elements = mockPokerGameDOM();
		elements['player-balance'] = {
			addEventListener: () => {},
			innerHTML: '',
			textContent: '500',
			classList: { add: () => {}, remove: () => {}, toggle: () => {} },
			value: '0',
		};

		const timers = mockTrackedTimers();

		try {
			const game = new PokerGame() as unknown as {
				players: Player[];
				currentPlayerIndex: number;
				processAITurn: () => Promise<void>;
				dealNewHand: () => Promise<void>;
			};

			const originalProcessAITurn = game.processAITurn.bind(game);
			game.currentPlayerIndex = 1;
			void originalProcessAITurn();

			const staleAiDelay = timers.scheduledTimers.find((timer) => !timer.cleared);
			expect(staleAiDelay).toBeDefined();

			game.processAITurn = async () => {};
			await game.dealNewHand();
			await Promise.resolve();
			await Promise.resolve();

			expect(game.currentPlayerIndex).toBe(4);
			expect(game.players[1].hasActed).toBe(false);
			expect(game.players[1].folded).toBe(false);

			staleAiDelay?.callback();
			await Promise.resolve();
			await Promise.resolve();

			expect(game.currentPlayerIndex).toBe(4);
			expect(game.players[1].hasActed).toBe(false);
			expect(game.players[1].folded).toBe(false);
		} finally {
			timers.restore();
		}
	});
});

describe('Game state consistency', () => {
	test('total chips in play remains constant', () => {
		const players = [
			createPlayer(0, 'Alice', 500),
			createPlayer(1, 'Bob', 500),
			createPlayer(2, 'Charlie', 500),
		];

		const initialTotal = players.reduce((sum, p) => sum + p.chips, 0);

		// Simulate some betting
		players[0] = placeBet(players[0], 50);
		players[1] = placeBet(players[1], 50);

		const pot = players[0].currentBet + players[1].currentBet;
		const currentTotal = players.reduce((sum, p) => sum + p.chips, 0) + pot;

		expect(currentTotal).toBe(initialTotal);
	});

	test('current bets never exceed player chips plus bets', () => {
		const player = createPlayer(0, 'Alice', 100);
		const initialChips = player.chips;

		const result = placeBet(player, 150); // More than available

		expect(result.currentBet).toBeLessThanOrEqual(initialChips);
		expect(result.chips + result.currentBet).toBe(initialChips);
	});
});

describe('Turn management', () => {
	test('turn advances to next active player', () => {
		const players = [
			createPlayer(0, 'Alice', 500),
			{ ...createPlayer(1, 'Bob', 500), folded: true },
			createPlayer(2, 'Charlie', 500),
		];

		let currentIdx = 0;
		// Find next non-folded player
		currentIdx = (currentIdx + 1) % players.length;
		while (players[currentIdx].folded && currentIdx !== 0) {
			currentIdx = (currentIdx + 1) % players.length;
		}

		expect(currentIdx).toBe(2); // Skip folded Bob
	});
});

describe('PokerGame guest LLM, showdown messaging, and position', () => {
	beforeEach(() => {
		mockPokerGameDOM();
		(globalThis as typeof globalThis & { localStorage: Storage }).localStorage = {
			getItem: () => null,
			setItem: () => {},
			removeItem: () => {},
			clear: () => {},
			key: () => null,
			length: 0,
		};
		(globalThis as typeof globalThis & { fetch: typeof fetch }).fetch = mock(async () => {
			return { ok: true, status: 200, json: async () => ({ balance: 500 }) };
		}) as unknown as typeof fetch;
	});

	test('getLLMSettings returns null in guest mode without fetching', async () => {
		const elements = mockPokerGameDOM();
		elements['poker-root'] = {
			addEventListener: () => {},
			dataset: { guestMode: 'true' },
			innerHTML: '',
			textContent: '',
			classList: { add: () => {}, remove: () => {}, toggle: () => {} },
			value: '0',
		};
		elements['player-balance'] = {
			addEventListener: () => {},
			dataset: { balance: '1000', balanceAvailable: 'true', guestMode: 'true', userId: '' },
			innerHTML: '',
			textContent: '$1,000',
			classList: { add: () => {}, remove: () => {}, toggle: () => {} },
			value: '0',
		};

		const fetchCalls: string[] = [];
		const originalFetch = globalThis.fetch;
		(globalThis as typeof globalThis & { fetch: typeof fetch }).fetch = mock(
			async (input: string | URL | Request) => {
				const url =
					typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
				fetchCalls.push(url);
				return { ok: true, status: 200, json: async () => ({ settings: null }) };
			},
		) as unknown as typeof fetch;

		try {
			const game = new PokerGame() as unknown as {
				isGuestMode: boolean;
				getLLMSettings: () => Promise<unknown>;
			};

			expect(game.isGuestMode).toBe(true);
			const result = await game.getLLMSettings();
			expect(result).toBeNull();
			expect(fetchCalls).toEqual([]);
		} finally {
			(globalThis as typeof globalThis & { fetch: typeof fetch }).fetch = originalFetch;
		}
	});

	test('getLLMSettings reads browser-local settings without profile fetches', async () => {
		const originalLocalStorage = (globalThis as typeof globalThis & { localStorage: Storage })
			.localStorage;
		const originalFetch = globalThis.fetch;
		const storage = new Map<string, string>();
		(globalThis as typeof globalThis & { localStorage: Storage }).localStorage = {
			getItem: (key: string) => storage.get(key) ?? null,
			setItem: (key: string, value: string) => storage.set(key, value),
			removeItem: (key: string) => storage.delete(key),
			clear: () => storage.clear(),
			key: (index: number) => Array.from(storage.keys())[index] ?? null,
			get length() {
				return storage.size;
			},
		};
		localStorage.setItem(
			'arcturus-ai-settings',
			JSON.stringify({ provider: 'openai', model: 'gpt-4o', apiKey: 'sk-local' }),
		);

		const fetchCalls: string[] = [];
		(globalThis as typeof globalThis & { fetch: typeof fetch }).fetch = mock(
			async (input: string | URL | Request) => {
				const url =
					typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
				fetchCalls.push(url);
				return { ok: true, status: 200, json: async () => ({ settings: null }) };
			},
		) as unknown as typeof fetch;

		try {
			const game = new PokerGame() as unknown as {
				getLLMSettings: () => Promise<unknown>;
			};
			const result = await game.getLLMSettings();

			expect(result).toEqual({ provider: 'openai', model: 'gpt-4o', apiKey: 'sk-local' });
			expect(fetchCalls).toEqual([]);
		} finally {
			(globalThis as typeof globalThis & { localStorage: Storage }).localStorage =
				originalLocalStorage;
			(globalThis as typeof globalThis & { fetch: typeof fetch }).fetch = originalFetch;
		}
	});

	test('formatShowdownMessage covers single winner, tie, empty, and multi-tier cases', () => {
		const elements = mockPokerGameDOM();
		elements['player-balance'] = {
			addEventListener: () => {},
			dataset: { balance: '500' },
			innerHTML: '',
			textContent: '500',
			classList: { add: () => {}, remove: () => {}, toggle: () => {} },
			value: '0',
		};

		const game = new PokerGame() as unknown as {
			formatShowdownMessage: (tierResults: Array<{ amount: number; winners: Player[] }>) => string;
		};

		expect(game.formatShowdownMessage([])).toBe('Showdown complete.');

		const alice = createPlayer(0, 'Alice', 500);
		const bob = createPlayer(1, 'Bob', 500);
		expect(game.formatShowdownMessage([{ amount: 300, winners: [alice] }])).toBe(
			'Alice wins 300 chips! 🎉',
		);
		expect(game.formatShowdownMessage([{ amount: 300, winners: [alice, bob] }])).toBe(
			'Tie! Alice, Bob split the 300 chips pot 🤝',
		);

		const charlie = createPlayer(2, 'Charlie', 500);
		expect(
			game.formatShowdownMessage([
				{ amount: 200, winners: [alice] },
				{ amount: 100, winners: [charlie] },
			]),
		).toBe('Main pot: Alice wins 200 chips | Side pot 1: Charlie wins 100 chips');

		expect(
			game.formatShowdownMessage([
				{ amount: 200, winners: [alice, bob] },
				{ amount: 100, winners: [charlie] },
			]),
		).toBe('Main pot: Alice & Bob split 200 chips | Side pot 1: Charlie wins 100 chips');
	});

	test('getPlayerPosition maps 3-handed dealer/early/middle correctly', () => {
		const elements = mockPokerGameDOM();
		elements['player-balance'] = {
			addEventListener: () => {},
			dataset: { balance: '500' },
			innerHTML: '',
			textContent: '500',
			classList: { add: () => {}, remove: () => {}, toggle: () => {} },
			value: '0',
		};

		const game = new PokerGame() as unknown as {
			players: Player[];
			dealerIndex: number;
			getPlayerPosition: (player: Player) => 'early' | 'middle' | 'late';
		};

		// Exercise the retained 3-handed position branch.
		game.players = game.players.slice(0, 3);
		game.dealerIndex = 0;
		expect(game.getPlayerPosition(game.players[0])).toBe('late');
		expect(game.getPlayerPosition(game.players[1])).toBe('early');
		expect(game.getPlayerPosition(game.players[2])).toBe('middle');

		// Rotate dealer to index 1.
		game.dealerIndex = 1;
		expect(game.getPlayerPosition(game.players[1])).toBe('late');
		expect(game.getPlayerPosition(game.players[2])).toBe('early');
		expect(game.getPlayerPosition(game.players[0])).toBe('middle');
	});
});

describe('PokerGame settings save/reset with difficulty', () => {
	test('save settings persists per-opponent difficulty and rebuilds AI configs', () => {
		const elements = mockPokerGameDOM();
		elements['player-balance'] = {
			addEventListener: () => {},
			dataset: { balance: '500' },
			innerHTML: '',
			textContent: '500',
			classList: { add: () => {}, remove: () => {}, toggle: () => {} },
			value: '0',
		};

		const game = new PokerGame() as unknown as {
			aiConfigs: Map<number, { personality: string; difficulty: string }>;
			pendingChipReset: boolean;
		};

		// Populate all settings form elements with valid values (created by
		// the constructor's renderSettingsPanel / attachSettingsListeners).
		elements['setting-starting-chips'].value = '1000';
		elements['setting-small-blind'].value = '10';
		elements['setting-big-blind'].value = '20';
		elements['setting-ai-speed'].value = 'fast';
		elements['setting-ai-personality-1'].value = 'tight-passive';
		elements['setting-ai-personality-2'].value = 'loose-aggressive';
		elements['setting-ai-difficulty-1'].value = 'easy';
		elements['setting-ai-difficulty-2'].value = 'hard';
		elements['setting-use-llm-ai'].checked = false;

		// Click save.
		elements['btn-save-settings'].click();

		expect(game.aiConfigs.get(1)).toMatchObject({
			personality: 'tight-passive',
			difficulty: 'easy',
		});
		expect(game.aiConfigs.get(2)).toMatchObject({
			personality: 'loose-aggressive',
			difficulty: 'hard',
		});
		expect(game.pendingChipReset).toBe(true);
	});

	test('save settings falls back to current settings when difficulty select is invalid', () => {
		const elements = mockPokerGameDOM();
		elements['player-balance'] = {
			addEventListener: () => {},
			dataset: { balance: '500' },
			innerHTML: '',
			textContent: '500',
			classList: { add: () => {}, remove: () => {}, toggle: () => {} },
			value: '0',
		};

		const game = new PokerGame() as unknown as {
			aiConfigs: Map<number, { personality: string; difficulty: string }>;
		};

		elements['setting-starting-chips'].value = '1000';
		elements['setting-small-blind'].value = '10';
		elements['setting-big-blind'].value = '20';
		elements['setting-ai-speed'].value = 'normal';
		elements['setting-ai-personality-1'].value = 'tight-aggressive';
		elements['setting-ai-personality-2'].value = 'loose-passive';
		// Invalid difficulty values → should fall back to current settings.
		elements['setting-ai-difficulty-1'].value = 'bogus';
		elements['setting-ai-difficulty-2'].value = '';
		elements['setting-use-llm-ai'].checked = false;

		elements['btn-save-settings'].click();

		// Defaults are 'medium' for both difficulties.
		expect(game.aiConfigs.get(1)?.difficulty).toBe('medium');
		expect(game.aiConfigs.get(2)?.difficulty).toBe('medium');
	});

	test('reset settings rebuilds AI configs from defaults including difficulty', () => {
		const elements = mockPokerGameDOM();
		elements['player-balance'] = {
			addEventListener: () => {},
			dataset: { balance: '500' },
			innerHTML: '',
			textContent: '500',
			classList: { add: () => {}, remove: () => {}, toggle: () => {} },
			value: '0',
		};

		const game = new PokerGame() as unknown as {
			aiConfigs: Map<number, { personality: string; difficulty: string }>;
			pendingChipReset: boolean;
		};

		elements['btn-reset-settings'].click();

		const defaults = DEFAULT_SETTINGS;
		expect(game.aiConfigs.get(1)).toMatchObject({
			personality: defaults.aiPersonality1,
			difficulty: defaults.aiDifficulty1,
		});
		expect(game.aiConfigs.get(2)).toMatchObject({
			personality: defaults.aiPersonality2,
			difficulty: defaults.aiDifficulty2,
		});
		expect(game.pendingChipReset).toBe(true);
	});
});

describe('PokerGame human call all-in via UI', () => {
	test('btn-call clamps to remaining chips and marks the player all-in', () => {
		const elements = mockPokerGameDOM();
		elements['player-balance'] = {
			addEventListener: () => {},
			dataset: { balance: '500' },
			innerHTML: '',
			textContent: '500',
			classList: { add: () => {}, remove: () => {}, toggle: () => {} },
			value: '0',
		};

		const game = new PokerGame() as unknown as {
			players: Player[];
			currentPlayerIndex: number;
			isProcessingAction: boolean;
			pot: number;
			processAITurn: () => Promise<void>;
		};

		// Human's turn, facing a bet larger than their stack.
		game.currentPlayerIndex = 0;
		game.players[0] = { ...game.players[0], chips: 30, currentBet: 0, folded: false };
		game.players[1] = { ...game.players[1], currentBet: 100, folded: false };
		game.players[2] = { ...game.players[2], currentBet: 100, folded: false };

		// Prevent the async AI turn from leaking out of this test.
		game.processAITurn = async () => {};

		elements['btn-call'].click();

		// placeBet clamps to 30 chips and marks all-in.
		expect(game.players[0].chips).toBe(0);
		expect(game.players[0].isAllIn).toBe(true);
		expect(game.players[0].currentBet).toBe(30);
	});
});

describe('PokerGame processAITurn strips opponent hole cards', () => {
	test('sanitizedPlayers strips opponent hands before passing to makeAIDecision', async () => {
		const elements = mockPokerGameDOM();
		elements['player-balance'] = {
			addEventListener: () => {},
			dataset: { balance: '500' },
			innerHTML: '',
			textContent: '500',
			classList: { add: () => {}, remove: () => {}, toggle: () => {} },
			value: '0',
		};

		const timers = mockTrackedTimers();

		try {
			const game = new PokerGame(() => 0.5) as unknown as {
				players: Player[];
				currentPlayerIndex: number;
				pot: number;
				minimumBet: number;
				gamePhase: string;
				bettingRound: string | null;
				communityCards: Card[];
				processAITurn: () => Promise<void>;
			};

			// Set up an AI turn: player 1 (AI) with a hand, opponents have hands.
			game.currentPlayerIndex = 1;
			game.players[0] = {
				...game.players[0],
				hand: [card('A', 'hearts', 14), card('K', 'spades', 13)],
				currentBet: 10,
				folded: false,
			};
			game.players[1] = {
				...game.players[1],
				hand: [card('Q', 'hearts', 12), card('J', 'hearts', 11)],
				currentBet: 10,
				folded: false,
			};
			game.players[2] = {
				...game.players[2],
				hand: [card('9', 'clubs', 9), card('8', 'clubs', 8)],
				currentBet: 10,
				folded: false,
			};
			game.pot = 30;
			game.minimumBet = 10;
			game.gamePhase = 'preflop';
			game.bettingRound = 'preflop';

			// Start processAITurn — it awaits waitForTurnTransition (a timer).
			const turnPromise = game.processAITurn();

			// Flush the waitForTurnTransition timer so the AI decision runs.
			await Promise.resolve();
			const transitionTimer = timers.scheduledTimers.find((t) => !t.cleared);
			transitionTimer?.callback();
			await turnPromise;

			// The AI player's hand must remain intact in this.players (only the
			// context copy is sanitized), and the turn advanced.
			expect(game.players[1].hand).toHaveLength(2);
		} finally {
			timers.restore();
		}
	});
});

describe('Poker wallet settlement commands', () => {
	test('builds a loss command for a human fold-out', () => {
		const command = buildPokerSettlementCommand(-40, 'loss');

		expect(command).toEqual({
			settlementId: expect.stringMatching(/^poker-/),
			game: 'poker',
			delta: -40,
			stats: { rounds: 1, wins: 0, losses: 1, biggestWin: 0 },
		});
	});

	test('builds a one-round win command from the final showdown delta', () => {
		const command = buildPokerSettlementCommand(150, 'win');

		expect(command).toEqual({
			settlementId: expect.stringMatching(/^poker-/),
			game: 'poker',
			delta: 150,
			stats: { rounds: 1, wins: 1, losses: 0, biggestWin: 150 },
		});
	});

	test('does not auto-deal while the shared settlement gate is blocked', async () => {
		const elements = mockPokerGameDOM();
		(globalThis as typeof globalThis & { localStorage: Storage }).localStorage = {
			getItem: () => null,
			setItem: () => {},
			removeItem: () => {},
			clear: () => {},
			key: () => null,
			length: 0,
		};
		(globalThis as typeof globalThis & { fetch: typeof fetch }).fetch = mock(async () => ({
			ok: true,
			status: 200,
			json: async () => ({ settings: null }),
		})) as unknown as typeof fetch;
		elements['player-balance'] = {
			addEventListener: () => {},
			dataset: { balance: '500', balanceAvailable: 'true', userId: 'settlement-user' },
			innerHTML: '',
			textContent: '500',
			classList: { add: () => {}, remove: () => {}, toggle: () => {} },
			value: '0',
		};

		const gate = {
			pending: buildPokerSettlementCommand(-10, 'loss'),
			isBlocked: true,
			settle: async () => ({ balance: 490, duplicate: false }),
			retry: async () => null,
			reset: () => {},
		} as SettlementGate;
		const game = new PokerGame(undefined, gate) as unknown as {
			dealNewHand: () => Promise<void>;
			players: Player[];
			humanChipsBefore: number;
		};

		await game.dealNewHand();

		expect(game.players[0].hand).toHaveLength(0);
		expect(game.players[0].currentBet).toBe(0);
		expect(game.humanChipsBefore).toBe(0);
	});

	test('does not mutate an active hand when manual deal finalization is pending', async () => {
		const elements = mockPokerGameDOM();
		(globalThis as typeof globalThis & { localStorage: Storage }).localStorage = {
			getItem: () => null,
			setItem: () => {},
			removeItem: () => {},
			clear: () => {},
			key: () => null,
			length: 0,
		};
		(globalThis as typeof globalThis & { fetch: typeof fetch }).fetch = mock(async () => ({
			ok: true,
			status: 200,
			json: async () => ({ settings: null }),
		})) as unknown as typeof fetch;
		elements['player-balance'] = {
			addEventListener: () => {},
			dataset: { balance: '500', balanceAvailable: 'true', userId: 'manual-settlement-user' },
			innerHTML: '',
			textContent: '500',
			classList: { add: () => {}, remove: () => {}, toggle: () => {} },
			value: '0',
		};

		const { gate, release } = createPendingSettlementGate();
		const game = new PokerGame(undefined, gate) as unknown as {
			dealNewHand: () => Promise<void>;
			players: Player[];
			humanChipsBefore: number;
			pot: number;
		};
		const activeHand = [card('A', 'spades', 14)];
		game.players[0] = { ...game.players[0], chips: 450, hand: activeHand, currentBet: 7 };
		game.humanChipsBefore = 500;
		game.pot = 7;

		await game.dealNewHand();

		expect(game.players[0].hand).toEqual(activeHand);
		expect(game.players[0].currentBet).toBe(7);
		expect(game.pot).toBe(7);
		expect(game.humanChipsBefore).toBe(0);
		expect(gate.pending).not.toBeNull();

		release({ balance: 450, duplicate: false });
		await flushAsyncWork();
	});

	test('does not mutate an active hand when an auto-restart finalization is pending', async () => {
		const elements = mockPokerGameDOM();
		(globalThis as typeof globalThis & { localStorage: Storage }).localStorage = {
			getItem: () => null,
			setItem: () => {},
			removeItem: () => {},
			clear: () => {},
			key: () => null,
			length: 0,
		};
		(globalThis as typeof globalThis & { fetch: typeof fetch }).fetch = mock(async () => ({
			ok: true,
			status: 200,
			json: async () => ({ settings: null }),
		})) as unknown as typeof fetch;
		elements['player-balance'] = {
			addEventListener: () => {},
			dataset: { balance: '500', balanceAvailable: 'true', userId: 'restart-settlement-user' },
			innerHTML: '',
			textContent: '500',
			classList: { add: () => {}, remove: () => {}, toggle: () => {} },
			value: '0',
		};

		const timers = mockTrackedTimers();
		const { gate, release } = createPendingSettlementGate();
		try {
			const game = new PokerGame(undefined, gate) as unknown as {
				players: Player[];
				humanChipsBefore: number;
				pot: number;
				scheduleAutoDeal: (delayMs: number) => void;
			};
			const activeHand = [card('K', 'hearts', 13)];
			game.players[0] = { ...game.players[0], chips: 450, hand: activeHand, currentBet: 7 };
			game.humanChipsBefore = 500;
			game.pot = 7;

			game.scheduleAutoDeal(0);
			const restart = timers.scheduledTimers.find((timer) => timer.delay === 0 && !timer.cleared);
			restart?.callback();
			await flushAsyncWork();

			expect(game.players[0].hand).toEqual(activeHand);
			expect(game.players[0].currentBet).toBe(7);
			expect(game.pot).toBe(7);
			expect(game.humanChipsBefore).toBe(0);
			expect(gate.pending).not.toBeNull();

			release({ balance: 450, duplicate: false });
			await flushAsyncWork();
		} finally {
			timers.restore();
		}
	});

	test('retry handler re-attempts a failed settlement and adopts the result', async () => {
		const elements = mockPokerGameDOM();
		(globalThis as typeof globalThis & { localStorage: Storage }).localStorage = {
			getItem: () => null,
			setItem: () => {},
			removeItem: () => {},
			clear: () => {},
			key: () => null,
			length: 0,
		};
		(globalThis as typeof globalThis & { fetch: typeof fetch }).fetch = mock(async () => ({
			ok: true,
			status: 200,
			json: async () => ({ settings: null }),
		})) as unknown as typeof fetch;
		elements['player-balance'] = {
			addEventListener: () => {},
			dataset: { balance: '500', balanceAvailable: 'true', userId: 'retry-user' },
			innerHTML: '',
			textContent: '500',
			classList: { add: () => {}, remove: () => {}, toggle: () => {} },
			value: '0',
		};

		let settleCalls = 0;
		let retryCalls = 0;
		let pendingCommand: ReturnType<typeof buildPokerSettlementCommand> | null = null;
		const gate: SettlementGate = {
			get pending() {
				return pendingCommand;
			},
			get isBlocked() {
				return pendingCommand !== null;
			},
			settle: async (command) => {
				settleCalls += 1;
				pendingCommand = command;
				throw new Error('NETWORK_ERROR');
			},
			retry: async () => {
				retryCalls += 1;
				const result = { balance: 460, duplicate: false };
				pendingCommand = null;
				return result;
			},
			reset: () => {
				pendingCommand = null;
			},
		};
		const game = new PokerGame(undefined, gate) as unknown as {
			players: Player[];
			humanChipsBefore: number;
			hasServerSyncedBalance: boolean;
			serverSyncedBalance: number;
			settleHand: (outcome: 'win' | 'loss' | 'push') => void;
		};

		game.humanChipsBefore = 500;
		game.players[0] = { ...game.players[0], chips: 460 };
		game.settleHand('loss');
		await flushAsyncWork();

		expect(settleCalls).toBe(1);
		expect(elements['game-status']?.textContent).toContain('Settlement failed');

		// Click retry — the retry handler calls gate.retry() and adopts the result.
		elements['btn-retry-settlement'].click();
		await flushAsyncWork();

		expect(retryCalls).toBe(1);
		expect(game.players[0].chips).toBe(460);
		expect(game.serverSyncedBalance).toBe(460);
	});

	test('reset handler clears the gate and restores the server-synced balance', async () => {
		const elements = mockPokerGameDOM();
		(globalThis as typeof globalThis & { localStorage: Storage }).localStorage = {
			getItem: () => null,
			setItem: () => {},
			removeItem: () => {},
			clear: () => {},
			key: () => null,
			length: 0,
		};
		(globalThis as typeof globalThis & { fetch: typeof fetch }).fetch = mock(async () => ({
			ok: true,
			status: 200,
			json: async () => ({ settings: null }),
		})) as unknown as typeof fetch;
		elements['player-balance'] = {
			addEventListener: () => {},
			dataset: { balance: '500', balanceAvailable: 'true', userId: 'reset-user' },
			innerHTML: '',
			textContent: '500',
			classList: { add: () => {}, remove: () => {}, toggle: () => {} },
			value: '0',
		};

		let resetCalls = 0;
		const gate: SettlementGate = {
			pending: null,
			isBlocked: false,
			settle: async () => {
				throw new Error('NETWORK_ERROR');
			},
			retry: async () => null,
			reset: () => {
				resetCalls += 1;
			},
		};
		const game = new PokerGame(undefined, gate) as unknown as {
			players: Player[];
			humanChipsBefore: number;
			serverSyncedBalance: number;
			settleHand: (outcome: 'win' | 'loss' | 'push') => void;
		};

		game.humanChipsBefore = 500;
		game.players[0] = { ...game.players[0], chips: 420 };
		game.settleHand('loss');
		await flushAsyncWork();

		expect(elements['game-status']?.textContent).toContain('Settlement failed');

		// Click reset — the reset handler clears the gate and restores balance.
		elements['btn-reset-settlement'].click();

		expect(resetCalls).toBe(1);
		expect(game.players[0].chips).toBe(game.serverSyncedBalance);
		expect(game.humanChipsBefore).toBe(0);
	});

	test('dispatches achievement-earned event when settlement returns new achievements', async () => {
		const elements = mockPokerGameDOM();
		(globalThis as typeof globalThis & { localStorage: Storage }).localStorage = {
			getItem: () => null,
			setItem: () => {},
			removeItem: () => {},
			clear: () => {},
			key: () => null,
			length: 0,
		};
		(globalThis as typeof globalThis & { fetch: typeof fetch }).fetch = mock(async () => ({
			ok: true,
			status: 200,
			json: async () => ({ settings: null }),
		})) as unknown as typeof fetch;
		elements['player-balance'] = {
			addEventListener: () => {},
			dataset: { balance: '500', balanceAvailable: 'true', userId: 'ach-user' },
			innerHTML: '',
			textContent: '500',
			classList: { add: () => {}, remove: () => {}, toggle: () => {} },
			value: '0',
		};

		const dispatched: Array<{ type: string; detail: unknown }> = [];
		const origDispatch = (globalThis as typeof globalThis & { window: Window }).window
			.dispatchEvent;
		(globalThis as typeof globalThis & { window: Window }).window.dispatchEvent = ((event: {
			type: string;
			detail: unknown;
		}) => {
			dispatched.push(event);
			return true;
		}) as typeof window.dispatchEvent;

		try {
			const gate: SettlementGate = {
				pending: null,
				isBlocked: false,
				settle: async () => ({
					balance: 650,
					duplicate: false,
					newAchievements: [{ id: 'big-win', icon: '🎉' }],
				}),
				retry: async () => null,
				reset: () => {},
			};
			const game = new PokerGame(undefined, gate) as unknown as {
				players: Player[];
				humanChipsBefore: number;
				settleHand: (outcome: 'win' | 'loss' | 'push') => void;
			};

			game.humanChipsBefore = 500;
			game.players[0] = { ...game.players[0], chips: 650 };
			game.settleHand('win');
			await flushAsyncWork();

			expect(dispatched.some((e) => e.type === 'achievement-earned')).toBe(true);
			const achEvent = dispatched.find((e) => e.type === 'achievement-earned');
			expect((achEvent?.detail as { achievements: unknown[] }).achievements).toEqual([
				{ id: 'big-win', icon: '🎉' },
			]);
		} finally {
			(globalThis as typeof globalThis & { window: Window }).window.dispatchEvent = origDispatch;
		}
	});
});

// The mockup's six seats must play real hands, and custom amounts must remain legal.
describe('Poker six-max table controls', () => {
	let restoreGlobals: () => void;
	beforeEach(() => {
		const originals = {
			document: globalThis.document,
			window: globalThis.window,
			localStorage: globalThis.localStorage,
			HTMLButtonElement: globalThis.HTMLButtonElement,
			CustomEvent: globalThis.CustomEvent,
		};
		restoreGlobals = () => {
			Object.assign(globalThis, originals);
		};
	});
	afterEach(() => restoreGlobals());
	function setupTable() {
		const elements = mockPokerGameDOM();
		const balance = document.getElementById('player-balance')!;
		balance.dataset.balance = '1000';
		balance.dataset.guestMode = 'true';
		(globalThis as typeof globalThis & { localStorage: Storage }).localStorage = {
			getItem: () => null,
			setItem: () => {},
			removeItem: () => {},
			clear: () => {},
			key: () => null,
			length: 0,
		};
		const game = new PokerGame() as unknown as {
			players: Player[];
			pot: number;
			aiConfigs: Map<number, unknown>;
			currentPlayerIndex: number;
			bettingRound: string | null;
			minimumBet: number;
			isProcessingAction: boolean;
			processAITurn: () => Promise<void>;
			advanceTurn: () => void;
			dealNewHand: () => Promise<void>;
			updateActionButtons: () => void;
		};
		game.processAITurn = async () => {};
		return { game, elements };
	}

	test('deals twelve distinct hole cards, funds all five AI seats, and conserves chips', async () => {
		const { game, elements } = setupTable();
		expect(elements['btn-fold'].disabled).toBe(true);
		expect(elements['btn-deal'].hidden).toBe(false);
		await game.dealNewHand();
		expect(game.players).toHaveLength(6);
		expect(game.aiConfigs.size).toBe(5);
		const cards = game.players.flatMap((player) =>
			player.hand.map((card) => `${card.suit}-${card.rank}`),
		);
		expect(cards).toHaveLength(12);
		expect(new Set(cards).size).toBe(12);
		expect(game.players.reduce((sum, player) => sum + player.chips, game.pot)).toBe(3500);
		expect(game.currentPlayerIndex).toBe(4);
		expect(elements['btn-deal'].hidden).toBe(true);
		expect(elements['btn-fold'].disabled).toBe(true);
	});

	test('reserves the call amount, rejects malformed raises, and permits the affordable maximum', () => {
		const { game, elements } = setupTable();
		game.players[0] = { ...game.players[0], chips: 125, currentBet: 5 };
		game.players[1].currentBet = 25;
		game.bettingRound = 'preflop';
		game.minimumBet = 30;
		game.advanceTurn = () => {};
		game.updateActionButtons();
		const slider = document.getElementById('bet-slider') as HTMLInputElement;
		expect(slider.min).toBe('30');
		expect(slider.max).toBe('105');
		for (const value of ['NaN', '0', '29', '106', '30.5']) {
			slider.value = value;
			elements['btn-raise'].click();
			expect(game.players[0].chips).toBe(125);
			expect(game.pot).toBe(0);
		}
		slider.value = '105';
		elements['btn-raise'].click();
		expect(game.players[0].chips).toBe(0);
		expect(game.players[0].currentBet).toBe(130);
		expect(game.players[0].isAllIn).toBe(true);
	});

	test('shows Call for a short stack and locks actions after the hand', () => {
		const { game, elements } = setupTable();
		game.players[0].chips = 7;
		game.players[1].currentBet = 20;
		game.bettingRound = 'preflop';
		game.updateActionButtons();
		expect(elements['btn-call'].hidden).toBe(false);
		expect(elements['btn-call'].disabled).toBe(false);
		expect(elements['call-amount'].textContent).toBe('7');
		expect(elements['btn-check'].hidden).toBe(true);
		expect(elements['btn-raise'].disabled).toBe(true);
		game.bettingRound = null;
		game.updateActionButtons();
		expect(elements['btn-call'].disabled).toBe(true);
		expect(elements['btn-deal'].hidden).toBe(false);
	});
});

describe('Poker betting control regressions', () => {
	type ControlGame = {
		players: Player[];
		pot: number;
		gamePhase: 'preflop' | 'flop' | 'turn' | 'river' | 'showdown';
		bettingRound: string | null;
		currentPlayerIndex: number;
		communityCards: Card[];
		dealerIndex: number;
		minimumBet: number;
		lastRaiseAmount: number;
		aiRival: AIRivalAssistant;
		settingsManager: GameSettingsManager;
		processAITurn: () => Promise<void>;
		advanceTurn: () => void;
		nextPhase: () => void;
		dealNewHand: () => Promise<void>;
		updateActionButtons: () => void;
		updateGameStatus: (message: string) => void;
		showSettlementRecovery: (message: string) => void;
		cancelPendingAutoDeal: () => void;
		cancelPendingTurnTransitions: () => void;
		waitForTurnTransition: () => Promise<boolean>;
	};
	let game: ControlGame;
	let runAITurn: () => Promise<void>;
	let advanceTurn: () => void;
	let restoreGlobals: () => void;
	let blocked: boolean;
	const button = (id: string) => document.getElementById(`btn-${id}`) as HTMLButtonElement;
	const input = (id: string) => document.getElementById(id) as HTMLInputElement;

	beforeEach(() => {
		const dom = new DOMWindow({ url: 'http://localhost:2000/games/poker' });
		const originals = {
			document: globalThis.document,
			window: globalThis.window,
			localStorage: globalThis.localStorage,
			HTMLButtonElement: globalThis.HTMLButtonElement,
			HTMLInputElement: globalThis.HTMLInputElement,
			Event: globalThis.Event,
		};
		restoreGlobals = () => Object.assign(globalThis, originals);
		Object.assign(globalThis, {
			document: dom.document,
			window: dom,
			localStorage: dom.localStorage,
			HTMLButtonElement: dom.HTMLButtonElement,
			HTMLInputElement: dom.HTMLInputElement,
			Event: dom.Event,
		});
		document.body.innerHTML = `
			<div id="poker-root"><span id="player-balance" data-balance="1000"></span>
				<p id="game-status"></p><p id="ai-rival-status"></p>
				${['fold', 'check', 'call', 'raise', 'deal', 'max-bet'].map((id) => `<button id="btn-${id}"></button>`).join('')}
				<input id="bet-slider" type="range" min="10" max="1000" value="20">
				<input id="bet-input" type="number"><span id="bet-amount"></span>
				${Array.from({ length: 4 }, () => '<button class="quick-bet-chip"><span data-preset-amount></span></button>').join('')}
			</div>`;
		blocked = false;
		game = new PokerGame(() => 0.99, {
			pending: null,
			get isBlocked() {
				return blocked;
			},
			settle: async () => {
				throw new Error('Unexpected settlement');
			},
			retry: async () => null,
			reset: () => {
				blocked = false;
			},
		}) as unknown as ControlGame;
		runAITurn = game.processAITurn.bind(game);
		advanceTurn = game.advanceTurn.bind(game);
		game.processAITurn = async () => {};
		game.advanceTurn = () => {};
		game.bettingRound = 'preflop';
	});
	afterEach(() => {
		game.cancelPendingAutoDeal();
		game.cancelPendingTurnTransitions();
		restoreGlobals();
	});

	test('reset restores Deal after a blocked auto-deal has stopped', async () => {
		game.bettingRound = null;
		game.gamePhase = 'showdown';
		blocked = true;
		game.updateActionButtons();
		await game.dealNewHand();
		expect(button('deal').disabled).toBe(true);
		button('reset-settlement').click();
		expect(blocked).toBe(false);
		expect(button('deal').disabled).toBe(false);
		button('deal').click();
		expect(game).toMatchObject({ bettingRound: 'preflop' });
		expect(game.players.every((player) => player.hand.length === 2)).toBe(true);
	});

	test.each(['preflop', 'flop', 'turn'] as const)(
		'resets the opening minimum after %s',
		(phase) => {
			game.gamePhase = phase;
			game.dealerIndex = 5;
			game.minimumBet = game.lastRaiseAmount = 200;
			game.players = game.players.map((player) => ({ ...player, currentBet: 200, hasActed: true }));
			game.nextPhase();
			expect(game.minimumBet).toBe(10);
			expect(game.lastRaiseAmount).toBe(10);
			expect(input('bet-slider').min).toBe('10');
			input('bet-slider').value = '10';
			button('raise').click();
			expect(game.players[0].currentBet).toBe(10);
			expect(game.players[0].chips).toBe(990);
		},
	);

	test('permits a short all-in raise without lowering the next full raise', () => {
		game.minimumBet = game.lastRaiseAmount = 50;
		game.players[0].chips = 75;
		game.players[1].currentBet = 50;
		game.updateActionButtons();
		expect(button('raise').disabled).toBe(false);
		expect(input('bet-slider').min).toBe('25');
		expect(input('bet-slider').max).toBe('25');
		button('raise').click();
		expect(game.players[0].chips).toBe(0);
		expect(game.players[0].currentBet).toBe(75);
		expect(game.players[0].isAllIn).toBe(true);
		expect(game.minimumBet).toBe(50);
		expect(game.lastRaiseAmount).toBe(50);
	});

	test.each([75, 100])('enforces AI raise rights after a human all-in to %i', async (shove) => {
		game.gamePhase = game.bettingRound = 'flop';
		game.dealerIndex = game.currentPlayerIndex = 0;
		game.minimumBet = game.lastRaiseAmount = 50;
		game.communityCards = [
			card('K', 'hearts', 13),
			card('K', 'diamonds', 13),
			card('2', 'hearts', 2),
		];
		game.players = game.players.map((player) => ({
			...player,
			folded: player.id > 2,
			currentBet: player.id === 1 || player.id === 2 ? 50 : 0,
			totalBet: player.id === 1 || player.id === 2 ? 50 : 0,
			hasActed: player.id === 1 || player.id === 2,
		}));
		game.players[0].chips = shove;
		game.players[0].hand = [card('A', 'hearts', 14), card('A', 'diamonds', 14)];
		game.players[1].hand = [card('K', 'spades', 13), card('2', 'clubs', 2)];
		game.players[2].hand = [card('Q', 'spades', 12), card('Q', 'diamonds', 12)];
		game.pot = 100;
		game.waitForTurnTransition = async () => true;
		let aiTurn: Promise<void> | undefined;
		game.processAITurn = () => (aiTurn = runAITurn());
		let advances = 0;
		// Run the real human-to-AI transition and AI decision; stop after its response.
		game.advanceTurn = () => {
			if (advances++ === 0) advanceTurn();
		};
		game.updateActionButtons();
		input('bet-slider').value = String(shove - 50);
		button('raise').click();
		expect(aiTurn).toBeDefined();
		await aiTurn;
		expect(game.players[0].isAllIn).toBe(true);
		if (shove === 75) {
			expect(game.players[1].currentBet).toBe(75);
			expect(game.minimumBet).toBe(50);
			expect(document.getElementById('game-status')?.textContent).toContain('calls 25 chips');
		} else {
			// A full raise must still allow the AI's value re-raise with a full house.
			expect(game.players[1].currentBet).toBeGreaterThan(100);
		}
	});

	test.each([
		{ name: 'unacted player', acted: false, paid: 50, firstAllIn: 75, highest: 75, canRaise: true },
		{
			name: 'short raise after acting',
			acted: true,
			paid: 50,
			firstAllIn: 75,
			highest: 75,
			canRaise: false,
		},
		{ name: 'full raise', acted: true, paid: 50, firstAllIn: 100, highest: 100, canRaise: true },
		{
			name: 'cumulative short raises',
			acted: true,
			paid: 50,
			firstAllIn: 75,
			highest: 100,
			canRaise: true,
		},
		{
			name: 'caller of the first short raise',
			acted: true,
			paid: 75,
			firstAllIn: 75,
			highest: 100,
			canRaise: false,
		},
	])(
		'keeps human raise rights correct for $name',
		({ acted, paid, firstAllIn, highest, canRaise }) => {
			game.minimumBet = 50;
			game.players[0].hasActed = acted;
			game.players[0].currentBet = paid;
			game.players[1].currentBet = firstAllIn;
			game.players[2].currentBet = highest;
			game.updateActionButtons();
			expect(button('raise').disabled).toBe(!canRaise);
			expect(input('bet-slider').disabled).toBe(!canRaise);
			expect(button('call').disabled).toBe(false);
			expect(button('fold').disabled).toBe(false);
			if (!canRaise) {
				button('raise').disabled = false;
				button('raise').click();
				expect(game.players[0].currentBet).toBe(paid);
				button('call').click();
				expect(game.players[0].currentBet).toBe(highest);
			}
		},
	);

	test('disables raising when the minimum exceeds the cap and an all-in is over the cap', () => {
		game.minimumBet = 1200;
		game.players[1].currentBet = 1200;
		for (const stack of [2300, 5000]) {
			game.players[0].chips = stack;
			game.updateActionButtons();
			expect(button('raise').disabled).toBe(true);
			expect(input('bet-slider').disabled).toBe(true);
			expect(button('max-bet').disabled).toBe(true);
			// The handler must also reject an attempted raise independently of disabled UI.
			button('raise').disabled = false;
			button('raise').click();
			expect(game.players[0].chips).toBe(stack);
		}
	});

	test.each([
		[20, 200],
		[300, 300],
		[1000, 800],
	])('synchronizes AI raise %i to the legal amount %i', (suggested, actual) => {
		game.minimumBet = 200;
		game.players[1].currentBet = 200;
		game.updateActionButtons();
		const assistant = game.aiRival as unknown as {
			applyAiMove: (move: AiMove, onStatus: (message: string) => void) => void;
		};
		assistant.applyAiMove({ move: 'raise', amount: suggested, raw: '' }, (message) =>
			game.updateGameStatus(message),
		);
		expect(input('bet-slider').value).toBe(String(actual));
		expect(input('bet-input').value).toBe(String(actual));
		expect(document.getElementById('bet-amount')?.textContent).toBe(String(actual));
		expect(document.getElementById('ai-rival-status')?.textContent).toContain(`${actual} chips`);
		button('raise').click();
		expect(game.players[0].chips).toBe(1000 - 200 - actual);
	});

	test('checks instead of folding when an LLM raise outruns a short stack with no bet to call', async () => {
		const originalFetch = globalThis.fetch;
		localStorage.setItem(
			'arcturus-ai-settings',
			JSON.stringify({ provider: 'openai', model: 'gpt-4o', apiKey: 'sk-test' }),
		);
		game.settingsManager.updateSettings({ useLLMAI: true });
		const fetchMock = mock(
			async () =>
				({
					ok: true,
					status: 200,
					json: async () => ({
						choices: [{ message: { content: '{"action":"raise","amount":50}' } }],
					}),
				}) as Response,
		);
		(globalThis as typeof globalThis & { fetch: typeof fetch }).fetch =
			fetchMock as unknown as typeof fetch;
		try {
			clearLLMCache();
			// The clamped LLM raise (minRaise 10) outruns the 5-chip stack; with
			// nothing to call, checking is free — folding this hand was the bug.
			game.players[1].chips = 5;
			game.currentPlayerIndex = 1;
			game.waitForTurnTransition = async () => true;
			await runAITurn();
			expect(fetchMock).toHaveBeenCalled();
			expect(game.players[1].folded).toBe(false);
			expect(game.players[1].hasActed).toBe(true);
			expect(game.players[1].chips).toBe(5);
			expect(document.getElementById('game-status')?.textContent).toContain('checks');
		} finally {
			(globalThis as typeof globalThis & { fetch: typeof fetch }).fetch = originalFetch;
			localStorage.removeItem('arcturus-ai-settings');
		}
	});
});
