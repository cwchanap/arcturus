/**
 * Achievement System Business Logic
 *
 * Orchestrates achievement checking and granting.
 * Main entry point for achievement operations.
 */

import type { Database } from '../db';
import type {
	AchievementDefinition,
	AchievementWithStatus,
	AchievementCheckContext,
} from './types';
import type { GameType } from '../game-stats/types';
import { ACHIEVEMENTS, ACHIEVEMENT_CHECKS } from './achievement-rules';
import {
	getUserAchievements,
	getEarnedAchievementIds,
	grantAchievement,
} from './achievement-repository';
import { getAggregateUserStats } from '../game-stats/game-stats-repository';
import { getUserRank } from '../leaderboard/leaderboard-repository';

/**
 * Build achievement check context from current state
 */
async function buildAchievementContext(
	db: Database,
	userId: string,
	currentChipBalance: number,
	options: {
		recentWinAmount?: number;
		gameType?: GameType;
	} = {},
): Promise<AchievementCheckContext> {
	// Fetch data in parallel
	const [existingAchievementIds, aggregateStats, overallRank] = await Promise.all([
		getEarnedAchievementIds(db, userId),
		getAggregateUserStats(db, userId),
		getUserRank(db, userId),
	]);

	return {
		userId,
		overallRank,
		totalWins: aggregateStats.totalWins,
		totalLosses: aggregateStats.totalLosses,
		totalHandsPlayed: aggregateStats.totalHandsPlayed,
		biggestWin: aggregateStats.biggestWin,
		totalNetProfit: aggregateStats.totalNetProfit,
		currentChipBalance,
		recentWinAmount: options.recentWinAmount,
		gameType: options.gameType,
		existingAchievementIds,
	};
}

/**
 * Check and grant all applicable achievements for a user
 * Returns list of newly granted achievements for notifications
 */
export async function checkAndGrantAchievements(
	db: Database,
	userId: string,
	currentChipBalance: number,
	options: {
		recentWinAmount?: number;
		gameType?: GameType;
	} = {},
): Promise<AchievementDefinition[]> {
	// Build context with all necessary data
	const context = await buildAchievementContext(db, userId, currentChipBalance, options);

	const newlyGranted: AchievementDefinition[] = [];

	// Check each achievement
	for (const achievement of ACHIEVEMENTS) {
		const checkFn = ACHIEVEMENT_CHECKS[achievement.id];
		if (!checkFn) {
			console.warn(`No check function for achievement: ${achievement.id}`);
			continue;
		}

		const result = checkFn(context);

		if (result.shouldGrant) {
			// Try to grant (will be ignored if already granted due to race condition)
			const granted = await grantAchievement(db, userId, achievement.id, result.gameType);

			if (granted) {
				newlyGranted.push(achievement);
				console.warn(`[ACHIEVEMENT] Achievement unlocked for ${userId}: ${achievement.name}`);
			}
		}
	}

	return newlyGranted;
}

/**
 * Get all achievements with unlock status for a user (for profile display)
 */
export async function getAchievementsWithStatus(
	db: Database,
	userId: string,
): Promise<AchievementWithStatus[]> {
	const userAchievements = await getUserAchievements(db, userId);

	// Create a map for quick lookup
	const earnedMap = new Map(userAchievements.map((ua) => [ua.achievementId, ua]));

	// Map all achievements to status objects
	return ACHIEVEMENTS.map((achievement) => {
		const earned = earnedMap.get(achievement.id);

		return {
			...achievement,
			isUnlocked: !!earned,
			earnedAt: earned?.earnedAt ?? null,
			gameType: earned?.gameType ?? null,
		};
	});
}

/**
 * Get only unlocked achievements for a user
 */
export async function getUnlockedAchievements(
	db: Database,
	userId: string,
): Promise<AchievementWithStatus[]> {
	const allWithStatus = await getAchievementsWithStatus(db, userId);
	return allWithStatus.filter((a) => a.isUnlocked);
}

/**
 * Get achievement progress summary for a user
 */
export async function getAchievementProgress(
	db: Database,
	userId: string,
): Promise<{
	total: number;
	unlocked: number;
	percentage: number;
}> {
	const achievements = await getAchievementsWithStatus(db, userId);
	const unlocked = achievements.filter((a) => a.isUnlocked).length;

	return {
		total: achievements.length,
		unlocked,
		percentage: achievements.length > 0 ? (unlocked / achievements.length) * 100 : 0,
	};
}

// Re-export types and utilities
export type { AchievementDefinition, AchievementWithStatus, UserAchievementRecord } from './types';
export { ACHIEVEMENTS, getAchievementById, getAchievementsByCategory } from './achievement-rules';
