/**
 * Achievement Repository
 *
 * Database operations for user achievements.
 */

import { eq, and, sql } from 'drizzle-orm';
import { userAchievement } from '../../db/schema';
import type { Database } from '../db';
import type { UserAchievementRecord } from './types';
import type { GameType } from '../game-stats/types';

/**
 * Redact user ID for logging to avoid PII exposure
 * Returns a truncated version of the userId (first 4 chars + '***')
 */
export function redactUserId(userId: string): string {
	if (!userId || userId.length < 4) return '***';
	return `${userId.slice(0, 4)}***`;
}

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
		await db
			.insert(userAchievement)
			.values({
				userId,
				achievementId,
				earnedAt: now,
				gameType: gameType ?? null,
			})
			.onConflictDoNothing();

		// Deterministically verify insert success by checking if row exists with our timestamp
		const [existing] = await db
			.select({ earnedAt: userAchievement.earnedAt })
			.from(userAchievement)
			.where(
				and(eq(userAchievement.userId, userId), eq(userAchievement.achievementId, achievementId)),
			)
			.limit(1);

		// Row exists with our timestamp -> we just inserted it
		// Compare at second precision since SQLite stores timestamps as integers (seconds)
		const storedTime = Math.floor((existing?.earnedAt?.getTime() ?? 0) / 1000);
		const insertTime = Math.floor(now.getTime() / 1000);
		return storedTime === insertTime;
	} catch (error) {
		// Database errors other than conflict (connection issues, etc.)
		const errorMessage = error instanceof Error ? error.message : String(error);
		console.error(
			`[ACHIEVEMENT_GRANT_ERROR] Failed to grant achievement ${achievementId} to user ${redactUserId(userId)}: ${errorMessage}`,
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
	const [result] = await db
		.select({ achievementId: userAchievement.achievementId })
		.from(userAchievement)
		.where(
			and(eq(userAchievement.userId, userId), eq(userAchievement.achievementId, achievementId)),
		)
		.limit(1);

	return !!result;
}

/**
 * Get count of achievements earned by user
 */
export async function getAchievementCount(db: Database, userId: string): Promise<number> {
	const [result] = await db
		.select({ count: sql<number>`count(*)`.as('count') })
		.from(userAchievement)
		.where(eq(userAchievement.userId, userId));

	return result?.count ?? 0;
}
