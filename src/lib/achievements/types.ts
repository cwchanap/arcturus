/**
 * Achievement System Domain Types
 */

import type { GameType } from '../game-stats/types';

/**
 * Achievement category for organization
 */
export type AchievementCategory = 'leaderboard' | 'gameplay' | 'milestone';

/**
 * Achievement definition (static configuration)
 */
export interface AchievementDefinition {
	id: string;
	name: string;
	description: string;
	category: AchievementCategory;
	icon: string; // emoji
}

/**
 * User's earned achievement record
 */
export interface UserAchievementRecord {
	achievementId: string;
	earnedAt: Date;
	gameType: GameType | null;
}

/**
 * Achievement with unlock status for display
 */
export interface AchievementWithStatus extends AchievementDefinition {
	isUnlocked: boolean;
	earnedAt: Date | null;
	gameType: GameType | null;
}

/**
 * Context provided to achievement evaluators
 */
export interface AchievementCheckContext {
	userId: string;

	// Overall chip balance rank
	overallRank: number | null;

	// Aggregate game statistics
	totalWins: number;
	totalLosses: number;
	totalHandsPlayed: number;
	biggestWin: number;
	totalNetProfit: number;

	// Current round context (for real-time checks)
	currentChipBalance: number;
	recentWinAmount?: number;
	gameType?: GameType;

	// Already earned achievements (to prevent re-granting)
	existingAchievementIds: string[];
}

/**
 * Result of checking an achievement
 */
export interface AchievementCheckResult {
	achievementId: string;
	shouldGrant: boolean;
	gameType?: GameType;
}
