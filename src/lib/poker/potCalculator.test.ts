import { describe, expect, test } from 'bun:test';
import type { Card, Player } from './types';
import {
	calculatePot,
	calculateRoundPot,
	calculateSidePots,
	distributePot,
	getMinimumBet,
	resolveSidePotAwards,
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

	// A simple winner-determiner: the eligible player with the lowest id wins.
	// Lets us drive side-pot resolution without depending on handEvaluator.
	const lowestIdWins = (eligible: Player[], _community: Card[]): Player[] => {
		if (eligible.length === 0) return [];
		const minId = Math.min(...eligible.map((p) => p.id));
		return eligible.filter((p) => p.id === minId);
	};

	describe('resolveSidePotAwards', () => {
		test('single pot: winner takes the full pot', () => {
			const players = [
				makePlayer({ id: 0, totalBet: 50 }),
				makePlayer({ id: 1, totalBet: 50 }),
				makePlayer({ id: 2, totalBet: 50 }),
			];
			const { awards, tierWinners } = resolveSidePotAwards(players, [], lowestIdWins);
			expect(awards.get(0)).toBe(150);
			expect(awards.has(1)).toBe(false);
			expect(awards.has(2)).toBe(false);
			expect(tierWinners.map((p) => p.id)).toEqual([0]);
		});

		test('short all-in only wins the main pot, not the side pot', () => {
			// Player 1 is all-in for 50; players 0 and 2 bet 100 each.
			// Main pot = 150 (50 from each), eligible: 0, 1, 2.
			// Side pot = 100 (extra 50 from 0 and 2), eligible: 0, 2.
			// lowestIdWins: player 1 wins the main pot (lowest id among 0,1,2 is 0...).
			// To model "short stack wins main, big stack wins side", use a determiner
			// that picks the all-in player for the main pot and the covering player for side.
			const players = [
				makePlayer({ id: 0, totalBet: 100 }),
				makePlayer({ id: 1, totalBet: 50, isAllIn: true }),
				makePlayer({ id: 2, totalBet: 100 }),
			];
			// Determiner: all-in player wins when eligible; otherwise lowest covering id.
			const determiner = (eligible: Player[], _c: Card[]): Player[] => {
				const allIn = eligible.filter((p) => p.isAllIn);
				if (allIn.length > 0) return allIn;
				const minId = Math.min(...eligible.map((p) => p.id));
				return eligible.filter((p) => p.id === minId);
			};
			const { awards, tierWinners, tierResults } = resolveSidePotAwards(players, [], determiner);
			// Main pot 150 -> player 1; side pot 100 -> player 0 (lowest covering id).
			expect(awards.get(1)).toBe(150);
			expect(awards.get(0)).toBe(100);
			expect(awards.has(2)).toBe(false);
			expect(tierWinners.map((p) => p.id).sort()).toEqual([0, 1]);
			// tierResults must keep the tiers separate so callers can distinguish
			// side-pot-different-winners from a genuine split-pot tie.
			expect(tierResults).toHaveLength(2);
			expect(tierResults[0]).toEqual({ amount: 150, winners: [players[1]] });
			expect(tierResults[1]).toEqual({ amount: 100, winners: [players[0]] });
		});

		test('short all-in cannot win chips from bets it did not cover', () => {
			// Player 0 all-in for 20, players 1 and 2 bet 100 each. Player 0 has the
			// best hand overall but should only win the main pot (60), not the side
			// pot (160). The side pot must go to the best of {1, 2}.
			const players = [
				makePlayer({ id: 0, totalBet: 20, isAllIn: true }),
				makePlayer({ id: 1, totalBet: 100 }),
				makePlayer({ id: 2, totalBet: 100 }),
			];
			// Player 0 always wins when eligible; otherwise player 2 wins over 1.
			const determiner = (eligible: Player[], _c: Card[]): Player[] => {
				if (eligible.some((p) => p.id === 0)) {
					return eligible.filter((p) => p.id === 0);
				}
				return eligible.filter((p) => p.id === 2);
			};
			const { awards, tierWinners } = resolveSidePotAwards(players, [], determiner);
			// Main pot = 60 (20*3) -> player 0. Side pot = 160 (80*2) -> player 2.
			expect(awards.get(0)).toBe(60);
			expect(awards.get(2)).toBe(160);
			expect(awards.has(1)).toBe(false);
			expect(tierWinners.map((p) => p.id).sort()).toEqual([0, 2]);
		});

		test('folded players contribute to pots but never win', () => {
			const players = [
				makePlayer({ id: 0, totalBet: 60, folded: true }),
				makePlayer({ id: 1, totalBet: 60 }),
				makePlayer({ id: 2, totalBet: 30, isAllIn: true }),
				makePlayer({ id: 3, totalBet: 60 }),
			];
			// Player 2 (all-in) wins main pot when eligible; player 3 wins side.
			const determiner = (eligible: Player[], _c: Card[]): Player[] => {
				const allIn = eligible.filter((p) => p.isAllIn);
				if (allIn.length > 0) return allIn;
				return eligible.filter((p) => p.id === 3);
			};
			const { awards, tierWinners } = resolveSidePotAwards(players, [], determiner);
			// Main pot 120 -> player 2; side pot 90 -> player 3.
			expect(awards.get(2)).toBe(120);
			expect(awards.get(3)).toBe(90);
			expect(awards.has(0)).toBe(false); // folded, never wins
			expect(awards.has(1)).toBe(false);
			expect(tierWinners.map((p) => p.id).sort()).toEqual([2, 3]);
		});

		test('tie within a tier splits that tier pot', () => {
			const players = [
				makePlayer({ id: 0, totalBet: 50 }),
				makePlayer({ id: 1, totalBet: 50 }),
				makePlayer({ id: 2, totalBet: 50 }),
			];
			// All three tie.
			const determiner = (_eligible: Player[], _c: Card[]): Player[] => _eligible;
			const { awards, tierWinners } = resolveSidePotAwards(players, [], determiner);
			// 150 / 3 = 50 each, remainder 0.
			expect(awards.get(0)).toBe(50);
			expect(awards.get(1)).toBe(50);
			expect(awards.get(2)).toBe(50);
			expect(tierWinners.map((p) => p.id).sort()).toEqual([0, 1, 2]);
		});
	});
});
