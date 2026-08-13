import { describe, expect, test } from 'bun:test';
import { VideoPokerGame } from './game';

const id = (card: { rank: number; suit: string }) => `${card.rank}-${card.suit}`;

describe('VideoPokerGame', () => {
	test('exposes one wager validation rule for the UI and game invariants', () => {
		const game = new VideoPokerGame(3, () => 0);
		expect(game.getWagerError(1)).toBeNull();
		expect(game.getWagerError(2.5)).toContain('whole');
		expect(game.getWagerError(0)).toContain('between');
		expect(game.getWagerError(4)).toBe('Wager exceeds available balance');
	});

	test('deals five unique cards and deducts the wager', () => {
		const game = new VideoPokerGame(100, () => 0);
		game.setWager(5);
		game.deal();
		const state = game.getState();
		expect(state.phase).toBe('holding');
		expect(state.balance).toBe(95);
		expect(state.hand).toHaveLength(5);
		expect(new Set(state.hand.map(id)).size).toBe(5);
	});

	test('keeps held cards and replaces unheld cards once', () => {
		const game = new VideoPokerGame(100, () => 0);
		game.deal();
		const dealt = game.getState().hand.map(id);
		game.toggleHold(0);
		game.toggleHold(2);
		const result = game.draw();
		const finalIds = result.finalHand.map(id);
		expect(finalIds[0]).toBe(dealt[0]);
		expect(finalIds[2]).toBe(dealt[2]);
		expect(finalIds[1]).not.toBe(dealt[1]);
		expect(finalIds[3]).not.toBe(dealt[3]);
		expect(finalIds[4]).not.toBe(dealt[4]);
		expect(new Set(finalIds).size).toBe(5);
		expect(() => game.draw()).toThrow();
	});

	test('keeps payout and balance math consistent', () => {
		const game = new VideoPokerGame(100, () => 0);
		game.setWager(3);
		game.deal();
		const result = game.draw();
		expect(result.netDelta).toBe(result.payout - 3);
		expect(game.getState().balance).toBe(100 + result.netDelta);
	});

	test('keeps programmer-invalid phase/index calls as invariant failures', () => {
		const game = new VideoPokerGame(100, () => 0);
		expect(() => game.toggleHold(0)).toThrow();
		game.deal();
		const before = game.getState();
		expect(() => game.toggleHold(5)).toThrow();
		expect(game.getState()).toEqual(before);
		expect(() => game.setWager(2)).toThrow();
	});

	test('preserves completed result until explicit reset', () => {
		const game = new VideoPokerGame(100, () => 0);
		game.deal();
		game.draw();
		const completedBalance = game.getState().balance;
		game.resetRound();
		expect(game.getState()).toMatchObject({
			phase: 'ready',
			balance: completedBalance,
			hand: [],
			heldIndexes: [],
			result: null,
		});
	});

	test('setBalance replaces the balance with a normalized integer', () => {
		const game = new VideoPokerGame(100, () => 0);
		game.deal();
		game.draw();
		game.setBalance(250.7);
		expect(game.getState().balance).toBe(250);
		expect(() => game.setBalance(-1)).toThrow(RangeError);
		expect(() => game.setBalance(Number.NaN)).toThrow(RangeError);
	});

	test('getState returns a deep snapshot that cannot mutate internal state', () => {
		const game = new VideoPokerGame(100, () => 0);
		game.deal();
		game.toggleHold(0);
		game.draw();

		const snapshot = game.getState();
		const internalBefore = game.getState();

		// Mutate every cloneable field on the snapshot
		if (snapshot.hand[0]) snapshot.hand[0].rank = 2;
		if (snapshot.hand[0]) snapshot.hand[0].suit = 'clubs';
		// Mutate the arrays themselves to expose shared references
		snapshot.hand.push({ rank: 99, suit: 'hearts' });
		snapshot.heldIndexes.push(99);
		snapshot.heldIndexes.length = 0;
		if (snapshot.result) {
			snapshot.result.evaluation.category = 'royal-flush';
			snapshot.result.evaluation.label = 'tampered';
			snapshot.result.finalHand.push({ rank: 99, suit: 'hearts' });
			if (snapshot.result.finalHand[0]) snapshot.result.finalHand[0].rank = 14;
			if (snapshot.result.finalHand[0]) snapshot.result.finalHand[0].suit = 'spades';
		}

		const internalAfter = game.getState();
		expect(internalAfter.hand).toEqual(internalBefore.hand);
		expect(internalAfter.heldIndexes).toEqual(internalBefore.heldIndexes);
		expect(internalAfter.result?.evaluation).toEqual(internalBefore.result?.evaluation);
		expect(internalAfter.result?.finalHand).toEqual(internalBefore.result?.finalHand);
	});

	test('draw returns a deep snapshot that cannot mutate internal state', () => {
		const game = new VideoPokerGame(100, () => 0);
		game.deal();
		game.toggleHold(0);
		const result = game.draw();
		const internalBefore = game.getState();

		// Mutate every cloneable field on the value returned directly by draw()
		if (result.finalHand[0]) result.finalHand[0].rank = 14;
		if (result.finalHand[0]) result.finalHand[0].suit = 'spades';
		result.evaluation.category = 'royal-flush';
		result.evaluation.label = 'tampered';
		result.payout = 999999;
		result.netDelta = 999999;

		const internalAfter = game.getState();
		expect(internalAfter.hand).toEqual(internalBefore.hand);
		expect(internalAfter.result?.evaluation).toEqual(internalBefore.result?.evaluation);
		expect(internalAfter.result?.finalHand).toEqual(internalBefore.result?.finalHand);
		expect(internalAfter.result?.payout).toBe(internalBefore.result?.payout);
		expect(internalAfter.result?.netDelta).toBe(internalBefore.result?.netDelta);
	});
});
