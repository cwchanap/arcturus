import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';

type TopPlayer = {
	userId: string;
	playerName: string;
	chipBalance: number;
};

const mockGetTopPlayers = Object.assign(async (): Promise<TopPlayer[]> => [], {
	calls: [] as unknown[][],
	impl: async (): Promise<TopPlayer[]> => [],
});

const mockGetUserRank = Object.assign(async (): Promise<number | null> => null, {
	calls: [] as unknown[][],
	impl: async () => null as number | null,
});

const mockGetTotalPlayerCount = Object.assign(async (): Promise<number> => 0, {
	calls: [] as unknown[][],
	impl: async () => 0,
});

const mockGetBulkUserAchievements = Object.assign(async () => new Map<string, string[]>(), {
	calls: [] as unknown[][],
	impl: async () => new Map<string, string[]>(),
});

let getLeaderboardData: typeof import('./leaderboard').getLeaderboardData;

beforeAll(() => {
	mock.module('./leaderboard-repository', () => ({
		getTopPlayers: async (...args: unknown[]) => {
			mockGetTopPlayers.calls.push(args);
			return mockGetTopPlayers.impl();
		},
		getUserRank: async (...args: unknown[]) => {
			mockGetUserRank.calls.push(args);
			return mockGetUserRank.impl();
		},
		getTotalPlayerCount: async (...args: unknown[]) => {
			mockGetTotalPlayerCount.calls.push(args);
			return mockGetTotalPlayerCount.impl();
		},
	}));

	mock.module('../achievements/achievement-repository', () => ({
		getBulkUserAchievements: async (...args: unknown[]) => {
			mockGetBulkUserAchievements.calls.push(args);
			return mockGetBulkUserAchievements.impl();
		},
	}));
});

beforeAll(async () => {
	({ getLeaderboardData } = await import('./leaderboard'));
});

beforeEach(() => {
	mockGetTopPlayers.calls = [];
	mockGetUserRank.calls = [];
	mockGetTotalPlayerCount.calls = [];
	mockGetBulkUserAchievements.calls = [];
	mockGetTopPlayers.impl = async () => [
		{ userId: 'user-1', playerName: 'Alice', chipBalance: 5000 },
		{ userId: 'user-2', playerName: 'Bob', chipBalance: 4000 },
	];
	mockGetUserRank.impl = async () => 3;
	mockGetTotalPlayerCount.impl = async () => 25;
	mockGetBulkUserAchievements.impl = async () => new Map([['user-1', ['🏆']]]);
});

afterAll(async () => {
	const actualRepository = await import(`./leaderboard-repository.ts?restore=${Date.now()}`);
	const actualAchievements = await import(
		`../achievements/achievement-repository.ts?restore=${Date.now()}`
	);
	mock.module('./leaderboard-repository', () => actualRepository);
	mock.module('../achievements/achievement-repository', () => actualAchievements);
	mock.restore();
});

describe('getLeaderboardData', () => {
	test('returns leaderboard data after top players resolve', async () => {
		const result = await getLeaderboardData({} as never, {
			currentUserId: 'current-user',
			limit: 2,
		});

		expect(result.entries).toHaveLength(2);
		expect(result.entries[0]?.badges).toEqual(['🏆']);
		expect(result.currentUserRank).toBe(3);
		expect(result.totalPlayers).toBe(25);
		expect(mockGetTopPlayers.calls).toHaveLength(1);
		expect(mockGetUserRank.calls).toHaveLength(1);
		expect(mockGetTotalPlayerCount.calls).toHaveLength(1);
		expect(mockGetBulkUserAchievements.calls).toHaveLength(1);
	});

	test('does not start rank or count queries when top players fails', async () => {
		const topPlayersError = new Error('top players failed');
		mockGetTopPlayers.impl = async () => {
			throw topPlayersError;
		};

		await expect(
			getLeaderboardData({} as never, {
				currentUserId: 'current-user',
				limit: 2,
			}),
		).rejects.toThrow(topPlayersError.message);

		expect(mockGetTopPlayers.calls).toHaveLength(1);
		expect(mockGetUserRank.calls).toHaveLength(0);
		expect(mockGetTotalPlayerCount.calls).toHaveLength(0);
		expect(mockGetBulkUserAchievements.calls).toHaveLength(0);
	});
});
