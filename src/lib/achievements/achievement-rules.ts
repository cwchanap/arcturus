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
 * Achievement threshold constants
 * These values can be tuned for game balance
 */
export const ACHIEVEMENT_THRESHOLDS = {
	/** Rank required for Rising Star achievement */
	RISING_STAR_RANK: 50,
	/** Rank required for High Roller achievement */
	HIGH_ROLLER_RANK: 10,
	/** Rank required for Champion achievement */
	CHAMPION_RANK: 1,
	/** Total wins required for Consistent Winner achievement */
	CONSISTENT_WINS: 100,
	/** Chip balance threshold for Comeback King achievement */
	COMEBACK_LOW_BALANCE: 1000,
} as const;

/**
 * All achievement definitions
 */
export const ACHIEVEMENTS: AchievementDefinition[] = [
	{
		id: 'rising_star',
		name: 'Rising Star',
		description: `Enter the top ${ACHIEVEMENT_THRESHOLDS.RISING_STAR_RANK} leaderboard`,
		category: 'leaderboard',
		icon: '🌟',
	},
	{
		id: 'high_roller',
		name: 'High Roller',
		description: `Reach the top ${ACHIEVEMENT_THRESHOLDS.HIGH_ROLLER_RANK} on the leaderboard`,
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
		description: `Win ${ACHIEVEMENT_THRESHOLDS.CONSISTENT_WINS} hands across all games`,
		category: 'milestone',
		icon: '🎯',
	},
	{
		id: 'comeback',
		name: 'Comeback King',
		description: `Win after dropping below ${new Intl.NumberFormat('en-US').format(ACHIEVEMENT_THRESHOLDS.COMEBACK_LOW_BALANCE)} chips`,
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

	// Check if user is in top threshold
	const shouldGrant =
		overallRank !== null && overallRank <= ACHIEVEMENT_THRESHOLDS.RISING_STAR_RANK;

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

	const shouldGrant =
		overallRank !== null && overallRank <= ACHIEVEMENT_THRESHOLDS.HIGH_ROLLER_RANK;

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

	const shouldGrant = overallRank === ACHIEVEMENT_THRESHOLDS.CHAMPION_RANK;

	return { achievementId: 'champion', shouldGrant };
}

/**
 * Consistent Winner: Win 100 hands across all games
 */
function checkConsistent(context: AchievementCheckContext): AchievementCheckResult {
	const { totalWins, existingAchievementIds } = context;

	if (existingAchievementIds.includes('consistent')) {
		return { achievementId: 'consistent', shouldGrant: false };
	}

	const shouldGrant = totalWins >= ACHIEVEMENT_THRESHOLDS.CONSISTENT_WINS;

	// Global achievement - not tied to a specific game type
	return { achievementId: 'consistent', shouldGrant };
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

	// Check if user was below threshold before this win and just won something
	const wasLow =
		recentWinAmount !== undefined &&
		currentChipBalance - recentWinAmount < ACHIEVEMENT_THRESHOLDS.COMEBACK_LOW_BALANCE;
	const justWon = recentWinAmount !== undefined && recentWinAmount > 0;
	const shouldGrant = wasLow && justWon;

	return { achievementId: 'comeback', shouldGrant, gameType };
}

/**
 * Map of achievement IDs to their check functions
 */
export const ACHIEVEMENT_CHECKS: Record<import('./types').AchievementId, AchievementCheckFn> = {
	rising_star: checkRisingStar,
	high_roller: checkHighRoller,
	champion: checkChampion,
	consistent: checkConsistent,
	comeback: checkComeback,
};

/**
 * Get achievement definition by ID
 */
export function getAchievementById(
	id: import('./types').AchievementId,
): AchievementDefinition | undefined {
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
