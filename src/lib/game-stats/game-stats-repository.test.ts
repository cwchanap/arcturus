/**
 * Game Stats Repository Tests
 *
 * Tests for database operations in game-stats-repository.ts
 */

import { describe, expect, test } from 'bun:test';
import {
	getUserGameRank,
	getTotalPlayersForGame,
	updateGameStats,
} from './game-stats-repository';
import type { Database } from '../db';
import type { GameType, RankingMetric } from './types';
import { MIN_HANDS_FOR_WIN_RATE } from './constants';

/**
 * Mock database implementation that simulates Drizzle ORM query chains
 */
function createMockDb({
	userStats = null,
	allStats = [],
	defaultCount = 0,
	countResolver,
}: {
	userStats: any;
	allStats: any[];
	defaultCount: number;
	countResolver?: (condition: unknown) => number;
}): Database {
	return {
		select: (columns?: any) => {
			// If selecting count, this is a count query
			const isCountQuery = columns?.count !== undefined;

			return {
				from: (table: any) => {
					return {
						where: (condition: any) => {
							if (isCountQuery) {
								// Count query: return a promise that resolves to an array with count
								const count = countResolver ? countResolver(condition) : defaultCount;
								return Promise.resolve([{ count }]);
							}

							// getGameStats query pattern: return { limit() }
							return {
								limit: (limit: number) => {
									return Promise.resolve(userStats ? [userStats] : []);
								},
							};
						},
						orderBy: () => ({
							limit: () => {
								return Promise.resolve([]);
							},
						}),
					};
				},
				innerJoin: () => {
					return {
						where: () => ({
							orderBy: () => ({
								limit: () => {
									return Promise.resolve(allStats);
								},
							}),
						}),
					};
				},
			};
		},
	} as unknown as Database;
}

describe('getUserGameRank', () => {
	test('returns null when user has no game stats', async () => {
		// User does not exist in the database
		const mockDb = createMockDb({
			userStats: null,
			allStats: [],
			defaultCount: 0,
		});

		const result = await getUserGameRank(
			mockDb,
			'nonexistent-user',
			'blackjack' as GameType,
			'wins',
		);
		expect(result).toBeNull();
	});

	test('calculates rank correctly for wins metric', async () => {
		// User has 50 wins, 2 users have more (100 and 75 wins)
		const mockDb = createMockDb({
			userStats: {
				userId: 'user1',
				gameType: 'blackjack',
				totalWins: 50,
				totalLosses: 30,
				handsPlayed: 80,
				biggestWin: 500,
				netProfit: 200,
				updatedAt: new Date(),
			},
			allStats: [],
			defaultCount: 2, // 2 users have more wins (100 and 75)
		});

		const result = await getUserGameRank(mockDb, 'user1', 'blackjack' as GameType, 'wins');
		expect(result).toBe(3); // Rank 3 (2 users ranked higher + 1)
	});

	test('calculates rank correctly for net_profit metric', async () => {
		// User has net profit of 500, 3 users have higher profits
		const mockDb = createMockDb({
			userStats: {
				userId: 'user1',
				gameType: 'poker',
				totalWins: 10,
				totalLosses: 8,
				handsPlayed: 18,
				biggestWin: 300,
				netProfit: 500,
				updatedAt: new Date(),
			},
			allStats: [],
			defaultCount: 3, // 3 users have higher profits
		});

		const result = await getUserGameRank(mockDb, 'user1', 'poker' as GameType, 'net_profit');
		expect(result).toBe(4); // Rank 4 (3 users ranked higher + 1)
	});

	test('calculates rank correctly for biggest_win metric', async () => {
		// User has biggest win of 1000, 1 user has a bigger win
		const mockDb = createMockDb({
			userStats: {
				userId: 'user1',
				gameType: 'baccarat',
				totalWins: 5,
				totalLosses: 5,
				handsPlayed: 10,
				biggestWin: 1000,
				netProfit: 0,
				updatedAt: new Date(),
			},
			allStats: [],
			defaultCount: 1, // 1 user has a bigger win
		});

		const result = await getUserGameRank(mockDb, 'user1', 'baccarat' as GameType, 'biggest_win');
		expect(result).toBe(2); // Rank 2 (1 user ranked higher + 1)
	});

	test('returns null for win_rate when user has no decided games (all pushes)', async () => {
		// User has 10 hands but all are pushes (0 wins, 0 losses)
		// totalDecidedGames = 0, userWinRate = null, rank should be null
		const mockDb = createMockDb({
			userStats: {
				userId: 'user1',
				gameType: 'blackjack',
				totalWins: 0,
				totalLosses: 0,
				handsPlayed: 10,
				biggestWin: 0,
				netProfit: 0,
				updatedAt: new Date(),
			},
			allStats: [],
			defaultCount: 0,
		});

		const result = await getUserGameRank(mockDb, 'user1', 'blackjack' as GameType, 'win_rate');
		expect(result).toBeNull(); // Cannot rank when totalDecidedGames === 0
	});

	test('returns null for win_rate when user has insufficient hands', async () => {
		// User has 5 wins, 3 losses, but only 8 hands (below MIN_HANDS_FOR_WIN_RATE = 10)
		const mockDb = createMockDb({
			userStats: {
				userId: 'user1',
				gameType: 'poker',
				totalWins: 5,
				totalLosses: 3,
				handsPlayed: 8, // Below threshold
				biggestWin: 200,
				netProfit: 100,
				updatedAt: new Date(),
			},
			allStats: [],
			defaultCount: 0,
		});

		const result = await getUserGameRank(mockDb, 'user1', 'poker' as GameType, 'win_rate');
		expect(result).toBeNull(); // Not enough hands to qualify for ranking
	});

	test('calculates rank correctly for win_rate with decided games', async () => {
		// User has 5 wins, 5 losses, 12 hands (10 decided, meets threshold)
		// Win rate = 5/10 = 50%, assume 1 user has higher win rate
		const mockDb = createMockDb({
			userStats: {
				userId: 'user1',
				gameType: 'blackjack',
				totalWins: 5,
				totalLosses: 5,
				handsPlayed: 12,
				biggestWin: 500,
				netProfit: 200,
				updatedAt: new Date(),
			},
			allStats: [],
			defaultCount: 1, // 1 user has higher win rate
		});

		const result = await getUserGameRank(mockDb, 'user1', 'blackjack' as GameType, 'win_rate');
		expect(result).toBe(2); // Rank 2 (1 user ranked higher + 1)
	});
});

describe('getUserGameRank - win_rate edge cases', () => {
	// These tests document the specific fix for the edge case where
	// totalDecidedGames === 0 causes incorrect rank 1 to be returned

	test('edge case: 10 hands played, all pushes (0 wins, 0 losses)', async () => {
		// Scenario: User plays 10 hands, all are pushes
		// Expected: totalDecidedGames = 0, userWinRate = null, rank = null (unrankable)
		// The fix ensures this returns null instead of incorrectly returning rank 1

		const mockDb = createMockDb({
			userStats: {
				userId: 'user1',
				gameType: 'blackjack',
				totalWins: 0,
				totalLosses: 0,
				handsPlayed: 10, // Meets MIN_HANDS_FOR_WIN_RATE threshold
				biggestWin: 0,
				netProfit: 0,
				updatedAt: new Date(),
			},
			allStats: [],
			defaultCount: 0,
		});

		const result = await getUserGameRank(mockDb, 'user1', 'blackjack' as GameType, 'win_rate');
		expect(result).toBeNull(); // The fix ensures getUserGameRank returns null in this case
	});

	test('edge case: 15 hands played, all pushes (0 wins, 0 losses)', async () => {
		// Same scenario with different hand count
		const mockDb = createMockDb({
			userStats: {
				userId: 'user1',
				gameType: 'poker',
				totalWins: 0,
				totalLosses: 0,
				handsPlayed: 15,
				biggestWin: 0,
				netProfit: 0,
				updatedAt: new Date(),
			},
			allStats: [],
			defaultCount: 0,
		});

		const result = await getUserGameRank(mockDb, 'user1', 'poker' as GameType, 'win_rate');
		expect(result).toBeNull();
	});

	test('normal case: 10 hands, 5 wins, 5 losses, 0 pushes', async () => {
		// Normal scenario with decided games - should return a valid rank
		const mockDb = createMockDb({
			userStats: {
				userId: 'user1',
				gameType: 'blackjack',
				totalWins: 5,
				totalLosses: 5,
				handsPlayed: 10,
				biggestWin: 500,
				netProfit: 200,
				updatedAt: new Date(),
			},
			allStats: [],
			defaultCount: 2, // Assume 2 users have higher win rate
		});

		const result = await getUserGameRank(mockDb, 'user1', 'blackjack' as GameType, 'win_rate');
		expect(result).toBe(3); // Rank 3 (2 users ranked higher + 1)
	});

	test('edge case: 10 hands, 1 win, 0 losses, 9 pushes', async () => {
		// Scenario: User plays 10 hands, but only 1 decided game (1 win, 0 losses)
		// Expected: totalDecidedGames = 1, which is < MIN_HANDS_FOR_WIN_RATE (10)
		// Result: rank = null (unrankable) - prevents push-heavy outliers
		// This is the fix for the review comment issue

		const mockDb = createMockDb({
			userStats: {
				userId: 'user1',
				gameType: 'blackjack',
				totalWins: 1,
				totalLosses: 0,
				handsPlayed: 10, // Would qualify under old logic
				biggestWin: 100,
				netProfit: 100,
				updatedAt: new Date(),
			},
			allStats: [],
			defaultCount: 0,
		});

		const result = await getUserGameRank(mockDb, 'user1', 'blackjack' as GameType, 'win_rate');
		expect(result).toBeNull(); // Should be null due to insufficient decided games
	});

	test('edge case: exactly 10 decided hands, 10 wins, 0 pushes', async () => {
		// Scenario: User plays exactly MIN_HANDS_FOR_WIN_RATE decided hands
		// Expected: qualifies with 100% win rate (10 wins, 0 losses)

		const mockDb = createMockDb({
			userStats: {
				userId: 'user1',
				gameType: 'blackjack',
				totalWins: 10,
				totalLosses: 0,
				handsPlayed: 10, // Exactly the threshold
				biggestWin: 200,
				netProfit: 1000,
				updatedAt: new Date(),
			},
			allStats: [],
			defaultCount: 2, // 2 users have higher win rate
		});

		const result = await getUserGameRank(mockDb, 'user1', 'blackjack' as GameType, 'win_rate');
		expect(result).toBe(3); // Rank 3 (2 users ranked higher + 1)
	});
});

function extractSqlText(value: unknown): string {
	if (value && typeof value === 'object' && 'queryChunks' in value) {
		return (value as { queryChunks: unknown[] }).queryChunks.map((chunk) => String(chunk)).join('');
	}

	const serialized = JSON.stringify(value);
	if (serialized && serialized !== '{}') {
		return serialized;
	}

	return String(value ?? '');
}

describe('getTotalPlayersForGame', () => {
	test('returns total players for win-rate queries', async () => {
		const mockDb = createMockDb({
			userStats: null,
			allStats: [],
			defaultCount: 0,
			countResolver: (condition) => {
				void condition;
				return 7;
			},
		});

		const total = await getTotalPlayersForGame(mockDb, 'blackjack' as GameType, 'win_rate');
		expect(total).toBe(7);
	});
});

describe('updateGameStats', () => {
	test('uses different biggestWin updates for aggregated vs single-round', async () => {
		let captured: Record<string, unknown> | null = null;

		const mockDb = {
			insert: () => ({
				values: () => ({
					onConflictDoNothing: () => Promise.resolve(),
				}),
			}),
			update: () => ({
				set: (values: Record<string, unknown>) => {
					captured = values;
					return {
						where: () => Promise.resolve(),
					};
				},
			}),
		} as unknown as Database;

		await updateGameStats(mockDb, 'user1', 'blackjack' as GameType, {
			winsIncrement: 1,
			lossesIncrement: 0,
			handsIncrement: 2,
			chipDelta: 100,
			biggestWinCandidate: null,
		});

		const aggregatedText = extractSqlText(captured?.biggestWin);

		await updateGameStats(mockDb, 'user1', 'blackjack' as GameType, {
			winsIncrement: 1,
			lossesIncrement: 0,
			handsIncrement: 1,
			chipDelta: 20,
			biggestWinCandidate: 200,
		});

		const singleRoundText = extractSqlText(captured?.biggestWin);
		expect(aggregatedText).not.toBe(singleRoundText);
	});
});
