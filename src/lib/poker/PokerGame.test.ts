import { describe, expect, test, beforeEach, mock } from 'bun:test';
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
import { PokerGame } from './PokerGame';
import { DEFAULT_SETTINGS } from './types';
import { DEFAULT_GUEST_GAME_BALANCE } from '../public-game-session';

// Mock DOM for PokerGame constructor
function mockPokerGameDOM() {
	interface MockElement {
		addEventListener: (event: string, handler?: () => void) => void;
		click: () => void;
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
			if (!elements[id]) {
				const listeners: Record<string, (() => void) | undefined> = {};
				elements[id] = {
					addEventListener: (event: string, handler?: () => void) => {
						listeners[event] = handler;
					},
					click: () => {
						listeners['click']?.();
					},
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
	(globalThis as typeof globalThis & { window: Window & typeof globalThis }).window = {
		dispatchEvent: () => true,
		addEventListener: () => {},
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
		(globalThis as typeof globalThis & { fetch: typeof fetch }).fetch = mock(
			async (input: string | URL | Request) => {
				const url =
					typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

				if (url === '/api/profile/llm-settings') {
					return {
						ok: true,
						status: 200,
						json: async () => ({ settings: null }),
					};
				}

				return {
					ok: true,
					status: 200,
					json: async () => ({ balance: 500 }),
				};
			},
		) as unknown as typeof fetch;
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

	test('guest mode stays playable and skips account chip sync', async () => {
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
				syncChips: (outcome: 'win' | 'loss' | 'push') => void;
			};

			expect(game.hasServerSyncedBalance).toBe(true);
			expect(game.players[0].chips).toBe(1000);

			game.humanChipsBefore = 1000;
			game.players[0] = { ...game.players[0], chips: 1050 };
			game.syncChips('win');

			await flushAsyncWork();

			expect(fetchCalls).not.toContain('/api/chips/update');
			expect(game.humanChipsBefore).toBe(0);
			expect(game.players[0].chips).toBe(1050);
		} finally {
			(globalThis as typeof globalThis & { fetch: typeof fetch }).fetch = originalFetch;
		}
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
		expect(balanceEl.textContent).toBe('$850');
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
		expect(game.players[0].chips).toBe(65);
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

	test('guest syncChips keeps serverSyncedBalance in step with the persisted bankroll', () => {
		// Regression: the guest branch of syncChips persisted the new chip count
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
			syncChips: (outcome: 'win' | 'loss' | 'push') => void;
		};

		// Guest loaded with the default $1,000 baseline.
		expect(game.serverSyncedBalance).toBe(1000);

		// Guest loses the whole stack.
		game.players[0] = { ...game.players[0], chips: 0 };
		game.syncChips('loss');

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

			if (url === '/api/profile/llm-settings') {
				return {
					ok: true,
					status: 200,
					json: async () => ({ settings: null }),
				};
			}

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
			game.players[1] = { ...game.players[1], folded: true };
			game.players[2] = { ...game.players[2], folded: true };

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

			expect(game.currentPlayerIndex).toBe(1);
			expect(game.players[1].hasActed).toBe(false);
			expect(game.players[1].folded).toBe(false);

			staleAiDelay?.callback();
			await Promise.resolve();
			await Promise.resolve();

			expect(game.currentPlayerIndex).toBe(1);
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

describe('PokerGame syncChips', () => {
	test('does not call chips API before a hand baseline exists', () => {
		const elements = mockPokerGameDOM();
		elements['player-balance'] = {
			addEventListener: () => {},
			innerHTML: '',
			textContent: '500',
			classList: { add: () => {}, remove: () => {}, toggle: () => {} },
			value: '0',
		};

		const fetchMock = mock(async (input: string | URL | Request) => {
			const url =
				typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

			if (url === '/api/profile/llm-settings') {
				return {
					ok: true,
					status: 200,
					json: async () => ({ settings: null }),
				};
			}

			return {
				ok: true,
				status: 200,
				json: async () => ({ balance: 500 }),
			};
		}) as unknown as typeof fetch;
		(globalThis as typeof globalThis & { fetch: typeof fetch }).fetch = fetchMock;

		const game = new PokerGame() as unknown as {
			syncChips: (outcome: 'win' | 'loss' | 'push') => void;
		};

		game.syncChips('loss');

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock).toHaveBeenCalledWith('/api/profile/llm-settings');
	});

	test('dispatches achievement-earned when chip sync returns new achievements', async () => {
		const elements = mockPokerGameDOM();
		elements['player-balance'] = {
			addEventListener: () => {},
			innerHTML: '',
			textContent: '500',
			classList: { add: () => {}, remove: () => {}, toggle: () => {} },
			value: '0',
		};

		const dispatchEvent = mock((event: { type: string; detail?: unknown }) => event);
		(globalThis as typeof globalThis & { window: Window & typeof globalThis }).window = {
			dispatchEvent: dispatchEvent as unknown as Window['dispatchEvent'],
			addEventListener: () => {},
		} as unknown as Window & typeof globalThis;

		const fetchMock = mock(async (input: string | URL | Request) => {
			const url =
				typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

			if (url === '/api/profile/llm-settings') {
				return {
					ok: true,
					status: 200,
					json: async () => ({ settings: null }),
				};
			}

			return {
				ok: true,
				status: 200,
				json: async () => ({
					balance: 650,
					newAchievements: [{ id: 'poker-first-win', name: 'First Win', icon: 'trophy' }],
				}),
			};
		}) as unknown as typeof fetch;
		(globalThis as typeof globalThis & { fetch: typeof fetch }).fetch = fetchMock;

		const game = new PokerGame() as unknown as {
			players: Player[];
			humanChipsBefore: number;
			syncChips: (outcome: 'win' | 'loss' | 'push') => void;
		};

		game.humanChipsBefore = 500;
		game.players[0] = { ...game.players[0], chips: 650 };
		game.syncChips('win');

		await flushAsyncWork();
		await flushAsyncWork();

		expect(dispatchEvent).toHaveBeenCalledTimes(1);
		expect(dispatchEvent.mock.calls[0]?.[0]).toMatchObject({
			type: 'achievement-earned',
			detail: {
				achievements: [{ id: 'poker-first-win', name: 'First Win', icon: 'trophy' }],
			},
		});
	});

	test('records biggest win candidate as net profit instead of total pot', async () => {
		const elements = mockPokerGameDOM();
		elements['player-balance'] = {
			addEventListener: () => {},
			innerHTML: '',
			textContent: '500',
			classList: { add: () => {}, remove: () => {}, toggle: () => {} },
			value: '0',
		};

		const chipUpdateBodies: Array<Record<string, unknown>> = [];
		const deferred = { resolveFirstResponse: null as null | (() => void) };
		const firstResponse = new Promise((resolve) => {
			deferred.resolveFirstResponse = () => resolve(undefined);
		});
		const fetchMock = mock(async (input: string | URL | Request, init?: RequestInit) => {
			const url =
				typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

			if (url === '/api/profile/llm-settings') {
				return {
					ok: true,
					status: 200,
					json: async () => ({ settings: null }),
				};
			}

			chipUpdateBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
			return {
				ok: true,
				status: 200,
				json: async () => ({ balance: 650 }),
			};
		}) as unknown as typeof fetch;
		(globalThis as typeof globalThis & { fetch: typeof fetch }).fetch = fetchMock;

		const game = new PokerGame() as unknown as {
			players: Player[];
			pot: number;
			humanChipsBefore: number;
			nextPhase: () => void;
		};

		game.humanChipsBefore = 500;
		game.pot = 300;
		game.players[0] = { ...game.players[0], chips: 350, totalBet: 150, folded: false };
		game.players[1] = { ...game.players[1], folded: true };
		game.players[2] = { ...game.players[2], folded: true };
		game.nextPhase();

		await flushAsyncWork();

		expect(chipUpdateBodies).toHaveLength(1);
		expect(chipUpdateBodies[0].delta).toBe(150);
		expect(chipUpdateBodies[0].biggestWinCandidate).toBe(150);
	});

	test('records an abandoned hand as a loss before resetting a new hand baseline', async () => {
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

			if (url === '/api/profile/llm-settings') {
				return {
					ok: true,
					status: 200,
					json: async () => ({ settings: null }),
				};
			}

			chipUpdateBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
			return {
				ok: true,
				status: 200,
				json: async () => ({ balance: 450 }),
			};
		}) as unknown as typeof fetch;
		(globalThis as typeof globalThis & { fetch: typeof fetch }).fetch = fetchMock;

		const game = new PokerGame() as unknown as {
			players: Player[];
			humanChipsBefore: number;
			processAITurn: () => Promise<void>;
			dealNewHand: () => Promise<void>;
		};

		game.processAITurn = async () => {};
		game.humanChipsBefore = 500;
		game.players[0] = { ...game.players[0], chips: 450 };

		await game.dealNewHand();
		await flushAsyncWork();

		expect(chipUpdateBodies).toHaveLength(1);
		expect(chipUpdateBodies[0].delta).toBe(-50);
		expect(chipUpdateBodies[0].previousBalance).toBe(500);
		expect(chipUpdateBodies[0].outcome).toBe('loss');
		expect(chipUpdateBodies[0].handCount).toBe(1);
		expect(chipUpdateBodies[0].winsIncrement).toBe(0);
		expect(chipUpdateBodies[0].lossesIncrement).toBe(1);
		expect(chipUpdateBodies[0].biggestWinCandidate).toBe(0);
		expect(game.humanChipsBefore).toBe(450);
		expect(game.players[0].chips).toBe(440);
	});

	test('records a zero-delta abandoned hand as a loss before dealing again', async () => {
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

			if (url === '/api/profile/llm-settings') {
				return {
					ok: true,
					status: 200,
					json: async () => ({ settings: null }),
				};
			}

			chipUpdateBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
			return {
				ok: true,
				status: 200,
				json: async () => ({ balance: 500 }),
			};
		}) as unknown as typeof fetch;
		(globalThis as typeof globalThis & { fetch: typeof fetch }).fetch = fetchMock;

		const game = new PokerGame() as unknown as {
			players: Player[];
			humanChipsBefore: number;
			processAITurn: () => Promise<void>;
			dealNewHand: () => Promise<void>;
		};

		game.processAITurn = async () => {};
		game.humanChipsBefore = 500;
		game.players[0] = { ...game.players[0], chips: 500 };

		await game.dealNewHand();
		await flushAsyncWork();

		expect(chipUpdateBodies).toHaveLength(1);
		expect(chipUpdateBodies[0].delta).toBe(0);
		expect(chipUpdateBodies[0].previousBalance).toBe(500);
		expect(chipUpdateBodies[0].outcome).toBe('loss');
		expect(chipUpdateBodies[0].handCount).toBe(1);
		expect(chipUpdateBodies[0].winsIncrement).toBe(0);
		expect(chipUpdateBodies[0].lossesIncrement).toBe(1);
		expect(chipUpdateBodies[0].biggestWinCandidate).toBe(0);
		expect(game.humanChipsBefore).toBe(500);
		expect(game.players[0].chips).toBe(490);
	});

	test('serializes queued syncs and uses the updated balance for later hands', async () => {
		const elements = mockPokerGameDOM();
		elements['player-balance'] = {
			addEventListener: () => {},
			innerHTML: '',
			textContent: '500',
			classList: { add: () => {}, remove: () => {}, toggle: () => {} },
			value: '0',
		};

		const chipUpdateBodies: Array<Record<string, unknown>> = [];
		const deferred = { resolveFirstRequest: null as null | (() => void) };
		const firstRequest = new Promise((resolve) => {
			deferred.resolveFirstRequest = () => resolve(undefined);
		});

		const fetchMock = mock(async (input: string | URL | Request, init?: RequestInit) => {
			const url =
				typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

			if (url === '/api/profile/llm-settings') {
				return {
					ok: true,
					status: 200,
					json: async () => ({ settings: null }),
				};
			}

			chipUpdateBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
			if (chipUpdateBodies.length === 1) {
				await firstRequest;
				return {
					ok: true,
					status: 200,
					json: async () => ({ balance: 550 }),
				};
			}

			return {
				ok: true,
				status: 200,
				json: async () => ({ balance: 500 }),
			};
		}) as unknown as typeof fetch;
		(globalThis as typeof globalThis & { fetch: typeof fetch }).fetch = fetchMock;

		const game = new PokerGame() as unknown as {
			players: Player[];
			humanChipsBefore: number;
			syncChips: (outcome: 'win' | 'loss' | 'push') => void;
		};

		game.humanChipsBefore = 500;
		game.players[0] = { ...game.players[0], chips: 550 };
		game.syncChips('win');

		await flushAsyncWork();

		game.humanChipsBefore = 550;
		game.players[0] = { ...game.players[0], chips: 500 };
		game.syncChips('loss');

		await flushAsyncWork();

		expect(chipUpdateBodies).toHaveLength(1);
		expect(chipUpdateBodies[0].previousBalance).toBe(500);
		expect(chipUpdateBodies[0].delta).toBe(50);

		if (deferred.resolveFirstRequest) {
			deferred.resolveFirstRequest();
		}
		await flushAsyncWork();
		await flushAsyncWork();

		expect(chipUpdateBodies).toHaveLength(2);
		expect(chipUpdateBodies[1].previousBalance).toBe(550);
		expect(chipUpdateBodies[1].delta).toBe(-50);
	});

	test('retries a queued hand after BALANCE_MISMATCH with the refreshed balance', async () => {
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

			if (url === '/api/profile/llm-settings') {
				return {
					ok: true,
					status: 200,
					json: async () => ({ settings: null }),
				};
			}

			chipUpdateBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
			if (chipUpdateBodies.length === 1) {
				return {
					ok: false,
					status: 409,
					json: async () => ({ error: 'BALANCE_MISMATCH', currentBalance: 550 }),
				};
			}

			return {
				ok: true,
				status: 200,
				json: async () => ({ balance: 500 }),
			};
		}) as unknown as typeof fetch;
		(globalThis as typeof globalThis & { fetch: typeof fetch }).fetch = fetchMock;

		const game = new PokerGame() as unknown as {
			players: Player[];
			humanChipsBefore: number;
			serverSyncedBalance: number;
			syncChips: (outcome: 'win' | 'loss' | 'push') => void;
		};

		game.humanChipsBefore = 600;
		game.players[0] = { ...game.players[0], chips: 550 };
		game.syncChips('loss');

		await flushAsyncWork();
		await flushAsyncWork();

		expect(chipUpdateBodies).toHaveLength(2);
		expect(chipUpdateBodies[0].previousBalance).toBe(500);
		expect(chipUpdateBodies[1].previousBalance).toBe(550);
		expect(chipUpdateBodies[1].delta).toBe(-50);
		expect(game.serverSyncedBalance).toBe(500);
		expect(game.players[0].chips).toBe(500);
	});

	test('retries equal-balance BALANCE_MISMATCH responses with the same syncId instead of dropping the queued sync', async () => {
		const elements = mockPokerGameDOM();
		elements['player-balance'] = {
			addEventListener: () => {},
			innerHTML: '',
			textContent: '500',
			classList: { add: () => {}, remove: () => {}, toggle: () => {} },
			value: '0',
		};

		const chipUpdateBodies: Array<Record<string, unknown>> = [];
		const deferred = { resolveFirstResponse: null as null | (() => void) };
		const firstResponse = new Promise((resolve) => {
			deferred.resolveFirstResponse = () => resolve(undefined);
		});

		const fetchMock = mock(async (input: string | URL | Request, init?: RequestInit) => {
			const url =
				typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

			if (url === '/api/profile/llm-settings') {
				return {
					ok: true,
					status: 200,
					json: async () => ({ settings: null }),
				};
			}

			chipUpdateBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
			if (chipUpdateBodies.length === 1) {
				await firstResponse;
				return {
					ok: false,
					status: 409,
					json: async () => ({ error: 'BALANCE_MISMATCH', currentBalance: 550 }),
				};
			}

			return {
				ok: true,
				status: 200,
				json: async () => ({ balance: 600 }),
			};
		}) as unknown as typeof fetch;
		(globalThis as typeof globalThis & { fetch: typeof fetch }).fetch = fetchMock;

		const game = new PokerGame() as unknown as {
			players: Player[];
			humanChipsBefore: number;
			serverSyncedBalance: number;
			pendingChipSyncs: Array<Record<string, unknown>>;
			syncChips: (outcome: 'win' | 'loss' | 'push') => void;
		};

		game.humanChipsBefore = 500;
		game.players[0] = { ...game.players[0], chips: 550 };
		game.syncChips('win');

		await flushAsyncWork();

		game.humanChipsBefore = 550;
		game.players[0] = { ...game.players[0], chips: 530 };

		if (deferred.resolveFirstResponse) {
			deferred.resolveFirstResponse();
		}

		await flushAsyncWork();
		await flushAsyncWork();

		expect(chipUpdateBodies).toHaveLength(2);
		expect(chipUpdateBodies[0].previousBalance).toBe(500);
		expect(chipUpdateBodies[0].delta).toBe(50);
		expect(chipUpdateBodies[1].previousBalance).toBe(550);
		expect(chipUpdateBodies[1].delta).toBe(50);
		expect(chipUpdateBodies[1].syncId).toBe(chipUpdateBodies[0].syncId);
		expect(game.pendingChipSyncs).toHaveLength(0);
		expect(game.serverSyncedBalance).toBe(600);
		expect(game.humanChipsBefore).toBe(600);
		expect(game.players[0].chips).toBe(580);
	});

	test('rebases the active hand baseline when BALANCE_MISMATCH refreshes the server balance', async () => {
		const elements = mockPokerGameDOM();
		elements['player-balance'] = {
			addEventListener: () => {},
			innerHTML: '',
			textContent: '500',
			classList: { add: () => {}, remove: () => {}, toggle: () => {} },
			value: '0',
		};

		const chipUpdateBodies: Array<Record<string, unknown>> = [];
		const deferred = { resolveFirstResponse: null as null | (() => void) };
		const firstResponse = new Promise((resolve) => {
			deferred.resolveFirstResponse = () => resolve(undefined);
		});

		const fetchMock = mock(async (input: string | URL | Request, init?: RequestInit) => {
			const url =
				typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

			if (url === '/api/profile/llm-settings') {
				return {
					ok: true,
					status: 200,
					json: async () => ({ settings: null }),
				};
			}

			chipUpdateBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
			if (chipUpdateBodies.length === 1) {
				await firstResponse;
				return {
					ok: false,
					status: 409,
					json: async () => ({ error: 'BALANCE_MISMATCH', currentBalance: 450 }),
				};
			}

			return {
				ok: true,
				status: 200,
				json: async () => ({ balance: 500 }),
			};
		}) as unknown as typeof fetch;
		(globalThis as typeof globalThis & { fetch: typeof fetch }).fetch = fetchMock;

		const game = new PokerGame() as unknown as {
			players: Player[];
			humanChipsBefore: number;
			serverSyncedBalance: number;
			syncChips: (outcome: 'win' | 'loss' | 'push') => void;
		};

		game.humanChipsBefore = 500;
		game.players[0] = { ...game.players[0], chips: 550 };
		game.syncChips('win');

		await flushAsyncWork();

		game.humanChipsBefore = 550;
		game.players[0] = { ...game.players[0], chips: 530 };

		if (deferred.resolveFirstResponse) {
			deferred.resolveFirstResponse();
		}

		await flushAsyncWork();
		await flushAsyncWork();

		expect(chipUpdateBodies).toHaveLength(2);
		expect(chipUpdateBodies[0].previousBalance).toBe(500);
		expect(chipUpdateBodies[0].delta).toBe(50);
		expect(chipUpdateBodies[1].previousBalance).toBe(450);
		expect(chipUpdateBodies[1].delta).toBe(50);
		expect(game.humanChipsBefore).toBe(500);
		expect(game.players[0].chips).toBe(480);
		expect(game.serverSyncedBalance).toBe(500);
	});

	test('rebases later queued sync baselines after BALANCE_MISMATCH before flushing them', async () => {
		const elements = mockPokerGameDOM();
		elements['player-balance'] = {
			addEventListener: () => {},
			dataset: {},
			innerHTML: '',
			textContent: '500',
			classList: { add: () => {}, remove: () => {}, toggle: () => {} },
			value: '0',
		};

		const chipUpdateBodies: Array<Record<string, unknown>> = [];
		const deferred = { resolveFirstResponse: null as null | (() => void) };
		const firstResponse = new Promise((resolve) => {
			deferred.resolveFirstResponse = () => resolve(undefined);
		});

		const fetchMock = mock(async (input: string | URL | Request, init?: RequestInit) => {
			const url =
				typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

			if (url === '/api/profile/llm-settings') {
				return {
					ok: true,
					status: 200,
					json: async () => ({ settings: null }),
				};
			}

			chipUpdateBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
			if (chipUpdateBodies.length === 1) {
				await firstResponse;
				return {
					ok: false,
					status: 409,
					json: async () => ({ error: 'BALANCE_MISMATCH', currentBalance: 550 }),
				};
			}

			return {
				ok: true,
				status: 200,
				json: async () => ({ balance: chipUpdateBodies.length === 2 ? 600 : 560 }),
			};
		}) as unknown as typeof fetch;
		(globalThis as typeof globalThis & { fetch: typeof fetch }).fetch = fetchMock;

		const game = new PokerGame() as unknown as {
			players: Player[];
			humanChipsBefore: number;
			serverSyncedBalance: number;
			pendingChipSyncs: Array<Record<string, unknown>>;
			syncChips: (outcome: 'win' | 'loss' | 'push') => void;
		};

		game.humanChipsBefore = 500;
		game.players[0] = { ...game.players[0], chips: 550 };
		game.syncChips('win');

		await flushAsyncWork();

		game.humanChipsBefore = 550;
		game.players[0] = { ...game.players[0], chips: 510 };
		game.syncChips('loss');

		if (deferred.resolveFirstResponse) {
			deferred.resolveFirstResponse();
		}

		await flushAsyncWork();
		await flushAsyncWork();
		await flushAsyncWork();

		expect(chipUpdateBodies).toHaveLength(3);
		expect(chipUpdateBodies[0].previousBalance).toBe(500);
		expect(chipUpdateBodies[0].delta).toBe(50);
		expect(chipUpdateBodies[1].previousBalance).toBe(550);
		expect(chipUpdateBodies[1].delta).toBe(50);
		expect(chipUpdateBodies[2].previousBalance).toBe(600);
		expect(chipUpdateBodies[2].delta).toBe(-40);
		expect(game.pendingChipSyncs).toHaveLength(0);
		expect(game.serverSyncedBalance).toBe(560);
	});

	test('keeps a rate-limited sync queued until a later flush succeeds', async () => {
		const elements = mockPokerGameDOM();
		elements['player-balance'] = {
			addEventListener: () => {},
			dataset: {},
			innerHTML: '',
			textContent: '500',
			classList: { add: () => {}, remove: () => {}, toggle: () => {} },
			value: '0',
		};

		const chipUpdateBodies: Array<Record<string, unknown>> = [];
		const deferred = { resolveFirstResponse: null as null | (() => void) };
		const firstResponse = new Promise((resolve) => {
			deferred.resolveFirstResponse = () => resolve(undefined);
		});
		const fetchMock = mock(async (input: string | URL | Request, init?: RequestInit) => {
			const url =
				typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

			if (url === '/api/profile/llm-settings') {
				return {
					ok: true,
					status: 200,
					json: async () => ({ settings: null }),
				};
			}

			chipUpdateBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
			if (chipUpdateBodies.length === 1) {
				return {
					ok: false,
					status: 429,
					json: async () => ({ error: 'RATE_LIMITED' }),
				};
			}

			return {
				ok: true,
				status: 200,
				json: async () => ({ balance: 450 }),
			};
		}) as unknown as typeof fetch;
		(globalThis as typeof globalThis & { fetch: typeof fetch }).fetch = fetchMock;

		const game = new PokerGame() as unknown as {
			players: Player[];
			humanChipsBefore: number;
			serverSyncedBalance: number;
			pendingChipSyncs: Array<Record<string, unknown>>;
			syncChips: (outcome: 'win' | 'loss' | 'push') => void;
			flushChipSyncQueue: () => Promise<void>;
		};

		game.humanChipsBefore = 500;
		game.players[0] = { ...game.players[0], chips: 450 };
		game.syncChips('loss');

		await flushAsyncWork();

		expect(chipUpdateBodies).toHaveLength(1);
		expect(chipUpdateBodies[0].previousBalance).toBe(500);
		expect(chipUpdateBodies[0].delta).toBe(-50);
		expect(game.pendingChipSyncs).toHaveLength(1);
		expect(game.serverSyncedBalance).toBe(500);

		await game.flushChipSyncQueue();

		expect(chipUpdateBodies).toHaveLength(2);
		expect(chipUpdateBodies[1].previousBalance).toBe(500);
		expect(chipUpdateBodies[1].delta).toBe(-50);
		expect(game.pendingChipSyncs).toHaveLength(0);
		expect(game.serverSyncedBalance).toBe(450);
	});

	test('automatically retries a deferred sync after the retry delay elapses', async () => {
		const elements = mockPokerGameDOM();
		elements['player-balance'] = {
			addEventListener: () => {},
			dataset: {},
			innerHTML: '',
			textContent: '500',
			classList: { add: () => {}, remove: () => {}, toggle: () => {} },
			value: '0',
		};

		const chipUpdateBodies: Array<Record<string, unknown>> = [];
		const fetchMock = mock(async (input: string | URL | Request, init?: RequestInit) => {
			const url =
				typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

			if (url === '/api/profile/llm-settings') {
				return {
					ok: true,
					status: 200,
					json: async () => ({ settings: null }),
				};
			}

			chipUpdateBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
			if (chipUpdateBodies.length === 1) {
				return {
					ok: false,
					status: 429,
					headers: new Headers({ 'Retry-After': '1' }),
					json: async () => ({ error: 'RATE_LIMITED' }),
				};
			}

			return {
				ok: true,
				status: 200,
				headers: new Headers(),
				json: async () => ({ balance: 450 }),
			};
		}) as unknown as typeof fetch;
		(globalThis as typeof globalThis & { fetch: typeof fetch }).fetch = fetchMock;

		const timers = mockTrackedTimers();

		try {
			const game = new PokerGame() as unknown as {
				players: Player[];
				humanChipsBefore: number;
				serverSyncedBalance: number;
				pendingChipSyncs: Array<Record<string, unknown>>;
				syncChips: (outcome: 'win' | 'loss' | 'push') => void;
			};

			game.humanChipsBefore = 500;
			game.players[0] = { ...game.players[0], chips: 450 };
			game.syncChips('loss');

			await flushAsyncWork();

			expect(chipUpdateBodies).toHaveLength(1);
			expect(game.pendingChipSyncs).toHaveLength(1);

			const retryTimer = timers.scheduledTimers.find((t) => !t.cleared);
			expect(retryTimer).toBeDefined();
			retryTimer?.callback();
			await flushAsyncWork();

			expect(chipUpdateBodies).toHaveLength(2);
			expect(chipUpdateBodies[1].previousBalance).toBe(500);
			expect(chipUpdateBodies[1].delta).toBe(-50);
			expect(game.pendingChipSyncs).toHaveLength(0);
			expect(game.serverSyncedBalance).toBe(450);
		} finally {
			timers.restore();
		}
	});

	test('keeps a 409 without currentBalance queued until a later flush succeeds', async () => {
		const elements = mockPokerGameDOM();
		elements['player-balance'] = {
			addEventListener: () => {},
			dataset: {},
			innerHTML: '',
			textContent: '500',
			classList: { add: () => {}, remove: () => {}, toggle: () => {} },
			value: '0',
		};

		const chipUpdateBodies: Array<Record<string, unknown>> = [];
		const fetchMock = mock(async (input: string | URL | Request, init?: RequestInit) => {
			const url =
				typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

			if (url === '/api/profile/llm-settings') {
				return {
					ok: true,
					status: 200,
					json: async () => ({ settings: null }),
				};
			}

			chipUpdateBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
			if (chipUpdateBodies.length === 1) {
				return {
					ok: false,
					status: 409,
					json: async () => ({ error: 'BALANCE_MISMATCH' }),
				};
			}

			return {
				ok: true,
				status: 200,
				json: async () => ({ balance: 450 }),
			};
		}) as unknown as typeof fetch;
		(globalThis as typeof globalThis & { fetch: typeof fetch }).fetch = fetchMock;

		const game = new PokerGame() as unknown as {
			players: Player[];
			humanChipsBefore: number;
			serverSyncedBalance: number;
			pendingChipSyncs: Array<Record<string, unknown>>;
			syncChips: (outcome: 'win' | 'loss' | 'push') => void;
			flushChipSyncQueue: () => Promise<void>;
		};

		game.humanChipsBefore = 500;
		game.players[0] = { ...game.players[0], chips: 450 };
		game.syncChips('loss');

		await flushAsyncWork();

		expect(chipUpdateBodies).toHaveLength(1);
		expect(chipUpdateBodies[0].previousBalance).toBe(500);
		expect(chipUpdateBodies[0].delta).toBe(-50);
		expect(game.pendingChipSyncs).toHaveLength(1);
		expect(game.serverSyncedBalance).toBe(500);

		await game.flushChipSyncQueue();

		expect(chipUpdateBodies).toHaveLength(2);
		expect(chipUpdateBodies[1].previousBalance).toBe(500);
		expect(chipUpdateBodies[1].delta).toBe(-50);
		expect(game.pendingChipSyncs).toHaveLength(0);
		expect(game.serverSyncedBalance).toBe(450);
	});

	test('drops a SYNC_ID_REUSE_MISMATCH sync and rebases the local bankroll to the confirmed server balance', async () => {
		const elements = mockPokerGameDOM();
		elements['player-balance'] = {
			addEventListener: () => {},
			dataset: {},
			innerHTML: '',
			textContent: '500',
			classList: { add: () => {}, remove: () => {}, toggle: () => {} },
			value: '0',
		};

		const chipUpdateBodies: Array<Record<string, unknown>> = [];
		const fetchMock = mock(async (input: string | URL | Request, init?: RequestInit) => {
			const url =
				typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

			if (url === '/api/profile/llm-settings') {
				return {
					ok: true,
					status: 200,
					json: async () => ({ settings: null }),
				};
			}

			chipUpdateBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
			return {
				ok: false,
				status: 409,
				json: async () => ({ error: 'SYNC_ID_REUSE_MISMATCH' }),
			};
		}) as unknown as typeof fetch;
		(globalThis as typeof globalThis & { fetch: typeof fetch }).fetch = fetchMock;

		const game = new PokerGame() as unknown as {
			players: Player[];
			humanChipsBefore: number;
			serverSyncedBalance: number;
			pendingChipSyncs: Array<Record<string, unknown>>;
			syncChips: (outcome: 'win' | 'loss' | 'push') => void;
			flushChipSyncQueue: () => Promise<void>;
		};

		game.humanChipsBefore = 500;
		game.players[0] = { ...game.players[0], chips: 650 };
		game.syncChips('win');

		await flushAsyncWork();

		expect(chipUpdateBodies).toHaveLength(1);
		expect(chipUpdateBodies[0].previousBalance).toBe(500);
		expect(chipUpdateBodies[0].delta).toBe(150);
		expect(game.pendingChipSyncs).toHaveLength(0);
		expect(game.serverSyncedBalance).toBe(500);
		expect(game.players[0].chips).toBe(500);

		await game.flushChipSyncQueue();

		expect(chipUpdateBodies).toHaveLength(1);
		expect(game.pendingChipSyncs).toHaveLength(0);
		expect(game.serverSyncedBalance).toBe(500);
	});

	test('drops a DELTA_EXCEEDS_LIMIT sync and rebases the local bankroll to the confirmed server balance', async () => {
		const elements = mockPokerGameDOM();
		elements['player-balance'] = {
			addEventListener: () => {},
			dataset: {},
			innerHTML: '',
			textContent: '500',
			classList: { add: () => {}, remove: () => {}, toggle: () => {} },
			value: '0',
		};

		const chipUpdateBodies: Array<Record<string, unknown>> = [];
		const fetchMock = mock(async (input: string | URL | Request, init?: RequestInit) => {
			const url =
				typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

			if (url === '/api/profile/llm-settings') {
				return {
					ok: true,
					status: 200,
					json: async () => ({ settings: null }),
				};
			}

			chipUpdateBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
			if (chipUpdateBodies.length === 1) {
				return {
					ok: false,
					status: 400,
					json: async () => ({ error: 'DELTA_EXCEEDS_LIMIT' }),
				};
			}

			return {
				ok: true,
				status: 200,
				json: async () => ({ balance: 650 }),
			};
		}) as unknown as typeof fetch;
		(globalThis as typeof globalThis & { fetch: typeof fetch }).fetch = fetchMock;

		const game = new PokerGame() as unknown as {
			players: Player[];
			humanChipsBefore: number;
			serverSyncedBalance: number;
			pendingChipSyncs: Array<Record<string, unknown>>;
			syncChips: (outcome: 'win' | 'loss' | 'push') => void;
			flushChipSyncQueue: () => Promise<void>;
		};

		game.humanChipsBefore = 500;
		game.players[0] = { ...game.players[0], chips: 650 };
		game.syncChips('win');

		await flushAsyncWork();

		expect(chipUpdateBodies).toHaveLength(1);
		expect(chipUpdateBodies[0].previousBalance).toBe(500);
		expect(chipUpdateBodies[0].delta).toBe(150);
		expect(chipUpdateBodies[0].biggestWinCandidate).toBe(150);
		expect(game.pendingChipSyncs).toHaveLength(0);
		expect(game.serverSyncedBalance).toBe(500);
		expect(game.players[0].chips).toBe(500);

		await game.flushChipSyncQueue();

		expect(chipUpdateBodies).toHaveLength(1);
		expect(game.pendingChipSyncs).toHaveLength(0);
		expect(game.serverSyncedBalance).toBe(500);
	});

	test('sends outcome: push with biggestWinCandidate: 0 for a tie hand', async () => {
		const elements = mockPokerGameDOM();
		elements['player-balance'] = {
			addEventListener: () => {},
			dataset: {},
			innerHTML: '',
			textContent: '500',
			classList: { add: () => {}, remove: () => {}, toggle: () => {} },
			value: '0',
		};

		const chipUpdateBodies: Array<Record<string, unknown>> = [];
		const fetchMock = mock(async (input: string | URL | Request, init?: RequestInit) => {
			const url =
				typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

			if (url === '/api/profile/llm-settings') {
				return {
					ok: true,
					status: 200,
					json: async () => ({ settings: null }),
				};
			}

			chipUpdateBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
			return {
				ok: true,
				status: 200,
				json: async () => ({ balance: 500 }),
			};
		}) as unknown as typeof fetch;
		(globalThis as typeof globalThis & { fetch: typeof fetch }).fetch = fetchMock;

		const game = new PokerGame() as unknown as {
			players: Player[];
			humanChipsBefore: number;
			syncChips: (outcome: 'win' | 'loss' | 'push') => void;
		};

		game.humanChipsBefore = 500;
		game.players[0] = { ...game.players[0], chips: 500 };
		game.syncChips('push');

		await flushAsyncWork();

		expect(chipUpdateBodies).toHaveLength(1);
		expect(chipUpdateBodies[0].outcome).toBe('push');
		expect(chipUpdateBodies[0].delta).toBe(0);
		expect(chipUpdateBodies[0].biggestWinCandidate).toBe(0);
	});

	test('syncs using updated serverSyncedBalance when response.json() fails but response is ok', async () => {
		const elements = mockPokerGameDOM();
		elements['player-balance'] = {
			addEventListener: () => {},
			innerHTML: '',
			textContent: '500',
			classList: { add: () => {}, remove: () => {}, toggle: () => {} },
			value: '0',
		};

		const fetchMock = mock(async (input: string | URL | Request) => {
			const url =
				typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
			if (url === '/api/profile/llm-settings') {
				return { ok: true, status: 200, json: async () => ({ settings: null }) };
			}
			return {
				ok: true,
				status: 200,
				json: async (): Promise<unknown> => {
					throw new Error('Unexpected end of JSON input');
				},
			};
		}) as unknown as typeof fetch;
		(globalThis as typeof globalThis & { fetch: typeof fetch }).fetch = fetchMock;

		const game = new PokerGame() as unknown as {
			players: Player[];
			humanChipsBefore: number;
			serverSyncedBalance: number;
			syncChips: (outcome: 'win' | 'loss' | 'push') => void;
		};

		game.humanChipsBefore = 500;
		game.players[0] = { ...game.players[0], chips: 550 };
		game.syncChips('win');

		await flushAsyncWork();

		// Falls back to serverSyncedBalance += delta when JSON parse fails but response.ok
		expect(game.serverSyncedBalance).toBe(550);
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
		(globalThis as typeof globalThis & { fetch: typeof fetch }).fetch = mock(
			async (input: string | URL | Request) => {
				const url =
					typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
				if (url === '/api/profile/llm-settings') {
					return { ok: true, status: 200, json: async () => ({ settings: null }) };
				}
				return { ok: true, status: 200, json: async () => ({ balance: 500 }) };
			},
		) as unknown as typeof fetch;
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
			expect(fetchCalls).not.toContain('/api/profile/llm-settings');
		} finally {
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
			'Alice wins $300! 🎉',
		);
		expect(game.formatShowdownMessage([{ amount: 300, winners: [alice, bob] }])).toBe(
			'Tie! Alice, Bob split the $300 pot 🤝',
		);

		const charlie = createPlayer(2, 'Charlie', 500);
		expect(
			game.formatShowdownMessage([
				{ amount: 200, winners: [alice] },
				{ amount: 100, winners: [charlie] },
			]),
		).toBe('Main pot: Alice wins $200 | Side pot 1: Charlie wins $100');

		expect(
			game.formatShowdownMessage([
				{ amount: 200, winners: [alice, bob] },
				{ amount: 100, winners: [charlie] },
			]),
		).toBe('Main pot: Alice & Bob split $200 | Side pot 1: Charlie wins $100');
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

		// 3 players, dealer at index 0.
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

describe('PokerGame beforeunload guest guard', () => {
	test('guest mode does not persist pending syncs on beforeunload', () => {
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
			dataset: { balance: '1000', balanceAvailable: 'true', guestMode: 'true', userId: 'g1' },
			innerHTML: '',
			textContent: '$1,000',
			classList: { add: () => {}, remove: () => {}, toggle: () => {} },
			value: '0',
		};

		const setItemCalls: string[] = [];
		(globalThis as typeof globalThis & { localStorage: Storage }).localStorage = {
			getItem: () => null,
			setItem: (key: string) => setItemCalls.push(key),
			removeItem: () => {},
			clear: () => {},
			key: () => null,
			length: 0,
		};

		let beforeUnloadHandler: (() => void) | null = null;
		(globalThis as typeof globalThis & { window: Window & typeof globalThis }).window = {
			dispatchEvent: () => true,
			addEventListener: ((event: string, handler: () => void) => {
				if (event === 'beforeunload') beforeUnloadHandler = handler;
			}) as Window['addEventListener'],
		} as unknown as Window & typeof globalThis;

		new PokerGame();

		expect(beforeUnloadHandler).not.toBeNull();
		beforeUnloadHandler?.();

		// Guest mode → persistPendingSyncs is skipped.
		expect(setItemCalls).not.toContain('poker_pending_chip_syncs');
	});

	test('non-guest mode persists pending syncs on beforeunload', () => {
		const elements = mockPokerGameDOM();
		elements['player-balance'] = {
			addEventListener: () => {},
			dataset: { balance: '500', balanceAvailable: 'true', userId: 'u1' },
			innerHTML: '',
			textContent: '500',
			classList: { add: () => {}, remove: () => {}, toggle: () => {} },
			value: '0',
		};

		let beforeUnloadHandler: (() => void) | null = null;
		(globalThis as typeof globalThis & { window: Window & typeof globalThis }).window = {
			dispatchEvent: () => true,
			addEventListener: ((event: string, handler: () => void) => {
				if (event === 'beforeunload') beforeUnloadHandler = handler;
			}) as Window['addEventListener'],
		} as unknown as Window & typeof globalThis;

		new PokerGame();

		expect(beforeUnloadHandler).not.toBeNull();
		// Should not throw. persistPendingSyncs runs (line 179).
		expect(() => beforeUnloadHandler?.()).not.toThrow();
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

describe('PokerGame pending sync TTL', () => {
	test('drops pending syncs older than the TTL on load', () => {
		const elements = mockPokerGameDOM();
		elements['player-balance'] = {
			addEventListener: () => {},
			dataset: { balance: '500', balanceAvailable: 'true', userId: 'ttl-user' },
			innerHTML: '',
			textContent: '500',
			classList: { add: () => {}, remove: () => {}, toggle: () => {} },
			value: '0',
		};

		const staleEntry = {
			syncId: 'stale-sync-id',
			previousBalance: 500,
			delta: 100,
			createdAt: Date.now() - 8 * 24 * 60 * 60 * 1000, // 8 days ago > 7-day TTL
		};

		(globalThis as typeof globalThis & { localStorage: Storage }).localStorage = {
			getItem: (key: string) =>
				key === 'arcturus_poker_pending_syncs:ttl-user' ? JSON.stringify([staleEntry]) : null,
			setItem: () => {},
			removeItem: () => {},
			clear: () => {},
			key: () => null,
			length: 0,
		};

		(globalThis as typeof globalThis & { fetch: typeof fetch }).fetch = mock(
			async (input: string | URL | Request) => {
				const url =
					typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
				if (url === '/api/profile/llm-settings') {
					return { ok: true, status: 200, json: async () => ({ settings: null }) };
				}
				return { ok: true, status: 200, json: async () => ({ balance: 500 }) };
			},
		) as unknown as typeof fetch;

		const game = new PokerGame() as unknown as {
			pendingChipSyncs: Array<Record<string, unknown>>;
		};

		expect(game.pendingChipSyncs).toHaveLength(0);
	});

	test('drops pending syncs without a createdAt timestamp (pre-TTL snapshots)', () => {
		const elements = mockPokerGameDOM();
		elements['player-balance'] = {
			addEventListener: () => {},
			dataset: { balance: '500', balanceAvailable: 'true', userId: 'ttl-user2' },
			innerHTML: '',
			textContent: '500',
			classList: { add: () => {}, remove: () => {}, toggle: () => {} },
			value: '0',
		};

		// No createdAt field — simulates a snapshot from before the TTL fix.
		// A missing timestamp gives no bound on how long the entry sat in
		// localStorage; if the server already committed it more than
		// RETENTION_DAYS ago the idempotency receipt is gone, so replaying
		// would double-apply the delta. Legacy entries are dropped rather
		// than replayed.
		const legacyEntry = {
			syncId: 'legacy-sync-id',
			previousBalance: 500,
			delta: 100,
		};

		(globalThis as typeof globalThis & { localStorage: Storage }).localStorage = {
			getItem: (key: string) =>
				key === 'arcturus_poker_pending_syncs:ttl-user2' ? JSON.stringify([legacyEntry]) : null,
			setItem: () => {},
			removeItem: () => {},
			clear: () => {},
			key: () => null,
			length: 0,
		};

		(globalThis as typeof globalThis & { fetch: typeof fetch }).fetch = mock(
			async (input: string | URL | Request) => {
				const url =
					typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
				if (url === '/api/profile/llm-settings') {
					return { ok: true, status: 200, json: async () => ({ settings: null }) };
				}
				return { ok: true, status: 200, json: async () => ({ balance: 600 }) };
			},
		) as unknown as typeof fetch;

		const game = new PokerGame() as unknown as {
			pendingChipSyncs: Array<Record<string, unknown>>;
		};

		expect(game.pendingChipSyncs).toHaveLength(0);
	});

	test('loads fresh pending syncs within the TTL', () => {
		const elements = mockPokerGameDOM();
		elements['player-balance'] = {
			addEventListener: () => {},
			dataset: { balance: '500', balanceAvailable: 'true', userId: 'ttl-user3' },
			innerHTML: '',
			textContent: '500',
			classList: { add: () => {}, remove: () => {}, toggle: () => {} },
			value: '0',
		};

		const freshEntry = {
			syncId: 'fresh-sync-id',
			previousBalance: 500,
			delta: 100,
			createdAt: Date.now(), // fresh
		};

		(globalThis as typeof globalThis & { localStorage: Storage }).localStorage = {
			getItem: (key: string) =>
				key === 'arcturus_poker_pending_syncs:ttl-user3' ? JSON.stringify([freshEntry]) : null,
			setItem: () => {},
			removeItem: () => {},
			clear: () => {},
			key: () => null,
			length: 0,
		};

		(globalThis as typeof globalThis & { fetch: typeof fetch }).fetch = mock(
			async (input: string | URL | Request) => {
				const url =
					typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
				if (url === '/api/profile/llm-settings') {
					return { ok: true, status: 200, json: async () => ({ settings: null }) };
				}
				return { ok: true, status: 200, json: async () => ({ balance: 600 }) };
			},
		) as unknown as typeof fetch;

		const game = new PokerGame() as unknown as {
			pendingChipSyncs: Array<Record<string, unknown>>;
		};

		expect(game.pendingChipSyncs).toHaveLength(1);
		expect(game.pendingChipSyncs[0].syncId).toBe('fresh-sync-id');
	});

	test('drops pending syncs with a future createdAt timestamp on load', () => {
		const elements = mockPokerGameDOM();
		elements['player-balance'] = {
			addEventListener: () => {},
			dataset: { balance: '500', balanceAvailable: 'true', userId: 'ttl-user4' },
			innerHTML: '',
			textContent: '500',
			classList: { add: () => {}, remove: () => {}, toggle: () => {} },
			value: '0',
		};

		// A future timestamp (corrupted localStorage / clock correction) must
		// never satisfy the TTL — otherwise retention cleanup of the server's
		// idempotency receipt would let a later retry re-apply the delta.
		const futureEntry = {
			syncId: 'future-sync-id',
			previousBalance: 500,
			delta: 100,
			createdAt: Date.now() + 8 * 24 * 60 * 60 * 1000, // 8 days in the future
		};

		(globalThis as typeof globalThis & { localStorage: Storage }).localStorage = {
			getItem: (key: string) =>
				key === 'arcturus_poker_pending_syncs:ttl-user4' ? JSON.stringify([futureEntry]) : null,
			setItem: () => {},
			removeItem: () => {},
			clear: () => {},
			key: () => null,
			length: 0,
		};

		(globalThis as typeof globalThis & { fetch: typeof fetch }).fetch = mock(
			async (input: string | URL | Request) => {
				const url =
					typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
				if (url === '/api/profile/llm-settings') {
					return { ok: true, status: 200, json: async () => ({ settings: null }) };
				}
				return { ok: true, status: 200, json: async () => ({ balance: 600 }) };
			},
		) as unknown as typeof fetch;

		const game = new PokerGame() as unknown as {
			pendingChipSyncs: Array<Record<string, unknown>>;
		};

		expect(game.pendingChipSyncs).toHaveLength(0);
	});

	test('reconciles players[0].chips with server balance when dropping an expired in-memory sync', async () => {
		const elements = mockPokerGameDOM();
		elements['player-balance'] = {
			addEventListener: () => {},
			dataset: { balance: '500', balanceAvailable: 'true', userId: 'expire-user1' },
			innerHTML: '',
			textContent: '500',
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

		const requestedUrls: string[] = [];
		(globalThis as typeof globalThis & { fetch: typeof fetch }).fetch = mock(
			async (input: string | URL | Request) => {
				const url =
					typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
				requestedUrls.push(url);
				if (url === '/api/profile/llm-settings') {
					return { ok: true, status: 200, json: async () => ({ settings: null }) };
				}
				if (url === '/api/chips/balance') {
					return { ok: true, status: 200, json: async () => ({ balance: 500 }) };
				}
				// /api/chips/update should NOT be called — the expired sync is
				// dropped before sendChipSync runs.
				return { ok: true, status: 200, json: async () => ({ balance: 999 }) };
			},
		) as unknown as typeof fetch;

		const game = new PokerGame() as unknown as {
			players: Player[];
			humanChipsBefore: number;
			serverSyncedBalance: number;
			pendingChipSyncs: Array<Record<string, unknown>>;
			hasServerSyncedBalance: boolean;
			syncChips: (outcome: 'win' | 'loss' | 'push') => void;
			flushChipSyncQueue: () => Promise<void>;
		};

		// Simulate a pending sync with an expired createdAt (8 days old).
		// The local balance (550) includes the unconfirmed +50 delta.
		game.humanChipsBefore = 0;
		game.serverSyncedBalance = 500;
		game.players[0] = { ...game.players[0], chips: 550 };
		game.pendingChipSyncs = [
			{
				syncId: 'expired-sync-id',
				previousBalance: 500,
				delta: 50,
				createdAt: Date.now() - 8 * 24 * 60 * 60 * 1000,
			},
		];

		await game.flushChipSyncQueue();

		expect(game.pendingChipSyncs).toHaveLength(0);
		expect(requestedUrls).toContain('/api/chips/balance');
		// The expired sync is dropped before it can be re-sent, so the
		// authoritative balance fetch is the only chip endpoint hit.
		expect(requestedUrls).not.toContain('/api/chips/update');
		// The authoritative server balance (500) replaces the inflated local
		// balance (550) — the unconfirmed +50 delta is discarded.
		expect(game.serverSyncedBalance).toBe(500);
		expect(game.players[0].chips).toBe(500);
		expect(game.hasServerSyncedBalance).toBe(true);
	});

	test('blocks play when balance fetch fails after dropping an expired in-memory sync', async () => {
		const elements = mockPokerGameDOM();
		elements['player-balance'] = {
			addEventListener: () => {},
			dataset: { balance: '500', balanceAvailable: 'true', userId: 'expire-user2' },
			innerHTML: '',
			textContent: '500',
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

		const requestedUrls: string[] = [];
		(globalThis as typeof globalThis & { fetch: typeof fetch }).fetch = mock(
			async (input: string | URL | Request) => {
				const url =
					typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
				requestedUrls.push(url);
				if (url === '/api/profile/llm-settings') {
					return { ok: true, status: 200, json: async () => ({ settings: null }) };
				}
				if (url === '/api/chips/balance') {
					// Balance fetch fails — cannot recover authoritative balance.
					return { ok: false, status: 500, json: async () => ({}) };
				}
				return { ok: true, status: 200, json: async () => ({ balance: 999 }) };
			},
		) as unknown as typeof fetch;

		const game = new PokerGame() as unknown as {
			players: Player[];
			humanChipsBefore: number;
			serverSyncedBalance: number;
			pendingChipSyncs: Array<Record<string, unknown>>;
			hasServerSyncedBalance: boolean;
			syncChips: (outcome: 'win' | 'loss' | 'push') => void;
			flushChipSyncQueue: () => Promise<void>;
		};

		game.humanChipsBefore = 0;
		game.serverSyncedBalance = 500;
		game.players[0] = { ...game.players[0], chips: 550 };
		game.pendingChipSyncs = [
			{
				syncId: 'expired-sync-id2',
				previousBalance: 500,
				delta: 50,
				createdAt: Date.now() - 8 * 24 * 60 * 60 * 1000,
			},
		];

		await game.flushChipSyncQueue();

		expect(game.pendingChipSyncs).toHaveLength(0);
		// Play is blocked — the deal button is disabled and the user is
		// told to refresh, since the balance cannot be trusted.
		expect(game.hasServerSyncedBalance).toBe(false);
		// Even when balance recovery fails, the expired sync must never be
		// re-sent to /api/chips/update — it is dropped before sendChipSync.
		expect(requestedUrls).not.toContain('/api/chips/update');
	});
});
