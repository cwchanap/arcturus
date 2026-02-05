/**
 * Game Statistics Repository
 *
 * Database operations for game statistics.
 * Uses Drizzle ORM with Cloudflare D1.
 */

import { eq, and, desc, sql, gt, lt, or } from 'drizzle-orm';
import { gameStats, user } from '../../db/schema';
import type { Database } from '../db';
import type { GameType, GameStats, RankingMetric } from './types';
import { MIN_HANDS_FOR_WIN_RATE } from './constants';

/**
 * Raw player data from game stats query
 */
export interface RawGameStatsPlayer {
	userId: string;
	playerName: string;
	totalWins: number;
	totalLosses: number;
	handsPlayed: number;
	biggestWin: number;
	netProfit: number;
}

/**
 * Get game stats for a specific user and game type
 */
export async function getGameStats(
	db: Database,
	userId: string,
	gameType: GameType,
): Promise<GameStats | null> {
	const [result] = await db
		.select()
		.from(gameStats)
		.where(and(eq(gameStats.userId, userId), eq(gameStats.gameType, gameType)))
		.limit(1);

	if (!result) return null;

	return {
		userId: result.userId,
		gameType: result.gameType as GameType,
		totalWins: result.totalWins,
		totalLosses: result.totalLosses,
		handsPlayed: result.handsPlayed,
		biggestWin: result.biggestWin,
		netProfit: result.netProfit,
		updatedAt: result.updatedAt,
	};
}

/**
 * Get all game stats for a user (all games)
 */
export async function getAllUserGameStats(db: Database, userId: string): Promise<GameStats[]> {
	const results = await db.select().from(gameStats).where(eq(gameStats.userId, userId));

	return results.map((result) => ({
		userId: result.userId,
		gameType: result.gameType as GameType,
		totalWins: result.totalWins,
		totalLosses: result.totalLosses,
		handsPlayed: result.handsPlayed,
		biggestWin: result.biggestWin,
		netProfit: result.netProfit,
		updatedAt: result.updatedAt,
	}));
}

/**
 * Initialize game stats for a user (first time playing a game)
 */
export async function initializeGameStats(
	db: Database,
	userId: string,
	gameType: GameType,
): Promise<void> {
	const now = new Date();

	await db
		.insert(gameStats)
		.values({
			userId,
			gameType,
			totalWins: 0,
			totalLosses: 0,
			handsPlayed: 0,
			biggestWin: 0,
			netProfit: 0,
			updatedAt: now,
		})
		.onConflictDoNothing();
}

/**
 * Update game stats atomically after a round
 */
export async function updateGameStats(
	db: Database,
	userId: string,
	gameType: GameType,
	update: {
		winsIncrement: number;
		lossesIncrement: number;
		handsIncrement: number;
		chipDelta: number;
		biggestWinCandidate?: number | null;
	},
): Promise<void> {
	const now = new Date();
	const biggestWinCandidate =
		update.biggestWinCandidate === undefined ? update.chipDelta : update.biggestWinCandidate;
	const biggestWinUpdate =
		biggestWinCandidate === null
			? sql`${gameStats.biggestWin}`
			: sql`CASE
				WHEN ${biggestWinCandidate} > 0 AND ${biggestWinCandidate} > ${gameStats.biggestWin}
				THEN ${biggestWinCandidate}
				ELSE ${gameStats.biggestWin}
			END`;

	// Ensure stats record exists
	await initializeGameStats(db, userId, gameType);

	// Atomic update using SQL increments - compute biggestWin atomically to avoid race conditions
	// Note: SQLite doesn't support GREATEST(), so we use a CASE statement instead
	await db
		.update(gameStats)
		.set({
			totalWins: sql`${gameStats.totalWins} + ${update.winsIncrement}`,
			totalLosses: sql`${gameStats.totalLosses} + ${update.lossesIncrement}`,
			handsPlayed: sql`${gameStats.handsPlayed} + ${update.handsIncrement}`,
			biggestWin: biggestWinUpdate,
			netProfit: sql`${gameStats.netProfit} + ${update.chipDelta}`,
			updatedAt: now,
		})
		.where(and(eq(gameStats.userId, userId), eq(gameStats.gameType, gameType)));
}

/**
 * Get top players for a specific game and ranking metric
 */
export async function getTopPlayersForGame(
	db: Database,
	gameType: GameType,
	rankingMetric: RankingMetric,
	limit: number,
): Promise<RawGameStatsPlayer[]> {
	// Build order by clause based on ranking metric
	let orderByClause;

	switch (rankingMetric) {
		case 'wins':
			orderByClause = desc(gameStats.totalWins);
			break;
		case 'win_rate':
			// Order by calculated win rate, but require minimum hands
			// Use NULLIF to prevent division by zero
			orderByClause = desc(
				sql`CAST(${gameStats.totalWins} AS REAL) / NULLIF(${gameStats.totalWins} + ${gameStats.totalLosses}, 0)`,
			);
			break;
		case 'biggest_win':
			orderByClause = desc(gameStats.biggestWin);
			break;
		case 'net_profit':
			orderByClause = desc(gameStats.netProfit);
			break;
	}

	// Build where clause - filter out players with insufficient decided hands for win_rate
	// Use totalWins + totalLosses (decided games) instead of handsPlayed to exclude push-heavy records
	const whereClause =
		rankingMetric === 'win_rate'
			? and(
					eq(gameStats.gameType, gameType),
					sql`(${gameStats.totalWins} + ${gameStats.totalLosses}) >= ${MIN_HANDS_FOR_WIN_RATE}`,
				)
			: eq(gameStats.gameType, gameType);

	const results = await db
		.select({
			userId: gameStats.userId,
			playerName: user.name,
			totalWins: gameStats.totalWins,
			totalLosses: gameStats.totalLosses,
			handsPlayed: gameStats.handsPlayed,
			biggestWin: gameStats.biggestWin,
			netProfit: gameStats.netProfit,
		})
		.from(gameStats)
		.innerJoin(user, eq(gameStats.userId, user.id))
		.where(whereClause)
		.orderBy(orderByClause, user.id) // Secondary sort by user ID for determinism
		.limit(limit);

	return results;
}

/**
 * Get user's rank for a specific game and metric
 */
export async function getUserGameRank(
	db: Database,
	userId: string,
	gameType: GameType,
	rankingMetric: RankingMetric,
): Promise<number | null> {
	const userStats = await getGameStats(db, userId, gameType);
	if (!userStats) return null;

	// Count users ranked higher based on the metric
	let countCondition;

	switch (rankingMetric) {
		case 'wins':
			countCondition = or(
				gt(gameStats.totalWins, userStats.totalWins),
				and(eq(gameStats.totalWins, userStats.totalWins), lt(gameStats.userId, userId)),
			);
			break;
		case 'biggest_win':
			countCondition = or(
				gt(gameStats.biggestWin, userStats.biggestWin),
				and(eq(gameStats.biggestWin, userStats.biggestWin), lt(gameStats.userId, userId)),
			);
			break;
		case 'net_profit':
			countCondition = or(
				gt(gameStats.netProfit, userStats.netProfit),
				and(eq(gameStats.netProfit, userStats.netProfit), lt(gameStats.userId, userId)),
			);
			break;
		case 'win_rate': {
			// Users must meet minimum decided hands threshold to qualify for win rate ranking
			// Use totalWins + totalLosses (decided games) instead of handsPlayed to exclude push-heavy records
			const totalDecidedGames = userStats.totalWins + userStats.totalLosses;
			if (totalDecidedGames < MIN_HANDS_FOR_WIN_RATE) {
				return null;
			}

			const userWinRateSql = sql`CAST(${userStats.totalWins} AS REAL) / NULLIF(${userStats.totalWins} + ${userStats.totalLosses}, 0)`;

			// For win rate, we need a more complex comparison
			// Users with higher win rate rank higher, tie-break by userId
			const [result] = await db
				.select({
					count: sql<number>`count(*)`.as('count'),
				})
				.from(gameStats)
				.where(
					and(
						eq(gameStats.gameType, gameType),
						sql`(${gameStats.totalWins} + ${gameStats.totalLosses}) >= ${MIN_HANDS_FOR_WIN_RATE}`,
						or(
							sql`CAST(${gameStats.totalWins} AS REAL) / NULLIF(${gameStats.totalWins} + ${gameStats.totalLosses}, 0) > ${userWinRateSql}`,
							and(
								sql`CAST(${gameStats.totalWins} AS REAL) / NULLIF(${gameStats.totalWins} + ${gameStats.totalLosses}, 0) = ${userWinRateSql}`,
								lt(gameStats.userId, userId),
							),
						),
					),
				);

			return (result?.count ?? 0) + 1;
		}
	}

	const [result] = await db
		.select({
			count: sql<number>`count(*)`.as('count'),
		})
		.from(gameStats)
		.where(and(eq(gameStats.gameType, gameType), countCondition));

	return (result?.count ?? 0) + 1;
}

/**
 * Get total number of players for a specific game
 */
export async function getTotalPlayersForGame(
	db: Database,
	gameType: GameType,
	rankingMetric?: RankingMetric,
): Promise<number> {
	const whereClause =
		rankingMetric === 'win_rate'
			? and(
					eq(gameStats.gameType, gameType),
					sql`(${gameStats.totalWins} + ${gameStats.totalLosses}) >= ${MIN_HANDS_FOR_WIN_RATE}`,
				)
			: eq(gameStats.gameType, gameType);

	const [result] = await db
		.select({ count: sql<number>`count(*)`.as('count') })
		.from(gameStats)
		.where(whereClause);

	return result?.count ?? 0;
}

/**
 * Get aggregate stats across all games for a user
 */
export async function getAggregateUserStats(
	db: Database,
	userId: string,
): Promise<{
	totalWins: number;
	totalLosses: number;
	totalHandsPlayed: number;
	biggestWin: number;
	totalNetProfit: number;
}> {
	const allStats = await getAllUserGameStats(db, userId);

	return allStats.reduce(
		(acc, stats) => ({
			totalWins: acc.totalWins + stats.totalWins,
			totalLosses: acc.totalLosses + stats.totalLosses,
			totalHandsPlayed: acc.totalHandsPlayed + stats.handsPlayed,
			biggestWin: Math.max(acc.biggestWin, stats.biggestWin),
			totalNetProfit: acc.totalNetProfit + stats.netProfit,
		}),
		{
			totalWins: 0,
			totalLosses: 0,
			totalHandsPlayed: 0,
			biggestWin: 0,
			totalNetProfit: 0,
		},
	);
}
