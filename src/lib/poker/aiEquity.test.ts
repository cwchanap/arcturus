import { describe, expect, test } from 'bun:test';
import type { Card, GameContext, Player } from './types';
import { estimateVisibleEquity } from './aiEquity';

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

function context(aiPlayer: Player, players: Player[], communityCards: Card[] = []): GameContext {
	return {
		player: aiPlayer,
		players,
		communityCards,
		pot: 100,
		minimumBet: 10,
		phase: communityCards.length === 0 ? 'preflop' : 'flop',
		bettingRound: communityCards.length === 0 ? 'preflop' : 'flop',
		position: 'middle',
	};
}

describe('estimateVisibleEquity', () => {
	test('rates pocket aces above weak offsuit preflop', () => {
		const aces = player(1, 500, 0, [card('A', 'spades', 14), card('A', 'hearts', 14)]);
		const weak = player(1, 500, 0, [card('7', 'clubs', 7), card('2', 'diamonds', 2)]);

		const acesEstimate = estimateVisibleEquity(context(aces, [aces, player(2, 500, 0)]));
		const weakEstimate = estimateVisibleEquity(context(weak, [weak, player(2, 500, 0)]));

		expect(acesEstimate.equity).toBeGreaterThan(weakEstimate.equity);
		expect(acesEstimate.madeStrength).toBeGreaterThan(0.85);
		expect(weakEstimate.madeStrength).toBeLessThan(0.35);
	});

	test('adds draw potential for a flush draw', () => {
		const ai = player(1, 500, 0, [card('A', 'hearts', 14), card('K', 'hearts', 13)]);
		const estimate = estimateVisibleEquity(
			context(
				ai,
				[ai, player(2, 500, 0)],
				[card('9', 'hearts', 9), card('5', 'hearts', 5), card('2', 'clubs', 2)],
			),
		);

		expect(estimate.outs).toBeGreaterThanOrEqual(9);
		expect(estimate.drawPotential).toBeGreaterThan(0.12);
		expect(estimate.equity).toBeGreaterThan(estimate.madeStrength);
	});

	test('reduces equity on threatening paired boards', () => {
		const ai = player(1, 500, 0, [card('A', 'clubs', 14), card('J', 'diamonds', 11)]);
		const dryEstimate = estimateVisibleEquity(
			context(
				ai,
				[ai, player(2, 500, 0)],
				[card('K', 'spades', 13), card('7', 'diamonds', 7), card('2', 'clubs', 2)],
			),
		);
		const scaryEstimate = estimateVisibleEquity(
			context(
				ai,
				[ai, player(2, 500, 0)],
				[card('K', 'spades', 13), card('K', 'hearts', 13), card('Q', 'spades', 12)],
			),
		);

		expect(scaryEstimate.texturePressure).toBeGreaterThan(dryEstimate.texturePressure);
		expect(scaryEstimate.equity).toBeLessThan(dryEstimate.equity);
	});

	test('calculates pot odds from current public bets', () => {
		const ai = player(1, 500, 10, [card('9', 'clubs', 9), card('9', 'hearts', 9)]);
		const estimate = estimateVisibleEquity(context(ai, [ai, player(2, 500, 60)]));

		expect(estimate.callAmount).toBe(50);
		expect(estimate.potOdds).toBeCloseTo(50 / 150);
	});
});
