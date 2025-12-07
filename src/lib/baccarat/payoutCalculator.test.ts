/**
 * Unit tests for payoutCalculator
 */

import { describe, expect, test } from 'bun:test';
import {
	calculatePayout,
	calculateTotalPayout,
	calculateAllPayouts,
	getPayoutMultiplier,
	getPayoutDescription,
	calculatePotentialWinnings,
	validatePayout,
} from './payoutCalculator';
import type { Bet, RoundOutcome } from './types';
import { PAYOUTS } from './constants';

// Helper to create a round outcome
function createOutcome(
	winner: 'player' | 'banker' | 'tie',
	playerPair = false,
	bankerPair = false,
): RoundOutcome {
	return {
		winner,
		playerHand: {
			cards: [
				{ rank: '5', suit: 'hearts' },
				{ rank: '4', suit: 'diamonds' },
			],
		},
		bankerHand: {
			cards: [
				{ rank: '3', suit: 'hearts' },
				{ rank: '4', suit: 'diamonds' },
			],
		},
		playerValue: 9,
		bankerValue: 7,
		playerPair,
		bankerPair,
		isNatural: false,
		betResults: [],
		timestamp: Date.now(),
	};
}

describe('calculatePayout - Player bet', () => {
	test('should pay 1:1 on player win', () => {
		const bet: Bet = { type: 'player', amount: 100 };
		const outcome = createOutcome('player');
		const result = calculatePayout(bet, outcome);

		expect(result.outcome).toBe('win');
		expect(result.payout).toBe(100);
	});

	test('should push on tie', () => {
		const bet: Bet = { type: 'player', amount: 100 };
		const outcome = createOutcome('tie');
		const result = calculatePayout(bet, outcome);

		expect(result.outcome).toBe('push');
		expect(result.payout).toBe(0);
	});

	test('should lose on banker win', () => {
		const bet: Bet = { type: 'player', amount: 100 };
		const outcome = createOutcome('banker');
		const result = calculatePayout(bet, outcome);

		expect(result.outcome).toBe('lose');
		expect(result.payout).toBe(-100);
	});
});

describe('calculatePayout - Banker bet', () => {
	test('should pay 0.95:1 on banker win (5% commission)', () => {
		const bet: Bet = { type: 'banker', amount: 100 };
		const outcome = createOutcome('banker');
		const result = calculatePayout(bet, outcome);

		expect(result.outcome).toBe('win');
		expect(result.payout).toBe(95);
	});

	test('should push on tie', () => {
		const bet: Bet = { type: 'banker', amount: 100 };
		const outcome = createOutcome('tie');
		const result = calculatePayout(bet, outcome);

		expect(result.outcome).toBe('push');
		expect(result.payout).toBe(0);
	});

	test('should lose on player win', () => {
		const bet: Bet = { type: 'banker', amount: 100 };
		const outcome = createOutcome('player');
		const result = calculatePayout(bet, outcome);

		expect(result.outcome).toBe('lose');
		expect(result.payout).toBe(-100);
	});
});

describe('calculatePayout - Tie bet', () => {
	test('should pay 8:1 on tie', () => {
		const bet: Bet = { type: 'tie', amount: 100 };
		const outcome = createOutcome('tie');
		const result = calculatePayout(bet, outcome);

		expect(result.outcome).toBe('win');
		expect(result.payout).toBe(800);
	});

	test('should lose on player win (no push)', () => {
		const bet: Bet = { type: 'tie', amount: 100 };
		const outcome = createOutcome('player');
		const result = calculatePayout(bet, outcome);

		expect(result.outcome).toBe('lose');
		expect(result.payout).toBe(-100);
	});

	test('should lose on banker win (no push)', () => {
		const bet: Bet = { type: 'tie', amount: 100 };
		const outcome = createOutcome('banker');
		const result = calculatePayout(bet, outcome);

		expect(result.outcome).toBe('lose');
		expect(result.payout).toBe(-100);
	});
});

describe('calculatePayout - Player Pair bet', () => {
	test('should pay 11:1 on player pair', () => {
		const bet: Bet = { type: 'playerPair', amount: 100 };
		const outcome = createOutcome('player', true, false);
		const result = calculatePayout(bet, outcome);

		expect(result.outcome).toBe('win');
		expect(result.payout).toBe(1100);
	});

	test('should lose if no player pair', () => {
		const bet: Bet = { type: 'playerPair', amount: 100 };
		const outcome = createOutcome('player', false, false);
		const result = calculatePayout(bet, outcome);

		expect(result.outcome).toBe('lose');
		expect(result.payout).toBe(-100);
	});

	test('should win regardless of round winner', () => {
		const bet: Bet = { type: 'playerPair', amount: 100 };
		const outcome = createOutcome('banker', true, false);
		const result = calculatePayout(bet, outcome);

		expect(result.outcome).toBe('win');
		expect(result.payout).toBe(1100);
	});
});

describe('calculatePayout - Banker Pair bet', () => {
	test('should pay 11:1 on banker pair', () => {
		const bet: Bet = { type: 'bankerPair', amount: 100 };
		const outcome = createOutcome('banker', false, true);
		const result = calculatePayout(bet, outcome);

		expect(result.outcome).toBe('win');
		expect(result.payout).toBe(1100);
	});

	test('should lose if no banker pair', () => {
		const bet: Bet = { type: 'bankerPair', amount: 100 };
		const outcome = createOutcome('banker', false, false);
		const result = calculatePayout(bet, outcome);

		expect(result.outcome).toBe('lose');
		expect(result.payout).toBe(-100);
	});
});

describe('calculateTotalPayout', () => {
	test('should sum all bet payouts', () => {
		const bets: Bet[] = [
			{ type: 'player', amount: 100 },
			{ type: 'tie', amount: 50 },
		];
		const outcome = createOutcome('player');
		const total = calculateTotalPayout(bets, outcome);

		// Player wins: +100, Tie loses: -50
		expect(total).toBe(50);
	});

	test('should handle empty bets', () => {
		const outcome = createOutcome('player');
		const total = calculateTotalPayout([], outcome);

		expect(total).toBe(0);
	});

	test('should handle multiple winning bets', () => {
		const bets: Bet[] = [
			{ type: 'player', amount: 100 },
			{ type: 'playerPair', amount: 50 },
		];
		const outcome = createOutcome('player', true);
		const total = calculateTotalPayout(bets, outcome);

		// Player wins: +100, Player pair wins: +550
		expect(total).toBe(650);
	});

	test('should handle tie scenario with push', () => {
		const bets: Bet[] = [
			{ type: 'player', amount: 100 },
			{ type: 'banker', amount: 100 },
			{ type: 'tie', amount: 50 },
		];
		const outcome = createOutcome('tie');
		const total = calculateTotalPayout(bets, outcome);

		// Player push: 0, Banker push: 0, Tie wins: +400
		expect(total).toBe(400);
	});
});

describe('calculateAllPayouts', () => {
	test('should return results for all bets', () => {
		const bets: Bet[] = [
			{ type: 'player', amount: 100 },
			{ type: 'banker', amount: 100 },
		];
		const outcome = createOutcome('player');
		const results = calculateAllPayouts(bets, outcome);

		expect(results.length).toBe(2);
		expect(results[0].outcome).toBe('win');
		expect(results[1].outcome).toBe('lose');
	});
});

describe('getPayoutMultiplier', () => {
	test('should return correct multipliers', () => {
		expect(getPayoutMultiplier('player')).toBe(PAYOUTS.player);
		expect(getPayoutMultiplier('banker')).toBe(PAYOUTS.banker);
		expect(getPayoutMultiplier('tie')).toBe(PAYOUTS.tie);
		expect(getPayoutMultiplier('playerPair')).toBe(PAYOUTS.playerPair);
		expect(getPayoutMultiplier('bankerPair')).toBe(PAYOUTS.bankerPair);
	});
});

describe('getPayoutDescription', () => {
	test('should return human-readable descriptions', () => {
		expect(getPayoutDescription('player')).toBe('1:1');
		expect(getPayoutDescription('banker')).toContain('commission');
		expect(getPayoutDescription('tie')).toBe('8:1');
		expect(getPayoutDescription('playerPair')).toBe('11:1');
		expect(getPayoutDescription('bankerPair')).toBe('11:1');
	});
});

describe('calculatePotentialWinnings', () => {
	test('should calculate potential profit', () => {
		expect(calculatePotentialWinnings(100, 'player')).toBe(100);
		expect(calculatePotentialWinnings(100, 'banker')).toBe(95);
		expect(calculatePotentialWinnings(100, 'tie')).toBe(800);
		expect(calculatePotentialWinnings(100, 'playerPair')).toBe(1100);
	});
});

describe('validatePayout', () => {
	test('should validate correct payout', () => {
		const bet: Bet = { type: 'player', amount: 100 };
		const outcome = createOutcome('player');
		expect(validatePayout(bet, outcome, 100)).toBe(true);
	});

	test('should reject incorrect payout', () => {
		const bet: Bet = { type: 'player', amount: 100 };
		const outcome = createOutcome('player');
		expect(validatePayout(bet, outcome, 50)).toBe(false);
	});

	test('should handle floating point precision', () => {
		const bet: Bet = { type: 'banker', amount: 100 };
		const outcome = createOutcome('banker');
		expect(validatePayout(bet, outcome, 95.001)).toBe(true);
	});
});
