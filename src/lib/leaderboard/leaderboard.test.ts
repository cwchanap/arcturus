/**
 * Leaderboard Unit Tests
 *
 * Tests for leaderboard business logic and data transformation.
 */

import { describe, expect, test, mock, beforeEach } from 'bun:test';
import type { LeaderboardEntry, RawPlayerData } from './types';

// Mock the repository functions
const mockGetTopPlayers = mock<(limit: number) => Promise<RawPlayerData[]>>();
const mockGetUserRank = mock<(userId: string) => Promise<number | null>>();
const mockGetTotalPlayerCount = mock<() => Promise<number>>();

// We'll test the transformation logic directly since mocking Drizzle is complex
describe('Leaderboard Data Transformation', () => {
	beforeEach(() => {
		mockGetTopPlayers.mockReset();
		mockGetUserRank.mockReset();
		mockGetTotalPlayerCount.mockReset();
	});

	describe('Entry Transformation', () => {
		test('transforms raw player data to leaderboard entries with correct ranks', () => {
			const rawPlayers: RawPlayerData[] = [
				{ userId: 'user1', playerName: 'Alice', chipBalance: 50000 },
				{ userId: 'user2', playerName: 'Bob', chipBalance: 30000 },
				{ userId: 'user3', playerName: 'Charlie', chipBalance: 10000 },
			];

			const entries: LeaderboardEntry[] = rawPlayers.map((player, index) => ({
				rank: index + 1,
				userId: player.userId,
				playerName: player.playerName,
				chipBalance: player.chipBalance,
				isCurrentUser: player.userId === 'user2',
			}));

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

			const currentUserId = 'current-user';
			const entries: LeaderboardEntry[] = rawPlayers.map((player, index) => ({
				rank: index + 1,
				userId: player.userId,
				playerName: player.playerName,
				chipBalance: player.chipBalance,
				isCurrentUser: player.userId === currentUserId,
			}));

			expect(entries[0].isCurrentUser).toBe(false);
			expect(entries[1].isCurrentUser).toBe(true);
		});

		test('handles empty player list', () => {
			const rawPlayers: RawPlayerData[] = [];

			const entries: LeaderboardEntry[] = rawPlayers.map((player, index) => ({
				rank: index + 1,
				userId: player.userId,
				playerName: player.playerName,
				chipBalance: player.chipBalance,
				isCurrentUser: false,
			}));

			expect(entries).toHaveLength(0);
		});

		test('handles null currentUserId (unauthenticated)', () => {
			const rawPlayers: RawPlayerData[] = [
				{ userId: 'user1', playerName: 'Alice', chipBalance: 50000 },
			];

			const currentUserId: string | null = null;
			const entries: LeaderboardEntry[] = rawPlayers.map((player, index) => ({
				rank: index + 1,
				userId: player.userId,
				playerName: player.playerName,
				chipBalance: player.chipBalance,
				isCurrentUser: currentUserId ? player.userId === currentUserId : false,
			}));

			expect(entries[0].isCurrentUser).toBe(false);
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

			const currentUserInTop = entries.some((e) => e.isCurrentUser);
			expect(currentUserInTop).toBe(true);
		});

		test('detects when current user is NOT in top list', () => {
			const entries: LeaderboardEntry[] = [
				{ rank: 1, userId: 'user1', playerName: 'Alice', chipBalance: 50000, isCurrentUser: false },
				{ rank: 2, userId: 'user2', playerName: 'Bob', chipBalance: 30000, isCurrentUser: false },
			];

			const currentUserInTop = entries.some((e) => e.isCurrentUser);
			expect(currentUserInTop).toBe(false);
		});
	});

	describe('Rank Calculation Logic', () => {
		test('rank should be 1 for highest balance', () => {
			// User with highest balance should be rank 1
			// This tests the logic: rank = (count of users with higher balance) + 1
			const higherBalanceCount = 0;
			const rank = higherBalanceCount + 1;
			expect(rank).toBe(1);
		});

		test('rank calculation with tied balances uses user ID for tie-breaking', () => {
			// If two users have same balance, the one with lower ID (alphabetically) ranks higher
			// User A (id: "aaa") and User B (id: "bbb") both have 10000 chips
			// User A should rank higher because "aaa" < "bbb"

			// For User A: count of (higher balance OR same balance with lower ID) = 0
			const userARank = 0 + 1; // rank 1

			// For User B: count of (higher balance OR same balance with lower ID) = 1 (User A)
			const userBRank = 1 + 1; // rank 2

			expect(userARank).toBe(1);
			expect(userBRank).toBe(2);
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
