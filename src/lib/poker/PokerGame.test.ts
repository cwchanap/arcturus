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
import {
	AUTO_DEAL_DELAY_MS,
	AUTO_DEAL_STORAGE_KEY,
	PokerGame,
	buildPokerSettlementCommand,
} from './PokerGame';
import { SESSION_STATS_KEY } from './sessionStats';
import { SNG_START_STACK } from './sitAndGo';
import { clearLLMCache } from './llmAIStrategy';
import type { GameSettingsManager } from './GameSettingsManager';
import type { AIRivalAssistant, AiMove } from './AIRivalAssistant';
import { DEFAULT_SETTINGS } from './types';
import { DEFAULT_GUEST_GAME_BALANCE } from '../public-game-session';
import type { SettlementGate, SettleRoundCommand, SettleRoundResult } from '../wallet';

let windowListeners: Record<string, (() => void) | undefined> = {};

// Mock DOM for PokerGame constructor
function mockPokerGameDOM() {
	interface MockElement {
		addEventListener: (event: string, handler?: () => void) => void;
		click?: () => void;
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
			(globalThis as { fetch: typeof originalFetch }).fetch = originalFetch;
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
				autoDealEnabled: boolean;
			};

			game.autoDealEnabled = true;
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
				(timer) => timer.delay === AUTO_DEAL_DELAY_MS && !timer.cleared,
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

	test('holds the finished hand on screen until the player deals when auto-deal is off', () => {
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
				pot: number;
				humanChipsBefore: number;
				handStartChips: number;
				handNumber: number;
				nextPhase: () => void;
				sessionStats: { hands: number; net: number; streak: number };
			};
			game.handNumber = 1;
			game.humanChipsBefore = 500;
			game.handStartChips = 500;
			game.pot = 150;
			game.players[0] = { ...game.players[0], chips: 450, folded: false };
			game.players = game.players.map((player) => ({ ...player, folded: player.id !== 0 }));

			game.nextPhase();

			expect(timers.scheduledTimers.some((timer) => timer.delay === AUTO_DEAL_DELAY_MS)).toBe(
				false,
			);
			expect(elements['btn-deal'].hidden).toBe(false);
			expect(elements['btn-deal'].textContent).toBe('Next Hand');
			expect(elements['poker-result'].hidden).toBe(false);
			expect(elements['poker-result-title'].textContent).toBe('You win 150 chips');
			expect(elements['poker-result-delta'].textContent).toBe('Your hand +100');
			expect(game.sessionStats).toMatchObject({ hands: 1, net: 100, streak: 1 });
		} finally {
			timers.restore();
		}
	});

	test('a walkover raise announces only the contested chips, not the returned raise', () => {
		const elements = mockPokerGameDOM();
		elements['player-balance'] = {
			addEventListener: () => {},
			click: () => {},
			innerHTML: '',
			textContent: '500',
			classList: { add: () => {}, remove: () => {}, toggle: () => {} },
			value: '0',
		};
		const timers = mockTrackedTimers();
		try {
			const game = new PokerGame() as unknown as {
				players: Player[];
				pot: number;
				humanChipsBefore: number;
				handStartChips: number;
				handNumber: number;
				nextPhase: () => void;
				sessionStats: { hands: number; net: number; biggestPot: number };
			};
			// Blinds 5/10; the human raises to 100 and both blinds fold. 90 of
			// the 115-chip pot is the human's own uncalled raise coming back.
			game.handNumber = 1;
			game.humanChipsBefore = 500;
			game.handStartChips = 500;
			game.pot = 115;
			game.players = game.players.map((player) => ({
				...player,
				folded: player.id !== 0,
				totalBet: player.id === 0 ? 100 : player.id === 1 ? 5 : player.id === 2 ? 10 : 0,
			}));
			game.players[0] = { ...game.players[0], chips: 400 };

			game.nextPhase();

			expect(game.players[0].chips).toBe(515);
			expect(elements['poker-result-title'].textContent).toBe('You win 25 chips');
			expect(elements['poker-result-delta'].textContent).toBe('Your hand +15');
			// The status line agrees with the banner: the returned raise is not
			// announced as winnings.
			expect(elements['game-status'].textContent).toBe(
				'[Preflop | Pot: 115 chips] You win 25 chips! (Everyone else folded) 🎉',
			);
			expect(game.sessionStats).toMatchObject({ hands: 1, net: 15, biggestPot: 25 });
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
			(globalThis as { fetch: typeof originalFetch }).fetch = originalFetch;
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
			(globalThis as { fetch: typeof originalFetch }).fetch = originalFetch;
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

		const alice = createPlayer(3, 'Alice', 500);
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

		// Tiers won by the same player read as one win, and the human reads as "You win".
		expect(
			game.formatShowdownMessage([
				{ amount: 30, winners: [charlie] },
				{ amount: 40, winners: [charlie] },
			]),
		).toBe('Charlie wins 70 chips! 🎉');
		const you = createPlayer(0, 'You', 500);
		expect(game.formatShowdownMessage([{ amount: 120, winners: [you] }])).toBe(
			'You win 120 chips! 🎉',
		);
	});

	test('presentHandResult reads ties from pot tiers, not award totals', () => {
		const elements = mockPokerGameDOM();
		elements['player-balance'] = {
			addEventListener: () => {},
			click: () => {},
			dataset: { balance: '500' },
			innerHTML: '',
			textContent: '500',
			classList: { add: () => {}, remove: () => {}, toggle: () => {} },
			value: '0',
		};

		const game = new PokerGame() as unknown as {
			players: Player[];
			handStartChips: number;
			ui: unknown;
			presentHandResult: (
				awards: Map<number, number>,
				tiers: Array<{ amount: number; winners: Player[] }>,
				showdown: boolean,
			) => void;
		};
		const titles: string[] = [];
		game.ui = {
			showHandResult: ({ title }: { title: string }) => titles.push(title),
			showChipDelta: () => {},
		};
		game.handStartChips = 0;
		const [you, rivalA, rivalB] = game.players;

		// You win the main pot outright while a rival takes a side pot: not a split.
		game.presentHandResult(
			new Map([
				[you.id, 150],
				[rivalA.id, 100],
			]),
			[
				{ amount: 150, winners: [you] },
				{ amount: 100, winners: [rivalA] },
			],
			false,
		);
		// A genuine tie for the pot you won.
		game.presentHandResult(
			new Map([
				[you.id, 50],
				[rivalA.id, 50],
			]),
			[{ amount: 100, winners: [you, rivalA] }],
			false,
		);
		// An odd chip pays a rivals' tie 51/50; it is still a split.
		game.presentHandResult(
			new Map([
				[rivalA.id, 51],
				[rivalB.id, 50],
			]),
			[{ amount: 101, winners: [rivalA, rivalB] }],
			false,
		);
		// Different rivals win the main and side pots: the main pot's winner headlines.
		game.presentHandResult(
			new Map([
				[rivalA.id, 150],
				[rivalB.id, 100],
			]),
			[
				{ amount: 150, winners: [rivalA] },
				{ amount: 100, winners: [rivalB] },
			],
			false,
		);

		expect(titles).toEqual([
			'You win 150 chips',
			'You split 50 chips',
			'Player 2 & Player 3 split 101 chips',
			'Player 2 wins 150 chips',
		]);
	});

	test('a folded hand keeps its local delta when the server balance reconciles mid-hand', () => {
		const elements = mockPokerGameDOM();
		elements['player-balance'] = {
			addEventListener: () => {},
			click: () => {},
			dataset: { balance: '500', balanceAvailable: 'true', userId: 'fold-delta-user' },
			innerHTML: '',
			textContent: '500',
			classList: { add: () => {}, remove: () => {}, toggle: () => {} },
			value: '0',
		};

		const { gate } = createPendingSettlementGate();
		const game = new PokerGame(undefined, gate) as unknown as {
			players: Player[];
			handStartChips: number;
			humanChipsBefore: number;
			sessionStats: { hands: number; net: number; streak: number };
			settleHand: (outcome: 'win' | 'loss' | 'push') => void;
			adoptSettlementResult: (result: SettleRoundResult) => void;
			presentHandResult: (
				awards: Map<number, number>,
				tiers: Array<{ amount: number; winners: Player[] }>,
				showdown: boolean,
			) => void;
		};

		// The human put 40 chips into the hand and folded: the outcome is final.
		game.handStartChips = 500;
		game.humanChipsBefore = 500;
		game.players[0] = { ...game.players[0], chips: 460, folded: true, totalBet: 40 };
		game.settleHand('loss');

		// Before the remaining opponents finish, the server answer reconciles
		// the stack to an account balance that includes unrelated winnings.
		game.adoptSettlementResult({ balance: 580, duplicate: false });
		expect(game.players[0].chips).toBe(580);

		const winner = game.players[1];
		game.presentHandResult(new Map([[winner.id, 40]]), [{ amount: 40, winners: [winner] }], false);

		expect(elements['poker-result-delta'].textContent).toBe('Your hand −40');
		expect(elements['poker-result'].dataset?.tone).toBe('loss');
		expect(elements['seat-delta-0'].textContent).toBe('−40');
		expect(game.sessionStats).toMatchObject({ hands: 1, net: -40, streak: 0 });
	});

	test('an uncalled bet returned at showdown is not announced as winnings', () => {
		const elements = mockPokerGameDOM();
		elements['player-balance'] = {
			addEventListener: () => {},
			click: () => {},
			dataset: { balance: '500' },
			innerHTML: '',
			textContent: '500',
			classList: { add: () => {}, remove: () => {}, toggle: () => {} },
			value: '0',
		};

		const game = new PokerGame() as unknown as {
			players: Player[];
			communityCards: Card[];
			handStartChips: number;
			handStartStacks: Map<number, number>;
			sessionStats: { hands: number; net: number; biggestPot: number; streak: number };
			presentHandResult: (
				awards: Map<number, number>,
				tiers: Array<{ amount: number; winners: Player[]; uncontested: boolean }>,
				showdown: boolean,
			) => void;
		};

		// The human bet 500; the lone rival called all-in for 100 and won the
		// showdown. The extra 400 in the human's award is the human's own
		// uncalled bet coming back, not winnings.
		game.communityCards = [
			card('K', 'hearts', 13),
			card('K', 'spades', 13),
			card('9', 'diamonds', 9),
			card('8', 'clubs', 8),
			card('5', 'spades', 5),
		];
		game.players[0] = {
			...game.players[0],
			chips: 400,
			hand: [card('Q', 'diamonds', 12), card('J', 'spades', 11)],
		};
		// The rival started the hand at 500, committed 100, and collected the
		// 200 pot — ending at 600 for a net +100.
		game.players[1] = {
			...game.players[1],
			chips: 600,
			hand: [card('A', 'hearts', 14), card('2', 'clubs', 2)],
		};
		game.handStartChips = 500;
		game.handStartStacks = new Map([[1, 500]]);

		const [you, rival] = game.players;
		game.presentHandResult(
			new Map([
				[rival.id, 200],
				[you.id, 400],
			]),
			[
				{ amount: 200, winners: [rival], uncontested: false },
				{ amount: 400, winners: [you], uncontested: true },
			],
			true,
		);

		expect(elements['poker-result-title'].textContent).toBe('Player 2 wins 200 chips');
		expect(elements['poker-result-detail'].textContent).toBe('Pair');
		expect(elements['poker-result-delta'].textContent).toBe('Your hand −100');
		expect(elements['poker-result'].dataset?.tone).toBe('loss');
		// Seat floats show net change — no "+400" on the human, and the rival's
		// 200 award nets their 100 stake down to +100.
		expect(elements['seat-delta-0'].textContent).toBe('−100');
		expect(elements['seat-delta-1'].textContent).toBe('+100');
		expect(game.sessionStats).toMatchObject({ hands: 1, net: -100, biggestPot: 0 });
	});

	test('a pot win on a net-loss hand reads as a take, not a win', () => {
		const elements = mockPokerGameDOM();
		elements['player-balance'] = {
			addEventListener: () => {},
			click: () => {},
			dataset: { balance: '500' },
			innerHTML: '',
			textContent: '500',
			classList: { add: () => {}, remove: () => {}, toggle: () => {} },
			value: '0',
		};

		const game = new PokerGame() as unknown as {
			players: Player[];
			communityCards: Card[];
			handStartChips: number;
			handStartStacks: Map<number, number>;
			presentHandResult: (
				awards: Map<number, number>,
				tiers: Array<{ amount: number; winners: Player[]; uncontested: boolean }>,
				showdown: boolean,
			) => void;
		};

		// The human committed 100, won the 60 main pot, and lost the 160 side
		// pot: a real award but a net −40 hand.
		game.communityCards = [
			card('K', 'hearts', 13),
			card('K', 'spades', 13),
			card('9', 'diamonds', 9),
			card('8', 'clubs', 8),
			card('5', 'spades', 5),
		];
		game.players[0] = {
			...game.players[0],
			chips: 460,
			hand: [card('Q', 'diamonds', 12), card('J', 'spades', 11)],
		};
		game.players[1] = {
			...game.players[1],
			chips: 560,
			hand: [card('A', 'hearts', 14), card('2', 'clubs', 2)],
		};
		game.players[2] = { ...game.players[2], chips: 480 };
		game.handStartChips = 500;
		game.handStartStacks = new Map([
			[1, 500],
			[2, 500],
		]);

		const [you, rivalA] = game.players;
		game.presentHandResult(
			new Map([
				[you.id, 60],
				[rivalA.id, 160],
			]),
			[
				{ amount: 60, winners: [you], uncontested: false },
				{ amount: 160, winners: [rivalA], uncontested: false },
			],
			true,
		);

		expect(elements['poker-result-title'].textContent).toBe('You take 60 chips');
		expect(elements['poker-result-delta'].textContent).toBe('Your hand −40');
		expect(elements['poker-result'].dataset?.tone).toBe('loss');
		// Every seat floats its net change: the rival who took the side pot
		// netted +60, the all-in loser shows −20.
		expect(elements['seat-delta-0'].textContent).toBe('−40');
		expect(elements['seat-delta-1'].textContent).toBe('+60');
		expect(elements['seat-delta-2'].textContent).toBe('−20');
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
		elements['btn-save-settings'].click?.();

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

		elements['btn-save-settings'].click?.();

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

		elements['btn-reset-settings'].click?.();

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

		elements['btn-call'].click?.();

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
		expect('feats' in command).toBe(false);
	});

	test('carries a royal_treatment feat only when one is reported', () => {
		const withFeats = buildPokerSettlementCommand(150, 'win', ['royal_treatment']);
		expect(withFeats.feats).toEqual(['royal_treatment']);

		const withoutFeats = buildPokerSettlementCommand(-40, 'loss', undefined);
		expect('feats' in withoutFeats).toBe(false);
	});

	/** Authenticated cash table with a capturing settlement gate. */
	function royalShowdownFixture(gate: SettlementGate): {
		game: {
			players: Player[];
			communityCards: Card[];
			gamePhase: 'preflop' | 'flop' | 'turn' | 'river' | 'showdown';
			bettingRound: string | null;
			pot: number;
			handNumber: number;
			humanChipsBefore: number;
			handStartChips: number;
			handInProgress: boolean;
			nextPhase: () => void;
		};
	} {
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
			dataset: { balance: '1000', balanceAvailable: 'true', userId: 'royal-user' },
			innerHTML: '',
			textContent: '1000',
			classList: { add: () => {}, remove: () => {}, toggle: () => {} },
			value: '0',
		};

		const game = new PokerGame(undefined, gate) as unknown as {
			players: Player[];
			communityCards: Card[];
			gamePhase: 'preflop' | 'flop' | 'turn' | 'river' | 'showdown';
			bettingRound: string | null;
			pot: number;
			handNumber: number;
			humanChipsBefore: number;
			handStartChips: number;
			handInProgress: boolean;
			nextPhase: () => void;
		};
		game.handNumber = 1;
		game.humanChipsBefore = 1000;
		game.handStartChips = 1000;
		game.handInProgress = true;
		game.gamePhase = 'river';
		game.bettingRound = 'river';
		// Royal on board except the T/J the human holds: a board-only royal
		// also counts, and the human here wins the contested showdown.
		game.communityCards = [
			card('Q', 'hearts', 12),
			card('K', 'hearts', 13),
			card('A', 'hearts', 14),
			card('4', 'clubs', 4),
			card('5', 'clubs', 5),
		];
		game.pot = 200;
		game.players[0] = {
			...game.players[0],
			chips: 900,
			folded: false,
			hasActed: true,
			currentBet: 100,
			totalBet: 100,
			hand: [card('10', 'hearts', 10), card('J', 'hearts', 11)],
		};
		game.players[1] = {
			...game.players[1],
			chips: 900,
			folded: false,
			hasActed: true,
			currentBet: 100,
			totalBet: 100,
			hand: [card('2', 'spades', 2), card('3', 'diamonds', 3)],
		};
		for (const seat of [2, 3, 4, 5]) {
			game.players[seat] = { ...game.players[seat], folded: true, hasActed: true };
		}
		return { game };
	}

	test('reports royal_treatment at a contested showdown with a human royal', async () => {
		const commands: SettleRoundCommand[] = [];
		const gate: SettlementGate = {
			pending: null,
			isBlocked: false,
			async settle(command) {
				commands.push(command);
				return { balance: 1000 + command.delta, duplicate: false };
			},
			retry: async () => null,
			reset: () => {},
		};
		const { game } = royalShowdownFixture(gate);

		game.nextPhase();
		await flushAsyncWork();

		expect(commands).toHaveLength(1);
		expect(commands[0].game).toBe('poker');
		expect(commands[0].delta).toBe(100);
		expect(commands[0].feats).toEqual(['royal_treatment']);
	});

	test('reports no feat at a contested showdown without a royal', async () => {
		const commands: SettleRoundCommand[] = [];
		const gate: SettlementGate = {
			pending: null,
			isBlocked: false,
			async settle(command) {
				commands.push(command);
				return { balance: 1000 + command.delta, duplicate: false };
			},
			retry: async () => null,
			reset: () => {},
		};
		const { game } = royalShowdownFixture(gate);
		// Trip kings beat the opponent's pair of queens but earn no wallet feat.
		game.players[0] = {
			...game.players[0],
			hand: [card('K', 'spades', 13), card('K', 'clubs', 13)],
		};
		game.players[1] = {
			...game.players[1],
			hand: [card('Q', 'spades', 12), card('Q', 'diamonds', 12)],
		};

		game.nextPhase();
		await flushAsyncWork();

		expect(commands).toHaveLength(1);
		expect(commands[0].delta).toBe(100);
		expect('feats' in commands[0]).toBe(false);
	});

	test('reports no feat when the hand ends in a walkover, even with a royal', async () => {
		const commands: SettleRoundCommand[] = [];
		const gate: SettlementGate = {
			pending: null,
			isBlocked: false,
			async settle(command) {
				commands.push(command);
				return { balance: 1000 + command.delta, duplicate: false };
			},
			retry: async () => null,
			reset: () => {},
		};
		const { game } = royalShowdownFixture(gate);
		// Everyone else folds: the human takes the pot uncontested on the river.
		for (const seat of [1, 2, 3, 4, 5]) {
			game.players[seat] = { ...game.players[seat], folded: true, hasActed: true };
		}

		game.nextPhase();
		await flushAsyncWork();

		expect(commands).toHaveLength(1);
		expect(commands[0].delta).toBe(100);
		expect('feats' in commands[0]).toBe(false);
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

	test('re-arms auto-deal after a settlement that outlives the countdown', async () => {
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
			dataset: { balance: '500', balanceAvailable: 'true', userId: 'slow-settlement-user' },
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
				autoDealEnabled: boolean;
				settleHand: (outcome?: 'win' | 'loss' | 'push') => void;
				finishHand: () => void;
			};
			game.autoDealEnabled = true;
			game.humanChipsBefore = 500;
			game.players[0] = { ...game.players[0], chips: 450 };

			game.settleHand('loss');
			game.finishHand();

			const stalled = timers.scheduledTimers.find(
				(timer) => timer.delay === AUTO_DEAL_DELAY_MS && !timer.cleared,
			);
			expect(stalled).toBeDefined();
			stalled?.callback();
			await flushAsyncWork();

			expect(game.players[0].hand).toHaveLength(0);
			expect(gate.pending).not.toBeNull();

			release({ balance: 490, duplicate: false });
			await flushAsyncWork();

			const rearmed = timers.scheduledTimers.find(
				(timer) => timer.delay === AUTO_DEAL_DELAY_MS && !timer.cleared && timer !== stalled,
			);
			expect(rearmed).toBeDefined();
			rearmed?.callback();
			await flushAsyncWork();

			expect(game.players[0].hand).toHaveLength(2);
		} finally {
			timers.restore();
		}
	});

	test('leaves auto-deal stopped when the overdue settlement fails', async () => {
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
			dataset: { balance: '500', balanceAvailable: 'true', userId: 'failed-settlement-user' },
			innerHTML: '',
			textContent: '500',
			classList: { add: () => {}, remove: () => {}, toggle: () => {} },
			value: '0',
		};

		const timers = mockTrackedTimers();
		let pendingCommand: ReturnType<typeof buildPokerSettlementCommand> | null = null;
		const gate: SettlementGate = {
			get pending() {
				return pendingCommand;
			},
			get isBlocked() {
				return pendingCommand !== null;
			},
			settle: async (command) => {
				pendingCommand = command;
				throw new Error('NETWORK_ERROR');
			},
			retry: async () => null,
			reset: () => {
				pendingCommand = null;
			},
		};
		try {
			const game = new PokerGame(undefined, gate) as unknown as {
				players: Player[];
				humanChipsBefore: number;
				autoDealEnabled: boolean;
				settleHand: (outcome?: 'win' | 'loss' | 'push') => void;
				finishHand: () => void;
			};
			game.autoDealEnabled = true;
			game.humanChipsBefore = 500;
			game.players[0] = { ...game.players[0], chips: 450 };

			game.settleHand('loss');
			game.finishHand();

			const stalled = timers.scheduledTimers.find(
				(timer) => timer.delay === AUTO_DEAL_DELAY_MS && !timer.cleared,
			);
			expect(stalled).toBeDefined();
			stalled?.callback();
			await flushAsyncWork();

			expect(game.players[0].hand).toHaveLength(0);
			expect(
				timers.scheduledTimers.some(
					(timer) => timer.delay === AUTO_DEAL_DELAY_MS && !timer.cleared && timer !== stalled,
				),
			).toBe(false);
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
		elements['btn-retry-settlement'].click?.();
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

		const dispatched: string[] = [];
		(globalThis as typeof globalThis & { window: Window }).window.dispatchEvent = ((event: {
			type: string;
		}) => {
			dispatched.push(event.type);
			return true;
		}) as unknown as typeof window.dispatchEvent;

		// Click reset — the reset handler clears the gate and restores balance.
		elements['btn-reset-settlement'].click?.();

		expect(resetCalls).toBe(1);
		expect(game.players[0].chips).toBe(game.serverSyncedBalance);
		expect(game.humanChipsBefore).toBe(0);
		// The table missions read the account once the hand is closed.
		expect(dispatched).toContain('poker-hand-settled');
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
		}) as unknown as typeof window.dispatchEvent;

		try {
			const gate: SettlementGate = {
				pending: null,
				isBlocked: false,
				settle: async () => ({
					balance: 650,
					duplicate: false,
					newAchievements: [{ id: 'rising_star', icon: '🎉' }],
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
				{ id: 'rising_star', icon: '🎉' },
			]);
		} finally {
			(globalThis as typeof globalThis & { window: Window }).window.dispatchEvent = origDispatch;
		}
	});

	function mockSignedInTable() {
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
			dataset: { balance: '500', balanceAvailable: 'true', userId: 'mission-user' },
			innerHTML: '',
			textContent: '500',
			classList: { add: () => {}, remove: () => {}, toggle: () => {} },
			value: '0',
			click: () => {},
		};
		return elements;
	}

	test('tells the table a hand settled once the settlement is adopted', async () => {
		mockSignedInTable();
		const dispatched: string[] = [];
		const win = (globalThis as typeof globalThis & { window: Window }).window;
		const origDispatch = win.dispatchEvent;
		win.dispatchEvent = ((event: { type: string }) => {
			dispatched.push(event.type);
			return true;
		}) as unknown as typeof window.dispatchEvent;

		try {
			const gate: SettlementGate = {
				pending: null,
				isBlocked: false,
				settle: async () => ({ balance: 650, duplicate: false }),
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
			expect(dispatched).not.toContain('poker-hand-settled');
			await flushAsyncWork();

			expect(dispatched).toContain('poker-hand-settled');
		} finally {
			win.dispatchEvent = origDispatch;
		}
	});

	test('after a fold, tells the table once the hand is over', async () => {
		mockSignedInTable();
		const dispatched: string[] = [];
		const win = (globalThis as typeof globalThis & { window: Window }).window;
		const origDispatch = win.dispatchEvent;
		win.dispatchEvent = ((event: { type: string }) => {
			dispatched.push(event.type);
			return true;
		}) as unknown as typeof window.dispatchEvent;

		try {
			const gate: SettlementGate = {
				pending: null,
				isBlocked: false,
				settle: async () => ({ balance: 480, duplicate: false }),
				retry: async () => null,
				reset: () => {},
			};
			const game = new PokerGame(undefined, gate) as unknown as {
				players: Player[];
				humanChipsBefore: number;
				handInProgress: boolean;
				settleHand: (outcome: 'win' | 'loss' | 'push') => void;
				finishHand: () => void;
			};

			// The human folds and settles while the rivals play on.
			game.handInProgress = true;
			game.humanChipsBefore = 500;
			game.players[0] = { ...game.players[0], chips: 480 };
			game.settleHand('loss');
			await flushAsyncWork();
			expect(dispatched).not.toContain('poker-hand-settled');

			game.finishHand();
			expect(dispatched.filter((type) => type === 'poker-hand-settled')).toHaveLength(1);
		} finally {
			win.dispatchEvent = origDispatch;
		}
	});

	test('a reset while the hand plays on reports once the hand is over', async () => {
		const elements = mockSignedInTable();
		const dispatched: string[] = [];
		const win = (globalThis as typeof globalThis & { window: Window }).window;
		const origDispatch = win.dispatchEvent;
		win.dispatchEvent = ((event: { type: string }) => {
			dispatched.push(event.type);
			return true;
		}) as unknown as typeof window.dispatchEvent;

		try {
			let blocked = false;
			const gate = {
				get pending() {
					return null;
				},
				get isBlocked() {
					return blocked;
				},
				settle: async () => {
					blocked = true;
					throw new Error('NETWORK_ERROR');
				},
				retry: async () => null,
				reset: () => {
					blocked = false;
				},
			} as SettlementGate;
			const game = new PokerGame(undefined, gate) as unknown as {
				players: Player[];
				humanChipsBefore: number;
				handInProgress: boolean;
				settleHand: (outcome: 'win' | 'loss' | 'push') => void;
				finishHand: () => void;
			};

			// The human folds, the settlement fails, and they reset mid-hand.
			game.handInProgress = true;
			game.humanChipsBefore = 500;
			game.players[0] = { ...game.players[0], chips: 480 };
			game.settleHand('loss');
			await flushAsyncWork();
			elements['btn-reset-settlement'].click?.();
			expect(dispatched).not.toContain('poker-hand-settled');

			game.finishHand();
			expect(dispatched.filter((type) => type === 'poker-hand-settled')).toHaveLength(1);
		} finally {
			win.dispatchEvent = origDispatch;
		}
	});

	test('a hand that ends while its settlement runs reports only once it lands', () => {
		mockSignedInTable();
		const dispatched: string[] = [];
		const win = (globalThis as typeof globalThis & { window: Window }).window;
		const origDispatch = win.dispatchEvent;
		win.dispatchEvent = ((event: { type: string }) => {
			dispatched.push(event.type);
			return true;
		}) as unknown as typeof window.dispatchEvent;

		try {
			const gate: SettlementGate = {
				pending: null,
				isBlocked: true,
				settle: async () => ({ balance: 650, duplicate: false }),
				retry: async () => null,
				reset: () => {},
			};
			const game = new PokerGame(undefined, gate) as unknown as {
				handInProgress: boolean;
				finishHand: () => void;
			};
			game.handInProgress = true;
			game.finishHand();
			expect(dispatched).not.toContain('poker-hand-settled');
		} finally {
			win.dispatchEvent = origDispatch;
		}
	});

	test('adopts a claimed mission reward between hands, not mid-hand', () => {
		mockSignedInTable();
		const game = new PokerGame() as unknown as {
			players: Player[];
			serverSyncedBalance: number;
			handInProgress: boolean;
			adoptAccountBalance: (balance: number) => boolean;
		};

		game.handInProgress = true;
		expect(game.adoptAccountBalance(1250)).toBe(false);
		expect(game.players[0].chips).toBe(500);

		game.handInProgress = false;
		expect(game.adoptAccountBalance(1250)).toBe(true);
		expect(game.players[0].chips).toBe(1250);
		expect(game.serverSyncedBalance).toBe(1250);

		expect(game.adoptAccountBalance(Number.NaN)).toBe(false);
		expect(game.players[0].chips).toBe(1250);
	});

	test('a claimed reward makes an unavailable balance playable', () => {
		const elements = mockSignedInTable();
		elements['player-balance'].dataset = {
			balance: '',
			balanceAvailable: 'false',
			userId: 'mission-user',
		};
		const game = new PokerGame() as unknown as {
			players: Player[];
			hasServerSyncedBalance: boolean;
			adoptAccountBalance: (balance: number) => void;
		};
		expect(game.hasServerSyncedBalance).toBe(false);

		game.adoptAccountBalance(750);

		expect(game.hasServerSyncedBalance).toBe(true);
		expect(game.players[0].chips).toBe(750);
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
			elements['btn-raise'].click?.();
			expect(game.players[0].chips).toBe(125);
			expect(game.pot).toBe(0);
		}
		slider.value = '105';
		elements['btn-raise'].click?.();
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
				<p id="game-status"></p><p id="ai-rival-status"></p><p id="poker-to-call"></p>
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
		button('reset-settlement').click?.();
		expect(blocked).toBe(false);
		expect(button('deal').disabled).toBe(false);
		button('deal').click?.();
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
			button('raise').click?.();
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
		button('raise').click?.();
		expect(game.players[0].chips).toBe(0);
		expect(game.players[0].currentBet).toBe(75);
		expect(game.players[0].isAllIn).toBe(true);
		expect(game.minimumBet).toBe(50);
		expect(game.lastRaiseAmount).toBe(50);
	});

	test('pot odds count only the pot the short-stacked caller can win', () => {
		// Two rivals committed 100 each; the human has just 10 chips and can
		// contest only the first 10 of each bet — 10/(20+10) ≈ 33%.
		game.players[0].chips = 10;
		game.players[1].currentBet = 100;
		game.players[1].totalBet = 100;
		game.players[2].currentBet = 100;
		game.players[2].totalBet = 100;
		game.pot = 200;
		game.updateActionButtons();
		expect(document.getElementById('poker-to-call')?.textContent).toBe(
			'To call 10 · Pot 200 · Pot odds 33%',
		);
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
		button('raise').click?.();
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
				button('raise').click?.();
				expect(game.players[0].currentBet).toBe(paid);
				button('call').click?.();
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
			// The handler must also reject an attempted raise independently of disabled UI.
			button('raise').disabled = false;
			button('raise').click?.();
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
		button('raise').click?.();
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
			(globalThis as { fetch: typeof originalFetch }).fetch = originalFetch;
			localStorage.removeItem('arcturus-ai-settings');
		}
	});
});

describe('Poker table sound, turn timer and hand recap', () => {
	type TableGame = {
		players: Player[];
		currentPlayerIndex: number;
		bettingRound: string | null;
		pot: number;
		processAITurn: () => Promise<void>;
		updateActionButtons: () => void;
		actOnTimeout: () => void;
		nextPhase: () => void;
		recap: { start: (hand: number, hole: Card[]) => void; last: unknown };
		turnTimer: { running: boolean; stop: () => void };
	};

	function setup() {
		const elements = mockPokerGameDOM();
		(globalThis as typeof globalThis & { localStorage: Storage }).localStorage = {
			getItem: () => null,
			setItem: () => {},
			removeItem: () => {},
		} as unknown as Storage;
		elements['player-balance'] = {
			addEventListener: () => {},
			click: () => {},
			dataset: { balance: '500' },
			innerHTML: '',
			textContent: '500',
			classList: { add: () => {}, remove: () => {}, toggle: () => {} },
			value: '0',
		};
		const played: string[] = [];
		const sound = {
			play: (sfx: string) => void played.push(sfx),
			isMuted: () => false,
			setMuted: () => {},
			unlock: () => {},
		};
		const game = new PokerGame(undefined, undefined, sound) as unknown as TableGame;
		game.processAITurn = async () => {};
		return { elements, game, played };
	}

	/** Put the human on turn preflop, facing `facing` chips. */
	function humanTurn(game: TableGame, facing: number) {
		game.bettingRound = 'preflop';
		game.currentPlayerIndex = 0;
		game.players = game.players.map((player) => ({
			...player,
			currentBet: player.id === 0 ? 0 : facing,
			folded: false,
			hasActed: false,
		}));
		game.updateActionButtons();
	}

	function setVisibility(state: string | undefined) {
		(document as unknown as { visibilityState?: string }).visibilityState = state;
	}

	afterEach(() => setVisibility(undefined));

	test('the human turn chimes and starts the countdown only while the page is visible', () => {
		const { game, played } = setup();
		setVisibility('hidden');
		humanTurn(game, 0);
		expect(played).toEqual(['turn']);
		expect(game.turnTimer.running).toBe(false);

		game.bettingRound = null;
		game.updateActionButtons();
		setVisibility('visible');
		humanTurn(game, 0);
		expect(game.turnTimer.running).toBe(true);

		game.bettingRound = null;
		game.updateActionButtons();
		expect(game.turnTimer.running).toBe(false);
	});

	test('running out of time folds when facing a bet', () => {
		const timers = mockTrackedTimers();
		try {
			const { game, played } = setup();
			setVisibility('visible');
			humanTurn(game, 20);
			game.actOnTimeout();
			expect(game.players[0].folded).toBe(true);
			expect(played).toContain('fold');
			expect(game.turnTimer.running).toBe(false);
		} finally {
			timers.restore();
		}
	});

	test('running out of time checks when checking is free', () => {
		const timers = mockTrackedTimers();
		try {
			const { game, played } = setup();
			setVisibility('visible');
			humanTurn(game, 0);
			game.actOnTimeout();
			expect(game.players[0].folded).toBe(false);
			expect(game.players[0].hasActed).toBe(true);
			expect(played).toContain('check');
		} finally {
			timers.restore();
		}
	});

	test('a finished hand leaves a recap with each action and the winner', () => {
		const timers = mockTrackedTimers();
		try {
			const { elements, game, played } = setup();
			game.recap.start(1, game.players[0].hand);
			humanTurn(game, 20);
			elements['btn-fold'].click?.();
			// Everyone but seat 1 has folded: seat 1 takes the pot uncontested.
			game.players = game.players.map((player) =>
				player.id === 1 ? player : { ...player, folded: true },
			);
			game.pot = 60;
			game.nextPhase();

			const recap = game.recap.last as {
				streets: Array<{ events: Array<{ playerId: number; action: string }> }>;
				reveals: Array<{ playerId: number }>;
				showdown: boolean;
			};
			expect(recap.streets[0].events).toEqual([
				expect.objectContaining({ playerId: 0, action: 'fold' }),
			]);
			expect(recap.showdown).toBe(false);
			expect(recap.reveals.map((reveal) => reveal.playerId)).toEqual([1]);
			// A fold already cost the chips; no losing sting on top of it.
			expect(played).not.toContain('lose');
			expect(elements['btn-recap'].hidden).toBe(false);
		} finally {
			timers.restore();
		}
	});
});

// HPA-176: shared cash-engine defects the Sit & Go work exposed. The first
// three tests were RED against the pre-fix engine: an all-in runout froze the
// table and dead seats were still asked to act.
describe('Poker all-in runout and dead-seat defects (HPA-176)', () => {
	type DefectGame = {
		players: Player[];
		pot: number;
		gamePhase: 'preflop' | 'flop' | 'turn' | 'river' | 'showdown';
		bettingRound: string | null;
		currentPlayerIndex: number;
		dealerIndex: number;
		communityCards: Card[];
		handNumber: number;
		humanChipsBefore: number;
		handStartChips: number;
		handInProgress: boolean;
		nextPhase: () => void;
		advanceTurn: () => void;
		processAITurn: () => Promise<void>;
	};

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

	/** Guest cash table: the same engine as authenticated cash, fully local. */
	function cashTable() {
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
				userId: 'defects',
			},
			innerHTML: '',
			textContent: '$1,000',
			classList: { add: () => {}, remove: () => {}, toggle: () => {} },
			value: '0',
		};
		const game = new PokerGame() as unknown as DefectGame;
		return { elements, game };
	}

	function foldSeats(game: DefectGame, seats: number[]) {
		for (const seat of seats) {
			game.players[seat] = { ...game.players[seat], folded: true, hasActed: true };
		}
	}

	test('all-in runout with the human on the button runs the board out instead of freezing', () => {
		const { game } = cashTable();
		const timers = mockTrackedTimers();
		try {
			game.handNumber = 1;
			game.humanChipsBefore = 500;
			game.handStartChips = 500;
			game.handInProgress = true;
			game.dealerIndex = 0;
			game.gamePhase = 'preflop';
			game.bettingRound = 'preflop';
			game.pot = 1000;
			game.players[0] = {
				...game.players[0],
				chips: 0,
				isAllIn: true,
				folded: false,
				hasActed: true,
				currentBet: 500,
				totalBet: 500,
				hand: [card('A', 'hearts', 14), card('A', 'diamonds', 14)],
			};
			game.players[1] = {
				...game.players[1],
				chips: 0,
				isAllIn: true,
				folded: false,
				hasActed: true,
				currentBet: 500,
				totalBet: 500,
				hand: [card('K', 'hearts', 13), card('K', 'diamonds', 13)],
			};
			foldSeats(game, [2, 3, 4, 5]);

			game.nextPhase();

			// The frozen defect: the all-in human dealer was handed the turn with
			// every control dead and no timer ever scheduled again.
			const runout = timers.scheduledTimers.find((timer) => !timer.cleared);
			expect(runout).toBeDefined();

			for (let i = 0; i < 5; i++) {
				const next = timers.scheduledTimers.find((timer) => !timer.cleared);
				if (!next) break;
				next.callback();
			}

			expect(game.communityCards).toHaveLength(5);
			expect(game.bettingRound).toBeNull();
			expect(game.handInProgress).toBe(false);
			expect(game.pot).toBe(0);
			expect(game.players[0].chips + game.players[1].chips).toBe(1000);
		} finally {
			timers.restore();
		}
	});

	test('a folded AI on the button is never selected to act on a new street', async () => {
		const { game } = cashTable();
		const timers = mockTrackedTimers();
		try {
			game.handNumber = 1;
			game.humanChipsBefore = 500;
			game.handStartChips = 500;
			game.handInProgress = true;
			game.dealerIndex = 1;
			game.gamePhase = 'preflop';
			game.bettingRound = 'preflop';
			game.pot = 600;
			game.players[0] = { ...game.players[0], chips: 400, folded: true, hasActed: true };
			game.players[1] = {
				...game.players[1],
				chips: 300,
				folded: true,
				hasActed: false,
				hand: [card('K', 'hearts', 13), card('K', 'diamonds', 13)],
			};
			game.players[2] = {
				...game.players[2],
				chips: 0,
				isAllIn: true,
				folded: false,
				hasActed: true,
				currentBet: 300,
				totalBet: 300,
				hand: [card('A', 'spades', 14), card('A', 'clubs', 14)],
			};
			foldSeats(game, [3, 4]);
			game.players[5] = {
				...game.players[5],
				chips: 0,
				isAllIn: true,
				folded: false,
				hasActed: true,
				currentBet: 300,
				totalBet: 300,
				hand: [card('Q', 'spades', 12), card('Q', 'diamonds', 12)],
			};

			game.nextPhase();

			const pending = timers.scheduledTimers.find((timer) => !timer.cleared);
			expect(pending).toBeDefined();
			pending?.callback();
			await flushAsyncWork();

			// The illegal decision: the folded button seat was asked to act (any
			// decision flips hasActed and can move its chips).
			expect(game.players[1].hasActed).toBe(false);
			expect(game.players[1].chips).toBe(300);
			expect(game.players[1].currentBet).toBe(0);
		} finally {
			timers.restore();
		}
	});

	test('processAITurn advances without deciding for a seat that cannot act', async () => {
		const { game } = cashTable();
		const timers = mockTrackedTimers();
		try {
			game.bettingRound = 'flop';
			game.currentPlayerIndex = 2;
			game.players[2] = {
				...game.players[2],
				chips: 0,
				isAllIn: true,
				folded: false,
				// The dead seat must keep a hand so a decision is possible and detectable.
				hand: [card('A', 'hearts', 14), card('A', 'diamonds', 14)],
			};

			const turn = game.processAITurn();
			const delay = timers.scheduledTimers.find((timer) => !timer.cleared);
			expect(delay).toBeDefined();
			delay?.callback();
			await turn;

			// The all-in seat must never place a phantom bet or mark itself acted.
			expect(game.players[2].hasActed).toBe(false);
			expect(game.players[2].chips).toBe(0);
			expect(game.players[2].currentBet).toBe(0);
		} finally {
			timers.restore();
		}
	});

	test('short all-in side pots still resolve at the runout showdown', () => {
		const { game } = cashTable();
		const timers = mockTrackedTimers();
		try {
			game.handNumber = 1;
			game.humanChipsBefore = 500;
			game.handStartChips = 500;
			game.handInProgress = true;
			game.gamePhase = 'river';
			game.bettingRound = 'river';
			game.communityCards = [
				card('2', 'hearts', 2),
				card('7', 'diamonds', 7),
				card('9', 'clubs', 9),
				card('3', 'spades', 3),
				card('5', 'hearts', 5),
			];
			game.pot = 700;
			game.players[0] = {
				...game.players[0],
				chips: 0,
				isAllIn: true,
				folded: false,
				hasActed: true,
				currentBet: 100,
				totalBet: 100,
				hand: [card('A', 'hearts', 14), card('A', 'diamonds', 14)],
			};
			game.players[1] = {
				...game.players[1],
				chips: 0,
				isAllIn: true,
				folded: false,
				hasActed: true,
				currentBet: 300,
				totalBet: 300,
				hand: [card('K', 'hearts', 13), card('K', 'diamonds', 13)],
			};
			game.players[2] = {
				...game.players[2],
				chips: 200,
				folded: false,
				hasActed: true,
				currentBet: 300,
				totalBet: 300,
				hand: [card('Q', 'hearts', 12), card('Q', 'diamonds', 12)],
			};
			foldSeats(game, [3, 4, 5]);

			game.nextPhase(); // river -> showdown

			// Aces take the 300 main pot, kings the 400 side pot; queens get nothing.
			expect(game.players[0].chips).toBe(300);
			expect(game.players[1].chips).toBe(400);
			expect(game.players[2].chips).toBe(200);
			expect(game.pot).toBe(0);
			expect(game.handInProgress).toBe(false);
		} finally {
			timers.restore();
		}
	});

	test('an outstanding preflop call/fold decision versus an all-in raise is not skipped', () => {
		const { game, elements } = cashTable();
		const timers = mockTrackedTimers();
		try {
			game.handInProgress = true;
			game.gamePhase = 'preflop';
			game.bettingRound = 'preflop';
			game.currentPlayerIndex = 1;
			game.pot = 500;
			game.players[0] = {
				...game.players[0],
				chips: 400,
				folded: false,
				hasActed: true,
				currentBet: 100,
				totalBet: 100,
			};
			game.players[1] = {
				...game.players[1],
				chips: 0,
				isAllIn: true,
				folded: false,
				hasActed: true,
				currentBet: 500,
				totalBet: 500,
			};
			foldSeats(game, [2, 3, 4, 5]);

			game.advanceTurn();

			// The shove left the human a live call/fold decision.
			expect(game.currentPlayerIndex).toBe(0);
			expect(elements['btn-call']?.hidden).toBe(false);
			expect(elements['btn-call']?.disabled).toBe(false);
			expect(elements['btn-fold']?.disabled).toBe(false);

			elements['btn-call']?.click?.();
			expect(game.players[0].isAllIn).toBe(true);
			expect(game.players[0].currentBet).toBe(500);
			// The runout proceeds on timers rather than skipping the showdown.
			expect(timers.scheduledTimers.some((timer) => !timer.cleared)).toBe(true);
		} finally {
			timers.restore();
		}
	});
});

describe('PokerGame Sit & Go mode (HPA-176)', () => {
	type SngGame = {
		players: Player[];
		serverSyncedBalance: number;
		humanChipsBefore: number;
		handNumber: number;
		dealerIndex: number;
		finishedPlace: number | null;
		minimumBet: number;
		handStartStacks: Map<number, number>;
		settingsManager: GameSettingsManager;
		aiRival: AIRivalAssistant;
		settleHand: (outcome: 'win' | 'loss' | 'push') => void;
		finishHand: () => void;
		adoptAccountBalance: (balance: number) => boolean;
		getLLMSettings: () => Promise<unknown>;
		getPlayerPosition: (player: Player) => 'early' | 'middle' | 'late';
		updateGameStatus: (message: string) => void;
		processAITurn: () => Promise<void>;
		dealNewHand: () => Promise<void>;
	};

	interface SngDomOptions {
		guest: boolean;
		/** Value for data-poker-mode; omit to leave the attribute unset. */
		mode?: string;
		/** Rendered account balance; omit for an unavailable balance. */
		balance?: string;
	}

	function mockModeDom({ guest, mode, balance }: SngDomOptions) {
		const elements = mockPokerGameDOM();
		elements['poker-root'] = {
			addEventListener: () => {},
			dataset: mode ? { guestMode: String(guest), pokerMode: mode } : { guestMode: String(guest) },
			innerHTML: '',
			textContent: '',
			classList: { add: () => {}, remove: () => {}, toggle: () => {} },
			value: '0',
		};
		elements['player-balance'] = {
			addEventListener: () => {},
			dataset: {
				balance: balance ?? '',
				balanceAvailable: balance === undefined ? 'false' : 'true',
				guestMode: String(guest),
				userId: guest ? 'anonymous' : 'u_sng',
			},
			innerHTML: '',
			textContent: balance === undefined ? 'Unavailable' : `$${balance}`,
			classList: { add: () => {}, remove: () => {}, toggle: () => {} },
			value: '0',
		};
		return elements;
	}

	function memoryStorage(seed: Record<string, string> = {}) {
		const storage = { ...seed };
		(globalThis as typeof globalThis & { localStorage: Storage }).localStorage = {
			getItem: (key: string) => (key in storage ? storage[key] : null),
			setItem: (key: string, value: string) => {
				storage[key] = value;
			},
			removeItem: (key: string) => {
				delete storage[key];
			},
			clear: () => {
				for (const key of Object.keys(storage)) delete storage[key];
			},
			key: () => null,
			length: 0,
		};
		return storage;
	}

	function recordFetch() {
		const calls: string[] = [];
		const original = globalThis.fetch;
		(globalThis as typeof globalThis & { fetch: typeof fetch }).fetch = mock(
			async (input: string | URL | Request) => {
				const url =
					typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
				calls.push(url);
				return { ok: true, status: 200, json: async () => ({ balance: 500 }) };
			},
		) as unknown as typeof fetch;
		return { calls, restore: () => (globalThis.fetch = original) };
	}

	function recordWindowEvents() {
		const dispatched: string[] = [];
		const win = (globalThis as typeof globalThis & { window: Window }).window;
		const original = win.dispatchEvent;
		win.dispatchEvent = ((event: { type: string }) => {
			dispatched.push(event.type);
			return true;
		}) as typeof win.dispatchEvent;
		return { dispatched, restore: () => (win.dispatchEvent = original) };
	}

	function recordingGate() {
		const settlements: unknown[] = [];
		const gate: SettlementGate = {
			pending: null,
			isBlocked: false,
			settle: async (command) => {
				settlements.push(command);
				return { balance: 500, duplicate: false };
			},
			retry: async () => null,
			reset: () => {},
		};
		return { settlements, gate };
	}

	beforeEach(() => {
		mockPokerGameDOM();
		memoryStorage();
		(globalThis as typeof globalThis & { fetch: typeof fetch }).fetch = mock(async () => {
			return { ok: true, status: 200, json: async () => ({ balance: 500 }) };
		}) as unknown as typeof fetch;
	});

	test('SNG starts six fixed 500-chip stacks and adopts no account balance', () => {
		mockModeDom({ guest: false, mode: 'sng', balance: '2500' });

		const game = new PokerGame() as unknown as SngGame;

		expect(game.players).toHaveLength(6);
		for (const player of game.players) {
			expect(player.chips).toBe(SNG_START_STACK);
		}
		// The nonzero account balance is never adopted as the tournament stack.
		expect(game.serverSyncedBalance).toBe(SNG_START_STACK);
		expect(game.adoptAccountBalance(9999)).toBe(false);
		expect(game.players[0].chips).toBe(SNG_START_STACK);
	});

	test('SNG stays playable with an unavailable balance and makes zero wallet calls', async () => {
		const elements = mockModeDom({ guest: false, mode: 'sng' });
		const fetchRecorder = recordFetch();
		const events = recordWindowEvents();
		const { settlements, gate } = recordingGate();

		try {
			const game = new PokerGame(undefined, gate) as unknown as SngGame;

			expect(elements['btn-deal']?.disabled).toBe(false);
			for (const player of game.players) {
				expect(player.chips).toBe(SNG_START_STACK);
			}

			// A finished tournament hand settles nothing and tells the table nothing.
			game.humanChipsBefore = SNG_START_STACK;
			game.players[0] = { ...game.players[0], chips: 700 };
			game.settleHand('win');
			game.finishHand();
			await flushAsyncWork();

			expect(settlements).toHaveLength(0);
			expect(fetchRecorder.calls).toEqual([]);
			expect(events.dispatched).not.toContain('poker-hand-settled');
			expect(game.humanChipsBefore).toBe(0);
		} finally {
			fetchRecorder.restore();
			events.restore();
		}
	});

	test('SNG dealNewHand plays a local hand with no wallet or account activity', async () => {
		mockModeDom({ guest: false, mode: 'sng', balance: '2500' });
		const fetchRecorder = recordFetch();
		const { settlements, gate } = recordingGate();

		try {
			const game = new PokerGame(undefined, gate) as unknown as SngGame;
			game.processAITurn = async () => {};

			await game.dealNewHand();

			expect(game.handNumber).toBe(1);
			expect(game.humanChipsBefore).toBe(SNG_START_STACK);
			expect(settlements).toHaveLength(0);
			expect(fetchRecorder.calls).toEqual([]);
		} finally {
			fetchRecorder.restore();
		}
	});

	test('guest SNG never touches the persisted cash bankroll, cash still restores it', () => {
		const storage = memoryStorage({ 'poker-bankroll:anonymous': '725' });
		const elements = mockModeDom({ guest: true, mode: 'sng', balance: '1000' });

		const game = new PokerGame() as unknown as SngGame;

		for (const player of game.players) {
			expect(player.chips).toBe(SNG_START_STACK);
		}
		// The saved cash bankroll is neither read into the tournament stack...
		expect(storage['poker-bankroll:anonymous']).toBe('725');
		expect(elements['player-balance']?.textContent).toBe('$1000');

		// ...nor rewritten by settlement, unload, or a bust-and-deal.
		game.settleHand('loss');
		windowListeners.beforeunload?.();
		expect(storage['poker-bankroll:anonymous']).toBe('725');

		// The same saved bankroll still backs an ordinary cash game.
		mockModeDom({ guest: true, balance: '1000' });
		memoryStorage({ 'poker-bankroll:anonymous': '725' });
		const cashGame = new PokerGame() as unknown as SngGame;
		expect(cashGame.players[0].chips).toBe(725);
	});

	test('absent or unknown mode values default to cash', () => {
		mockModeDom({ guest: false, mode: 'tournament', balance: '40' });
		const bogus = new PokerGame() as unknown as SngGame;
		expect(bogus.players[0].chips).toBe(40);

		mockModeDom({ guest: false, balance: '40' });
		const absent = new PokerGame() as unknown as SngGame;
		expect(absent.players[0].chips).toBe(40);
	});

	test('SNG forces rule-based AI: LLM settings are unavailable without fetching', async () => {
		mockModeDom({ guest: false, mode: 'sng', balance: '2500' });
		memoryStorage({
			'arcturus-ai-settings': JSON.stringify({
				provider: 'openai',
				model: 'gpt-4o',
				apiKey: 'sk-local',
			}),
		});
		const fetchRecorder = recordFetch();

		try {
			const game = new PokerGame() as unknown as SngGame;
			expect(await game.getLLMSettings()).toBeNull();
			expect(fetchRecorder.calls).toEqual([]);
		} finally {
			fetchRecorder.restore();
		}
	});

	test('SNG settings save preserves the hidden cash fields', () => {
		const elements = mockModeDom({ guest: false, mode: 'sng', balance: '2500' });
		const storage = memoryStorage({
			poker_game_settings: JSON.stringify({
				startingChips: 777,
				smallBlind: 25,
				bigBlind: 50,
				useLLMAI: true,
			}),
		});

		new PokerGame();
		// The hidden inputs could hold anything — they must not be written back.
		elements['setting-starting-chips']!.value = '1';
		elements['setting-small-blind']!.value = '2';
		elements['setting-big-blind']!.value = '3';
		elements['setting-use-llm-ai']!.checked = false;
		elements['setting-ai-speed']!.value = 'fast';
		elements['btn-save-settings'].click?.();

		const saved = JSON.parse(storage['poker_game_settings']);
		expect(saved.startingChips).toBe(777);
		expect(saved.smallBlind).toBe(25);
		expect(saved.bigBlind).toBe(50);
		// The tournament-editable field does persist.
		expect(saved.aiSpeed).toBe('fast');
		expect(saved.useLLMAI).toBe(true);
	});

	test('SNG settings reset preserves the cash fields while resetting AI prefs', () => {
		const elements = mockModeDom({ guest: false, mode: 'sng', balance: '2500' });
		const storage = memoryStorage({
			poker_game_settings: JSON.stringify({
				startingChips: 777,
				smallBlind: 25,
				bigBlind: 50,
				aiSpeed: 'slow',
				useLLMAI: true,
			}),
		});

		new PokerGame();
		elements['btn-reset-settings'].click?.();

		const saved = JSON.parse(storage['poker_game_settings']);
		expect(saved.startingChips).toBe(777);
		expect(saved.smallBlind).toBe(25);
		expect(saved.bigBlind).toBe(50);
		expect(saved.useLLMAI).toBe(true);
		expect(saved.aiSpeed).toBe(DEFAULT_SETTINGS.aiSpeed);
	});

	test('a terminal finish stays on the status line through settings save and reset', () => {
		const elements = mockModeDom({ guest: false, mode: 'sng', balance: '2500' });
		memoryStorage();
		const game = new PokerGame() as unknown as SngGame;
		game.finishedPlace = 3;
		const statuses: string[] = [];
		game.updateGameStatus = (message) => statuses.push(message);

		elements['btn-save-settings'].click?.();
		elements['btn-reset-settings'].click?.();

		expect(statuses).toEqual([]);
	});

	test('SNG shows ladder blinds before the first deal, not saved cash blinds', () => {
		const elements = mockModeDom({ guest: false, mode: 'sng', balance: '2500' });
		memoryStorage({
			poker_game_settings: JSON.stringify({ smallBlind: 25, bigBlind: 50 }),
		});

		const game = new PokerGame() as unknown as SngGame;

		expect(game.minimumBet).toBe(10);
		expect(elements['table-blinds']?.textContent).toBe('5 / 10');
	});

	test('the AI Rival button never fires a paid request in SNG', () => {
		const elements = mockModeDom({ guest: false, mode: 'sng', balance: '2500' });
		memoryStorage({
			'arcturus-ai-settings': JSON.stringify({
				provider: 'openai',
				model: 'gpt-4o',
				apiKey: 'sk-local',
			}),
		});

		const game = new PokerGame() as unknown as SngGame;
		const spy = mock(async () => {});
		game.aiRival.requestAiMove = spy as unknown as AIRivalAssistant['requestAiMove'];

		elements['btn-ai-move'].click?.();

		expect(spy).not.toHaveBeenCalled();
	});

	test('AI position reads run over the dealt-in seats after eliminations', () => {
		mockModeDom({ guest: false, mode: 'sng', balance: '2500' });
		memoryStorage();

		const game = new PokerGame() as unknown as SngGame;
		// Survivors at seats 0, 2, 4, 5; the button is on seat 0. Seat-distance
		// math across all six seats would read seats 4 and 5 as 'late' — over
		// the dealt-in order [0,2,4,5] they are only middle of four.
		game.players = game.players.map((player, seat) => ({
			...player,
			chips: [500, 0, 500, 0, 500, 500][seat],
		}));
		game.handStartStacks = new Map([
			[0, 500],
			[2, 500],
			[4, 500],
			[5, 500],
		]);
		game.dealerIndex = 0;

		expect(game.getPlayerPosition(game.players[0])).toBe('late'); // button
		expect(game.getPlayerPosition(game.players[2])).toBe('early');
		expect(game.getPlayerPosition(game.players[4])).toBe('early');
		expect(game.getPlayerPosition(game.players[5])).toBe('middle');
	});
});

describe('PokerGame Sit & Go tournament lifecycle (HPA-176)', () => {
	type LifecycleGame = {
		players: Player[];
		pot: number;
		minimumBet: number;
		handNumber: number;
		dealerIndex: number;
		smallBlindIndex: number;
		bigBlindIndex: number;
		currentPlayerIndex: number;
		isProcessingAction: boolean;
		handInProgress: boolean;
		serverSyncedBalance: number;
		pendingChipReset: boolean;
		processAITurn: () => Promise<void>;
		dealNewHand: () => Promise<void>;
	};

	function sngTable(balance = '2500') {
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
			json: async () => ({ balance: 500 }),
		})) as unknown as typeof fetch;
		elements['poker-root'] = {
			addEventListener: () => {},
			dataset: { guestMode: 'false', pokerMode: 'sng' },
			innerHTML: '',
			textContent: '',
			classList: { add: () => {}, remove: () => {}, toggle: () => {} },
			value: '0',
		};
		elements['player-balance'] = {
			addEventListener: () => {},
			dataset: {
				balance,
				balanceAvailable: 'true',
				guestMode: 'false',
				userId: 'u_lifecycle',
			},
			innerHTML: '',
			textContent: `$${balance}`,
			classList: { add: () => {}, remove: () => {}, toggle: () => {} },
			value: '0',
		};
		const game = new PokerGame() as unknown as LifecycleGame;
		game.processAITurn = async () => {};
		return { elements, game };
	}

	function setStacks(game: LifecycleGame, chips: number[]) {
		game.players = game.players.map((player, seat) => ({ ...player, chips: chips[seat] }));
	}

	test('rotation skips busted seats: survivors [0,2,5] from a dead button', async () => {
		const { game } = sngTable();
		setStacks(game, [500, 0, 500, 0, 0, 500]);
		game.dealerIndex = 5;

		await game.dealNewHand();

		expect(game.handNumber).toBe(1);
		expect(game.dealerIndex).toBe(0);
		expect(game.smallBlindIndex).toBe(2);
		expect(game.bigBlindIndex).toBe(5);
		expect(game.players[0].isDealer).toBe(true);
		// Level-0 blinds (5/10) hit only funded seats.
		expect(game.players[2].chips).toBe(495);
		expect(game.players[5].chips).toBe(490);
		expect(game.players[1].chips).toBe(0);
		// Busted seats sit the hand out: folded, cardless, never acting.
		for (const seat of [1, 3, 4]) {
			expect(game.players[seat].folded).toBe(true);
			expect(game.players[seat].hand).toHaveLength(0);
		}
		for (const seat of [0, 2, 5]) {
			expect(game.players[seat].folded).toBe(false);
			expect(game.players[seat].hand).toHaveLength(2);
		}
		// Preflop action starts after the big blind: seat 0.
		expect(game.currentPlayerIndex).toBe(0);
	});

	test('heads-up [0,5]: the button posts the small blind and acts first preflop', async () => {
		const { game } = sngTable();
		setStacks(game, [800, 0, 0, 0, 0, 700]);
		game.dealerIndex = 5;

		await game.dealNewHand();

		expect(game.dealerIndex).toBe(0);
		expect(game.smallBlindIndex).toBe(0);
		expect(game.bigBlindIndex).toBe(5);
		expect(game.players[0].chips).toBe(795); // small blind 5
		expect(game.players[5].chips).toBe(690); // big blind 10
		expect(game.currentPlayerIndex).toBe(0);
	});

	test('dead seats between the button, SB and BB are skipped without adjacency', async () => {
		const { game } = sngTable();
		setStacks(game, [500, 500, 0, 500, 0, 500]);
		game.dealerIndex = 1;

		await game.dealNewHand();

		expect(game.dealerIndex).toBe(3);
		expect(game.smallBlindIndex).toBe(5); // skips dead seat 4
		expect(game.bigBlindIndex).toBe(0); // wraps past dead seats
		expect(game.players[5].chips).toBe(495);
		expect(game.players[0].chips).toBe(490);
		// First to act preflop is the funded seat after the big blind: seat 1.
		expect(game.currentPlayerIndex).toBe(1);
	});

	test('heads-up blinds that put both seats all-in run out on timers', async () => {
		const { elements, game } = sngTable();
		setStacks(game, [5, 0, 0, 0, 0, 10]);
		game.dealerIndex = 5;
		const timers = mockTrackedTimers();
		try {
			await game.dealNewHand();

			// Level-0 blinds (5/10) put both survivors all-in; nobody can act.
			expect(game.players[0].isAllIn).toBe(true);
			expect(game.players[5].isAllIn).toBe(true);
			// The runout parks the turn pointer and locks input until the board
			// finishes dealing itself out.
			expect(game.currentPlayerIndex).toBe(-1);
			expect(game.isProcessingAction).toBe(true);
			expect(elements['btn-check']?.disabled).toBe(true);
			expect(elements['btn-call']?.disabled).toBe(true);
			expect(elements['btn-raise']?.disabled).toBe(true);
			const runout = timers.scheduledTimers.find((timer) => !timer.cleared);
			expect(runout).toBeDefined();

			for (let i = 0; i < 6; i++) {
				const next = timers.scheduledTimers.find((timer) => !timer.cleared);
				if (!next) break;
				next.callback();
				if (game.handInProgress) expect(game.currentPlayerIndex).toBe(-1);
			}

			expect(game.handInProgress).toBe(false);
			expect(game.pot).toBe(0);
			expect(game.players[0].chips + game.players[5].chips).toBe(15);
		} finally {
			timers.restore();
		}
	});

	test('SNG blinds derive from the tournament level and reach raise legality and the toolbar', async () => {
		const { game, elements } = sngTable();
		setStacks(game, [500, 500, 500, 500, 500, 500]);
		game.dealerIndex = 0;
		game.handNumber = 5; // the next deal is hand 6: level 1 (10/20)

		await game.dealNewHand();

		expect(game.players[2].chips).toBe(490); // SB 10
		expect(game.players[3].chips).toBe(480); // BB 20
		expect(game.minimumBet).toBe(20);
		expect(elements['table-blinds']?.textContent).toBe('10 / 20');
	});

	test('a zero-stack human with a positive wallet is not restored in SNG', async () => {
		const { game } = sngTable('2500');
		setStacks(game, [0, 500, 500, 500, 500, 500]);
		game.dealerIndex = 0;

		await game.dealNewHand();

		// Tournament over for the human: no deal, no cash restore.
		expect(game.handNumber).toBe(0);
		expect(game.players[0].chips).toBe(0);
		expect(game.players[0].hand).toHaveLength(0);
		expect(game.serverSyncedBalance).toBe(SNG_START_STACK);
	});

	test('busted AI seats are never auto-rebought in SNG', async () => {
		const { game } = sngTable();
		setStacks(game, [500, 0, 500, 500, 500, 500]);
		game.dealerIndex = 0;

		await game.dealNewHand();

		// A cash rebuy would restore the settings stack (1000).
		expect(game.players[1].chips).toBe(0);
		expect(game.players[1].folded).toBe(true);
		expect(game.players[1].hand).toHaveLength(0);
	});

	test('a pending cash chip reset never rewrites SNG stacks', async () => {
		const { game } = sngTable();
		game.pendingChipReset = true;
		setStacks(game, [700, 0, 600, 500, 400, 800]);
		game.dealerIndex = 5;

		await game.dealNewHand();

		// Seats 4 and 5 are out of the blinds: a cash reset would set them to 1000.
		expect(game.players[4].chips).toBe(400);
		expect(game.players[5].chips).toBe(800);
		expect(game.players.reduce((sum, player) => sum + player.chips, game.pot)).toBe(3000);
	});

	test('the tournament stops dealing once one seat holds every chip', async () => {
		const { game } = sngTable();
		setStacks(game, [3000, 0, 0, 0, 0, 0]);

		await game.dealNewHand();

		expect(game.handNumber).toBe(0);
		expect(game.players[0].hand).toHaveLength(0);
	});
});

describe('PokerGame Sit & Go terminal place and deal stop (HPA-176)', () => {
	type TerminalGame = {
		players: Player[];
		handNumber: number;
		finishedPlace: number | null;
		handStartStacks: Map<number, number>;
		humanChipsBefore: number;
		serverSyncedBalance: number;
		updateGameStatus: (message: string) => void;
		finishHand: () => void;
		settleHand: (outcome: 'win' | 'loss' | 'push') => void;
		dealNewHand: () => Promise<void>;
		scheduleAutoDeal: (delayMs: number) => void;
	};

	function sngTerminalTable(storage: Record<string, string> = {}) {
		const elements = mockPokerGameDOM();
		(globalThis as typeof globalThis & { localStorage: Storage }).localStorage = {
			getItem: (key: string) => (key in storage ? storage[key] : null),
			setItem: () => {},
			removeItem: () => {},
			clear: () => {},
			key: () => null,
			length: 0,
		};
		(globalThis as typeof globalThis & { fetch: typeof fetch }).fetch = mock(async () => ({
			ok: true,
			status: 200,
			json: async () => ({ balance: 500 }),
		})) as unknown as typeof fetch;
		elements['poker-root'] = {
			addEventListener: () => {},
			dataset: { guestMode: 'false', pokerMode: 'sng' },
			innerHTML: '',
			textContent: '',
			classList: { add: () => {}, remove: () => {}, toggle: () => {} },
			value: '0',
		};
		elements['player-balance'] = {
			addEventListener: () => {},
			dataset: {
				balance: '2500',
				balanceAvailable: 'true',
				guestMode: 'false',
				userId: 'u_terminal',
			},
			innerHTML: '',
			textContent: '$2,500',
			classList: { add: () => {}, remove: () => {}, toggle: () => {} },
			value: '0',
		};
		const game = new PokerGame() as unknown as TerminalGame;
		return { elements, game };
	}

	function setTerminalStacks(game: TerminalGame, chips: number[], startStacks: number[]): void {
		game.players = game.players.map((player, seat) => ({ ...player, chips: chips[seat] }));
		game.handStartStacks = new Map(startStacks.map((stack, seat) => [seat, stack]));
	}

	test('a busting human places behind simultaneous larger-stack busts', () => {
		const { game } = sngTerminalTable();
		setTerminalStacks(game, [0, 0, 500, 0, 700, 600], [300, 450, 500, 0, 700, 600]);
		const statuses: string[] = [];
		game.updateGameStatus = (message) => statuses.push(message);

		game.finishHand();

		// 3 funded survivors + the human; seat 1 busted the same hand from a
		// larger start stack and finishes ahead, seat 3 busted before the hand.
		expect(game.finishedPlace).toBe(5);
		expect(statuses).toEqual(['You finished 5th']);
	});

	test('a heads-up loss finishes 2nd and reports exactly once', () => {
		const { game } = sngTerminalTable();
		setTerminalStacks(game, [0, 3000, 0, 0, 0, 0], [500, 500, 0, 0, 0, 0]);
		const statuses: string[] = [];
		game.updateGameStatus = (message) => statuses.push(message);

		game.finishHand();
		game.finishHand(); // a later end-of-hand sweep must not re-report the finish

		expect(game.finishedPlace).toBe(2);
		expect(statuses).toEqual(['You finished 2nd']);
	});

	test('the sole surviving human finishes 1st', () => {
		const { game } = sngTerminalTable();
		setTerminalStacks(game, [3000, 0, 0, 0, 0, 0], [500, 500, 500, 500, 500, 500]);
		const statuses: string[] = [];
		game.updateGameStatus = (message) => statuses.push(message);

		game.finishHand();

		expect(game.finishedPlace).toBe(1);
		expect(statuses).toEqual(['You finished 1st']);
	});

	test('an ordinary finished hand keeps the tournament open and auto-deal alive', () => {
		const timers = mockTrackedTimers();
		try {
			const { game } = sngTerminalTable({ [AUTO_DEAL_STORAGE_KEY]: 'true' });
			setTerminalStacks(game, [400, 0, 0, 900, 700, 0], [500, 300, 200, 500, 700, 300]);
			const statuses: string[] = [];
			game.updateGameStatus = (message) => statuses.push(message);

			game.finishHand();

			expect(game.finishedPlace).toBeNull();
			expect(statuses).toEqual([]);
			expect(
				timers.scheduledTimers.some(
					(timer) => timer.delay === AUTO_DEAL_DELAY_MS && !timer.cleared,
				),
			).toBe(true);
		} finally {
			timers.restore();
		}
	});

	test('a terminal hand blocks queued, scheduled and manual deals', async () => {
		const timers = mockTrackedTimers();
		try {
			const { elements, game } = sngTerminalTable({ [AUTO_DEAL_STORAGE_KEY]: 'true' });
			setTerminalStacks(game, [0, 3000, 0, 0, 0, 0], [500, 500, 0, 0, 0, 0]);

			game.finishHand();

			// The terminal hand queues no countdown...
			expect(timers.scheduledTimers.filter((timer) => !timer.cleared)).toHaveLength(0);

			// ...refuses any later scheduling attempt...
			game.scheduleAutoDeal(0);
			expect(timers.scheduledTimers.filter((timer) => !timer.cleared)).toHaveLength(0);

			// ...and neither the manual deal button nor a fired auto-deal deal again.
			elements['btn-deal'].click?.();
			await flushAsyncWork();
			await game.dealNewHand();
			expect(game.handNumber).toBe(0);
			expect(game.finishedPlace).toBe(2);
		} finally {
			timers.restore();
		}
	});

	test('a pre-terminal auto-deal timer firing after the terminal hand never deals', () => {
		const timers = mockTrackedTimers();
		try {
			const { game } = sngTerminalTable({ [AUTO_DEAL_STORAGE_KEY]: 'true' });
			// An ordinary hand end queues the 5-second auto-deal countdown.
			setTerminalStacks(game, [400, 0, 0, 900, 700, 0], [500, 300, 200, 500, 700, 300]);
			game.finishHand();
			const countdown = timers.scheduledTimers.find(
				(timer) => timer.delay === AUTO_DEAL_DELAY_MS && !timer.cleared,
			);
			expect(countdown).toBeDefined();

			// The next hand ends the tournament: seat 3 was already busted, so the
			// heads-up loss places 2nd and the pending countdown dies with it.
			setTerminalStacks(game, [0, 2000, 0, 0, 0, 0], [400, 900, 0, 0, 0, 0]);
			game.finishHand();
			expect(game.finishedPlace).toBe(2);

			countdown!.callback(); // the clock fires the stale countdown anyway
			expect(timers.scheduledTimers.filter((timer) => !timer.cleared)).toHaveLength(0);
			expect(game.handNumber).toBe(0);
		} finally {
			timers.restore();
		}
	});

	test('cash settlement works normally after a fresh cash navigation', async () => {
		const { game } = sngTerminalTable();
		setTerminalStacks(game, [0, 3000, 0, 0, 0, 0], [500, 500, 0, 0, 0, 0]);
		game.finishHand();
		expect(game.finishedPlace).toBe(2);

		// A fresh cash page shares the browser storage but nothing else.
		const elements = mockPokerGameDOM();
		elements['player-balance'] = {
			addEventListener: () => {},
			dataset: { balance: '500', balanceAvailable: 'true', userId: 'u_cash_after_sng' },
			innerHTML: '',
			textContent: '500',
			classList: { add: () => {}, remove: () => {}, toggle: () => {} },
			value: '0',
		};
		const settlements: unknown[] = [];
		const gate: SettlementGate = {
			pending: null,
			isBlocked: false,
			settle: async (command) => {
				settlements.push(command);
				return { balance: 450, duplicate: false };
			},
			retry: async () => null,
			reset: () => {},
		};

		const cash = new PokerGame(undefined, gate) as unknown as TerminalGame;
		cash.humanChipsBefore = 500;
		cash.players[0] = { ...cash.players[0], chips: 450 };
		cash.settleHand('loss');
		await flushAsyncWork();

		expect(settlements).toHaveLength(1);
		const command = settlements[0] as ReturnType<typeof buildPokerSettlementCommand>;
		expect(command.delta).toBe(-50);
		expect(command.game).toBe('poker');
		expect(cash.serverSyncedBalance).toBe(450);
	});
});

describe('PokerGame SNG champion badge report (HPA-172)', () => {
	type ChampionGame = {
		players: Player[];
		handNumber: number;
		finishedPlace: number | null;
		handStartStacks: Map<number, number>;
		updateGameStatus: (message: string) => void;
		finishHand: () => void;
	};

	type RecordedRequest = { url: string; init?: RequestInit };

	function championTable({ guest = false }: { guest?: boolean } = {}) {
		const elements = mockPokerGameDOM();
		(globalThis as typeof globalThis & { localStorage: Storage }).localStorage = {
			getItem: () => null,
			setItem: () => {},
			removeItem: () => {},
			clear: () => {},
			key: () => null,
			length: 0,
		};
		const requests: RecordedRequest[] = [];
		(globalThis as typeof globalThis & { fetch: typeof fetch }).fetch = mock(
			async (input: string | URL | Request, init?: RequestInit) => {
				requests.push({ url: String(input), init });
				return {
					ok: true,
					status: 200,
					json: async () => ({
						newAchievements: [
							{ id: 'sng_champion', icon: '🏆' },
							{ id: 'big_score', icon: '💰' },
						],
					}),
				};
			},
		) as unknown as typeof fetch;
		elements['poker-root'] = {
			addEventListener: () => {},
			click: () => {},
			dataset: { guestMode: String(guest), pokerMode: 'sng' },
			innerHTML: '',
			textContent: '',
			classList: { add: () => {}, remove: () => {}, toggle: () => {} },
			value: '0',
		};
		elements['player-balance'] = {
			addEventListener: () => {},
			click: () => {},
			dataset: {
				balance: '2500',
				balanceAvailable: 'true',
				guestMode: String(guest),
				userId: guest ? 'anonymous' : 'u_champion',
			},
			innerHTML: '',
			textContent: '$2,500',
			classList: { add: () => {}, remove: () => {}, toggle: () => {} },
			value: '0',
		};
		const game = new PokerGame() as unknown as ChampionGame;
		return { elements, game, requests };
	}

	function setChampionStacks(game: ChampionGame, chips: number[], startStacks: number[]): void {
		game.players = game.players.map((player, seat) => ({ ...player, chips: chips[seat] }));
		game.handStartStacks = new Map(startStacks.map((stack, seat) => [seat, stack]));
	}

	function captureEarnedEvents(): Array<{ type: string; detail: unknown }> {
		const events: Array<{ type: string; detail: unknown }> = [];
		(
			globalThis as unknown as {
				window: { dispatchEvent: (event: { type: string; detail?: unknown }) => boolean };
			}
		).window.dispatchEvent = (event) => {
			events.push({ type: event.type, detail: event.detail });
			return true;
		};
		return events;
	}

	test('a signed-in first place sends exactly one empty badge POST and toasts returned badges', async () => {
		const { game, requests } = championTable();
		const events = captureEarnedEvents();
		setChampionStacks(game, [3000, 0, 0, 0, 0, 0], [500, 500, 500, 500, 500, 500]);
		const statuses: string[] = [];
		game.updateGameStatus = (message) => statuses.push(message);

		game.finishHand();
		game.finishHand(); // single-fire: a second end-of-hand sweep adds no request
		await flushAsyncWork();

		expect(game.finishedPlace).toBe(1);
		expect(statuses).toEqual(['You finished 1st']);
		expect(requests).toHaveLength(1);
		expect(requests[0].url).toBe('/api/achievements/sng-champion');
		expect(requests[0].init?.method).toBe('POST');
		expect(requests[0].init?.body).toBeUndefined();
		expect(events).toEqual([
			{
				type: 'achievement-earned',
				detail: {
					achievements: [
						{ id: 'sng_champion', icon: '🏆' },
						{ id: 'big_score', icon: '💰' },
					],
				},
			},
		]);
	});

	test('a lower-place finish sends no badge request', async () => {
		const { game, requests } = championTable();
		setChampionStacks(game, [0, 3000, 0, 0, 0, 0], [500, 500, 0, 0, 0, 0]);

		game.finishHand();
		game.finishHand();
		await flushAsyncWork();

		expect(game.finishedPlace).toBe(2);
		expect(requests).toHaveLength(0);
	});

	test('a guest first place sends no badge request', async () => {
		const { game, requests } = championTable({ guest: true });
		setChampionStacks(game, [3000, 0, 0, 0, 0, 0], [500, 500, 500, 500, 500, 500]);

		game.finishHand();
		await flushAsyncWork();

		expect(game.finishedPlace).toBe(1);
		expect(requests).toHaveLength(0);
	});

	test('an unfinished tournament sends no badge request', async () => {
		const { game, requests } = championTable();
		setChampionStacks(game, [400, 0, 0, 900, 700, 0], [500, 300, 200, 500, 700, 300]);

		game.finishHand();
		await flushAsyncWork();

		expect(game.finishedPlace).toBeNull();
		expect(requests).toHaveLength(0);
	});

	test('a rejected badge POST leaves the tournament result intact', async () => {
		const { game } = championTable();
		(globalThis as typeof globalThis & { fetch: typeof fetch }).fetch = mock(async () => {
			throw new Error('offline');
		}) as unknown as typeof fetch;
		setChampionStacks(game, [3000, 0, 0, 0, 0, 0], [500, 500, 500, 500, 500, 500]);
		const statuses: string[] = [];
		game.updateGameStatus = (message) => statuses.push(message);

		game.finishHand();
		await flushAsyncWork();

		expect(game.finishedPlace).toBe(1);
		expect(statuses).toEqual(['You finished 1st']);
	});
});

describe('PokerGame Sit & Go whole-tournament simulation (HPA-176)', () => {
	type SimGame = {
		players: Player[];
		pot: number;
		handNumber: number;
		handInProgress: boolean;
		bettingRound: string | null;
		currentPlayerIndex: number;
		isProcessingAction: boolean;
		dealNewHand: () => Promise<void>;
	};

	/** Deterministic LCG seeds AI decisions and the deck, so every run plays the same tournament. */
	function seededRandom(seed: number): () => number {
		let state = seed >>> 0;
		return () => {
			state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
			return state / 4294967296;
		};
	}

	test('a seeded tournament plays to a terminal state with zero cash side effects', async () => {
		const elements = mockPokerGameDOM();
		const storage: Record<string, string> = {};
		const sessionWrites: string[] = [];
		(globalThis as typeof globalThis & { localStorage: Storage }).localStorage = {
			getItem: (key: string) => (key in storage ? storage[key] : null),
			setItem: (key: string, value: string) => {
				storage[key] = value;
			},
			removeItem: (key: string) => {
				delete storage[key];
			},
			clear: () => {},
			key: () => null,
			length: 0,
		};
		const globalThisWithSession = globalThis as typeof globalThis & {
			sessionStorage?: Storage;
		};
		// A leftover cash session tally must survive the whole tournament untouched.
		const seededCashSession = JSON.stringify({
			hands: 3,
			net: 250,
			streak: 1,
			biggestPot: 400,
			bestHand: 'FLUSH',
		});
		globalThisWithSession.sessionStorage = {
			getItem: (key: string) => (key === SESSION_STATS_KEY ? seededCashSession : null),
			setItem: (key: string, value: string) => sessionWrites.push(`${key}=${value}`),
			removeItem: () => {},
			clear: () => {},
			key: () => null,
			length: 0,
		};
		const fetchCalls: string[] = [];
		const originalFetch = globalThis.fetch;
		(globalThis as typeof globalThis & { fetch: typeof fetch }).fetch = mock(
			async (input: string | URL | Request) => {
				const url =
					typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
				fetchCalls.push(url);
				return { ok: true, status: 200, json: async () => ({ balance: 500 }) };
			},
		) as unknown as typeof fetch;
		const settlements: unknown[] = [];
		const gate: SettlementGate = {
			pending: null,
			isBlocked: false,
			settle: async (command) => {
				settlements.push(command);
				return { balance: 500, duplicate: false };
			},
			retry: async () => null,
			reset: () => {},
		};
		const dispatched: string[] = [];
		const win = (globalThis as typeof globalThis & { window: Window }).window;
		const originalDispatch = win.dispatchEvent;
		win.dispatchEvent = ((event: { type: string }) => {
			dispatched.push(event.type);
			return true;
		}) as typeof win.dispatchEvent;
		elements['poker-root'] = {
			addEventListener: () => {},
			dataset: { guestMode: 'false', pokerMode: 'sng' },
			innerHTML: '',
			textContent: '',
			classList: { add: () => {}, remove: () => {}, toggle: () => {} },
			value: '0',
		};
		elements['player-balance'] = {
			addEventListener: () => {},
			dataset: {
				balance: '2500',
				balanceAvailable: 'true',
				guestMode: 'false',
				userId: 'u_sim',
			},
			innerHTML: '',
			textContent: '$2,500',
			classList: { add: () => {}, remove: () => {}, toggle: () => {} },
			value: '0',
		};

		const timers = mockTrackedTimers();
		try {
			const game = new PokerGame(seededRandom(20261021), gate) as unknown as SimGame;
			const TOTAL = 6 * SNG_START_STACK;

			const humanCanAct = () => {
				const human = game.players[0];
				return (
					game.handInProgress &&
					game.bettingRound !== null &&
					!game.isProcessingAction &&
					game.currentPlayerIndex === 0 &&
					!human.folded &&
					!human.isAllIn
				);
			};

			/** Conservation, dead-seat and liveness invariants after every step. */
			const assertStep = (bustedSeats: number[], foldedChips: Map<number, number>) => {
				expect(game.players.reduce((sum, player) => sum + player.chips, 0) + game.pot).toBe(TOTAL);
				for (const seat of bustedSeats) {
					// Busted seats stay busted, cardless and folded all hand.
					expect(game.players[seat].chips).toBe(0);
					expect(game.players[seat].folded).toBe(true);
					if (game.handInProgress) expect(game.players[seat].hand).toHaveLength(0);
				}
				// A folded seat never moves chips again for the rest of the hand.
				if (game.handInProgress) {
					for (const player of game.players) {
						if (!player.folded) continue;
						const seen = foldedChips.get(player.id);
						if (seen === undefined) foldedChips.set(player.id, player.chips);
						else expect(player.chips).toBe(seen);
					}
				}
				// Every pending state has a timer, awaits legal human input, or is
				// mid-transition; otherwise the table is stuck.
				if (game.handInProgress && game.bettingRound !== null) {
					const hasTimer = timers.scheduledTimers.some((timer) => !timer.cleared);
					const awaitingHuman = humanCanAct();
					expect(hasTimer || awaitingHuman || game.isProcessingAction).toBe(true);
				}
			};

			const actForHuman = (handIndex: number) => {
				const human = game.players[0];
				const call = getCallAmount(human, getHighestBet(game.players));
				const available = human.chips - call;
				if (handIndex % 3 === 0 && !human.hasActed && available > 0) {
					const slider = elements['bet-slider'];
					slider!.value = String(Math.min(1000, available));
					elements['btn-raise'].click?.(); // shove
				} else if (call > 0) {
					elements['btn-call'].click?.();
				} else {
					elements['btn-check'].click?.();
				}
			};

			let hands = 0;
			while (hands < 200) {
				const bustedSeats = game.players.filter((player) => player.chips === 0).map((p) => p.id);
				const foldedChips = new Map<number, number>();
				await game.dealNewHand();
				if (!game.handInProgress) break; // terminal guard refused the deal
				hands += 1;

				const firedTimers = new Set<number>();
				let steps = 0;
				while (game.handInProgress && steps++ < 400) {
					if (humanCanAct()) actForHuman(hands);
					else {
						// Fire each scheduled timer at most once, like a real clock.
						const timer = timers.scheduledTimers.find(
							(entry) => !entry.cleared && !firedTimers.has(entry.id),
						);
						expect(timer).toBeDefined();
						firedTimers.add(timer!.id);
						timer?.callback();
					}
					await flushAsyncWork();
					assertStep(bustedSeats, foldedChips);
				}
				// Every hand completes and pays out its whole pot.
				expect(game.handInProgress as boolean).toBe(false);
				expect(game.pot).toBe(0);

				const humanChips = game.players[0].chips;
				if (humanChips === 0 || humanChips === TOTAL) break;
			}

			// Terminal within the bound: the human wins all 3,000 chips or busts.
			expect(hands).toBeGreaterThan(0);
			expect(hands).toBeLessThan(200);
			const humanFinal = game.players[0].chips;
			expect(humanFinal === 0 || humanFinal === TOTAL).toBe(true);

			// Zero cash side effects across the entire run; a winning human may
			// fire only the wallet-free champion badge report.
			expect(settlements).toHaveLength(0);
			expect(fetchCalls.every((url) => url === '/api/achievements/sng-champion')).toBe(true);
			expect(dispatched).not.toContain('poker-hand-settled');
			expect(sessionWrites).toEqual([]);
			expect(storage).toEqual({});
		} finally {
			timers.restore();
			(globalThis as { fetch: typeof originalFetch }).fetch = originalFetch;
			win.dispatchEvent = originalDispatch;
			delete (globalThisWithSession as { sessionStorage?: unknown }).sessionStorage;
		}
	}, 30000);
});
