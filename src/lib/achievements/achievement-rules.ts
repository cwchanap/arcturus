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
	AchievementId,
} from './types';
import { GAME_TYPES } from '../game-stats/constants';
import type { GameStats, GameType } from '../game-stats/types';

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
	/** Wins required in a single game for Specialist achievement */
	SPECIALIST_WINS: 100,
	/** Biggest single win required for Big Score achievement */
	BIG_SCORE_WIN: 10000,
} as const;

/**
 * Wallet-settled feat IDs and the games allowed to report each one.
 * Compile-time checked: keys must be achievement IDs and values must be
 * valid game types. Wallet validation enforces game eligibility at runtime.
 */
export const WALLET_FEAT_GAMES = {
	royal_treatment: ['poker', 'video-poker'],
	triple_threat: ['sic-bo'],
	straight_up: ['roulette'],
	big_catch: ['keno'],
	jackpot: ['slots'],
} as const satisfies Partial<Record<AchievementId, readonly GameType[]>>;

export type WalletFeatId = keyof typeof WALLET_FEAT_GAMES;

/**
 * All achievement definitions (language-neutral; names live in the i18n
 * presentation catalog under src/lib/i18n/messages/achievements.ts)
 */
export const ACHIEVEMENTS: AchievementDefinition[] = [
	{
		id: 'rising_star',
		category: 'leaderboard',
		icon: '🌟',
	},
	{
		id: 'high_roller',
		category: 'leaderboard',
		icon: '💎',
	},
	{
		id: 'champion',
		category: 'leaderboard',
		icon: '🏆',
	},
	{
		id: 'consistent',
		category: 'milestone',
		icon: '🏅',
	},
	{
		id: 'comeback',
		category: 'gameplay',
		icon: '🔥',
	},
	{
		id: 'royal_treatment',
		category: 'gameplay',
		icon: '👑',
	},
	{
		id: 'sng_champion',
		category: 'gameplay',
		icon: '🥇',
	},
	{
		id: 'triple_threat',
		category: 'gameplay',
		icon: '🎲',
	},
	{
		id: 'straight_up',
		category: 'gameplay',
		icon: '🎯',
	},
	{
		id: 'big_catch',
		category: 'gameplay',
		icon: '🎱',
	},
	{
		id: 'jackpot',
		category: 'gameplay',
		icon: '🎰',
	},
	{
		id: 'grand_tour',
		category: 'milestone',
		icon: '🧭',
	},
	{
		id: 'specialist',
		category: 'milestone',
		icon: '🎓',
	},
	{
		id: 'big_score',
		category: 'milestone',
		icon: '💰',
	},
];

/**
 * Check function type
 */
export type AchievementCheckFn = (context: AchievementCheckContext) => AchievementCheckResult;

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
	// Use consistent null/undefined guard so recentWinAmount=null is treated as absent
	const hasRecentWin = recentWinAmount !== null && recentWinAmount !== undefined;
	const wasLow =
		hasRecentWin &&
		currentChipBalance - recentWinAmount < ACHIEVEMENT_THRESHOLDS.COMEBACK_LOW_BALANCE;
	const justWon = hasRecentWin && recentWinAmount > 0;
	const shouldGrant = wasLow && justWon;

	return { achievementId: 'comeback', shouldGrant, gameType };
}

/**
 * Shared helper for the six reported feats (five wallet feats plus the SNG
 * event): skip already-earned IDs and check the reported feats, attributing
 * the current game type. Game eligibility is enforced upstream (wallet
 * validator / SNG route), not here.
 */
function checkFeat(id: AchievementId): AchievementCheckFn {
	return (context: AchievementCheckContext): AchievementCheckResult => {
		if (context.existingAchievementIds.includes(id)) {
			return { achievementId: id, shouldGrant: false };
		}

		const shouldGrant = context.feats?.includes(id) ?? false;
		return { achievementId: id, shouldGrant, gameType: context.gameType };
	};
}

/**
 * Deterministic per-game milestone attribution: prefer the current settling
 * game when it qualifies, otherwise the first qualifying GAME_TYPES entry.
 * Returns undefined when no qualifying row maps to a current game type —
 * stats rows for removed games can qualify but are not attributable, so the
 * milestone does not grant rather than throwing on the lookup.
 */
function attributeQualifyingGame(
	context: AchievementCheckContext,
	qualifies: (
		row: Pick<GameStats, 'gameType' | 'handsPlayed' | 'totalWins' | 'biggestWin'>,
	) => boolean,
): GameType | undefined {
	if (context.gameType) {
		const current = context.gameStats.find(
			(row) => row.gameType === context.gameType && qualifies(row),
		);
		if (current) return current.gameType;
	}

	return GAME_TYPES.map((game) => context.gameStats.find((row) => row.gameType === game)).find(
		(row) => row && qualifies(row),
	)?.gameType;
}

/**
 * Grand Tour: play every game at least once. Global - stores no game type.
 */
function checkGrandTour(context: AchievementCheckContext): AchievementCheckResult {
	const { existingAchievementIds, gameStats } = context;

	if (existingAchievementIds.includes('grand_tour')) {
		return { achievementId: 'grand_tour', shouldGrant: false };
	}

	const played = new Set(
		gameStats.filter((row) => row.handsPlayed >= 1).map((row) => row.gameType),
	);
	const shouldGrant = GAME_TYPES.every((game) => played.has(game));

	return { achievementId: 'grand_tour', shouldGrant };
}

/**
 * Per-game milestone checks (Specialist, Big Score): skip already-earned IDs
 * and grant only when a qualifying stats row exists that can be attributed
 * to a current game type.
 */
function checkPerGameMilestone(
	id: AchievementId,
	qualifies: (
		row: Pick<GameStats, 'gameType' | 'handsPlayed' | 'totalWins' | 'biggestWin'>,
	) => boolean,
): AchievementCheckFn {
	return (context: AchievementCheckContext): AchievementCheckResult => {
		if (context.existingAchievementIds.includes(id)) {
			return { achievementId: id, shouldGrant: false };
		}

		const gameType = attributeQualifyingGame(context, qualifies);
		if (gameType === undefined) {
			return { achievementId: id, shouldGrant: false };
		}

		return { achievementId: id, shouldGrant: true, gameType };
	};
}

/**
 * Map of achievement IDs to their check functions
 */
export const ACHIEVEMENT_CHECKS: Partial<
	Record<import('./types').AchievementId, AchievementCheckFn>
> = {
	rising_star: checkRisingStar,
	high_roller: checkHighRoller,
	champion: checkChampion,
	consistent: checkConsistent,
	comeback: checkComeback,
	royal_treatment: checkFeat('royal_treatment'),
	sng_champion: checkFeat('sng_champion'),
	triple_threat: checkFeat('triple_threat'),
	straight_up: checkFeat('straight_up'),
	big_catch: checkFeat('big_catch'),
	jackpot: checkFeat('jackpot'),
	grand_tour: checkGrandTour,
	// Specialist: win 100 hands in a single game.
	specialist: checkPerGameMilestone(
		'specialist',
		(row) => row.totalWins >= ACHIEVEMENT_THRESHOLDS.SPECIALIST_WINS,
	),
	// Big Score: a single win of 10,000+ chips in any game.
	big_score: checkPerGameMilestone(
		'big_score',
		(row) => row.biggestWin >= ACHIEVEMENT_THRESHOLDS.BIG_SCORE_WIN,
	),
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
