import { describe, expect, test } from 'bun:test';
import { aggregateGameStats, calculateWinRate } from './aggregation';

describe('calculateWinRate', () => {
	test('uses decided hands and excludes pushes', () => {
		expect(calculateWinRate(6, 2)).toBe(75);
	});

	test('returns zero when there are no decided hands', () => {
		expect(calculateWinRate(0, 0)).toBe(0);
	});
});

describe('aggregateGameStats', () => {
	test('sums totals and takes the maximum biggest win', () => {
		expect(
			aggregateGameStats([
				{ totalWins: 3, totalLosses: 2, handsPlayed: 7, biggestWin: 80, netProfit: 20 },
				{ totalWins: 5, totalLosses: 4, handsPlayed: 10, biggestWin: 150, netProfit: -30 },
			]),
		).toEqual({
			totalWins: 8,
			totalLosses: 6,
			totalHandsPlayed: 17,
			biggestWin: 150,
			totalNetProfit: -10,
		});
	});
});
