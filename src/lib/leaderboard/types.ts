/**
 * Leaderboard Domain Types
 *
 * Defines the core entities and interfaces for the leaderboard feature.
 */

/**
 * A single entry in the leaderboard representing a player's ranking
 */
export interface LeaderboardEntry {
	rank: number;
	userId: string;
	playerName: string;
	chipBalance: number;
	isCurrentUser: boolean;
}

/**
 * Complete leaderboard data returned to the UI
 */
export interface LeaderboardData {
	entries: LeaderboardEntry[];
	currentUserRank: number | null;
	currentUserInTop: boolean;
	totalPlayers: number;
}

/**
 * Raw player data from database query
 */
export interface RawPlayerData {
	userId: string;
	playerName: string;
	chipBalance: number;
}

/**
 * Options for fetching leaderboard data
 */
export interface LeaderboardOptions {
	limit?: number;
	currentUserId?: string | null;
}

export const DEFAULT_LEADERBOARD_LIMIT = 50;
