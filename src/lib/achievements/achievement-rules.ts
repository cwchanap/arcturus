/**
 * Achievement Rules
 *
 * Defines all achievements and their criteria.
 * To add a new achievement:
 * 1. Add definition to ACHIEVEMENTS array
 * 2. Add check function to ACHIEVEMENT_CHECKS map
 * 3. Write unit tests
 */

import type {
	AchievementDefinition,
	AchievementCheckContext,
	AchievementCheckResult,
} from './types';

/**
 * All achievement definitions
 */
export const ACHIEVEMENTS: AchievementDefinition[] = [
	{
		id: 'rising_star',
		name: 'Rising Star',
		description: 'Enter the top 50 leaderboard',
		category: 'leaderboard',
		icon: '🌟',
	},
	{
		id: 'high_roller',
		name: 'High Roller',
		description: 'Reach the top 10 on the leaderboard',
		category: 'leaderboard',
		icon: '💎',
	},
	{
		id: 'champion',
		name: 'Champion',
		description: 'Reach #1 position on the leaderboard',
		category: 'leaderboard',
		icon: '🏆',
	},
	{
		id: 'consistent',
		name: 'Consistent Winner',
		description: 'Win 100 hands across all games',
		category: 'milestone',
		icon: '🎯',
	},
	{
		id: 'comeback',
		name: 'Comeback King',
		description: 'Win after dropping below 1,000 chips',
		category: 'gameplay',
		icon: '🔥',
	},
];

/**
 * Check function type
 */
type AchievementCheckFn = (context: AchievementCheckContext) => AchievementCheckResult;

/**
 * Rising Star: Enter top 50 leaderboard
 */
function checkRisingStar(context: AchievementCheckContext): AchievementCheckResult {
	const { overallRank, existingAchievementIds } = context;

	// Already earned
	if (existingAchievementIds.includes('rising_star')) {
		return { achievementId: 'rising_star', shouldGrant: false };
	}

	// Check if user is in top 50
	const shouldGrant = overallRank !== null && overallRank <= 50;

	return { achievementId: 'rising_star', shouldGrant };
}

/**
 * High Roller: Reach top 10 leaderboard
 */
function checkHighRoller(context: AchievementCheckContext): AchievementCheckResult {
	const { overallRank, existingAchievementIds } = context;

	if (existingAchievementIds.includes('high_roller')) {
		return { achievementId: 'high_roller', shouldGrant: false };
	}

	const shouldGrant = overallRank !== null && overallRank <= 10;

	return { achievementId: 'high_roller', shouldGrant };
}

/**
 * Champion: Reach #1 position
 */
function checkChampion(context: AchievementCheckContext): AchievementCheckResult {
	const { overallRank, existingAchievementIds } = context;

	if (existingAchievementIds.includes('champion')) {
		return { achievementId: 'champion', shouldGrant: false };
	}

	const shouldGrant = overallRank === 1;

	return { achievementId: 'champion', shouldGrant };
}

/**
 * Consistent Winner: Win 100 hands across all games
 */
function checkConsistent(context: AchievementCheckContext): AchievementCheckResult {
	const { totalWins, existingAchievementIds, gameType } = context;

	if (existingAchievementIds.includes('consistent')) {
		return { achievementId: 'consistent', shouldGrant: false };
	}

	const shouldGrant = totalWins >= 100;

	return { achievementId: 'consistent', shouldGrant, gameType };
}

/**
 * Comeback King: Win after dropping below 1,000 chips
 */
function checkComeback(context: AchievementCheckContext): AchievementCheckResult {
	const { currentChipBalance, recentWinAmount, existingAchievementIds, gameType } = context;

	if (existingAchievementIds.includes('comeback')) {
		return { achievementId: 'comeback', shouldGrant: false };
	}

	if (currentChipBalance === null || currentChipBalance === undefined) {
		return { achievementId: 'comeback', shouldGrant: false };
	}

	// Check if user was below 1000 chips before this win
	// and just won something
	const wasLow = recentWinAmount !== undefined && currentChipBalance - recentWinAmount < 1000;
	const justWon = recentWinAmount !== undefined && recentWinAmount > 0;
	const shouldGrant = wasLow && justWon;

	return { achievementId: 'comeback', shouldGrant, gameType };
}

/**
 * Map of achievement IDs to their check functions
 */
export const ACHIEVEMENT_CHECKS: Record<string, AchievementCheckFn> = {
	rising_star: checkRisingStar,
	high_roller: checkHighRoller,
	champion: checkChampion,
	consistent: checkConsistent,
	comeback: checkComeback,
};

/**
 * Get achievement definition by ID
 */
export function getAchievementById(id: string): AchievementDefinition | undefined {
	return ACHIEVEMENTS.find((a) => a.id === id);
}

/**
 * Get all achievements by category
 */
export function getAchievementsByCategory(
	category: AchievementDefinition['category'],
): AchievementDefinition[] {
	return ACHIEVEMENTS.filter((a) => a.category === category);
}
