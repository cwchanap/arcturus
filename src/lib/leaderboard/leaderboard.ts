/**
 * Leaderboard Business Logic
 *
 * Orchestrates leaderboard data retrieval and transformation.
 * This is the main entry point for leaderboard operations.
 */

import type { Database } from '../db';
import type { LeaderboardData, LeaderboardEntry, LeaderboardOptions, RawPlayerData } from './types';
import { DEFAULT_LEADERBOARD_LIMIT } from './types';
import { getTopPlayers, getUserRank, getTotalPlayerCount } from './leaderboard-repository';
import { getBulkUserAchievements } from '../achievements/achievement-repository';

/**
 * Checks if the current user appears in the provided leaderboard entries.
 *
 * @param entries - Array of leaderboard entries to search
 * @returns true if any entry has isCurrentUser set to true, false otherwise
 */
export function isCurrentUserInTop(entries: LeaderboardEntry[]): boolean {
	return entries.some((entry) => entry.isCurrentUser);
}

/**
 * Transforms raw player data into leaderboard entries with ranks and current user flag.
 * This is a pure function suitable for unit testing.
 *
 * @param rawPlayers - Array of raw player data from database
 * @param currentUserId - ID of the current user (or null if unauthenticated)
 * @returns Array of leaderboard entries with ranks
 */
export function transformToLeaderboardEntries(
	rawPlayers: RawPlayerData[],
	currentUserId: string | null = null,
	badgeMap: Map<string, string[]> = new Map(),
): LeaderboardEntry[] {
	return rawPlayers.map((player, index) => ({
		rank: index + 1,
		userId: player.userId,
		playerName: player.playerName,
		chipBalance: player.chipBalance,
		isCurrentUser: currentUserId ? player.userId === currentUserId : false,
		badges: badgeMap.get(player.userId) ?? [],
	}));
}

/**
 * Fetches complete leaderboard data including:
 * - Top N players ranked by chip balance
 * - Current user's rank (if authenticated)
 * - Whether current user appears in the top N
 *
 * @param db - Database instance
 * @param options - Configuration options
 * @returns Complete leaderboard data for UI rendering
 */
export async function getLeaderboardData(
	db: Database,
	options: LeaderboardOptions = {},
): Promise<LeaderboardData> {
	const { limit = DEFAULT_LEADERBOARD_LIMIT, currentUserId = null } = options;

	// Stage 1: fetch top players (userIds not known until this resolves)
	const rawPlayers = await getTopPlayers(db, limit);
	const userIds = rawPlayers.map((p) => p.userId);

	// Stage 2: parallel queries that depend on stage 1
	const [badgeMap, currentUserRank, totalPlayers] = await Promise.all([
		getBulkUserAchievements(db, userIds),
		currentUserId ? getUserRank(db, currentUserId) : Promise.resolve(null),
		getTotalPlayerCount(db),
	]);

	// Transform raw data into leaderboard entries with rank, current user flag, and badges
	const entries = transformToLeaderboardEntries(rawPlayers, currentUserId, badgeMap);

	// Check if current user appears in the displayed entries
	const currentUserInTop = isCurrentUserInTop(entries);

	return {
		entries,
		currentUserRank,
		currentUserInTop,
		totalPlayers,
	};
}

// Re-export types for convenience
export type { LeaderboardData, LeaderboardEntry, LeaderboardOptions, RawPlayerData } from './types';
export { DEFAULT_LEADERBOARD_LIMIT } from './types';
