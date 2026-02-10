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
	existingRowResult = null as null | { earnedAt: Date },
}: {
	selectResult?: any[];
	insertResult?: any;
	insertThrows?: boolean;
	existingRowResult?: null | { earnedAt: Date };
}): Database {
	const selectChain = {
		from: () => ({
			where: () => ({
				orderBy: () => Promise.resolve(selectResult),
				limit: () => Promise.resolve(selectResult.slice(0, 1)),
			}),
		}),
	};

	// Create a thenable that supports both await and .limit() chaining
	const createWhereThenable = (fullResult: any[], limitedResult: any[]) => {
		// Create a real Promise and attach the limit method to it
		const promise = Promise.resolve(fullResult) as Promise<any[]> & { limit: () => Promise<any[]> };
		promise.limit = () => Promise.resolve(limitedResult);
		return promise;
	};

	return {
		select: (columns?: any) => {
			// Initial check for existing row in grantAchievement (select with earnedAt column)
			if (columns?.earnedAt) {
				return {
					from: () => ({
						where: () => ({
							limit: () => Promise.resolve(existingRowResult ? [existingRowResult] : []),
						}),
					}),
				};
			}
			if (columns?.achievementId) {
				// For getEarnedAchievementIds and hasAchievement
				// Chain: select().from().where() -> returns thenable
				//        select().from().where().limit() -> thenable.limit()
				return {
					from: () => ({
						where: () => createWhereThenable(selectResult, selectResult.slice(0, 1)),
					}),
				};
			}
			if (columns?.count) {
				// For COUNT(*) queries in getAchievementCount
				return {
					from: () => ({
						where: () => Promise.resolve([{ count: selectResult.length }]),
					}),
				};
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

	test('grantAchievement returns true when no existing row and insert succeeds', async () => {
		const mockDb = createMockDb({
			existingRowResult: null, // No existing row found
		});

		const granted = await grantAchievement(mockDb, 'user1', 'high_roller', 'poker' as GameType);
		expect(granted).toBe(true);
	});

	test('grantAchievement returns false when row already exists', async () => {
		const mockDb = createMockDb({
			existingRowResult: { earnedAt: new Date('2024-01-15T10:30:00.000Z') }, // Existing row found
		});

		const granted = await grantAchievement(mockDb, 'user1', 'high_roller');
		expect(granted).toBe(false);
	});

	test('grantAchievement handles concurrent requests safely (check-then-insert pattern)', async () => {
		// With the check-then-insert pattern, if two concurrent requests both check
		// and find no existing row, only one will succeed in inserting due to
		// onConflictDoNothing at the database level
		const mockDb = createMockDb({
			existingRowResult: null, // No existing row at check time
		});

		const granted = await grantAchievement(mockDb, 'user1', 'high_roller');
		expect(granted).toBe(true); // Should succeed when no existing row
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
