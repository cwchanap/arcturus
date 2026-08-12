/**
 * Leaderboard Repository Tests
 *
 * Tests for database operations in leaderboard-repository.ts
 * Uses a mock Drizzle ORM chain pattern similar to game-stats-repository.test.ts
 */

import { beforeAll, describe, expect, mock, test } from 'bun:test';
import type { Database } from '../db';
import type { RawPlayerData } from './types';

type LeaderboardRepositoryModule = typeof import('./leaderboard-repository');

let getTopPlayers!: LeaderboardRepositoryModule['getTopPlayers'];
let getUserRank!: LeaderboardRepositoryModule['getUserRank'];
let getTotalPlayerCount!: LeaderboardRepositoryModule['getTotalPlayerCount'];
let calculateRank!: LeaderboardRepositoryModule['calculateRank'];

beforeAll(async () => {
	// Ensure this file always tests the real repository implementation, even when
	// other test files use mock.module('./leaderboard-repository') concurrently.
	// The cache-busting query param bypasses any leaked mock.module() override.
	mock.restore();
	const repository = await import(`./leaderboard-repository.ts?repository-test=${Date.now()}`);
	getTopPlayers = repository.getTopPlayers;
	getUserRank = repository.getUserRank;
	getTotalPlayerCount = repository.getTotalPlayerCount;
	calculateRank = repository.calculateRank;
});

/**
 * Mock database that simulates the Drizzle ORM query chains used by
 * leaderboard-repository.ts:
 *
 * 1. select({...}).from(user).orderBy(...).limit(...)  → getTopPlayers
 * 2. select({chipBalance}).from(user).where(eq).limit(1) → getUserRank (user lookup)
 * 3. select({count}).from(user).where(or(...))           → getUserRank (rank count)
 * 4. select({count}).from(user)                           → getTotalPlayerCount
 */
function createMockDb({
	topPlayers = [],
	userBalance = null,
	higherRankedCount = 0,
	totalCount = 0,
	capturedOrderBy,
	capturedLimit,
}: {
	topPlayers?: RawPlayerData[];
	userBalance?: number | null;
	higherRankedCount?: number;
	totalCount?: number;
	capturedOrderBy?: { clauses?: unknown[] };
	capturedLimit?: { limit?: number };
}): Database {
	const isCountColumn = (columns: unknown): boolean =>
		!!columns && typeof columns === 'object' && 'count' in (columns as Record<string, unknown>);

	const isTopPlayersSelect = (columns: unknown): boolean =>
		!!columns && typeof columns === 'object' && 'userId' in (columns as Record<string, unknown>);

	const isChipBalanceOnly = (columns: unknown): boolean =>
		!!columns &&
		typeof columns === 'object' &&
		'chipBalance' in (columns as Record<string, unknown>) &&
		!('userId' in (columns as Record<string, unknown>));

	return {
		select: (columns?: any) => ({
			from: (_table: any) => {
				// Count query (used by getUserRank rank-count and getTotalPlayerCount)
				if (isCountColumn(columns)) {
					return {
						// getTotalPlayerCount has no .where() — it resolves directly
						then: <T>(
							onfulfilled: (value: Array<{ count: number }>) => T,
							onrejected?: (reason: any) => T,
						) => {
							return Promise.resolve([{ count: totalCount }]).then(onfulfilled, onrejected);
						},
						where: (_condition: any) => Promise.resolve([{ count: higherRankedCount }]),
					};
				}

				// Full-column select (used by getTopPlayers)
				if (isTopPlayersSelect(columns)) {
					return {
						orderBy: (...clauses: any[]) => ({
							limit: (n: number) => {
								if (capturedOrderBy) {
									capturedOrderBy.clauses = clauses;
								}
								if (capturedLimit) {
									capturedLimit.limit = n;
								}
								return Promise.resolve(topPlayers);
							},
						}),
					};
				}

				// chipBalance-only query (used by getUserRank user lookup)
				if (isChipBalanceOnly(columns)) {
					return {
						where: (_condition: any) => ({
							limit: (_n: number) =>
								Promise.resolve(userBalance === null ? [] : [{ chipBalance: userBalance }]),
						}),
					};
				}

				// Fallback (should not be reached by leaderboard-repository)
				return {
					orderBy: (...clauses: any[]) => ({
						limit: (n: number) => {
							if (capturedOrderBy) {
								capturedOrderBy.clauses = clauses;
							}
							if (capturedLimit) {
								capturedLimit.limit = n;
							}
							return Promise.resolve(topPlayers);
						},
					}),
				};
			},
		}),
	} as unknown as Database;
}

describe('calculateRank', () => {
	test('returns 1 when no players have a higher balance', () => {
		const currentUser = { id: 'user1', chipBalance: 1000 };
		const allPlayers = [
			{ id: 'user1', chipBalance: 1000 },
			{ id: 'user2', chipBalance: 500 },
		];
		expect(calculateRank(currentUser, allPlayers)).toBe(1);
	});

	test('counts players with higher balance', () => {
		const currentUser = { id: 'user1', chipBalance: 500 };
		const allPlayers = [
			{ id: 'user1', chipBalance: 500 },
			{ id: 'user2', chipBalance: 1000 },
			{ id: 'user3', chipBalance: 750 },
		];
		expect(calculateRank(currentUser, allPlayers)).toBe(3);
	});

	test('tie-breaks by lower user id', () => {
		const currentUser = { id: 'userB', chipBalance: 1000 };
		const allPlayers = [
			{ id: 'userA', chipBalance: 1000 },
			{ id: 'userB', chipBalance: 1000 },
			{ id: 'userC', chipBalance: 1000 },
		];
		// userA has same balance and lower id → ranked higher
		expect(calculateRank(currentUser, allPlayers)).toBe(2);
	});

	test('returns 1 for the sole player with the highest balance and lowest id', () => {
		const currentUser = { id: 'aaa', chipBalance: 9999 };
		const allPlayers = [
			{ id: 'aaa', chipBalance: 9999 },
			{ id: 'bbb', chipBalance: 9999 },
		];
		expect(calculateRank(currentUser, allPlayers)).toBe(1);
	});

	test('returns 1 when allPlayers is empty', () => {
		const currentUser = { id: 'user1', chipBalance: 100 };
		expect(calculateRank(currentUser, [])).toBe(1);
	});
});

/**
 * Recursively extracts readable text from Drizzle ORM SQL/order objects.
 */
function drizzleSqlText(value: unknown): string {
	if (value == null) return '';
	if (typeof value === 'string') return value;
	if (typeof value === 'number') return String(value);
	if (typeof value !== 'object') return '';
	const obj = value as Record<string, unknown>;
	if (Array.isArray(obj.queryChunks)) {
		return obj.queryChunks.map((c: unknown) => drizzleSqlText(c)).join('');
	}
	if (typeof obj.name === 'string' && obj.name.length > 0) {
		return obj.name;
	}
	if (Array.isArray(obj.value)) {
		return obj.value.map((v: unknown) => drizzleSqlText(v)).join('');
	}
	if (obj.value !== undefined && obj.value !== null) {
		return drizzleSqlText(obj.value);
	}
	return '';
}

describe('getTopPlayers', () => {
	test('returns players ordered by chip balance descending', async () => {
		const topPlayers: RawPlayerData[] = [
			{ userId: 'user1', playerName: 'Alice', chipBalance: 5000 },
			{ userId: 'user2', playerName: 'Bob', chipBalance: 3000 },
			{ userId: 'user3', playerName: 'Carol', chipBalance: 1000 },
		];
		const capturedOrderBy: { clauses?: unknown[] } = {};
		const mockDb = createMockDb({ topPlayers, capturedOrderBy });

		const result = await getTopPlayers(mockDb, 10);
		expect(result).toEqual(topPlayers);
		expect(result).toHaveLength(3);
		// Verify the query orders by descending chip balance
		expect(capturedOrderBy.clauses).toBeDefined();
		expect(capturedOrderBy.clauses).toHaveLength(2);
		expect(drizzleSqlText(capturedOrderBy.clauses?.[0])).toContain('chipBalance');
	});

	test('returns empty array when no players exist', async () => {
		const mockDb = createMockDb({ topPlayers: [] });
		const result = await getTopPlayers(mockDb, 50);
		expect(result).toEqual([]);
	});

	test('respects the limit parameter', async () => {
		const topPlayers: RawPlayerData[] = [
			{ userId: 'user1', playerName: 'Alice', chipBalance: 5000 },
		];
		const capturedLimit: { limit?: number } = {};
		const mockDb = createMockDb({ topPlayers, capturedLimit });
		const result = await getTopPlayers(mockDb, 1);
		expect(result).toHaveLength(1);
		expect(capturedLimit.limit).toBe(1);
	});
});

describe('getUserRank', () => {
	test('returns null when user is not found', async () => {
		const mockDb = createMockDb({ userBalance: null });
		const result = await getUserRank(mockDb, 'nonexistent');
		expect(result).toBeNull();
	});

	test('calculates rank correctly when user exists', async () => {
		const mockDb = createMockDb({
			userBalance: 500,
			higherRankedCount: 2,
		});
		const result = await getUserRank(mockDb, 'user1');
		expect(result).toBe(3); // 2 higher + 1
	});

	test('returns rank 1 when no players have higher balance', async () => {
		const mockDb = createMockDb({
			userBalance: 9999,
			higherRankedCount: 0,
		});
		const result = await getUserRank(mockDb, 'user1');
		expect(result).toBe(1);
	});
});

describe('getTotalPlayerCount', () => {
	test('returns total player count from database', async () => {
		const mockDb = createMockDb({ totalCount: 42 });
		const result = await getTotalPlayerCount(mockDb);
		expect(result).toBe(42);
	});

	test('returns 0 when no players exist', async () => {
		const mockDb = createMockDb({ totalCount: 0 });
		const result = await getTotalPlayerCount(mockDb);
		expect(result).toBe(0);
	});
});
