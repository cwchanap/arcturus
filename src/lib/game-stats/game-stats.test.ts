import { describe, expect, mock, test } from 'bun:test';
import type { GameStats } from './types';
import {
	GAME_TYPES,
	RANKING_METRICS,
	isValidGameType,
	isValidRankingMetric,
	GAME_TYPE_LABELS,
	RANKING_METRIC_LABELS,
} from './constants';

const mockUpdateGameStats = Object.assign(
	async (_db: unknown, _userId: string, _gameType: string, update: any) => {
		mockUpdateGameStats.calls.push(update);
	},
	{ calls: [] as any[] },
);

const defaultPlayers = [
	{
		userId: 'user1',
		playerName: 'Alice',
		totalWins: 10,
		totalLosses: 5,
		handsPlayed: 20,
		biggestWin: 500,
		netProfit: 200,
	},
	{
		userId: 'user2',
		playerName: 'Bob',
		totalWins: 8,
		totalLosses: 7,
		handsPlayed: 20,
		biggestWin: 300,
		netProfit: 100,
	},
];

const mockGetTopPlayersForGame = Object.assign(async () => defaultPlayers, {
	calls: [] as any[],
	impl: async () => defaultPlayers,
});

const mockGetUserGameRank = Object.assign(async () => 2, {
	calls: [] as any[],
	impl: async () => 2,
});
const mockGetTotalPlayersForGame = Object.assign(async () => 10, {
	calls: [] as any[],
	impl: async () => 10,
});
const mockGetAllUserGameStats = Object.assign(async (): Promise<GameStats[]> => [], {
	calls: [] as any[],
	impl: async (): Promise<GameStats[]> => [],
});

mock.module('./game-stats-repository', () => ({
	getAllUserGameStats: async (...args: unknown[]) => {
		mockGetAllUserGameStats.calls.push(args);
		return mockGetAllUserGameStats.impl();
	},
	updateGameStats: async (db: unknown, userId: string, gameType: string, update: unknown) => {
		return mockUpdateGameStats(db, userId, gameType, update);
	},
	getTopPlayersForGame: async (...args: unknown[]) => {
		mockGetTopPlayersForGame.calls.push(args);
		return mockGetTopPlayersForGame.impl();
	},
	getUserGameRank: async (...args: unknown[]) => {
		mockGetUserGameRank.calls.push(args);
		return mockGetUserGameRank.impl();
	},
	getTotalPlayersForGame: async (...args: unknown[]) => {
		mockGetTotalPlayersForGame.calls.push(args);
		return mockGetTotalPlayersForGame.impl();
	},
}));

const gameStatsModule = await import('./game-stats');
const { calculateMetrics, recordGameRound, getGameLeaderboardData, getUserStatsAllGames } =
	gameStatsModule;

function resetGameStatsMocks() {
	mockUpdateGameStats.calls = [];
	mockGetTopPlayersForGame.calls = [];
	mockGetUserGameRank.calls = [];
	mockGetTotalPlayersForGame.calls = [];
	mockGetAllUserGameStats.calls = [];
	mockGetTopPlayersForGame.impl = async () => defaultPlayers;
	mockGetUserGameRank.impl = async () => 2;
	mockGetTotalPlayersForGame.impl = async () => 10;
	mockGetAllUserGameStats.impl = async () => [];
}

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

	test('calculates win rate based on decided hands only', () => {
		// Player with 10 hands: 6 wins, 4 pushes
		// handsPlayed = 10 (total hands played)
		// totalWins + totalLosses = 6 (decided games only)
		// win rate = 6/6 = 100%
		// Note: This player would NOT qualify for win-rate leaderboard under the new eligibility rules
		// because totalWins + totalLosses (6) < MIN_HANDS_FOR_WIN_RATE (10)
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

describe('recordGameRound', () => {
	test('derives win/loss increments from outcome', async () => {
		resetGameStatsMocks();
		await recordGameRound({} as any, 'user1', {
			gameType: 'blackjack',
			outcome: 'win',
			chipDelta: 50,
		});

		expect(mockUpdateGameStats.calls.length).toBe(1);
		expect(mockUpdateGameStats.calls[0]).toMatchObject({
			winsIncrement: 1,
			lossesIncrement: 0,
			handsIncrement: 1,
			chipDelta: 50,
		});
	});

	test('uses provided split-hand increments and biggest win candidate', async () => {
		resetGameStatsMocks();
		await recordGameRound({} as any, 'user1', {
			gameType: 'blackjack',
			outcome: 'loss',
			chipDelta: -20,
			handCount: 2,
			winsIncrement: 1,
			lossesIncrement: 1,
			biggestWinCandidate: 150,
		});

		expect(mockUpdateGameStats.calls[0]).toMatchObject({
			winsIncrement: 1,
			lossesIncrement: 1,
			handsIncrement: 2,
			chipDelta: -20,
			biggestWinCandidate: 150,
		});
	});
});

describe('getGameLeaderboardData', () => {
	test('returns leaderboard data with current user rank', async () => {
		resetGameStatsMocks();
		const result = await getGameLeaderboardData({} as any, {
			gameType: 'blackjack',
			rankingMetric: 'wins',
			currentUserId: 'user1',
			limit: 2,
		});

		expect(result.entries.length).toBe(2);
		expect(result.currentUserRank).toBe(2);
		expect(result.currentUserInTop).toBe(true);
		expect(result.totalPlayers).toBe(10);
	});

	test('handles null current user', async () => {
		resetGameStatsMocks();
		const result = await getGameLeaderboardData({} as any, {
			gameType: 'blackjack',
			rankingMetric: 'net_profit',
			currentUserId: null,
		});

		expect(result.currentUserRank).toBeNull();
		expect(result.currentUserInTop).toBe(false);
	});

	test('calculates win_rate metric values for leaderboard entries', async () => {
		resetGameStatsMocks();
		const result = await getGameLeaderboardData({} as any, {
			gameType: 'blackjack',
			rankingMetric: 'win_rate',
			currentUserId: 'user1',
			limit: 2,
		});

		expect(result.entries.length).toBe(2);
		expect(result.entries[0].metricValue).toBeCloseTo(66.666, 2);
		expect(result.entries[1].metricValue).toBeCloseTo(53.333, 2);
	});
});

describe('getUserStatsAllGames', () => {
	test('calculates metrics for all stats', async () => {
		resetGameStatsMocks();
		mockGetAllUserGameStats.impl = async () => [
			{
				userId: 'user1',
				gameType: 'blackjack',
				totalWins: 2,
				totalLosses: 2,
				handsPlayed: 4,
				biggestWin: 100,
				netProfit: 10,
				updatedAt: new Date(),
			},
		];

		const stats = await getUserStatsAllGames({} as any, 'user1');
		expect(stats[0].winRate).toBe(50);
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
