/**
 * Achievement Repository
 *
 * Database operations for user achievements.
 */

import { eq, and, sql } from 'drizzle-orm';
import { userAchievement } from '../../db/schema';
import type { Database } from '../db';
import type { UserAchievementRecord, AchievementId } from './types';
import { ACHIEVEMENT_IDS } from './types';
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
 * Type guard to check if a string is a valid achievement ID
 */
function isValidAchievementId(value: string): value is AchievementId {
	return (ACHIEVEMENT_IDS as readonly string[]).includes(value);
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

	return results
		.filter((r) => isValidAchievementId(r.achievementId))
		.map((r) => ({
			achievementId: r.achievementId as AchievementId,
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
): Promise<AchievementId[]> {
	const results = await db
		.select({ achievementId: userAchievement.achievementId })
		.from(userAchievement)
		.where(eq(userAchievement.userId, userId));

	return results.map((r) => r.achievementId).filter(isValidAchievementId);
}

/**
 * Grant an achievement to a user
 * Uses check-then-insert with onConflictDoNothing to handle race conditions (idempotent)
 *
 * @returns true if achievement was newly granted, false if already existed
 * @throws Error if database operation fails for reasons other than conflict
 */
export async function grantAchievement(
	db: Database,
	userId: string,
	achievementId: AchievementId,
	gameType?: GameType,
): Promise<boolean> {
	const now = new Date();

	try {
		// First, query for an existing row to avoid race conditions
		const [existingRow] = await db
			.select({ earnedAt: userAchievement.earnedAt })
			.from(userAchievement)
			.where(
				and(eq(userAchievement.userId, userId), eq(userAchievement.achievementId, achievementId)),
			)
			.limit(1);

		// If a row exists, return false (did not grant)
		if (existingRow) {
			return false;
		}

		// No existing row found, perform the insert
		const insertResult = await db
			.insert(userAchievement)
			.values({
				userId,
				achievementId,
				earnedAt: now,
				gameType: gameType ?? null,
			})
			.onConflictDoNothing();

		// Return true only if a row was actually inserted (not skipped due to conflict)
		// Check meta.changes for D1, fallback to rowsAffected for other databases
		const changes =
			(insertResult as { meta?: { changes?: number } })?.meta?.changes ??
			(insertResult as { rowsAffected?: number })?.rowsAffected ??
			0;
		return changes > 0;
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
	achievementId: AchievementId,
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
