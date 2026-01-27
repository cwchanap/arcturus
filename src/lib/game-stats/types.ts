/**
 * Game Statistics Domain Types
 *
 * Defines core entities and interfaces for tracking game performance.
 */

import type { GAME_TYPES, RANKING_METRICS } from './constants';

/**
 * Valid game type identifiers
 */
export type GameType = (typeof GAME_TYPES)[number];

/**
 * Valid ranking metrics for game leaderboards
 */
export type RankingMetric = (typeof RANKING_METRICS)[number];

/**
 * Outcome of a single game round
 */
export type GameRoundOutcome = 'win' | 'loss' | 'push';

/**
 * Game statistics for a specific user and game type
 */
export interface GameStats {
	userId: string;
	gameType: GameType;
	totalWins: number;
	totalLosses: number;
	handsPlayed: number;
	biggestWin: number;
	netProfit: number;
	updatedAt: Date;
}

/**
 * Payload for recording a game round
 */
export interface GameRoundRecord {
	gameType: GameType;
	outcome: GameRoundOutcome;
	chipDelta: number;
	handCount?: number; // For split hands in blackjack
	winsIncrement?: number; // For split-hand accuracy: number of wins in this round
	lossesIncrement?: number; // For split-hand accuracy: number of losses in this round
	biggestWinCandidate?: number | null; // Optional per-round win amount for biggestWin updates
}

/**
 * Game statistics with computed metrics
 */
export interface GameStatsWithMetrics extends GameStats {
	winRate: number; // Percentage (0-100)
}

/**
 * Game-specific leaderboard entry
 */
export interface GameLeaderboardEntry {
	rank: number;
	userId: string;
	playerName: string;
	gameType: GameType;
	metricValue: number;
	totalWins: number;
	handsPlayed: number;
	winRate: number;
	isCurrentUser: boolean;
}

/**
 * Options for fetching game leaderboards
 */
export interface GameLeaderboardOptions {
	gameType: GameType;
	rankingMetric: RankingMetric;
	limit?: number;
	currentUserId?: string | null;
}

/**
 * Complete game leaderboard data for UI
 */
export interface GameLeaderboardData {
	gameType: GameType;
	rankingMetric: RankingMetric;
	entries: GameLeaderboardEntry[];
	currentUserRank: number | null;
	currentUserInTop: boolean;
	totalPlayers: number;
}
