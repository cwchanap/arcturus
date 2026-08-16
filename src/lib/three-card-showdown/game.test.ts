import { describe, expect, test } from 'bun:test';
import type { Card, Rank, Suit } from '../cards';
import { ANTE_OPTIONS, MAX_ANTE, MIN_ANTE, ThreeCardShowdownGame } from './game';

const c = (rank: Rank, suit: Suit): Card => ({ rank, suit });

describe('constants', () => {
	test('ante bounds and options are pinned', () => {
		expect(MIN_ANTE).toBe(1);
		expect(MAX_ANTE).toBe(100);
		expect(ANTE_OPTIONS).toEqual([1, 5, 10, 25, 50, 100]);
	});
});

describe('initial state', () => {
	test('defaults to betting, Ante 1, empty hands, no result', () => {
		const game = new ThreeCardShowdownGame(100);
		expect(game.getState()).toEqual({
			phase: 'betting',
			balance: 100,
			ante: 1,
			playerHand: [],
			dealerHand: [],
			result: null,
		});
	});

	test('initial balance is normalized via truncation', () => {
		const game = new ThreeCardShowdownGame(100.7);
		expect(game.getState().balance).toBe(100);
	});

	test('non-finite or negative balances are rejected', () => {
		for (const bad of [-1, NaN, Infinity, -Infinity]) {
			expect(() => new ThreeCardShowdownGame(bad)).toThrow(
				'Balance must be a non-negative finite number',
			);
		}
	});
});

describe('getAnteError', () => {
	test('rejects non-integer antes first', () => {
		const game = new ThreeCardShowdownGame(100);
		expect(game.getAnteError(2.5)).toBe('Ante must be a whole number of chips');
		expect(game.getAnteError(150.5)).toBe('Ante must be a whole number of chips');
	});

	test('rejects antes outside the 1-100 range', () => {
		const game = new ThreeCardShowdownGame(100);
		expect(game.getAnteError(0)).toBe('Bet must be between 1 and 100 chips');
		expect(game.getAnteError(101)).toBe('Bet must be between 1 and 100 chips');
	});

	test('requires ante plus Play wager to fit the balance', () => {
		const short = new ThreeCardShowdownGame(15);
		expect(short.getAnteError(10)).toBe('Ante plus Play wager exceeds available balance');
		expect(short.getAnteError(7)).toBeNull();
	});

	test('accepts a valid ante', () => {
		const game = new ThreeCardShowdownGame(100);
		expect(game.getAnteError(10)).toBeNull();
	});
});

describe('setAnte', () => {
	test('sets the ante during betting', () => {
		const game = new ThreeCardShowdownGame(100);
		game.setAnte(10);
		expect(game.getState().ante).toBe(10);
	});

	test('throws the exact validation message for invalid antes', () => {
		const game = new ThreeCardShowdownGame(100);
		expect(() => game.setAnte(2.5)).toThrow('Ante must be a whole number of chips');
		expect(() => game.setAnte(101)).toThrow('Bet must be between 1 and 100 chips');
		const short = new ThreeCardShowdownGame(15);
		expect(() => short.setAnte(10)).toThrow('Ante plus Play wager exceeds available balance');
		expect(short.getState().ante).toBe(1);
	});

	test('is rejected after dealing', () => {
		const game = new ThreeCardShowdownGame(100, () => 0);
		game.setAnte(10);
		game.deal();
		expect(() => game.setAnte(5)).toThrow();
	});
});

describe('deal', () => {
	test('deals deterministically with constant-zero random and deducts one ante', () => {
		const game = new ThreeCardShowdownGame(100, () => 0);
		game.setAnte(10);
		game.deal();

		const state = game.getState();
		expect(state.phase).toBe('decision');
		expect(state.balance).toBe(90);
		expect(state.playerHand).toEqual([c(3, 'hearts'), c(4, 'hearts'), c(5, 'hearts')]);
		expect(state.dealerHand).toEqual([c(6, 'hearts'), c(7, 'hearts'), c(8, 'hearts')]);
		expect(state.result).toBeNull();
	});

	test('deals six unique cards', () => {
		const game = new ThreeCardShowdownGame(100, () => 0);
		game.deal();
		const state = game.getState();
		const seen = new Set(
			[...state.playerHand, ...state.dealerHand].map((card) => card.rank + card.suit),
		);
		expect(seen.size).toBe(6);
	});

	test('is rejected while the selected ante is unaffordable', () => {
		const game = new ThreeCardShowdownGame(1);
		expect(() => game.deal()).toThrow('Ante plus Play wager exceeds available balance');
	});

	test('is rejected outside betting', () => {
		const game = new ThreeCardShowdownGame(100, () => 0);
		game.deal();
		expect(() => game.deal()).toThrow();
		const completed = new ThreeCardShowdownGame(100, () => 0);
		completed.deal();
		completed.fold();
		expect(() => completed.deal()).toThrow();
	});
});

describe('fold', () => {
	test('loses exactly one ante and reports the fold accounting', () => {
		const foldGame = new ThreeCardShowdownGame(100, () => 0);
		foldGame.setAnte(10);
		foldGame.deal();
		const folded = foldGame.fold();
		expect(folded).toMatchObject({
			outcome: 'fold',
			totalWager: 10,
			grossPayout: 0,
			netDelta: -10,
		});
		expect(foldGame.getState().balance).toBe(90);
		expect(foldGame.getState().phase).toBe('complete');
	});

	test('records the dealt hands and evaluations for a fold', () => {
		const game = new ThreeCardShowdownGame(100, () => 0);
		game.setAnte(10);
		game.deal();
		const folded = game.fold();
		// The constant-zero dealer 6♥7♥8♥ straight flush qualifies, so a fold
		// reports dealerQualified from the actual evaluation, not a hardcoded false.
		expect(folded.dealerQualified).toBe(true);
		expect(folded.playerHand).toEqual([c(3, 'hearts'), c(4, 'hearts'), c(5, 'hearts')]);
		expect(folded.playerEvaluation.category).toBe('straight-flush');
		expect(folded.dealerEvaluation.category).toBe('straight-flush');
	});

	test('is rejected outside decision', () => {
		const game = new ThreeCardShowdownGame(100);
		expect(() => game.fold()).toThrow();
	});
});

describe('play', () => {
	test('dealer win costs both wagers with constant-zero shuffle', () => {
		const playGame = new ThreeCardShowdownGame(100, () => 0);
		playGame.setAnte(10);
		playGame.deal();
		const played = playGame.play();
		expect(played.outcome).toBe('dealer-win');
		expect(played.totalWager).toBe(20);
		expect(played.grossPayout).toBe(0);
		expect(played.netDelta).toBe(-20);
		expect(played.dealerQualified).toBe(true);
		expect(playGame.getState().balance).toBe(80);
		expect(playGame.getState().phase).toBe('complete');
	});

	test('dealer-not-qualified credits the gross payout after the second wager', () => {
		const notQualified = new ThreeCardShowdownGame(100, () => 0.125);
		notQualified.setAnte(10);
		notQualified.deal();
		expect(notQualified.getState().dealerHand).toEqual([
			c(7, 'clubs'),
			c(2, 'spades'),
			c(10, 'spades'),
		]);
		const played = notQualified.play();
		expect(played).toMatchObject({
			outcome: 'dealer-not-qualified',
			totalWager: 20,
			grossPayout: 30,
			netDelta: 10,
			dealerQualified: false,
		});
		expect(notQualified.getState().balance).toBe(110);
	});

	test('is rejected outside decision', () => {
		const game = new ThreeCardShowdownGame(100);
		expect(() => game.play()).toThrow();
		const played = new ThreeCardShowdownGame(100, () => 0);
		played.deal();
		played.play();
		expect(() => played.play()).toThrow();
	});
});

describe('immutable snapshots', () => {
	test('getState returns a deep clone that cannot mutate game state', () => {
		const game = new ThreeCardShowdownGame(100, () => 0);
		game.setAnte(10);
		game.deal();
		const state = game.getState();
		// Runtime mutation probe: the returned snapshot must be an independent clone.
		(state.playerHand as Card[])[0] = c(14, 'spades');
		expect(game.getState().playerHand[0]).toEqual(c(3, 'hearts'));
	});

	test('returned round results cannot mutate game state through aliases', () => {
		const game = new ThreeCardShowdownGame(100, () => 0);
		game.setAnte(10);
		game.deal();
		const folded = game.fold();
		(folded.playerHand as Card[])[0] = c(14, 'spades');
		(folded.playerEvaluation.tieBreakers as number[])[0] = 99;
		expect(game.getState().result?.playerHand[0]).toEqual(c(3, 'hearts'));
		expect(game.getState().result?.playerEvaluation.tieBreakers[0]).toBe(5);

		const second = new ThreeCardShowdownGame(100, () => 0);
		second.setAnte(10);
		second.deal();
		const played = second.play();
		(played.dealerHand as Card[])[1] = c(14, 'spades');
		(played.dealerEvaluation.tieBreakers as number[])[0] = 99;
		expect(second.getState().result?.dealerHand[1]).toEqual(c(7, 'hearts'));
		expect(second.getState().result?.dealerEvaluation.tieBreakers[0]).toBe(8);
	});
});

describe('resetRound', () => {
	test('returns to betting, keeps the ante, clears the hands and result', () => {
		const game = new ThreeCardShowdownGame(100, () => 0);
		game.setAnte(10);
		game.deal();
		game.fold();
		expect(game.getState().balance).toBe(90);

		game.resetRound();
		expect(game.getState()).toEqual({
			phase: 'betting',
			balance: 90,
			ante: 10,
			playerHand: [],
			dealerHand: [],
			result: null,
		});
	});

	test('allows another round after reset', () => {
		const game = new ThreeCardShowdownGame(100, () => 0);
		game.setAnte(10);
		game.deal();
		game.fold();
		game.resetRound();
		game.deal();
		expect(game.getState().phase).toBe('decision');
		expect(game.getState().balance).toBe(80);
	});

	test('is rejected outside complete', () => {
		const game = new ThreeCardShowdownGame(100);
		expect(() => game.resetRound()).toThrow();
	});
});

describe('setBalance', () => {
	test('adopts an authoritative balance through normalization', () => {
		const game = new ThreeCardShowdownGame(100);
		game.setBalance(50.7);
		expect(game.getState().balance).toBe(50);
	});

	test('rejects non-finite or negative balances', () => {
		const game = new ThreeCardShowdownGame(100);
		for (const bad of [-1, NaN, Infinity, -Infinity]) {
			expect(() => game.setBalance(bad)).toThrow('Balance must be a non-negative finite number');
		}
	});

	test('affects ante affordability checks', () => {
		const game = new ThreeCardShowdownGame(100);
		game.setBalance(19);
		expect(game.getAnteError(10)).toBe('Ante plus Play wager exceeds available balance');
	});
});
