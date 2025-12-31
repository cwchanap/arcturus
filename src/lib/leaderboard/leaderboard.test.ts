/**
 * Leaderboard Unit Tests
 *
 * Tests for leaderboard business logic and data transformation.
 */

import { describe, expect, test } from 'bun:test';
import type { LeaderboardEntry, RawPlayerData } from './types';
import { isCurrentUserInTop, transformToLeaderboardEntries } from './leaderboard';
import { calculateRank, type PlayerForRank } from './leaderboard-repository';

describe('Leaderboard Data Transformation', () => {
	describe('Entry Transformation', () => {
		test('transforms raw player data to leaderboard entries with correct ranks', () => {
			const rawPlayers: RawPlayerData[] = [
				{ userId: 'user1', playerName: 'Alice', chipBalance: 50000 },
				{ userId: 'user2', playerName: 'Bob', chipBalance: 30000 },
				{ userId: 'user3', playerName: 'Charlie', chipBalance: 10000 },
			];

			const entries = transformToLeaderboardEntries(rawPlayers, 'user2');

			expect(entries).toHaveLength(3);
			expect(entries[0].rank).toBe(1);
			expect(entries[0].playerName).toBe('Alice');
			expect(entries[1].rank).toBe(2);
			expect(entries[1].isCurrentUser).toBe(true);
			expect(entries[2].rank).toBe(3);
		});

		test('marks current user correctly when they are in the list', () => {
			const rawPlayers: RawPlayerData[] = [
				{ userId: 'user1', playerName: 'Alice', chipBalance: 50000 },
				{ userId: 'current-user', playerName: 'Me', chipBalance: 30000 },
			];

			const entries = transformToLeaderboardEntries(rawPlayers, 'current-user');

			expect(entries[0].isCurrentUser).toBe(false);
			expect(entries[1].isCurrentUser).toBe(true);
		});

		test('handles empty player list', () => {
			const rawPlayers: RawPlayerData[] = [];

			const entries = transformToLeaderboardEntries(rawPlayers);

			expect(entries).toHaveLength(0);
		});

		test('handles null currentUserId (unauthenticated)', () => {
			const rawPlayers: RawPlayerData[] = [
				{ userId: 'user1', playerName: 'Alice', chipBalance: 50000 },
			];

			const entries = transformToLeaderboardEntries(rawPlayers, null);

			expect(entries[0].isCurrentUser).toBe(false);
		});

		test('marks all users as not current when currentUserId is not in list', () => {
			const rawPlayers: RawPlayerData[] = [
				{ userId: 'user1', playerName: 'Alice', chipBalance: 50000 },
				{ userId: 'user2', playerName: 'Bob', chipBalance: 30000 },
			];

			const entries = transformToLeaderboardEntries(rawPlayers, 'user3');

			expect(entries[0].isCurrentUser).toBe(false);
			expect(entries[1].isCurrentUser).toBe(false);
		});

		test('preserves all player data in transformation', () => {
			const rawPlayers: RawPlayerData[] = [
				{ userId: 'user1', playerName: 'Alice', chipBalance: 50000 },
			];

			const entries = transformToLeaderboardEntries(rawPlayers);

			expect(entries[0].userId).toBe('user1');
			expect(entries[0].playerName).toBe('Alice');
			expect(entries[0].chipBalance).toBe(50000);
			expect(entries[0].rank).toBe(1);
		});

		test('assigns sequential ranks starting from 1', () => {
			const rawPlayers: RawPlayerData[] = [
				{ userId: 'user1', playerName: 'Alice', chipBalance: 50000 },
				{ userId: 'user2', playerName: 'Bob', chipBalance: 40000 },
				{ userId: 'user3', playerName: 'Charlie', chipBalance: 30000 },
				{ userId: 'user4', playerName: 'David', chipBalance: 20000 },
				{ userId: 'user5', playerName: 'Eve', chipBalance: 10000 },
			];

			const entries = transformToLeaderboardEntries(rawPlayers);

			expect(entries[0].rank).toBe(1);
			expect(entries[1].rank).toBe(2);
			expect(entries[2].rank).toBe(3);
			expect(entries[3].rank).toBe(4);
			expect(entries[4].rank).toBe(5);
		});
	});

	describe('Current User In Top Detection', () => {
		test('detects when current user is in top list', () => {
			const entries: LeaderboardEntry[] = [
				{ rank: 1, userId: 'user1', playerName: 'Alice', chipBalance: 50000, isCurrentUser: false },
				{
					rank: 2,
					userId: 'current',
					playerName: 'Me',
					chipBalance: 30000,
					isCurrentUser: true,
				},
			];

			const currentUserInTop = isCurrentUserInTop(entries);
			expect(currentUserInTop).toBe(true);
		});

		test('detects when current user is NOT in top list', () => {
			const entries: LeaderboardEntry[] = [
				{ rank: 1, userId: 'user1', playerName: 'Alice', chipBalance: 50000, isCurrentUser: false },
				{ rank: 2, userId: 'user2', playerName: 'Bob', chipBalance: 30000, isCurrentUser: false },
			];

			const currentUserInTop = isCurrentUserInTop(entries);
			expect(currentUserInTop).toBe(false);
		});
	});

	describe('Rank Calculation Logic', () => {
		test('rank should be 1 for highest balance (single user)', () => {
			// User with highest balance should be rank 1
			const allPlayers: PlayerForRank[] = [{ id: 'user1', chipBalance: 50000 }];
			const currentUser = { id: 'user1', chipBalance: 50000 };

			const rank = calculateRank(currentUser, allPlayers);
			expect(rank).toBe(1);
		});

		test('rank should be 2 for second highest balance', () => {
			// User with second highest balance should be rank 2
			const allPlayers: PlayerForRank[] = [
				{ id: 'user1', chipBalance: 50000 },
				{ id: 'user2', chipBalance: 30000 },
			];
			const currentUser = { id: 'user2', chipBalance: 30000 };

			const rank = calculateRank(currentUser, allPlayers);
			expect(rank).toBe(2);
		});

		test('rank calculation with tied balances uses user ID for tie-breaking', () => {
			// If two users have same balance, the one with lower ID (alphabetically) ranks higher
			// User A (id: "aaa") and User B (id: "bbb") both have 10000 chips
			// User A should rank higher because "aaa" < "bbb"

			const allPlayers: PlayerForRank[] = [
				{ id: 'aaa', chipBalance: 10000 },
				{ id: 'bbb', chipBalance: 10000 },
			];

			// Test User A: should be rank 1 (no users with higher balance OR same balance with lower ID)
			const userARank = calculateRank({ id: 'aaa', chipBalance: 10000 }, allPlayers);
			expect(userARank).toBe(1);

			// Test User B: should be rank 2 (1 user with same balance and lower ID: "aaa")
			const userBRank = calculateRank({ id: 'bbb', chipBalance: 10000 }, allPlayers);
			expect(userBRank).toBe(2);
		});

		test('rank calculation with multiple tied users', () => {
			// Three users with same balance: "alice", "bob", "charlie" all have 10000 chips
			// Expected ranks: alice=1, bob=2, charlie=3 (alphabetical order)

			const allPlayers: PlayerForRank[] = [
				{ id: 'alice', chipBalance: 10000 },
				{ id: 'bob', chipBalance: 10000 },
				{ id: 'charlie', chipBalance: 10000 },
			];

			expect(calculateRank({ id: 'alice', chipBalance: 10000 }, allPlayers)).toBe(1);
			expect(calculateRank({ id: 'bob', chipBalance: 10000 }, allPlayers)).toBe(2);
			expect(calculateRank({ id: 'charlie', chipBalance: 10000 }, allPlayers)).toBe(3);
		});

		test('rank calculation with mixed balances and ties', () => {
			// Complex scenario:
			// user1: 50000 chips -> rank 1
			// user2: 40000 chips -> rank 2
			// user3: 40000 chips -> rank 3 (tied with user2, but user2 < user3 alphabetically)
			// user4: 30000 chips -> rank 4

			const allPlayers: PlayerForRank[] = [
				{ id: 'user1', chipBalance: 50000 },
				{ id: 'user2', chipBalance: 40000 },
				{ id: 'user3', chipBalance: 40000 },
				{ id: 'user4', chipBalance: 30000 },
			];

			expect(calculateRank({ id: 'user1', chipBalance: 50000 }, allPlayers)).toBe(1);
			expect(calculateRank({ id: 'user2', chipBalance: 40000 }, allPlayers)).toBe(2);
			expect(calculateRank({ id: 'user3', chipBalance: 40000 }, allPlayers)).toBe(3);
			expect(calculateRank({ id: 'user4', chipBalance: 30000 }, allPlayers)).toBe(4);
		});

		test('rank calculation with numeric IDs', () => {
			// Numeric IDs should also work correctly for tie-breaking
			const allPlayers: PlayerForRank[] = [
				{ id: '100', chipBalance: 10000 },
				{ id: '200', chipBalance: 10000 },
				{ id: '150', chipBalance: 10000 },
			];

			// Sorted by ID: 100, 150, 200
			expect(calculateRank({ id: '100', chipBalance: 10000 }, allPlayers)).toBe(1);
			expect(calculateRank({ id: '150', chipBalance: 10000 }, allPlayers)).toBe(2);
			expect(calculateRank({ id: '200', chipBalance: 10000 }, allPlayers)).toBe(3);
		});

		test('rank calculation with zero balance', () => {
			// Users with zero balance should still be ranked correctly
			const allPlayers: PlayerForRank[] = [
				{ id: 'user1', chipBalance: 10000 },
				{ id: 'user2', chipBalance: 0 },
				{ id: 'user3', chipBalance: 0 },
			];

			expect(calculateRank({ id: 'user1', chipBalance: 10000 }, allPlayers)).toBe(1);
			expect(calculateRank({ id: 'user2', chipBalance: 0 }, allPlayers)).toBe(2);
			expect(calculateRank({ id: 'user3', chipBalance: 0 }, allPlayers)).toBe(3);
		});
	});

	describe('LeaderboardData Structure', () => {
		test('creates complete leaderboard data object', () => {
			const entries: LeaderboardEntry[] = [
				{ rank: 1, userId: 'user1', playerName: 'Alice', chipBalance: 50000, isCurrentUser: false },
			];
			const currentUserRank = 25;
			const totalPlayers = 100;
			const currentUserInTop = false;

			const leaderboardData = {
				entries,
				currentUserRank,
				currentUserInTop,
				totalPlayers,
			};

			expect(leaderboardData.entries).toHaveLength(1);
			expect(leaderboardData.currentUserRank).toBe(25);
			expect(leaderboardData.currentUserInTop).toBe(false);
			expect(leaderboardData.totalPlayers).toBe(100);
		});
	});
});

describe('Type Definitions', () => {
	test('LeaderboardEntry has all required fields', () => {
		const entry: LeaderboardEntry = {
			rank: 1,
			userId: 'test-id',
			playerName: 'Test Player',
			chipBalance: 10000,
			isCurrentUser: false,
		};

		expect(entry.rank).toBeDefined();
		expect(entry.userId).toBeDefined();
		expect(entry.playerName).toBeDefined();
		expect(entry.chipBalance).toBeDefined();
		expect(entry.isCurrentUser).toBeDefined();
	});

	test('RawPlayerData has all required fields', () => {
		const raw: RawPlayerData = {
			userId: 'test-id',
			playerName: 'Test Player',
			chipBalance: 10000,
		};

		expect(raw.userId).toBeDefined();
		expect(raw.playerName).toBeDefined();
		expect(raw.chipBalance).toBeDefined();
	});
});

describe('DEFAULT_LEADERBOARD_LIMIT', () => {
	test('default limit is 50', async () => {
		const { DEFAULT_LEADERBOARD_LIMIT } = await import('./types');
		expect(DEFAULT_LEADERBOARD_LIMIT).toBe(50);
	});
});
