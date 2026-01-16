/**
 * Achievement Repository
 *
 * Database operations for user achievements.
 */

import { eq } from 'drizzle-orm';
import { userAchievement } from '../../db/schema';
import type { Database } from '../db';
import type { UserAchievementRecord } from './types';
import type { GameType } from '../game-stats/types';

/**
 * Get all achievements earned by a user
 */
export async function getUserAchievements(
	db: Database,
	userId: string,
): Promise<UserAchievementRecord[]> {
	const results = await db
		.select()
		.from(userAchievement)
		.where(eq(userAchievement.userId, userId))
		.orderBy(userAchievement.earnedAt);

	return results.map((r) => ({
		achievementId: r.achievementId,
		earnedAt: r.earnedAt,
		gameType: r.gameType as GameType | null,
	}));
}

/**
 * Get IDs of achievements already earned by user (for quick checks)
 */
export async function getEarnedAchievementIds(db: Database, userId: string): Promise<string[]> {
	const results = await db
		.select({ achievementId: userAchievement.achievementId })
		.from(userAchievement)
		.where(eq(userAchievement.userId, userId));

	return results.map((r) => r.achievementId);
}

/**
 * Grant an achievement to a user
 * Uses onConflictDoNothing to handle race conditions (idempotent)
 */
export async function grantAchievement(
	db: Database,
	userId: string,
	achievementId: string,
	gameType?: GameType,
): Promise<boolean> {
	const now = new Date();

	const result = await db
		.insert(userAchievement)
		.values({
			userId,
			achievementId,
			earnedAt: now,
			gameType: gameType ?? null,
		})
		.onConflictDoNothing();

	// Check if insert was successful (not a conflict)
	const rowsAffected = result?.meta?.changes ?? result?.rowsAffected ?? 0;
	return rowsAffected > 0;
}

/**
 * Check if user has a specific achievement
 */
export async function hasAchievement(
	db: Database,
	userId: string,
	achievementId: string,
): Promise<boolean> {
	const earnedIds = await getEarnedAchievementIds(db, userId);
	return earnedIds.includes(achievementId);
}

/**
 * Get count of achievements earned by user
 */
export async function getAchievementCount(db: Database, userId: string): Promise<number> {
	const achievements = await getUserAchievements(db, userId);
	return achievements.length;
}
