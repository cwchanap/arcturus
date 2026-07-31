import { describe, expect, test } from 'bun:test';
import type { APIRoute } from 'astro';
import type { Database } from '../lib/db';
import { GAME_TYPES } from '../lib/game-stats/constants';
import type { PlayerStatisticsDashboard } from '../lib/game-stats/player-statistics-types';
import { createStatisticsGetHandler } from '../pages/api/profile/statistics';

const database = {} as Database;

const dashboard: PlayerStatisticsDashboard = {
	summary: {
		totalHands: 4,
		totalWins: 3,
		totalLosses: 1,
		overallWinRate: 75,
		totalNetProfit: 50,
		mostPlayedGame: 'blackjack',
	},
	games: GAME_TYPES.map((gameType, index) => ({
		gameType,
		totalWins: index === 0 ? 3 : 0,
		totalLosses: index === 0 ? 1 : 0,
		handsPlayed: index === 0 ? 4 : 0,
		winRate: index === 0 ? 75 : 0,
		netProfit: index === 0 ? 50 : 0,
		biggestWin: index === 0 ? 50 : 0,
		winsRank: index === 0 ? 1 : null,
	})),
};

function createContext({
	session = true,
	binding = {} as D1Database | null,
}: {
	session?: boolean;
	binding?: D1Database | null;
} = {}) {
	return {
		locals: {
			session: session ? { user: { id: 'session-user' } } : null,
			runtime: { env: binding ? { DB: binding } : {} },
		},
		params: { userId: 'attacker-selected-user' },
		url: new URL('https://arcturus.example/api/profile/statistics?userId=attacker-selected-user'),
		request: new Request(
			'https://arcturus.example/api/profile/statistics?userId=attacker-selected-user',
		),
	} as unknown as Parameters<APIRoute>[0];
}

function expectPrivateJson(response: Response) {
	expect(response.headers.get('content-type')).toContain('application/json');
	expect(response.headers.get('cache-control')).toBe('private, no-store');
}

describe('GET /api/profile/statistics', () => {
	test('returns the dashboard for the authenticated session identity only', async () => {
		const createDbCalls: D1Database[] = [];
		const serviceCalls: Array<[Database, string]> = [];
		const GET = createStatisticsGetHandler({
			createDb: (binding) => {
				createDbCalls.push(binding);
				return database;
			},
			getPlayerStatisticsDashboard: async (db, userId) => {
				serviceCalls.push([db, userId]);
				return dashboard;
			},
		});
		const binding = {} as D1Database;

		const response = await GET(createContext({ binding }));

		expect(response.status).toBe(200);
		expectPrivateJson(response);
		expect(JSON.parse(await response.text()) as unknown).toEqual(dashboard);
		expect(createDbCalls).toEqual([binding]);
		expect(serviceCalls).toEqual([[database, 'session-user']]);
	});

	test('returns a private no-store 401 without loading statistics when unauthenticated', async () => {
		let loaded = false;
		const GET = createStatisticsGetHandler({
			createDb: () => database,
			getPlayerStatisticsDashboard: async () => {
				loaded = true;
				return dashboard;
			},
		});

		const response = await GET(createContext({ session: false }));

		expect(response.status).toBe(401);
		expectPrivateJson(response);
		expect(JSON.parse(await response.text()) as unknown).toEqual({ error: 'Unauthorized' });
		expect(loaded).toBe(false);
	});

	test('returns a private no-store 500 when the database binding is missing', async () => {
		let loaded = false;
		const GET = createStatisticsGetHandler({
			createDb: () => database,
			getPlayerStatisticsDashboard: async () => {
				loaded = true;
				return dashboard;
			},
		});

		const response = await GET(createContext({ binding: null }));

		expect(response.status).toBe(500);
		expectPrivateJson(response);
		expect(JSON.parse(await response.text()) as unknown).toEqual({
			error: 'Unable to load player statistics',
		});
		expect(loaded).toBe(false);
	});

	test('returns a private no-store 500 when statistics loading throws', async () => {
		const GET = createStatisticsGetHandler({
			createDb: () => database,
			getPlayerStatisticsDashboard: async () => {
				throw new Error('database failed');
			},
		});

		const response = await GET(createContext());

		expect(response.status).toBe(500);
		expectPrivateJson(response);
		expect(JSON.parse(await response.text()) as unknown).toEqual({
			error: 'Unable to load player statistics',
		});
	});
});
