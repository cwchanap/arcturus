import { describe, expect, test } from 'bun:test';
import type { Database } from '../db';
import type { GameType } from '../game-stats/types';
import type { AchievementDefinition, AchievementId, UserAchievementRecord } from './types';

const mockGetEarnedAchievementIds = Object.assign(async () => ['rising_star'] as AchievementId[], {
	calls: [] as Array<{ userId: string }>,
});
const mockGetAggregateUserStats = Object.assign(
	async () => ({
		totalWins: 120,
		totalLosses: 30,
		totalHandsPlayed: 150,
		biggestWin: 500,
		totalNetProfit: 1000,
	}),
	{ calls: [] as Array<{ userId: string }> },
);
const mockGetUserRank = Object.assign(async () => 5, {
	calls: [] as Array<{ userId: string }>,
});
const mockGrantAchievement = Object.assign(
	async (_db: Database, _userId: string, achievementId: string, gameType?: GameType) => {
		mockGrantAchievement.calls.push({ achievementId, gameType });
		return achievementId !== 'high_roller';
	},
	{ calls: [] as Array<{ achievementId: string; gameType?: GameType }> },
);
const mockGetUserAchievements = Object.assign(
	async () =>
		[
			{
				achievementId: 'rising_star',
				earnedAt: new Date('2025-01-01'),
				gameType: null,
			},
		] as UserAchievementRecord[],
	{ calls: [] as Array<{ userId: string }> },
);

function resetMocks() {
	mockGetEarnedAchievementIds.calls = [];
	mockGetAggregateUserStats.calls = [];
	mockGetUserRank.calls = [];
	mockGrantAchievement.calls = [];
	mockGetUserAchievements.calls = [];
}

const achievementsModule = await import('./achievements');
const { createAchievementService, ACHIEVEMENTS } = achievementsModule;

const {
	checkAndGrantAchievements,
	getAchievementsWithStatus,
	getUnlockedAchievements,
	getAchievementProgress,
} = createAchievementService({
	getEarnedAchievementIds: async (_db: Database, userId: string) => {
		mockGetEarnedAchievementIds.calls.push({ userId });
		return mockGetEarnedAchievementIds();
	},
	grantAchievement: async (
		db: Database,
		userId: string,
		achievementId: string,
		gameType?: GameType,
	) => {
		void db;
		void userId;
		return mockGrantAchievement(db, userId, achievementId, gameType);
	},
	getUserAchievements: async (_db: Database, userId: string) => {
		mockGetUserAchievements.calls.push({ userId });
		return mockGetUserAchievements();
	},
	getAggregateUserStats: async (_db: Database, userId: string) => {
		mockGetAggregateUserStats.calls.push({ userId });
		return mockGetAggregateUserStats();
	},
	getUserRank: async (_db: Database, userId: string) => {
		mockGetUserRank.calls.push({ userId });
		return mockGetUserRank();
	},
});

function createMockDb(): Database {
	return {} as Database;
}

describe('achievements orchestration', () => {
	test('checkAndGrantAchievements grants and returns newly earned achievements', async () => {
		resetMocks();
		const db = createMockDb();

		const results = await checkAndGrantAchievements(db, 'user1', 2000, {
			recentWinAmount: 1500,
			gameType: 'blackjack' as GameType,
		});

		expect(mockGetEarnedAchievementIds.calls.length).toBe(1);
		expect(mockGetAggregateUserStats.calls.length).toBe(1);
		expect(mockGetUserRank.calls.length).toBe(1);
		expect(mockGrantAchievement.calls.length).toBeGreaterThan(0);

		const ids = results.map((a) => a.id);
		expect(ids.includes('high_roller')).toBe(false);
		expect(ids.length).toBeGreaterThan(0);
	});

	test('checkAndGrantAchievements skips missing check functions', async () => {
		resetMocks();
		const db = createMockDb();

		const originalLength = ACHIEVEMENTS.length;
		(ACHIEVEMENTS as AchievementDefinition[]).push({
			id: 'missing_check' as AchievementDefinition['id'],
			name: 'Missing',
			description: 'missing',
			category: 'leaderboard',
			icon: '⭐',
		});

		const warnSpy = console.warn;
		const warnings: string[] = [];
		console.warn = (...args: unknown[]) => {
			warnings.push(String(args[0] ?? ''));
		};

		try {
			const results = await checkAndGrantAchievements(db, 'user1', 5000);
			expect(results.length).toBeGreaterThan(0);
		} finally {
			console.warn = warnSpy;
			(ACHIEVEMENTS as AchievementDefinition[]).splice(originalLength, 1);
		}

		expect(
			warnings.some((msg) => msg.includes('No check function for achievement: missing_check')),
		).toBe(true);
	});

	test('getAchievementsWithStatus merges earned metadata', async () => {
		resetMocks();
		const db = createMockDb();

		const results = await getAchievementsWithStatus(db, 'user1');

		const risingStar = results.find((a) => a.id === 'rising_star');
		expect(risingStar?.isUnlocked).toBe(true);
		expect(risingStar?.earnedAt).toBeInstanceOf(Date);
	});

	test('getUnlockedAchievements filters to unlocked only', async () => {
		resetMocks();
		const db = createMockDb();

		const results = await getUnlockedAchievements(db, 'user1');
		const ids = results.map((a) => a.id);
		expect(ids).toEqual(['rising_star']);
	});

	test('getAchievementProgress returns totals and percentage', async () => {
		resetMocks();
		const db = createMockDb();

		const progress = await getAchievementProgress(db, 'user1');
		expect(progress.total).toBe(ACHIEVEMENTS.length);
		expect(progress.unlocked).toBe(1);
		expect(progress.percentage).toBeCloseTo((1 / ACHIEVEMENTS.length) * 100);
	});
});
