import { describe, expect, test } from 'bun:test';
import { calculateMetrics } from './game-stats';
import type { GameStats } from './types';
import {
	GAME_TYPES,
	RANKING_METRICS,
	isValidGameType,
	isValidRankingMetric,
	GAME_TYPE_LABELS,
	RANKING_METRIC_LABELS,
} from './constants';

describe('calculateMetrics', () => {
	test('calculates win rate correctly for player with wins and losses', () => {
		const stats: GameStats = {
			userId: 'user1',
			gameType: 'blackjack',
			totalWins: 30,
			totalLosses: 70,
			handsPlayed: 100,
			biggestWin: 500,
			netProfit: -200,
			updatedAt: new Date(),
		};

		const result = calculateMetrics(stats);

		expect(result.winRate).toBe(30); // 30 / (30 + 70) * 100 = 30%
		expect(result.totalWins).toBe(30);
		expect(result.totalLosses).toBe(70);
	});

	test('calculates win rate as 0 when no decided hands', () => {
		const stats: GameStats = {
			userId: 'user1',
			gameType: 'blackjack',
			totalWins: 0,
			totalLosses: 0,
			handsPlayed: 5, // All pushes
			biggestWin: 0,
			netProfit: 0,
			updatedAt: new Date(),
		};

		const result = calculateMetrics(stats);

		expect(result.winRate).toBe(0);
	});

	test('includes pushes in handsPlayed for win-rate eligibility', () => {
		// Player with 10 hands: 6 wins, 4 pushes
		// handsPlayed = 10 (meets MIN_HANDS_FOR_WIN_RATE threshold)
		// totalWins + totalLosses = 6
		// win rate = 6/6 = 100%
		const stats: GameStats = {
			userId: 'user1',
			gameType: 'blackjack',
			totalWins: 6,
			totalLosses: 0,
			handsPlayed: 10,
			biggestWin: 300,
			netProfit: 300,
			updatedAt: new Date(),
		};

		const result = calculateMetrics(stats);

		// Win rate is calculated on decided hands (6/6 = 100%)
		expect(result.winRate).toBe(100);
		// handsPlayed includes all hands (wins + losses + pushes)
		expect(result.handsPlayed).toBe(10);
	});

	test('calculates 100% win rate when all wins', () => {
		const stats: GameStats = {
			userId: 'user1',
			gameType: 'poker',
			totalWins: 50,
			totalLosses: 0,
			handsPlayed: 50,
			biggestWin: 10000,
			netProfit: 25000,
			updatedAt: new Date(),
		};

		const result = calculateMetrics(stats);

		expect(result.winRate).toBe(100);
	});

	test('preserves all original stats in result', () => {
		const stats: GameStats = {
			userId: 'user123',
			gameType: 'baccarat',
			totalWins: 10,
			totalLosses: 20,
			handsPlayed: 35,
			biggestWin: 2500,
			netProfit: -1500,
			updatedAt: new Date('2025-01-01'),
		};

		const result = calculateMetrics(stats);

		expect(result.userId).toBe('user123');
		expect(result.gameType).toBe('baccarat');
		expect(result.handsPlayed).toBe(35);
		expect(result.biggestWin).toBe(2500);
		expect(result.netProfit).toBe(-1500);
	});
});

describe('constants', () => {
	test('GAME_TYPES contains expected values', () => {
		expect(GAME_TYPES).toContain('blackjack');
		expect(GAME_TYPES).toContain('baccarat');
		expect(GAME_TYPES).toContain('poker');
		expect(GAME_TYPES.length).toBe(3);
	});

	test('RANKING_METRICS contains expected values', () => {
		expect(RANKING_METRICS).toContain('wins');
		expect(RANKING_METRICS).toContain('win_rate');
		expect(RANKING_METRICS).toContain('biggest_win');
		expect(RANKING_METRICS).toContain('net_profit');
		expect(RANKING_METRICS.length).toBe(4);
	});

	test('isValidGameType validates correctly', () => {
		expect(isValidGameType('blackjack')).toBe(true);
		expect(isValidGameType('baccarat')).toBe(true);
		expect(isValidGameType('poker')).toBe(true);
		expect(isValidGameType('roulette')).toBe(false);
		expect(isValidGameType('')).toBe(false);
		expect(isValidGameType(null as unknown as string)).toBe(false);
	});

	test('isValidRankingMetric validates correctly', () => {
		expect(isValidRankingMetric('wins')).toBe(true);
		expect(isValidRankingMetric('win_rate')).toBe(true);
		expect(isValidRankingMetric('biggest_win')).toBe(true);
		expect(isValidRankingMetric('net_profit')).toBe(true);
		expect(isValidRankingMetric('invalid')).toBe(false);
		expect(isValidRankingMetric('')).toBe(false);
	});

	test('GAME_TYPE_LABELS has labels for all game types', () => {
		for (const gameType of GAME_TYPES) {
			expect(GAME_TYPE_LABELS[gameType]).toBeDefined();
			expect(typeof GAME_TYPE_LABELS[gameType]).toBe('string');
		}
	});

	test('RANKING_METRIC_LABELS has labels for all metrics', () => {
		for (const metric of RANKING_METRICS) {
			expect(RANKING_METRIC_LABELS[metric]).toBeDefined();
			expect(typeof RANKING_METRIC_LABELS[metric]).toBe('string');
		}
	});
});
