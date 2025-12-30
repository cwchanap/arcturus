/**
 * Leaderboard Repository
 *
 * Handles all database operations for the leaderboard feature.
 * Uses Drizzle ORM with Cloudflare D1.
 */

import { desc, sql, eq, or, and, gt, lt } from 'drizzle-orm';
import { user } from '../../db/schema';
import type { Database } from '../db';
import type { RawPlayerData } from './types';

/**
 * Fetches the top players ordered by chip balance (descending).
 * Uses user ID as a secondary sort for deterministic tie-breaking.
 */
export async function getTopPlayers(db: Database, limit: number): Promise<RawPlayerData[]> {
	const results = await db
		.select({
			userId: user.id,
			playerName: user.name,
			chipBalance: user.chipBalance,
		})
		.from(user)
		.orderBy(desc(user.chipBalance), user.id)
		.limit(limit);

	return results;
}

/**
 * Calculates a user's rank based on their chip balance.
 * Rank is determined by counting users with higher balances.
 * Tie-breaking uses user ID for consistency.
 *
 * @returns The user's rank (1-indexed), or null if user not found
 */
export async function getUserRank(db: Database, userId: string): Promise<number | null> {
	// First get the user's chip balance
	const [currentUser] = await db
		.select({ chipBalance: user.chipBalance })
		.from(user)
		.where(eq(user.id, userId))
		.limit(1);

	if (!currentUser) {
		return null;
	}

	// Count users with higher balance, or same balance but lower ID (for tie-breaking)
	const [result] = await db
		.select({
			count: sql<number>`count(*)`.as('count'),
		})
		.from(user)
		.where(
			or(
				gt(user.chipBalance, currentUser.chipBalance),
				and(eq(user.chipBalance, currentUser.chipBalance), lt(user.id, userId)),
			),
		);

	const higherRankedCount = result?.count ?? 0;
	return higherRankedCount + 1;
}

/**
 * Gets the total number of players in the system.
 */
export async function getTotalPlayerCount(db: Database): Promise<number> {
	const [result] = await db.select({ count: sql<number>`count(*)`.as('count') }).from(user);

	return result?.count ?? 0;
}
