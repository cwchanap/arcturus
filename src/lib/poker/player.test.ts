import { describe, expect, test } from 'bun:test';
import type { Card } from './types';
import {
	createPlayer,
	createAIPlayer,
	canPlayerAct,
	placeBet,
	postBlind,
	foldPlayer,
	resetPlayerForNewHand,
	resetCurrentBets,
	dealCardsToPlayer,
	awardChips,
	getActivePlayers,
	getPlayersWhoCanAct,
	getNextPlayerIndex,
	isBettingRoundComplete,
	getHighestBet,
	getCallAmount,
} from './player';

// Helper to create a card
function card(value: string, suit: Card['suit'], rank: number): Card {
	return { value, suit, rank };
}

describe('createPlayer()', () => {
	test('creates player with default chips', () => {
		const player = createPlayer(1, 'Alice');
		expect(player.id).toBe(1);
		expect(player.name).toBe('Alice');
		expect(player.chips).toBe(1000); // STARTING_CHIPS default
		expect(player.isAI).toBe(false);
		expect(player.folded).toBe(false);
		expect(player.isAllIn).toBe(false);
		expect(player.hand).toEqual([]);
	});

	test('creates player with custom chips', () => {
		const player = createPlayer(2, 'Bob', 1000);
		expect(player.chips).toBe(1000);
	});

	test('creates AI player correctly', () => {
		const player = createAIPlayer(3, 'AI Bot', 750);
		expect(player.isAI).toBe(true);
		expect(player.chips).toBe(750);
	});
});

describe('canPlayerAct()', () => {
	test('returns true for active player', () => {
		const player = createPlayer(1, 'Alice', 500);
		expect(canPlayerAct(player)).toBe(true);
	});

	test('returns false for folded player', () => {
		const player = { ...createPlayer(1, 'Alice'), folded: true };
		expect(canPlayerAct(player)).toBe(false);
	});

	test('returns false for all-in player', () => {
		const player = { ...createPlayer(1, 'Alice'), isAllIn: true };
		expect(canPlayerAct(player)).toBe(false);
	});

	test('returns false for folded and all-in player', () => {
		const player = { ...createPlayer(1, 'Alice'), folded: true, isAllIn: true };
		expect(canPlayerAct(player)).toBe(false);
	});
});

describe('placeBet()', () => {
	test('deducts chips and updates bets', () => {
		const player = createPlayer(1, 'Alice', 500);
		const result = placeBet(player, 100);

		expect(result.chips).toBe(400);
		expect(result.currentBet).toBe(100);
		expect(result.totalBet).toBe(100);
		expect(result.hasActed).toBe(true);
		expect(result.isAllIn).toBe(false);
	});

	test('handles all-in when bet equals chips', () => {
		const player = createPlayer(1, 'Alice', 100);
		const result = placeBet(player, 100);

		expect(result.chips).toBe(0);
		expect(result.currentBet).toBe(100);
		expect(result.isAllIn).toBe(true);
	});

	test('caps bet at available chips', () => {
		const player = createPlayer(1, 'Alice', 50);
		const result = placeBet(player, 100);

		expect(result.chips).toBe(0);
		expect(result.currentBet).toBe(50);
		expect(result.isAllIn).toBe(true);
	});

	test('accumulates multiple bets correctly', () => {
		let player = createPlayer(1, 'Alice', 500);
		player = placeBet(player, 50);
		player = placeBet(player, 50);

		expect(player.chips).toBe(400);
		expect(player.currentBet).toBe(100);
		expect(player.totalBet).toBe(100);
	});
});

describe('postBlind()', () => {
	test('posts blind without setting hasActed', () => {
		const player = createPlayer(1, 'Alice', 500);
		const result = postBlind(player, 10);

		expect(result.chips).toBe(490);
		expect(result.currentBet).toBe(10);
		expect(result.totalBet).toBe(10);
		expect(result.hasActed).toBe(false); // Key difference from placeBet
	});

	test('handles all-in blind', () => {
		const player = createPlayer(1, 'Alice', 5);
		const result = postBlind(player, 10);

		expect(result.chips).toBe(0);
		expect(result.currentBet).toBe(5);
		expect(result.isAllIn).toBe(true);
	});
});

describe('foldPlayer()', () => {
	test('sets folded flag and hasActed', () => {
		const player = createPlayer(1, 'Alice', 500);
		const result = foldPlayer(player);

		expect(result.folded).toBe(true);
		expect(result.hasActed).toBe(true);
	});

	test('preserves other player state', () => {
		const player = { ...createPlayer(1, 'Alice', 500), currentBet: 50, totalBet: 50 };
		const result = foldPlayer(player);

		expect(result.chips).toBe(500);
		expect(result.currentBet).toBe(50);
		expect(result.totalBet).toBe(50);
	});
});

describe('resetPlayerForNewHand()', () => {
	test('resets all hand state but preserves chips', () => {
		const player = {
			...createPlayer(1, 'Alice', 300),
			hand: [card('A', 'hearts', 14), card('K', 'hearts', 13)],
			currentBet: 50,
			totalBet: 50,
			folded: true,
			isAllIn: true,
			hasActed: true,
		};

		const result = resetPlayerForNewHand(player);

		expect(result.chips).toBe(300); // Preserved
		expect(result.hand).toEqual([]);
		expect(result.currentBet).toBe(0);
		expect(result.totalBet).toBe(0);
		expect(result.folded).toBe(false);
		expect(result.isAllIn).toBe(false);
		expect(result.hasActed).toBe(false);
	});
});

describe('resetCurrentBets()', () => {
	test('resets current bet but preserves total bet', () => {
		const player = { ...createPlayer(1, 'Alice', 500), currentBet: 50, totalBet: 150 };
		const result = resetCurrentBets(player);

		expect(result.currentBet).toBe(0);
		expect(result.totalBet).toBe(150); // Preserved
		expect(result.hasActed).toBe(false);
	});
});

describe('dealCardsToPlayer()', () => {
	test('adds cards to empty hand', () => {
		const player = createPlayer(1, 'Alice', 500);
		const cards = [card('A', 'hearts', 14), card('K', 'spades', 13)];
		const result = dealCardsToPlayer(player, cards);

		expect(result.hand).toEqual(cards);
	});

	test('adds cards to existing hand', () => {
		const player = {
			...createPlayer(1, 'Alice', 500),
			hand: [card('Q', 'hearts', 12)],
		};
		const newCards = [card('J', 'clubs', 11)];
		const result = dealCardsToPlayer(player, newCards);

		expect(result.hand).toHaveLength(2);
		expect(result.hand[0].value).toBe('Q');
		expect(result.hand[1].value).toBe('J');
	});
});

describe('awardChips()', () => {
	test('adds chips to player', () => {
		const player = createPlayer(1, 'Alice', 500);
		const result = awardChips(player, 100);

		expect(result.chips).toBe(600);
	});

	test('handles large amounts', () => {
		const player = createPlayer(1, 'Alice', 100);
		const result = awardChips(player, 1000);

		expect(result.chips).toBe(1100);
	});
});

describe('getActivePlayers()', () => {
	test('returns only non-folded players', () => {
		const players = [
			createPlayer(1, 'Alice', 500),
			{ ...createPlayer(2, 'Bob', 500), folded: true },
			createPlayer(3, 'Charlie', 500),
			{ ...createPlayer(4, 'Dave', 500), folded: true },
		];

		const active = getActivePlayers(players);

		expect(active).toHaveLength(2);
		expect(active[0].name).toBe('Alice');
		expect(active[1].name).toBe('Charlie');
	});

	test('returns all players when none folded', () => {
		const players = [createPlayer(1, 'Alice', 500), createPlayer(2, 'Bob', 500)];
		const active = getActivePlayers(players);

		expect(active).toHaveLength(2);
	});

	test('returns empty array when all folded', () => {
		const players = [
			{ ...createPlayer(1, 'Alice', 500), folded: true },
			{ ...createPlayer(2, 'Bob', 500), folded: true },
		];
		const active = getActivePlayers(players);

		expect(active).toHaveLength(0);
	});
});

describe('getPlayersWhoCanAct()', () => {
	test('excludes folded and all-in players', () => {
		const players = [
			createPlayer(1, 'Alice', 500),
			{ ...createPlayer(2, 'Bob', 500), folded: true },
			{ ...createPlayer(3, 'Charlie', 0), isAllIn: true },
			createPlayer(4, 'Dave', 500),
		];

		const canAct = getPlayersWhoCanAct(players);

		expect(canAct).toHaveLength(2);
		expect(canAct[0].name).toBe('Alice');
		expect(canAct[1].name).toBe('Dave');
	});
});

describe('getNextPlayerIndex()', () => {
	test('finds next player who can act', () => {
		const players = [
			createPlayer(0, 'Alice', 500),
			{ ...createPlayer(1, 'Bob', 500), folded: true },
			createPlayer(2, 'Charlie', 500),
		];

		const nextIndex = getNextPlayerIndex(players, 0);
		expect(nextIndex).toBe(2); // Skips folded Bob
	});

	test('wraps around to beginning of array', () => {
		const players = [
			createPlayer(0, 'Alice', 500),
			{ ...createPlayer(1, 'Bob', 500), folded: true },
			{ ...createPlayer(2, 'Charlie', 500), folded: true },
		];

		const nextIndex = getNextPlayerIndex(players, 2);
		expect(nextIndex).toBe(0); // Wraps to Alice
	});

	test('returns current index when no one can act', () => {
		const players = [
			{ ...createPlayer(0, 'Alice', 500), folded: true },
			{ ...createPlayer(1, 'Bob', 500), folded: true },
		];

		const nextIndex = getNextPlayerIndex(players, 0);
		expect(nextIndex).toBe(0);
	});

	test('handles consecutive acting players', () => {
		const players = [
			createPlayer(0, 'Alice', 500),
			createPlayer(1, 'Bob', 500),
			createPlayer(2, 'Charlie', 500),
		];

		expect(getNextPlayerIndex(players, 0)).toBe(1);
		expect(getNextPlayerIndex(players, 1)).toBe(2);
		expect(getNextPlayerIndex(players, 2)).toBe(0);
	});
});

describe('isBettingRoundComplete()', () => {
	test('returns true when no active players', () => {
		const players = [
			{ ...createPlayer(0, 'Alice', 500), folded: true },
			{ ...createPlayer(1, 'Bob', 500), folded: true },
		];

		expect(isBettingRoundComplete(players)).toBe(true);
	});

	test('returns true when no one can act', () => {
		const players = [
			{ ...createPlayer(0, 'Alice', 0), isAllIn: true, currentBet: 100 },
			{ ...createPlayer(1, 'Bob', 0), isAllIn: true, currentBet: 100 },
		];

		expect(isBettingRoundComplete(players)).toBe(true);
	});

	test('returns false when player hasnt acted', () => {
		const players = [
			{ ...createPlayer(0, 'Alice', 500), hasActed: true, currentBet: 50 },
			{ ...createPlayer(1, 'Bob', 500), hasActed: false, currentBet: 50 },
		];

		expect(isBettingRoundComplete(players)).toBe(false);
	});

	test('returns false when bets not matched', () => {
		const players = [
			{ ...createPlayer(0, 'Alice', 500), hasActed: true, currentBet: 50 },
			{ ...createPlayer(1, 'Bob', 500), hasActed: true, currentBet: 100 },
		];

		expect(isBettingRoundComplete(players)).toBe(false);
	});

	test('returns true when all acted and matched bets', () => {
		const players = [
			{ ...createPlayer(0, 'Alice', 500), hasActed: true, currentBet: 100 },
			{ ...createPlayer(1, 'Bob', 500), hasActed: true, currentBet: 100 },
			{ ...createPlayer(2, 'Charlie', 500), hasActed: true, currentBet: 100 },
		];

		expect(isBettingRoundComplete(players)).toBe(true);
	});

	test('ignores folded players when checking completion', () => {
		const players = [
			{ ...createPlayer(0, 'Alice', 500), hasActed: true, currentBet: 100 },
			{ ...createPlayer(1, 'Bob', 500), folded: true, currentBet: 0 },
			{ ...createPlayer(2, 'Charlie', 500), hasActed: true, currentBet: 100 },
		];

		expect(isBettingRoundComplete(players)).toBe(true);
	});

	test('handles all-in players correctly', () => {
		const players = [
			{ ...createPlayer(0, 'Alice', 500), hasActed: true, currentBet: 100 },
			{ ...createPlayer(1, 'Bob', 0), isAllIn: true, hasActed: true, currentBet: 50 },
			{ ...createPlayer(2, 'Charlie', 500), hasActed: true, currentBet: 100 },
		];

		expect(isBettingRoundComplete(players)).toBe(true);
	});
});

describe('getHighestBet()', () => {
	test('returns highest current bet', () => {
		const players = [
			{ ...createPlayer(0, 'Alice', 500), currentBet: 50 },
			{ ...createPlayer(1, 'Bob', 500), currentBet: 100 },
			{ ...createPlayer(2, 'Charlie', 500), currentBet: 75 },
		];

		expect(getHighestBet(players)).toBe(100);
	});

	test('returns 0 when no bets placed', () => {
		const players = [createPlayer(0, 'Alice', 500), createPlayer(1, 'Bob', 500)];

		expect(getHighestBet(players)).toBe(0);
	});

	test('handles single player', () => {
		const players = [{ ...createPlayer(0, 'Alice', 500), currentBet: 25 }];

		expect(getHighestBet(players)).toBe(25);
	});
});

describe('getCallAmount()', () => {
	test('calculates correct call amount', () => {
		const player = { ...createPlayer(0, 'Alice', 500), currentBet: 30 };
		const highestBet = 100;

		expect(getCallAmount(player, highestBet)).toBe(70);
	});

	test('returns 0 when player matches highest bet', () => {
		const player = { ...createPlayer(0, 'Alice', 500), currentBet: 100 };
		const highestBet = 100;

		expect(getCallAmount(player, highestBet)).toBe(0);
	});

	test('returns 0 when player exceeds highest bet', () => {
		const player = { ...createPlayer(0, 'Alice', 500), currentBet: 150 };
		const highestBet = 100;

		expect(getCallAmount(player, highestBet)).toBe(0);
	});

	test('returns full amount when player hasnt bet', () => {
		const player = createPlayer(0, 'Alice', 500);
		const highestBet = 50;

		expect(getCallAmount(player, highestBet)).toBe(50);
	});
});

describe('Player integration scenarios', () => {
	test('complete betting sequence', () => {
		let player1 = createPlayer(1, 'Alice', 500);
		let player2 = createPlayer(2, 'Bob', 500);
		let player3 = createPlayer(3, 'Charlie', 500);

		// Pre-flop betting
		player1 = placeBet(player1, 10); // Small blind
		player2 = placeBet(player2, 20); // Big blind
		player3 = placeBet(player3, 20); // Call

		expect(player1.chips).toBe(490);
		expect(player2.chips).toBe(480);
		expect(player3.chips).toBe(480);

		// Player 1 calls
		const callAmount = getCallAmount(player1, getHighestBet([player1, player2, player3]));
		player1 = placeBet(player1, callAmount);

		expect(player1.currentBet).toBe(20);
		expect(player1.chips).toBe(480);
	});

	test('all-in scenario with side pots', () => {
		let shortStack = createPlayer(1, 'Short', 50);
		let midStack = createPlayer(2, 'Mid', 200);
		let bigStack = createPlayer(3, 'Big', 500);

		// Short stack goes all-in
		shortStack = placeBet(shortStack, 50);
		expect(shortStack.isAllIn).toBe(true);

		// Others call
		midStack = placeBet(midStack, 50);
		bigStack = placeBet(bigStack, 50);

		expect(getHighestBet([shortStack, midStack, bigStack])).toBe(50);
		expect(isBettingRoundComplete([shortStack, midStack, bigStack])).toBe(true);
	});

	test('progressive raising', () => {
		let player1 = createPlayer(1, 'Alice', 500);
		let player2 = createPlayer(2, 'Bob', 500);

		// Initial bet
		player1 = placeBet(player1, 50);

		// Bob raises
		player2 = placeBet(player2, 100);

		// Alice re-raises
		const toCall = getCallAmount(player1, getHighestBet([player1, player2]));
		player1 = placeBet(player1, toCall + 50); // Call + raise

		expect(player1.currentBet).toBe(150);
		expect(player2.currentBet).toBe(100);
	});
});
