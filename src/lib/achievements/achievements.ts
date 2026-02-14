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
	AchievementId,
} from './types';
import type { GameType } from '../game-stats/types';
import { ACHIEVEMENTS, ACHIEVEMENT_CHECKS } from './achievement-rules';
import type { AchievementCheckFn } from './achievement-rules';
import {
	getUserAchievements,
	getEarnedAchievementIds,
	grantAchievement,
	redactUserId,
} from './achievement-repository';
import { getAggregateUserStats } from '../game-stats/game-stats-repository';
import { getUserRank } from '../leaderboard/leaderboard-repository';

export class DatabaseError extends Error {
	cause: unknown;

	constructor(message: string, cause: unknown) {
		super(message);
		this.name = 'DatabaseError';
		this.cause = cause;
	}
}

function isDatabaseError(error: unknown): boolean {
	return (
		error instanceof DatabaseError || (error instanceof Error && error.name === 'DatabaseError')
	);
}

type AchievementDeps = {
	getUserAchievements: typeof getUserAchievements;
	getEarnedAchievementIds: typeof getEarnedAchievementIds;
	grantAchievement: typeof grantAchievement;
	getAggregateUserStats: typeof getAggregateUserStats;
	getUserRank: typeof getUserRank;
	achievementChecks: Record<AchievementId, AchievementCheckFn>;
};

export function createAchievementService(overrides: Partial<AchievementDeps> = {}) {
	const deps: AchievementDeps = {
		getUserAchievements,
		getEarnedAchievementIds,
		grantAchievement,
		getAggregateUserStats,
		getUserRank,
		achievementChecks: ACHIEVEMENT_CHECKS,
		...overrides,
	};

	async function runDatabaseOperation<T>(operation: string, run: () => Promise<T>): Promise<T> {
		try {
			return await run();
		} catch (error) {
			if (isDatabaseError(error)) {
				throw error;
			}
			throw new DatabaseError(`Achievement DB operation failed: ${operation}`, error);
		}
	}

	async function buildAchievementContext(
		db: Database,
		userId: string,
		currentChipBalance: number,
		options: {
			recentWinAmount?: number;
			gameType?: GameType;
		} = {},
	): Promise<AchievementCheckContext> {
		const [existingAchievementIds, stats, overallRank] = await Promise.all([
			runDatabaseOperation('getEarnedAchievementIds', () =>
				deps.getEarnedAchievementIds(db, userId),
			),
			runDatabaseOperation('getAggregateUserStats', () => deps.getAggregateUserStats(db, userId)),
			runDatabaseOperation('getUserRank', () => deps.getUserRank(db, userId)),
		]);

		return {
			userId,
			overallRank,
			totalWins: stats.totalWins,
			totalLosses: stats.totalLosses,
			totalHandsPlayed: stats.totalHandsPlayed,
			biggestWin: stats.biggestWin,
			totalNetProfit: stats.totalNetProfit,
			currentChipBalance,
			recentWinAmount: options.recentWinAmount,
			gameType: options.gameType,
			existingAchievementIds,
		};
	}

	async function checkAndGrantAchievements(
		db: Database,
		userId: string,
		currentChipBalance: number,
		options: {
			recentWinAmount?: number;
			gameType?: GameType;
		} = {},
		achievementsList: AchievementDefinition[] = ACHIEVEMENTS,
	): Promise<AchievementDefinition[]> {
		const context = await buildAchievementContext(db, userId, currentChipBalance, options);

		const newlyGranted: AchievementDefinition[] = [];

		for (const achievement of achievementsList) {
			const checkFn = deps.achievementChecks[achievement.id];
			if (!checkFn) {
				console.warn(`No check function for achievement: ${achievement.id}`);
				continue;
			}

			try {
				const result = checkFn(context);

				if (result?.shouldGrant) {
					const granted = await runDatabaseOperation(`grantAchievement:${achievement.id}`, () =>
						deps.grantAchievement(db, userId, achievement.id, result.gameType),
					);

					if (granted) {
						newlyGranted.push(achievement);
						console.warn(
							`[ACHIEVEMENT] Achievement unlocked for ${redactUserId(userId)}: ${achievement.name}`,
						);
					}
				}
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error);
				console.error(
					`[ACHIEVEMENT] Failed to evaluate ${achievement.id} for ${redactUserId(userId)}: ${errorMessage}`,
				);
				// Surface DB infrastructure errors so callers can detect aborted evaluation.
				if (isDatabaseError(error)) {
					throw error;
				}
			}
		}

		return newlyGranted;
	}

	async function getAchievementsWithStatus(
		db: Database,
		userId: string,
	): Promise<AchievementWithStatus[]> {
		const userAchievements = await runDatabaseOperation('getUserAchievements', () =>
			deps.getUserAchievements(db, userId),
		);
		const earnedMap = new Map(userAchievements.map((ua) => [ua.achievementId, ua]));

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

	async function getUnlockedAchievements(
		db: Database,
		userId: string,
	): Promise<AchievementWithStatus[]> {
		const allWithStatus = await getAchievementsWithStatus(db, userId);
		return allWithStatus.filter((a) => a.isUnlocked);
	}

	async function getAchievementProgress(
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

	return {
		checkAndGrantAchievements,
		getAchievementsWithStatus,
		getUnlockedAchievements,
		getAchievementProgress,
	};
}

const defaultService = createAchievementService();

export const {
	checkAndGrantAchievements,
	getAchievementsWithStatus,
	getUnlockedAchievements,
	getAchievementProgress,
} = defaultService;

// Re-export types and utilities
export type { AchievementDefinition, AchievementWithStatus, UserAchievementRecord } from './types';
export { ACHIEVEMENTS, getAchievementById, getAchievementsByCategory } from './achievement-rules';
