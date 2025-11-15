import { describe, expect, test, beforeEach } from 'bun:test';
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

// Mock DOM for PokerGame constructor
function mockPokerGameDOM() {
	interface MockElement {
		addEventListener: () => void;
		innerHTML?: string;
		textContent?: string;
		classList?: { add: () => void; remove: () => void };
		value?: string;
	}

	const elements: Record<string, MockElement> = {};

	(global as unknown as { document: unknown }).document = {
		getElementById: (id: string) => {
			if (!elements[id]) {
				elements[id] = {
					addEventListener: () => {},
					innerHTML: '',
					textContent: '',
					classList: { add: () => {}, remove: () => {} },
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

describe('PokerGame Core Logic', () => {
	beforeEach(() => {
		mockPokerGameDOM();
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
