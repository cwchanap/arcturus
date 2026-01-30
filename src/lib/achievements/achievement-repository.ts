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
		achievementId: r.achievementId as import('./types').AchievementId,
		earnedAt: r.earnedAt,
		gameType: r.gameType as GameType | null,
	}));
}

/**
 * Get IDs of achievements already earned by user (for quick checks)
 */
export async function getEarnedAchievementIds(
	db: Database,
	userId: string,
): Promise<import('./types').AchievementId[]> {
	const results = await db
		.select({ achievementId: userAchievement.achievementId })
		.from(userAchievement)
		.where(eq(userAchievement.userId, userId));

	return results.map((r) => r.achievementId as import('./types').AchievementId);
}

/**
 * Grant an achievement to a user
 * Uses onConflictDoNothing to handle race conditions (idempotent)
 *
 * @returns true if achievement was newly granted, false if already existed
 * @throws Error if database operation fails for reasons other than conflict
 */
export async function grantAchievement(
	db: Database,
	userId: string,
	achievementId: import('./types').AchievementId,
	gameType?: GameType,
): Promise<boolean> {
	const now = new Date();

	try {
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
	} catch (error) {
		// Database errors other than conflict (connection issues, etc.)
		console.error(
			`[ACHIEVEMENT_GRANT_ERROR] Failed to grant achievement ${achievementId} to user ${userId}:`,
			error,
		);
		throw error;
	}
}

/**
 * Check if user has a specific achievement
 */
export async function hasAchievement(
	db: Database,
	userId: string,
	achievementId: import('./types').AchievementId,
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
