import { describe, expect, test } from 'bun:test';
import type { Card, GameContext, Player } from './types';
import { getDifficultyProfile } from './aiDifficulty';
import { chooseRaiseAmount } from './aiBetSizing';

function card(value: string, suit: Card['suit'], rank: number): Card {
	return { value, suit, rank };
}

function player(id: number, chips: number, currentBet: number, hand: Card[] = []): Player {
	return {
		id,
		name: `Player ${id}`,
		chips,
		hand,
		currentBet,
		totalBet: currentBet,
		folded: false,
		isAllIn: false,
		isDealer: false,
		isAI: id !== 0,
		hasActed: false,
	};
}

function context(aiPlayer: Player, players: Player[], pot = 100): GameContext {
	return {
		player: aiPlayer,
		players,
		communityCards: [],
		pot,
		minimumBet: 10,
		phase: 'preflop',
		bettingRound: 'preflop',
		position: 'late',
	};
}

describe('chooseRaiseAmount', () => {
	test('returns a legal raise amount at least the minimum bet', () => {
		const ai = player(1, 500, 0, [card('A', 'spades', 14), card('A', 'hearts', 14)]);
		const amount = chooseRaiseAmount({
			context: context(ai, [ai, player(2, 500, 0)]),
			profile: getDifficultyProfile('medium'),
			equity: 0.82,
			texturePressure: 0.1,
		});

		expect(amount).toBeGreaterThanOrEqual(10);
		expect(amount! % 10).toBe(0);
	});

	test('caps raise amount by chips remaining after a call', () => {
		const ai = player(1, 35, 0, [card('A', 'spades', 14), card('K', 'spades', 13)]);
		const amount = chooseRaiseAmount({
			context: context(ai, [ai, player(2, 500, 20)], 100),
			profile: getDifficultyProfile('hard'),
			equity: 0.9,
			texturePressure: 0.2,
		});

		expect(amount).toBeLessThanOrEqual(15);
	});

	test('hard profile sizes larger than easy profile for strong value hands', () => {
		const ai = player(1, 500, 0, [card('A', 'spades', 14), card('A', 'hearts', 14)]);
		const gameContext = context(ai, [ai, player(2, 500, 0)], 120);

		const easyAmount = chooseRaiseAmount({
			context: gameContext,
			profile: getDifficultyProfile('easy'),
			equity: 0.9,
			texturePressure: 0.1,
		});
		const hardAmount = chooseRaiseAmount({
			context: gameContext,
			profile: getDifficultyProfile('hard'),
			equity: 0.9,
			texturePressure: 0.1,
		});

		expect(hardAmount).toBeGreaterThanOrEqual(easyAmount!);
	});

	test('returns null when no minimum raise is affordable after calling', () => {
		const ai = player(1, 12, 0, [card('Q', 'spades', 12), card('Q', 'hearts', 12)]);
		const amount = chooseRaiseAmount({
			context: context(ai, [ai, player(2, 500, 10)], 100),
			profile: getDifficultyProfile('medium'),
			equity: 0.8,
			texturePressure: 0.1,
		});

		expect(amount).toBeNull();
	});
});
