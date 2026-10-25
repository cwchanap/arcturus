import { describe, expect, mock, test } from 'bun:test';
import type { Database } from '../db';
import { GAME_TYPES } from '../game-stats/constants';
import type { GameStats, GameType } from '../game-stats/types';
import type { AchievementDefinition, AchievementId, UserAchievementRecord } from './types';

const mockGetEarnedAchievementIds = Object.assign(async () => ['rising_star'] as AchievementId[], {
	calls: [] as Array<{ userId: string }>,
});
// Rows whose aggregate matches the legacy aggregate fixture:
// wins 120, losses 30, hands 150, biggestWin 500, netProfit 1000.
const STATS_ROWS: GameStats[] = [
	{
		userId: 'user1',
		gameType: 'blackjack',
		totalWins: 100,
		totalLosses: 20,
		handsPlayed: 120,
		biggestWin: 500,
		netProfit: 800,
		updatedAt: new Date('2025-01-01'),
	},
	{
		userId: 'user1',
		gameType: 'poker',
		totalWins: 20,
		totalLosses: 10,
		handsPlayed: 30,
		biggestWin: 200,
		netProfit: 200,
		updatedAt: new Date('2025-01-01'),
	},
];
const mockGetAllUserGameStats = Object.assign(async () => STATS_ROWS.map((row) => ({ ...row })), {
	calls: [] as Array<{ userId: string }>,
});
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
	mockGetAllUserGameStats.calls = [];
	mockGetUserRank.calls = [];
	mockGrantAchievement.calls = [];
	mockGetUserAchievements.calls = [];
}

const achievementsModule = await import('./achievements');
const { createAchievementService, ACHIEVEMENTS, DatabaseError } = achievementsModule;
const { ACHIEVEMENT_CHECKS } = await import('./achievement-rules');

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
	getAllUserGameStats: async (_db: Database, userId: string) => {
		mockGetAllUserGameStats.calls.push({ userId });
		return mockGetAllUserGameStats();
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
		// Exactly one per-game stats read per evaluation feeds both aggregate
		// fields and the per-game context rows.
		expect(mockGetAllUserGameStats.calls.length).toBe(1);
		expect(mockGetUserRank.calls.length).toBe(1);
		expect(mockGrantAchievement.calls.length).toBeGreaterThan(0);

		const ids = results.map((a) => a.id);
		expect(ids.includes('high_roller')).toBe(false);
		expect(ids.length).toBeGreaterThan(0);
	});

	test('checkAndGrantAchievements uses provided overallRank snapshot instead of refetching rank', async () => {
		resetMocks();
		const db = createMockDb();

		const results = await checkAndGrantAchievements(db, 'user1', 2000, {
			recentWinAmount: 1500,
			gameType: 'blackjack' as GameType,
			overallRank: 1,
		});

		expect(mockGetUserRank.calls.length).toBe(0);
		expect(results.some((achievement) => achievement.id === 'champion')).toBe(true);
	});

	test('checkAndGrantAchievements skips missing check functions', async () => {
		resetMocks();
		const db = createMockDb();
		// Explicitly construct array with 'consistent' first to ensure deterministic order
		// This ensures the DatabaseError from 'consistent' is thrown before 'missing_check' is evaluated
		const consistentAchievement = ACHIEVEMENTS.find(
			(achievement) => achievement.id === 'consistent',
		);
		const customAchievements: AchievementDefinition[] = [
			consistentAchievement!,
			{
				id: 'missing_check' as AchievementDefinition['id'],
				category: 'leaderboard',
				icon: '⭐',
			},
		];

		const warnSpy = console.warn;
		const warnings: string[] = [];
		console.warn = (...args: unknown[]) => {
			warnings.push(String(args[0] ?? ''));
		};

		try {
			const results = await checkAndGrantAchievements(db, 'user1', 5000, {}, customAchievements);
			expect(results.length).toBeGreaterThan(0);
		} finally {
			console.warn = warnSpy;
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

	test('getAchievementsWithStatus reports locked badges, per-game attribution, and grand_tour as global', async () => {
		const db = createMockDb();
		const earned: UserAchievementRecord[] = [
			{
				achievementId: 'jackpot',
				earnedAt: new Date('2025-02-01'),
				gameType: 'slots' as GameType,
			},
			{ achievementId: 'grand_tour', earnedAt: new Date('2025-02-02'), gameType: null },
		];
		const service = createAchievementService({ getUserAchievements: async () => earned });

		const results = await service.getAchievementsWithStatus(db, 'user1');

		const jackpot = results.find((a) => a.id === 'jackpot');
		expect(jackpot?.isUnlocked).toBe(true);
		expect(jackpot?.gameType).toBe('slots');

		// Grand Tour is global: unlocked with no game attribution.
		const grandTour = results.find((a) => a.id === 'grand_tour');
		expect(grandTour?.isUnlocked).toBe(true);
		expect(grandTour?.gameType).toBeNull();

		const tripleThreat = results.find((a) => a.id === 'triple_threat');
		expect(tripleThreat?.isUnlocked).toBe(false);
		expect(tripleThreat?.earnedAt).toBeNull();
		expect(tripleThreat?.gameType).toBeNull();
	});

	test('wraps repository failures as DatabaseError', async () => {
		const db = createMockDb();
		const service = createAchievementService({
			getEarnedAchievementIds: async () => {
				throw new Error('d1 unavailable');
			},
		});

		await expect(service.checkAndGrantAchievements(db, 'user1', 1000)).rejects.toMatchObject({
			name: 'DatabaseError',
		});
	});

	test('continues evaluating achievements when check function throws non-database error', async () => {
		const db = createMockDb();

		const customAchievementChecks = {
			...ACHIEVEMENT_CHECKS,
			consistent: () => {
				throw new Error('rule failure');
			},
		};

		const { checkAndGrantAchievements: checkWithCustomChecks } = createAchievementService({
			getEarnedAchievementIds: async () => [],
			grantAchievement: async () => true,
			getAllUserGameStats: async () => [],
			getUserRank: async () => null,
			achievementChecks: customAchievementChecks,
		});

		const warnSpy = console.warn;
		const warnings: string[] = [];
		console.warn = (...args: unknown[]) => {
			warnings.push(String(args[0] ?? ''));
		};

		const customAchievements: AchievementDefinition[] = [
			...ACHIEVEMENTS.filter((achievement) => achievement.id === 'consistent'),
			{
				id: 'missing_check' as AchievementDefinition['id'],
				category: 'leaderboard',
				icon: '⭐',
			},
		];

		try {
			await checkWithCustomChecks(db, 'user1', 5000, {}, customAchievements);
		} finally {
			console.warn = warnSpy;
		}

		expect(
			warnings.some((msg) => msg.includes('No check function for achievement: missing_check')),
		).toBe(true);
	});

	test('rethrows when achievement evaluation encounters DatabaseError', async () => {
		const db = createMockDb();
		const dbError = new DatabaseError('db operation failed', new Error('inner'));

		const customAchievementChecks = {
			...ACHIEVEMENT_CHECKS,
			consistent: () => {
				throw dbError;
			},
		};

		const { checkAndGrantAchievements: checkWithCustomChecks } = createAchievementService({
			getEarnedAchievementIds: async () => [],
			grantAchievement: async () => true,
			getAllUserGameStats: async () => [],
			getUserRank: async () => null,
			achievementChecks: customAchievementChecks,
		});

		const warnSpy = console.warn;
		const warnings: string[] = [];
		console.warn = (...args: unknown[]) => {
			warnings.push(String(args[0] ?? ''));
		};

		const customAchievements: AchievementDefinition[] = [
			...ACHIEVEMENTS.filter((achievement) => achievement.id === 'consistent'),
			{
				id: 'missing_check' as AchievementDefinition['id'],
				category: 'leaderboard',
				icon: '⭐',
			},
		];

		try {
			await expect(checkWithCustomChecks(db, 'user1', 5000, {}, customAchievements)).rejects.toBe(
				dbError,
			);
		} finally {
			console.warn = warnSpy;
		}

		expect(
			warnings.some((msg) => msg.includes('No check function for achievement: missing_check')),
		).toBe(false);
	});

	test('checkAndGrantAchievements forwards service feats into the check context', async () => {
		resetMocks();
		const db = createMockDb();

		const results = await checkAndGrantAchievements(db, 'user1', 2000, {
			gameType: 'slots' as GameType,
			feats: ['jackpot'],
		});

		expect(results.some((achievement) => achievement.id === 'jackpot')).toBe(true);
		const jackpotGrant = mockGrantAchievement.calls.find(
			(call) => call.achievementId === 'jackpot',
		);
		expect(jackpotGrant?.gameType).toBe('slots');
	});

	test('checkAndGrantAchievements does not grant reported feats when feats are absent', async () => {
		resetMocks();
		const db = createMockDb();

		const results = await checkAndGrantAchievements(db, 'user1', 2000, {
			gameType: 'slots' as GameType,
		});

		expect(results.some((achievement) => achievement.id === 'jackpot')).toBe(false);
	});

	test('checkAndGrantAchievements passes per-game rows so gameStats achievements can grant', async () => {
		const db = createMockDb();
		// One played row per game satisfies grand_tour while aggregate values
		// stay tiny so no other stats achievement interferes.
		const rows: GameStats[] = GAME_TYPES.map((gameType) => ({
			userId: 'user2',
			gameType,
			totalWins: 0,
			totalLosses: 0,
			handsPlayed: 5,
			biggestWin: 0,
			netProfit: 0,
			updatedAt: new Date('2025-01-01'),
		}));

		const { checkAndGrantAchievements: checkWithRows } = createAchievementService({
			getEarnedAchievementIds: async () => [],
			grantAchievement: async () => true,
			getAllUserGameStats: async () => rows,
			getUserRank: async () => null,
		});

		const results = await checkWithRows(db, 'user2', 1000);
		expect(results.some((achievement) => achievement.id === 'grand_tour')).toBe(true);
	});
});
