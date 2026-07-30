import { describe, expect, test } from 'bun:test';
import type { Database } from '../db';
import { GAME_TYPES } from './constants';
import {
	PlayerStatisticsIntegrityError,
	buildPlayerStatisticsDashboard,
} from './player-statistics';
import * as playerStatistics from './player-statistics';
import type {
	PlayerStatisticsDashboard,
	PlayerStatisticsSourceRow,
	PlayerStatisticsSummary,
} from './player-statistics-types';
import type { GameStats, GameType } from './types';

const updatedAt = new Date('2026-07-30T00:00:00Z');

function row(overrides: Partial<PlayerStatisticsSourceRow>): PlayerStatisticsSourceRow {
	return {
		userId: 'user-1',
		gameType: 'blackjack',
		totalWins: 0,
		totalLosses: 0,
		handsPlayed: 0,
		biggestWin: 0,
		netProfit: 0,
		updatedAt,
		...overrides,
	};
}

describe('buildPlayerStatisticsDashboard', () => {
	test('zero-fills every canonical game in canonical order', () => {
		const dashboard = buildPlayerStatisticsDashboard([], new Map());

		expect(dashboard.games.map((game) => game.gameType)).toEqual([...GAME_TYPES]);
		expect(dashboard.games.every((game) => game.handsPlayed === 0)).toBe(true);
		expect(dashboard.summary).toEqual({
			totalHands: 0,
			totalWins: 0,
			totalLosses: 0,
			overallWinRate: 0,
			totalNetProfit: 0,
			mostPlayedGame: null,
		});
	});

	test('uses weighted overall win rate and canonical tie-break', () => {
		const dashboard = buildPlayerStatisticsDashboard([
			row({
				gameType: 'baccarat',
				totalWins: 1,
				totalLosses: 9,
				handsPlayed: 10,
				biggestWin: 25,
				netProfit: -10,
			}),
			row({
				gameType: 'blackjack',
				totalWins: 9,
				totalLosses: 1,
				handsPlayed: 10,
				biggestWin: 100,
				netProfit: 40,
			}),
		]);

		expect(dashboard.summary.overallWinRate).toBe(50);
		expect(dashboard.summary.mostPlayedGame).toBe('blackjack');
	});

	test('keeps pushes in hand totals while excluding them from win rates', () => {
		const dashboard = buildPlayerStatisticsDashboard([
			row({ gameType: 'craps', totalWins: 1, totalLosses: 1, handsPlayed: 5 }),
		]);

		expect(dashboard.summary.totalHands).toBe(5);
		expect(dashboard.summary.overallWinRate).toBe(50);
		expect(dashboard.games.find((game) => game.gameType === 'craps')).toMatchObject({
			handsPlayed: 5,
			winRate: 50,
		});
	});

	test('ignores unknown rows and retains the canonical dashboard shape', () => {
		const dashboard = buildPlayerStatisticsDashboard([
			row({ gameType: 'unsupported-game', totalWins: 99, handsPlayed: 99 }),
		]);

		expect(dashboard.games.map((game) => game.gameType)).toEqual([...GAME_TYPES]);
		expect(dashboard.summary.totalHands).toBe(0);
	});

	test('throws on duplicate canonical rows', () => {
		const blackjack = row({
			gameType: 'blackjack',
			totalWins: 1,
			handsPlayed: 1,
			biggestWin: 10,
			netProfit: 10,
		});

		expect(() => buildPlayerStatisticsDashboard([blackjack, blackjack])).toThrow(
			PlayerStatisticsIntegrityError,
		);
	});

	test('uses null for missing ranks and any zero-hand game rank', () => {
		const dashboard = buildPlayerStatisticsDashboard(
			[
				row({ gameType: 'blackjack', totalWins: 1, handsPlayed: 1 }),
				row({ gameType: 'baccarat', totalWins: 1, handsPlayed: 0 }),
			],
			new Map([['baccarat', 3]]),
		);

		expect(dashboard.games.find((game) => game.gameType === 'blackjack')?.winsRank).toBeNull();
		expect(dashboard.games.find((game) => game.gameType === 'baccarat')?.winsRank).toBeNull();
	});

	test('keeps numeric wins ranks for active games with zero wins', () => {
		const dashboard = buildPlayerStatisticsDashboard(
			[row({ gameType: 'roulette', totalLosses: 2, handsPlayed: 2 })],
			new Map([['roulette', 8]]),
		);

		expect(dashboard.games.find((game) => game.gameType === 'roulette')).toMatchObject({
			totalWins: 0,
			handsPlayed: 2,
			winsRank: 8,
		});
	});
});

type PlayerStatisticsService = {
	getPlayerStatisticsSummary(db: Database, userId: string): Promise<PlayerStatisticsSummary>;
	getPlayerStatisticsDashboard(db: Database, userId: string): Promise<PlayerStatisticsDashboard>;
};

type PlayerStatisticsServiceFactory = (overrides: {
	getAllUserGameStats: (db: Database, userId: string) => Promise<GameStats[]>;
	getBulkUserWinsRanks: (db: Database, userId: string) => Promise<Map<GameType, number>>;
}) => PlayerStatisticsService;

function serviceFactory(): PlayerStatisticsServiceFactory | undefined {
	return (playerStatistics as { createPlayerStatisticsService?: PlayerStatisticsServiceFactory })
		.createPlayerStatisticsService;
}

describe('createPlayerStatisticsService', () => {
	test('summary reads rows without loading ranks and returns the canonical summary', async () => {
		const factory = serviceFactory();
		expect(typeof factory).toBe('function');
		if (!factory) return;

		let rankRead = false;
		const service = factory({
			getAllUserGameStats: async () => [
				row({
					gameType: 'blackjack',
					totalWins: 3,
					totalLosses: 1,
					handsPlayed: 4,
					biggestWin: 30,
					netProfit: 20,
				}),
			],
			getBulkUserWinsRanks: async () => {
				rankRead = true;
				throw new Error('summary must not load ranks');
			},
		});

		await expect(service.getPlayerStatisticsSummary({} as Database, 'user-1')).resolves.toEqual({
			totalHands: 4,
			totalWins: 3,
			totalLosses: 1,
			overallWinRate: 75,
			totalNetProfit: 20,
			mostPlayedGame: 'blackjack',
		});
		expect(rankRead).toBe(false);
	});

	test('dashboard starts row and rank reads before either resolves', async () => {
		const factory = serviceFactory();
		expect(typeof factory).toBe('function');
		if (!factory) return;

		const started: string[] = [];
		let resolveRows!: (rows: GameStats[]) => void;
		let resolveRanks!: (ranks: Map<GameType, number>) => void;
		const rows = new Promise<GameStats[]>((resolve) => {
			resolveRows = resolve;
		});
		const ranks = new Promise<Map<GameType, number>>((resolve) => {
			resolveRanks = resolve;
		});
		const service = factory({
			getAllUserGameStats: async () => {
				started.push('rows');
				return rows;
			},
			getBulkUserWinsRanks: async () => {
				started.push('ranks');
				return ranks;
			},
		});

		const dashboard = service.getPlayerStatisticsDashboard({} as Database, 'user-1');
		expect(started).toEqual(['rows', 'ranks']);
		resolveRows([row({ gameType: 'roulette', totalWins: 2, handsPlayed: 2 })]);
		resolveRanks(new Map([['roulette', 4]]));

		const result = await dashboard;
		expect(result.summary).toMatchObject({
			totalHands: 2,
			totalWins: 2,
			overallWinRate: 100,
		});
		expect(result.games.find((game) => game.gameType === 'roulette')).toMatchObject({
			gameType: 'roulette',
			winsRank: 4,
		});
	});

	test('propagates row and rank read failures', async () => {
		const factory = serviceFactory();
		expect(typeof factory).toBe('function');
		if (!factory) return;

		const rowFailure = new Error('rows unavailable');
		const rankFailure = new Error('ranks unavailable');
		const rowFailureService = factory({
			getAllUserGameStats: async () => {
				throw rowFailure;
			},
			getBulkUserWinsRanks: async () => new Map(),
		});
		const rankFailureService = factory({
			getAllUserGameStats: async () => [],
			getBulkUserWinsRanks: async () => {
				throw rankFailure;
			},
		});

		await expect(
			rowFailureService.getPlayerStatisticsSummary({} as Database, 'user-1'),
		).rejects.toBe(rowFailure);
		await expect(
			rankFailureService.getPlayerStatisticsDashboard({} as Database, 'user-1'),
		).rejects.toBe(rankFailure);
	});
});
