/**
 * Game Statistics Business Logic
 *
 * Orchestrates game stats tracking and leaderboard generation.
 * This is the main entry point for game statistics operations.
 */

import type { Database } from '../db';
import type {
	GameType,
	GameRoundRecord,
	GameStats,
	GameStatsWithMetrics,
	GameLeaderboardData,
	GameLeaderboardEntry,
	GameLeaderboardOptions,
} from './types';
import { DEFAULT_GAME_LEADERBOARD_LIMIT } from './constants';
import {
	getAllUserGameStats,
	updateGameStats,
	getTopPlayersForGame,
	getUserGameRank,
	getTotalPlayersForGame,
} from './game-stats-repository';

/**
 * Calculate derived metrics from raw stats
 */
export function calculateMetrics(stats: GameStats): GameStatsWithMetrics {
	const totalDecided = stats.totalWins + stats.totalLosses;
	const winRate = totalDecided > 0 ? (stats.totalWins / totalDecided) * 100 : 0;

	return {
		...stats,
		winRate,
	};
}

/**
 * Record a game round outcome and update stats.
 * Called from the chip update endpoint after validating the chip change.
 */
export async function recordGameRound(
	db: Database,
	userId: string,
	record: GameRoundRecord,
): Promise<void> {
	const {
		gameType,
		outcome,
		chipDelta,
		handCount = 1,
		winsIncrement,
		lossesIncrement,
		biggestWinCandidate,
	} = record;

	// Convert outcome to stat increments
	// Use provided winsIncrement/lossesIncrement for split-hand accuracy,
	// otherwise derive from single outcome
	const actualWinsIncrement =
		winsIncrement !== undefined ? winsIncrement : outcome === 'win' ? 1 : 0;
	const actualLossesIncrement =
		lossesIncrement !== undefined ? lossesIncrement : outcome === 'loss' ? 1 : 0;
	// 'push' doesn't count as win or loss

	await updateGameStats(db, userId, gameType, {
		winsIncrement: actualWinsIncrement,
		lossesIncrement: actualLossesIncrement,
		handsIncrement: handCount,
		chipDelta,
		biggestWinCandidate:
			biggestWinCandidate !== undefined ? biggestWinCandidate : handCount > 1 ? null : chipDelta,
	});
}

/**
 * Transform raw player data into game leaderboard entries
 */
function transformToGameLeaderboardEntries(
	rawPlayers: Array<{
		userId: string;
		playerName: string;
		totalWins: number;
		totalLosses: number;
		handsPlayed: number;
		biggestWin: number;
		netProfit: number;
	}>,
	gameType: GameType,
	rankingMetric: string,
	currentUserId: string | null,
): GameLeaderboardEntry[] {
	return rawPlayers.map((player, index) => {
		// Calculate win rate
		const totalDecided = player.totalWins + player.totalLosses;
		const winRate = totalDecided > 0 ? (player.totalWins / totalDecided) * 100 : 0;

		// Determine metric value based on ranking metric
		let metricValue: number;
		switch (rankingMetric) {
			case 'wins':
				metricValue = player.totalWins;
				break;
			case 'win_rate':
				metricValue = winRate;
				break;
			case 'biggest_win':
				metricValue = player.biggestWin;
				break;
			case 'net_profit':
				metricValue = player.netProfit;
				break;
			default:
				throw new Error(`Unsupported ranking metric: ${rankingMetric}`);
		}

		return {
			rank: index + 1,
			userId: player.userId,
			playerName: player.playerName,
			gameType,
			metricValue,
			totalWins: player.totalWins,
			handsPlayed: player.handsPlayed,
			winRate,
			isCurrentUser: currentUserId ? player.userId === currentUserId : false,
		};
	});
}

/**
 * Check if current user appears in the provided leaderboard entries
 */
function isCurrentUserInTop(entries: GameLeaderboardEntry[]): boolean {
	return entries.some((entry) => entry.isCurrentUser);
}

/**
 * Get game-specific leaderboard data
 */
export async function getGameLeaderboardData(
	db: Database,
	options: GameLeaderboardOptions,
): Promise<GameLeaderboardData> {
	const {
		gameType,
		rankingMetric,
		limit = DEFAULT_GAME_LEADERBOARD_LIMIT,
		currentUserId = null,
	} = options;

	// Fetch data in parallel for better performance
	const [rawPlayers, currentUserRank, totalPlayers] = await Promise.all([
		getTopPlayersForGame(db, gameType, rankingMetric, limit),
		currentUserId
			? getUserGameRank(db, currentUserId, gameType, rankingMetric)
			: Promise.resolve(null),
		getTotalPlayersForGame(db, gameType, rankingMetric),
	]);

	// Transform raw data into leaderboard entries
	const entries = transformToGameLeaderboardEntries(
		rawPlayers,
		gameType,
		rankingMetric,
		currentUserId,
	);

	// Check if current user is in the displayed entries
	const currentUserInTop = isCurrentUserInTop(entries);

	return {
		gameType,
		rankingMetric,
		entries,
		currentUserRank,
		currentUserInTop,
		totalPlayers,
	};
}

/**
 * Get comprehensive stats for a user across all games
 */
export async function getUserStatsAllGames(
	db: Database,
	userId: string,
): Promise<GameStatsWithMetrics[]> {
	const allStats = await getAllUserGameStats(db, userId);
	return allStats.map(calculateMetrics);
}

// Re-export repository functions and types for convenience
export { getAllUserGameStats } from './game-stats-repository';
export type {
	GameType,
	GameRoundOutcome,
	GameRoundRecord,
	GameStats,
	GameStatsWithMetrics,
	GameLeaderboardData,
	GameLeaderboardEntry,
	GameLeaderboardOptions,
} from './types';
export {
	GAME_TYPES,
	RANKING_METRICS,
	GAME_TYPE_LABELS,
	RANKING_METRIC_LABELS,
	GAME_TYPE_ICONS,
	isValidGameType,
	isValidRankingMetric,
} from './constants';
