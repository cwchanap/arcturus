import { describe, expect, test } from 'bun:test';
import {
	ACHIEVEMENTS,
	ACHIEVEMENT_CHECKS,
	ACHIEVEMENT_THRESHOLDS,
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

describe('ACHIEVEMENTS', () => {
	test('contains all expected achievements', () => {
		expect(ACHIEVEMENTS.length).toBe(5);

		const ids = ACHIEVEMENTS.map((a) => a.id);
		expect(ids).toContain('rising_star');
		expect(ids).toContain('high_roller');
		expect(ids).toContain('champion');
		expect(ids).toContain('consistent');
		expect(ids).toContain('comeback');
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

	test('all achievements have check functions', () => {
		for (const achievement of ACHIEVEMENTS) {
			expect(ACHIEVEMENT_CHECKS[achievement.id]).toBeDefined();
			expect(typeof ACHIEVEMENT_CHECKS[achievement.id]).toBe('function');
		}
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
			const result = ACHIEVEMENT_CHECKS.rising_star(context);
			expect(result.shouldGrant).toBe(true);
		});

		test('grants when user is in top 10', () => {
			const context = createContext({ overallRank: 5 });
			const result = ACHIEVEMENT_CHECKS.rising_star(context);
			expect(result.shouldGrant).toBe(true);
		});

		test('does not grant when rank is above threshold', () => {
			const context = createContext({
				overallRank: ACHIEVEMENT_THRESHOLDS.RISING_STAR_RANK + 1,
			});
			const result = ACHIEVEMENT_CHECKS.rising_star(context);
			expect(result.shouldGrant).toBe(false);
		});

		test('does not grant when no rank', () => {
			const context = createContext({ overallRank: null });
			const result = ACHIEVEMENT_CHECKS.rising_star(context);
			expect(result.shouldGrant).toBe(false);
		});

		test('does not grant when already earned', () => {
			const context = createContext({
				overallRank: 10,
				existingAchievementIds: ['rising_star'],
			});
			const result = ACHIEVEMENT_CHECKS.rising_star(context);
			expect(result.shouldGrant).toBe(false);
		});
	});

	describe('high_roller', () => {
		test('grants when user reaches top threshold', () => {
			const context = createContext({ overallRank: ACHIEVEMENT_THRESHOLDS.HIGH_ROLLER_RANK });
			const result = ACHIEVEMENT_CHECKS.high_roller(context);
			expect(result.shouldGrant).toBe(true);
		});

		test('does not grant when rank is above threshold', () => {
			const context = createContext({
				overallRank: ACHIEVEMENT_THRESHOLDS.HIGH_ROLLER_RANK + 1,
			});
			const result = ACHIEVEMENT_CHECKS.high_roller(context);
			expect(result.shouldGrant).toBe(false);
		});

		test('does not grant when already earned', () => {
			const context = createContext({
				overallRank: 5,
				existingAchievementIds: ['high_roller'],
			});
			const result = ACHIEVEMENT_CHECKS.high_roller(context);
			expect(result.shouldGrant).toBe(false);
		});
	});

	describe('champion', () => {
		test('grants when user is #1', () => {
			const context = createContext({ overallRank: 1 });
			const result = ACHIEVEMENT_CHECKS.champion(context);
			expect(result.shouldGrant).toBe(true);
		});

		test('does not grant when rank is not 1', () => {
			const context = createContext({ overallRank: 2 });
			const result = ACHIEVEMENT_CHECKS.champion(context);
			expect(result.shouldGrant).toBe(false);
		});

		test('does not grant when already earned', () => {
			const context = createContext({
				overallRank: 1,
				existingAchievementIds: ['champion'],
			});
			const result = ACHIEVEMENT_CHECKS.champion(context);
			expect(result.shouldGrant).toBe(false);
		});
	});

	describe('consistent', () => {
		test('grants when user reaches win threshold', () => {
			const context = createContext({ totalWins: ACHIEVEMENT_THRESHOLDS.CONSISTENT_WINS });
			const result = ACHIEVEMENT_CHECKS.consistent(context);
			expect(result.shouldGrant).toBe(true);
		});

		test('does not grant when wins below threshold', () => {
			const context = createContext({ totalWins: ACHIEVEMENT_THRESHOLDS.CONSISTENT_WINS - 1 });
			const result = ACHIEVEMENT_CHECKS.consistent(context);
			expect(result.shouldGrant).toBe(false);
		});

		test('does not grant when already earned', () => {
			const context = createContext({
				totalWins: 150,
				existingAchievementIds: ['consistent'],
			});
			const result = ACHIEVEMENT_CHECKS.consistent(context);
			expect(result.shouldGrant).toBe(false);
		});
	});

	describe('comeback', () => {
		test('grants when recovering from low balance with a win', () => {
			// User was below threshold, won and recovered
			const balanceBelowThreshold = ACHIEVEMENT_THRESHOLDS.COMEBACK_LOW_BALANCE - 500; // 500 chips
			const winAmount = 1500;
			const newBalance = balanceBelowThreshold + winAmount;
			const context = createContext({
				currentChipBalance: newBalance,
				recentWinAmount: winAmount,
			});
			const result = ACHIEVEMENT_CHECKS.comeback(context);
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
			const result = ACHIEVEMENT_CHECKS.comeback(context);
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
			const result = ACHIEVEMENT_CHECKS.comeback(context);
			expect(result.shouldGrant).toBe(false);
		});

		test('does not grant without a win', () => {
			const context = createContext({
				currentChipBalance: 500,
				recentWinAmount: 0,
			});
			const result = ACHIEVEMENT_CHECKS.comeback(context);
			expect(result.shouldGrant).toBe(false);
		});

		test('does not grant when no recent win info', () => {
			const context = createContext({
				currentChipBalance: 2000,
			});
			const result = ACHIEVEMENT_CHECKS.comeback(context);
			expect(result.shouldGrant).toBe(false);
		});

		test('does not grant when already earned', () => {
			const context = createContext({
				currentChipBalance: 2000,
				recentWinAmount: 1500,
				existingAchievementIds: ['comeback'],
			});
			const result = ACHIEVEMENT_CHECKS.comeback(context);
			expect(result.shouldGrant).toBe(false);
		});
	});
});
