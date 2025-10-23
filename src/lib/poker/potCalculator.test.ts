import { describe, expect, test } from 'bun:test';
import type { Player } from './types';
import {
	calculatePot,
	calculateRoundPot,
	calculateSidePots,
	distributePot,
	getMinimumBet,
} from './potCalculator';

function makePlayer(partial: Partial<Player> & { id: number; name?: string }): Player {
	return {
		id: partial.id,
		name: partial.name ?? `Player ${partial.id}`,
		chips: partial.chips ?? 0,
		hand: partial.hand ?? [],
		currentBet: partial.currentBet ?? 0,
		totalBet: partial.totalBet ?? 0,
		folded: partial.folded ?? false,
		isAllIn: partial.isAllIn ?? false,
		isDealer: partial.isDealer ?? false,
		isAI: partial.isAI ?? false,
		hasActed: partial.hasActed ?? false,
	};
}

describe('potCalculator', () => {
	test('calculatePot sums total bets for all players', () => {
		const players = [
			makePlayer({ id: 0, totalBet: 50 }),
			makePlayer({ id: 1, totalBet: 30 }),
			makePlayer({ id: 2, totalBet: 20 }),
		];
		expect(calculatePot(players)).toBe(100);
	});

	test('calculateRoundPot sums current betting round contributions', () => {
		const players = [
			makePlayer({ id: 0, currentBet: 10 }),
			makePlayer({ id: 1, currentBet: 5 }),
			makePlayer({ id: 2, currentBet: 5 }),
		];
		expect(calculateRoundPot(players)).toBe(20);
	});

	test('distributePot splits evenly among winners with remainder to earliest players', () => {
		const winners = [makePlayer({ id: 1 }), makePlayer({ id: 3 }), makePlayer({ id: 5 })];
		const distribution = distributePot(winners, 10);
		expect(distribution.get(1)).toBe(4);
		expect(distribution.get(3)).toBe(3);
		expect(distribution.get(5)).toBe(3);
	});

	test('distributePot handles single winner', () => {
		const winners = [makePlayer({ id: 7 })];
		const distribution = distributePot(winners, 37);
		expect(distribution.get(7)).toBe(37);
	});

	test('getMinimumBet returns the higher of big blind or last raise', () => {
		expect(getMinimumBet(10, 15)).toBe(15);
		expect(getMinimumBet(20, 15)).toBe(20);
	});

	test('calculateSidePots returns single main pot when no one is all-in', () => {
		const players = [
			makePlayer({ id: 0, totalBet: 50 }),
			makePlayer({ id: 1, totalBet: 50 }),
			makePlayer({ id: 2, totalBet: 50 }),
		];
		const pots = calculateSidePots(players);
		expect(pots).toHaveLength(1);
		expect(pots[0]).toEqual({ amount: 150, eligiblePlayerIds: [0, 1, 2] });
	});

	test('calculateSidePots handles single all-in creating side pot', () => {
		const players = [
			makePlayer({ id: 0, totalBet: 100 }),
			makePlayer({ id: 1, totalBet: 50, isAllIn: true }),
			makePlayer({ id: 2, totalBet: 80 }),
		];
		const pots = calculateSidePots(players);
		expect(pots).toHaveLength(3);
		expect(pots[0]).toEqual({ amount: 150, eligiblePlayerIds: [0, 1, 2] });
		expect(pots[1]).toEqual({ amount: 60, eligiblePlayerIds: [0, 2] });
		expect(pots[2]).toEqual({ amount: 20, eligiblePlayerIds: [0] });
	});

	test('calculateSidePots handles multiple all-ins at different levels', () => {
		const players = [
			makePlayer({ id: 0, totalBet: 200 }),
			makePlayer({ id: 1, totalBet: 150, isAllIn: true }),
			makePlayer({ id: 2, totalBet: 80, isAllIn: true }),
			makePlayer({ id: 3, totalBet: 200 }),
		];
		const pots = calculateSidePots(players);
		expect(pots).toHaveLength(3);
		expect(pots[0]).toEqual({ amount: 320, eligiblePlayerIds: [0, 1, 2, 3] });
		expect(pots[1]).toEqual({ amount: 210, eligiblePlayerIds: [0, 1, 3] });
		expect(pots[2]).toEqual({ amount: 100, eligiblePlayerIds: [0, 3] });
	});

	test('calculateSidePots ignores folded players for eligibility', () => {
		const players = [
			makePlayer({ id: 0, totalBet: 60, folded: true }),
			makePlayer({ id: 1, totalBet: 60 }),
			makePlayer({ id: 2, totalBet: 30, isAllIn: true }),
			makePlayer({ id: 3, totalBet: 60 }),
		];
		const pots = calculateSidePots(players);
		expect(pots).toHaveLength(2);
		expect(pots[0]).toEqual({ amount: 120, eligiblePlayerIds: [1, 2, 3] });
		expect(pots[1]).toEqual({ amount: 90, eligiblePlayerIds: [1, 3] });
	});
});
