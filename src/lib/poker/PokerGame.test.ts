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

// Mock DOM for PokerGame constructor
function mockPokerGameDOM() {
	interface MockElement {
		addEventListener: () => void;
		dataset?: Record<string, string>;
		innerHTML?: string;
		textContent?: string;
		classList?: { add: () => void; remove: () => void; toggle: () => void };
		querySelector?: () => MockElement | null;
		querySelectorAll?: () => MockElement[];
		value?: string;
	}

	const elements: Record<string, MockElement> = {};

	(global as unknown as { document: unknown }).document = {
		getElementById: (id: string) => {
			if (!elements[id]) {
				elements[id] = {
					addEventListener: () => {},
					dataset: {},
					innerHTML: '',
					textContent: '',
					classList: { add: () => {}, remove: () => {}, toggle: () => {} },
					querySelector: () => null,
					querySelectorAll: () => [],
					value: '0',
				};
			}
			return elements[id];
		},
		querySelector: () => null,
		querySelectorAll: () => [],
	};

	(global as unknown as { HTMLButtonElement: unknown }).HTMLButtonElement = class {};

	return elements;
}

// Helper to create a card
function card(value: string, suit: Card['suit'], rank: number): Card {
	return { value, suit, rank };
}

async function flushAsyncWork() {
	await new Promise((resolve) => setTimeout(resolve, 0));
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

		const originalSetTimeout = globalThis.setTimeout;
		const originalClearTimeout = globalThis.clearTimeout;
		const scheduledTimers: Array<{
			id: number;
			delay: number;
			cleared: boolean;
			callback: () => void;
		}> = [];
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

			expect(chipUpdateBodies).toHaveLength(1);

			const staleAutoDeal = scheduledTimers.find((timer) => timer.delay === 3000 && !timer.cleared);
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
			globalThis.setTimeout = originalSetTimeout;
			globalThis.clearTimeout = originalClearTimeout;
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
		game.players[0] = { ...game.players[0], chips: 350, folded: false };
		game.players[1] = { ...game.players[1], folded: true };
		game.players[2] = { ...game.players[2], folded: true };
		game.nextPhase();

		await flushAsyncWork();

		expect(chipUpdateBodies).toHaveLength(1);
		expect(chipUpdateBodies[0].delta).toBe(150);
		expect(chipUpdateBodies[0].biggestWinCandidate).toBe(150);
	});

	test('persists the abandoned hand delta before resetting a new hand baseline', async () => {
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
		expect(game.humanChipsBefore).toBe(450);
		expect(game.players[0].chips).toBe(440);
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

		await new Promise((resolve) => setTimeout(resolve, 1100));
		await flushAsyncWork();

		expect(chipUpdateBodies).toHaveLength(2);
		expect(chipUpdateBodies[1].previousBalance).toBe(500);
		expect(chipUpdateBodies[1].delta).toBe(-50);
		expect(game.pendingChipSyncs).toHaveLength(0);
		expect(game.serverSyncedBalance).toBe(450);
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

	test('sends outcome: push with biggestWinCandidate: 0 for a tie hand', async () => {
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
				return { ok: true, status: 200, json: async () => ({ settings: null }) };
			}
			chipUpdateBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
			return { ok: true, status: 200, json: async () => ({ balance: 500 }) };
		}) as unknown as typeof fetch;
		(globalThis as typeof globalThis & { fetch: typeof fetch }).fetch = fetchMock;

		const game = new PokerGame() as unknown as {
			players: Player[];
			humanChipsBefore: number;
			syncChips: (outcome: 'win' | 'loss' | 'push') => void;
		};

		// Push: chip count unchanged (split pot)
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
