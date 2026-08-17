import { describe, expect, test } from 'bun:test';
import { PaiGowPokerGame, WAGER_OPTIONS } from './game';

describe('PaiGowPokerGame', () => {
	test('starts in betting with a five-chip wager', () => {
		const game = new PaiGowPokerGame(1_000, () => 0);

		expect(game.getState()).toEqual({
			phase: 'betting',
			balance: 1_000,
			wager: 5,
			playerCards: [],
			dealerCards: [],
			lowIndexes: [],
			result: null,
		});
		expect(WAGER_OPTIONS).toEqual([5, 10, 20, 50, 100]);
	});

	test('validates whole-number wagers, limits, and affordability without a divisibility rule', () => {
		const game = new PaiGowPokerGame(10, () => 0);

		expect(game.getWagerError(5.5)).toBe('Wager must be a whole number of chips');
		expect(game.getWagerError(4)).toBe('Bet must be between 5 and 100 chips');
		expect(game.getWagerError(101)).toBe('Bet must be between 5 and 100 chips');
		expect(game.getWagerError(11)).toBe('Wager exceeds available balance');
		expect(game.getWagerError(7)).toBeNull();

		game.setWager(7);
		expect(game.getState().wager).toBe(7);
		expect(() => game.setWager(4)).toThrow('Bet must be between 5 and 100 chips');
	});

	test('deals, auto-arranges, resolves the zero-RNG push, and resets the round', () => {
		const game = new PaiGowPokerGame(1_000, () => 0);
		game.setWager(20);
		game.deal();

		expect(game.getState()).toMatchObject({ phase: 'arranging', balance: 980, wager: 20 });
		expect(game.getState().playerCards).toEqual([
			{ rank: 3, suit: 'hearts' },
			{ rank: 4, suit: 'hearts' },
			{ rank: 5, suit: 'hearts' },
			{ rank: 6, suit: 'hearts' },
			{ rank: 7, suit: 'hearts' },
			{ rank: 8, suit: 'hearts' },
			{ rank: 9, suit: 'hearts' },
		]);
		expect(game.getState().dealerCards).toEqual([
			{ rank: 10, suit: 'hearts' },
			{ rank: 11, suit: 'hearts' },
			{ rank: 12, suit: 'hearts' },
			{ rank: 13, suit: 'hearts' },
			{ rank: 14, suit: 'hearts' },
			{ rank: 2, suit: 'diamonds' },
			{ rank: 3, suit: 'diamonds' },
		]);

		game.autoArrange();
		expect(game.getState().lowIndexes).toEqual([0, 1]);
		const result = game.confirm();

		expect(result).toMatchObject({
			outcome: 'push',
			wager: 20,
			commission: 0,
			grossPayout: 20,
			netDelta: 0,
		});
		expect(game.getState()).toMatchObject({ phase: 'complete', balance: 1_000, wager: 20 });

		game.resetRound();
		expect(game.getState()).toEqual({
			phase: 'betting',
			balance: 1_000,
			wager: 20,
			playerCards: [],
			dealerCards: [],
			lowIndexes: [],
			result: null,
		});
	});

	test('toggles at most two sorted Low indexes while arranging', () => {
		const game = new PaiGowPokerGame(1_000, () => 0);
		game.deal();

		game.toggleLowCard(3);
		game.toggleLowCard(1);
		expect(game.getState().lowIndexes).toEqual([1, 3]);

		game.toggleLowCard(5);
		expect(game.getState().lowIndexes).toEqual([1, 3]);

		game.toggleLowCard(1);
		expect(game.getState().lowIndexes).toEqual([3]);
		game.toggleLowCard(3);
		expect(game.getState().lowIndexes).toEqual([]);
	});

	test('rejects invalid phase operations and Low indexes', () => {
		const game = new PaiGowPokerGame(1_000, () => 0);

		expect(() => game.toggleLowCard(0)).toThrow();
		expect(() => game.autoArrange()).toThrow();
		expect(() => game.resetArrangement()).toThrow();
		expect(() => game.confirm()).toThrow('Confirm is only allowed while arranging');
		expect(() => game.resetRound()).toThrow();

		game.deal();
		expect(() => game.toggleLowCard(1.5)).toThrow();
		expect(() => game.toggleLowCard(-1)).toThrow();
		expect(() => game.toggleLowCard(7)).toThrow();
		expect(() => game.setWager(10)).toThrow();
	});

	test('clears an arrangement without changing the dealt hand', () => {
		const game = new PaiGowPokerGame(1_000, () => 0);
		game.deal();
		game.autoArrange();
		const dealt = game.getState();

		game.resetArrangement();
		const reset = game.getState();
		expect(reset.playerCards).toEqual(dealt.playerCards);
		expect(reset.dealerCards).toEqual(dealt.dealerCards);
		expect(reset.lowIndexes).toEqual([]);
		expect(reset.balance).toBe(dealt.balance);
	});

	test('keeps snapshots and confirmed results deeply immutable from callers', () => {
		const game = new PaiGowPokerGame(1_000, () => 0);
		game.setWager(20);
		game.deal();
		game.autoArrange();

		const expectedArranging = game.getState();
		const arrangingSnapshot = game.getState();
		arrangingSnapshot.playerCards[0] = { rank: 14, suit: 'spades' };
		arrangingSnapshot.lowIndexes.splice(0, 1);
		expect(game.getState()).toEqual(expectedArranging);

		const returnedResult = game.confirm();
		const expectedComplete = game.getState();
		returnedResult.player.high[0] = { rank: 'joker', suit: 'joker' };
		returnedResult.player.highRanking.tieBreakers[0] = 999;
		expect(game.getState()).toEqual(expectedComplete);

		const resultSnapshot = game.getState();
		resultSnapshot.result!.player.high[0] = { rank: 'joker', suit: 'joker' };
		resultSnapshot.result!.player.highRanking.tieBreakers[0] = 999;
		expect(game.getState()).toEqual(expectedComplete);
	});

	test('adopts an authoritative balance as-is', () => {
		const game = new PaiGowPokerGame(100, () => 0);
		game.setBalance(321.5);
		expect(game.getState().balance).toBe(321.5);
	});
});
