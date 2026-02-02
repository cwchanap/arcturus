import { describe, expect, test } from 'bun:test';
import {
	getUserAchievements,
	getEarnedAchievementIds,
	grantAchievement,
	hasAchievement,
	getAchievementCount,
} from './achievement-repository';
import type { Database } from '../db';
import type { GameType } from '../game-stats/types';

function createMockDb({
	selectResult = [],
	insertResult = { meta: { changes: 1 } },
	insertThrows = false,
}: {
	selectResult?: any[];
	insertResult?: any;
	insertThrows?: boolean;
}): Database {
	const selectChain = {
		from: () => ({
			where: () => ({
				orderBy: () => Promise.resolve(selectResult),
			}),
		}),
	};

	const selectProjectedChain = {
		from: () => ({
			where: () => Promise.resolve(selectResult),
		}),
	};

	return {
		select: (columns?: any) => {
			if (columns?.achievementId) {
				return selectProjectedChain;
			}
			return selectChain;
		},
		insert: () => ({
			values: () => ({
				onConflictDoNothing: () => {
					if (insertThrows) {
						throw new Error('insert failed');
					}
					return Promise.resolve(insertResult);
				},
			}),
		}),
	} as unknown as Database;
}

describe('achievement-repository', () => {
	test('getUserAchievements maps results with types', async () => {
		const now = new Date();
		const mockDb = createMockDb({
			selectResult: [{ achievementId: 'rising_star', earnedAt: now, gameType: 'blackjack' }],
		});

		const results = await getUserAchievements(mockDb, 'user1');
		expect(results).toEqual([
			{
				achievementId: 'rising_star',
				earnedAt: now,
				gameType: 'blackjack' as GameType,
			},
		]);
	});

	test('getEarnedAchievementIds returns id list', async () => {
		const mockDb = createMockDb({
			selectResult: [{ achievementId: 'champion' }, { achievementId: 'comeback' }],
		});

		const results = await getEarnedAchievementIds(mockDb, 'user1');
		expect(results).toEqual(['champion', 'comeback']);
	});

	test('grantAchievement returns true when insert succeeds', async () => {
		const mockDb = createMockDb({ insertResult: { meta: { changes: 1 } } });

		const granted = await grantAchievement(mockDb, 'user1', 'high_roller', 'poker' as GameType);
		expect(granted).toBe(true);
	});

	test('grantAchievement returns false when insert is skipped', async () => {
		const mockDb = createMockDb({ insertResult: { meta: { changes: 0 } } });

		const granted = await grantAchievement(mockDb, 'user1', 'high_roller');
		expect(granted).toBe(false);
	});

	test('grantAchievement logs and rethrows on error', async () => {
		const consoleSpy = console.error;
		const messages: string[] = [];
		console.error = (...args: unknown[]) => {
			messages.push(String(args[0] ?? ''));
		};

		const mockDb = createMockDb({ insertThrows: true });

		try {
			await expect(
				grantAchievement(mockDb, 'user1', 'champion', 'baccarat' as GameType),
			).rejects.toThrow('insert failed');

			expect(messages.some((msg) => msg.includes('[ACHIEVEMENT_GRANT_ERROR]'))).toBe(true);
		} finally {
			console.error = consoleSpy;
		}
	});

	test('hasAchievement checks earned list', async () => {
		const mockDb = createMockDb({ selectResult: [{ achievementId: 'comeback' }] });

		const result = await hasAchievement(mockDb, 'user1', 'comeback');
		expect(result).toBe(true);
	});

	test('getAchievementCount returns total', async () => {
		const mockDb = createMockDb({
			selectResult: [
				{ achievementId: 'rising_star', earnedAt: new Date(), gameType: null },
				{ achievementId: 'high_roller', earnedAt: new Date(), gameType: 'poker' },
			],
		});

		const count = await getAchievementCount(mockDb, 'user1');
		expect(count).toBe(2);
	});
});
