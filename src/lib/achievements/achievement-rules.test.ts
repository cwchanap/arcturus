import { describe, expect, test } from 'bun:test';
import {
	ACHIEVEMENTS,
	ACHIEVEMENT_CHECKS,
	ACHIEVEMENT_THRESHOLDS,
	EVALUATED_ACHIEVEMENTS,
	getAchievementById,
	getAchievementsByCategory,
} from './achievement-rules';
import type { AchievementCheckContext } from './types';

function createContext(overrides: Partial<AchievementCheckContext> = {}): AchievementCheckContext {
	return {
		userId: 'test-user',
		overallRank: null,
		totalWins: 0,
		totalLosses: 0,
		totalHandsPlayed: 0,
		biggestWin: 0,
		totalNetProfit: 0,
		currentChipBalance: 10000,
		existingAchievementIds: [],
		...overrides,
	};
}

function runAchievementCheck(
	id: keyof typeof ACHIEVEMENT_CHECKS,
	context: AchievementCheckContext,
): { shouldGrant: boolean } {
	const fn = ACHIEVEMENT_CHECKS[id];
	if (!fn) throw new Error(`Achievement check '${id}' is not defined`);
	return fn(context);
}

describe('ACHIEVEMENTS', () => {
	test('contains all expected achievements', () => {
		expect(ACHIEVEMENTS.length).toBe(6);

		const ids = ACHIEVEMENTS.map((a) => a.id);
		expect(ids).toContain('rising_star');
		expect(ids).toContain('high_roller');
		expect(ids).toContain('champion');
		expect(ids).toContain('consistent');
		expect(ids).toContain('comeback');
		expect(ids).toContain('ranked_debut');
	});

	test('all achievements have required properties', () => {
		for (const achievement of ACHIEVEMENTS) {
			expect(achievement.id).toBeDefined();
			expect(achievement.name).toBeDefined();
			expect(achievement.description).toBeDefined();
			expect(achievement.category).toBeDefined();
			expect(achievement.icon).toBeDefined();
		}
	});

	test('all evaluated achievements have check functions', () => {
		for (const achievement of EVALUATED_ACHIEVEMENTS) {
			expect(ACHIEVEMENT_CHECKS[achievement.id]).toBeDefined();
			expect(typeof ACHIEVEMENT_CHECKS[achievement.id]).toBe('function');
		}
	});

	test('ranked debut is catalog-visible and terminal-only', () => {
		expect(getAchievementById('ranked_debut')).toEqual({
			id: 'ranked_debut',
			name: 'Ranked Debut',
			description: 'Complete your first ranked game.',
			category: 'milestone',
			icon: '🎖️',
			grantSource: 'ranked-terminal',
		});
		expect(EVALUATED_ACHIEVEMENTS.every((item) => item.grantSource === 'evaluated')).toBe(true);
	});
});

describe('getAchievementById', () => {
	test('returns achievement when found', () => {
		const achievement = getAchievementById('rising_star');
		expect(achievement).toBeDefined();
		expect(achievement?.name).toBe('Rising Star');
	});

	test('returns undefined when not found', () => {
		const achievement = getAchievementById('nonexistent' as any);
		expect(achievement).toBeUndefined();
	});
});

describe('getAchievementsByCategory', () => {
	test('returns leaderboard achievements', () => {
		const leaderboardAchievements = getAchievementsByCategory('leaderboard');
		expect(leaderboardAchievements.length).toBeGreaterThan(0);

		for (const achievement of leaderboardAchievements) {
			expect(achievement.category).toBe('leaderboard');
		}
	});

	test('returns milestone achievements', () => {
		const milestoneAchievements = getAchievementsByCategory('milestone');
		expect(milestoneAchievements.length).toBeGreaterThan(0);

		for (const achievement of milestoneAchievements) {
			expect(achievement.category).toBe('milestone');
		}
	});

	test('returns empty array for unknown category', () => {
		const unknownAchievements = getAchievementsByCategory('unknown' as 'leaderboard');
		expect(unknownAchievements).toEqual([]);
	});
});

describe('Achievement check functions', () => {
	describe('rising_star', () => {
		test('grants when user reaches top threshold', () => {
			const context = createContext({ overallRank: ACHIEVEMENT_THRESHOLDS.RISING_STAR_RANK });
			const result = runAchievementCheck('rising_star', context);
			expect(result.shouldGrant).toBe(true);
		});

		test('grants when user is in top 10', () => {
			const context = createContext({ overallRank: 5 });
			const result = runAchievementCheck('rising_star', context);
			expect(result.shouldGrant).toBe(true);
		});

		test('does not grant when rank is above threshold', () => {
			const context = createContext({
				overallRank: ACHIEVEMENT_THRESHOLDS.RISING_STAR_RANK + 1,
			});
			const result = runAchievementCheck('rising_star', context);
			expect(result.shouldGrant).toBe(false);
		});

		test('does not grant when no rank', () => {
			const context = createContext({ overallRank: null });
			const result = runAchievementCheck('rising_star', context);
			expect(result.shouldGrant).toBe(false);
		});

		test('does not grant when already earned', () => {
			const context = createContext({
				overallRank: 10,
				existingAchievementIds: ['rising_star'],
			});
			const result = runAchievementCheck('rising_star', context);
			expect(result.shouldGrant).toBe(false);
		});
	});

	describe('high_roller', () => {
		test('grants when user reaches top threshold', () => {
			const context = createContext({ overallRank: ACHIEVEMENT_THRESHOLDS.HIGH_ROLLER_RANK });
			const result = runAchievementCheck('high_roller', context);
			expect(result.shouldGrant).toBe(true);
		});

		test('does not grant when rank is above threshold', () => {
			const context = createContext({
				overallRank: ACHIEVEMENT_THRESHOLDS.HIGH_ROLLER_RANK + 1,
			});
			const result = runAchievementCheck('high_roller', context);
			expect(result.shouldGrant).toBe(false);
		});

		test('does not grant when already earned', () => {
			const context = createContext({
				overallRank: 5,
				existingAchievementIds: ['high_roller'],
			});
			const result = runAchievementCheck('high_roller', context);
			expect(result.shouldGrant).toBe(false);
		});

		test('does not grant when no rank', () => {
			const context = createContext({ overallRank: null });
			const result = runAchievementCheck('high_roller', context);
			expect(result.shouldGrant).toBe(false);
		});
	});

	describe('champion', () => {
		test('grants when user is #1', () => {
			const context = createContext({ overallRank: 1 });
			const result = runAchievementCheck('champion', context);
			expect(result.shouldGrant).toBe(true);
		});

		test('does not grant when rank is not 1', () => {
			const context = createContext({ overallRank: 2 });
			const result = runAchievementCheck('champion', context);
			expect(result.shouldGrant).toBe(false);
		});

		test('does not grant when already earned', () => {
			const context = createContext({
				overallRank: 1,
				existingAchievementIds: ['champion'],
			});
			const result = runAchievementCheck('champion', context);
			expect(result.shouldGrant).toBe(false);
		});

		test('does not grant when no rank', () => {
			const context = createContext({ overallRank: null });
			const result = runAchievementCheck('champion', context);
			expect(result.shouldGrant).toBe(false);
		});
	});

	describe('consistent', () => {
		test('grants when user reaches win threshold', () => {
			const context = createContext({ totalWins: ACHIEVEMENT_THRESHOLDS.CONSISTENT_WINS });
			const result = runAchievementCheck('consistent', context);
			expect(result.shouldGrant).toBe(true);
		});

		test('does not grant when wins below threshold', () => {
			const context = createContext({ totalWins: ACHIEVEMENT_THRESHOLDS.CONSISTENT_WINS - 1 });
			const result = runAchievementCheck('consistent', context);
			expect(result.shouldGrant).toBe(false);
		});

		test('does not grant when already earned', () => {
			const context = createContext({
				totalWins: 150,
				existingAchievementIds: ['consistent'],
			});
			const result = runAchievementCheck('consistent', context);
			expect(result.shouldGrant).toBe(false);
		});
	});

	describe('comeback', () => {
		test('grants when recovering from low balance with a win', () => {
			// User was below threshold, won and recovered
			const balanceBelowThreshold = ACHIEVEMENT_THRESHOLDS.COMEBACK_LOW_BALANCE - 500; // threshold minus 500 chips
			const winAmount = 1500;
			const newBalance = balanceBelowThreshold + winAmount;
			const context = createContext({
				currentChipBalance: newBalance,
				recentWinAmount: winAmount,
			});
			const result = runAchievementCheck('comeback', context);
			expect(result.shouldGrant).toBe(true);
		});

		test('grants when barely below threshold', () => {
			// User was at threshold - 1, won something
			const balanceBelowThreshold = ACHIEVEMENT_THRESHOLDS.COMEBACK_LOW_BALANCE - 1;
			const winAmount = 100;
			const newBalance = balanceBelowThreshold + winAmount;
			const context = createContext({
				currentChipBalance: newBalance,
				recentWinAmount: winAmount,
			});
			const result = runAchievementCheck('comeback', context);
			expect(result.shouldGrant).toBe(true);
		});

		test('does not grant when was not below threshold before win', () => {
			// User was above threshold before win
			const balanceAboveThreshold = ACHIEVEMENT_THRESHOLDS.COMEBACK_LOW_BALANCE + 3000;
			const winAmount = 1000;
			const newBalance = balanceAboveThreshold + winAmount;
			const context = createContext({
				currentChipBalance: newBalance,
				recentWinAmount: winAmount,
			});
			const result = runAchievementCheck('comeback', context);
			expect(result.shouldGrant).toBe(false);
		});

		test('does not grant without a win', () => {
			const context = createContext({
				currentChipBalance: 500,
				recentWinAmount: 0,
			});
			const result = runAchievementCheck('comeback', context);
			expect(result.shouldGrant).toBe(false);
		});

		test('does not grant when no recent win info', () => {
			const context = createContext({
				currentChipBalance: 2000,
			});
			const result = runAchievementCheck('comeback', context);
			expect(result.shouldGrant).toBe(false);
		});

		test('does not grant when current balance is missing', () => {
			const context = createContext({
				currentChipBalance: null as unknown as number,
				recentWinAmount: 200,
			});
			const result = runAchievementCheck('comeback', context);
			expect(result.shouldGrant).toBe(false);
		});

		test('does not grant when already earned', () => {
			const context = createContext({
				currentChipBalance: 2000,
				recentWinAmount: 1500,
				existingAchievementIds: ['comeback'],
			});
			const result = runAchievementCheck('comeback', context);
			expect(result.shouldGrant).toBe(false);
		});
	});
});
