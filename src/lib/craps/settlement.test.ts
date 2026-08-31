import { describe, expect, test } from 'bun:test';
import type { CrapsBet, RollResult } from './types';
import { buildCrapsSettlementCommand, getAvailableCrapsBalance } from './settlement';

function bet(id: string, type: CrapsBet['type']): CrapsBet {
	return { id, type, amount: 25 };
}

function rollResult(overrides: Partial<RollResult> = {}): RollResult {
	return {
		roll: { die1: 3, die2: 4, total: 7 },
		phase: 'come-out',
		point: null,
		evaluations: [],
		netDelta: 0,
		...overrides,
	};
}

describe('Craps wallet settlement command', () => {
	test('returns null when a roll has no resolved wagers', () => {
		const result = rollResult({
			evaluations: [{ bet: bet('continue', 'passLine'), outcome: 'continue', payout: 0 }],
		});

		expect(buildCrapsSettlementCommand('craps-unresolved', result)).toBeNull();
	});

	test('summarizes resolved wagers with the positive net delta as biggest win', () => {
		const result = rollResult({
			evaluations: [
				{ bet: bet('win-small', 'field'), outcome: 'win', payout: 40 },
				{ bet: bet('win-large', 'passLine'), outcome: 'win', payout: 80 },
				{ bet: bet('loss', 'place4'), outcome: 'lose', payout: 0 },
				{ bet: bet('push', 'dontPass'), outcome: 'push', payout: 0 },
				{ bet: bet('continue', 'place8'), outcome: 'continue', payout: 0 },
			],
			netDelta: -5,
		});

		expect(buildCrapsSettlementCommand('craps-1', result)).toEqual({
			settlementId: 'craps-1',
			game: 'craps',
			delta: result.netDelta,
			stats: {
				rounds: 4,
				wins: 2,
				losses: 1,
				biggestWin: 0,
			},
		});
	});

	test('reports the positive net delta as biggest win on a net-positive roll', () => {
		const result = rollResult({
			evaluations: [
				{ bet: bet('win-small', 'field'), outcome: 'win', payout: 50 },
				{ bet: bet('win-large', 'passLine'), outcome: 'win', payout: 100 },
			],
			netDelta: 75,
		});

		const command = buildCrapsSettlementCommand('craps-win', result)!;
		expect(command.stats.biggestWin).toBe(75);
	});
});

describe('Craps available balance', () => {
	test('subtracts active at-risk wagers from the wallet balance', () => {
		expect(getAvailableCrapsBalance(1000, 250)).toBe(750);
	});

	test('leaves the wallet balance unchanged with no active wagers', () => {
		expect(getAvailableCrapsBalance(1000, 0)).toBe(1000);
	});

	test('rejects active wagers that exceed the wallet balance', () => {
		expect(() => getAvailableCrapsBalance(100, 150)).toThrow(
			'Active Craps wagers exceed the settled wallet balance',
		);
	});

	test('rejects an invalid wallet balance with a distinct message', () => {
		expect(() => getAvailableCrapsBalance(-1, 0)).toThrow('Invalid wallet balance');
		expect(() => getAvailableCrapsBalance(100.5, 0)).toThrow('Invalid wallet balance');
	});

	test('rejects an invalid active at-risk amount with a distinct message', () => {
		expect(() => getAvailableCrapsBalance(1000, -1)).toThrow('Invalid active at-risk amount');
		expect(() => getAvailableCrapsBalance(1000, 50.5)).toThrow('Invalid active at-risk amount');
	});
});
