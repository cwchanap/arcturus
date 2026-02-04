import { describe, expect, test } from 'bun:test';
import type { Database } from '../lib/db';
import type { AchievementDefinition } from '../lib/achievements/types';
import { createPostHandler } from '../pages/api/chips/update';

const mockCreateDb = Object.assign(
	(dbBinding: unknown) => {
		mockCreateDb.calls.push({ dbBinding });
		return mockCreateDb.db;
	},
	{
		calls: [] as Array<{ dbBinding: unknown }>,
		db: null as unknown as Database,
	},
);

const mockRecordGameRound = Object.assign(
	async (...args: unknown[]) => {
		mockRecordGameRound.calls.push(args);
		return mockRecordGameRound.impl(...args);
	},
	{
		calls: [] as Array<unknown[]>,
		impl: async (..._args: unknown[]) => {},
	},
);

const mockAchievement: AchievementDefinition = {
	id: 'rising_star',
	name: 'Rising Star',
	description: 'Test achievement',
	category: 'milestone',
	icon: '🌟',
};

const mockCheckAndGrantAchievements = Object.assign(
	async (...args: unknown[]) => {
		mockCheckAndGrantAchievements.calls.push(args);
		return mockCheckAndGrantAchievements.impl(...args);
	},
	{
		calls: [] as Array<unknown[]>,
		impl: async (..._args: unknown[]) => [mockAchievement],
	},
);

function createHandler(options: { lastUpdateByUser?: Map<string, number> } = {}) {
	return createPostHandler({
		createDb: (dbBinding: unknown) => mockCreateDb(dbBinding),
		recordGameRound: async (_db, _userId, _record) => {
			void _db;
			void _userId;
			void _record;
			return mockRecordGameRound(_db, _userId, _record);
		},
		checkAndGrantAchievements: async (_db, _userId, _currentChipBalance, _options) => {
			void _db;
			void _userId;
			void _currentChipBalance;
			void _options;
			return mockCheckAndGrantAchievements(_db, _userId, _currentChipBalance, _options);
		},
		lastUpdateByUser: options.lastUpdateByUser ?? new Map(),
	});
}

function resetMocks() {
	mockCreateDb.calls = [];
	mockRecordGameRound.calls = [];
	mockRecordGameRound.impl = async () => {};
	mockCheckAndGrantAchievements.calls = [];
	mockCheckAndGrantAchievements.impl = async () => [mockAchievement];
}

function createMockDb({
	chipBalance = 1000,
	updateChanges = 1,
	readChipBalance = chipBalance,
	selectThrows = false,
}: {
	chipBalance?: number;
	updateChanges?: number;
	readChipBalance?: number;
	selectThrows?: boolean;
} = {}): Database & { updateCalls: number } {
	let updateCalls = 0;
	const db = {
		select: () => {
			if (selectThrows) {
				throw new Error('select failed');
			}
			return {
				from: () => ({
					where: () => ({
						limit: () => Promise.resolve([{ chipBalance: readChipBalance }]),
					}),
				}),
			};
		},
		update: () => {
			updateCalls += 1;
			(db as { updateCalls: number }).updateCalls = updateCalls;
			return {
				set: () => ({
					where: () => Promise.resolve({ meta: { changes: updateChanges } }),
				}),
			};
		},
	} as unknown as Database & { updateCalls: number };
	db.updateCalls = updateCalls;
	return db;
}

function createLocals({
	user,
	withDb = true,
}: {
	user?: { id: string; chipBalance?: number } | null;
	withDb?: boolean;
}) {
	return {
		user: user ?? null,
		runtime: withDb ? { env: { DB: { binding: true } } } : { env: {} },
	};
}

async function readJson(response: Response) {
	return JSON.parse(await response.text());
}

describe('chips update API', () => {
	test('rejects unauthenticated requests', async () => {
		resetMocks();
		const POST = createHandler();
		const request = new Request('http://test.local', {
			method: 'POST',
			body: JSON.stringify({ delta: 10, gameType: 'blackjack' }),
		});

		const response = await POST({ request, locals: createLocals({ user: null }) } as any);
		const body = await readJson(response);
		expect(response.status).toBe(401);
		expect(body.error).toBe('UNAUTHORIZED');
	});

	test('rejects invalid JSON body', async () => {
		resetMocks();
		const POST = createHandler();
		const request = new Request('http://test.local', {
			method: 'POST',
			body: '{notjson',
			headers: { 'Content-Type': 'application/json' },
		});

		const response = await POST({
			request,
			locals: createLocals({ user: { id: 'user-json' } }),
		} as any);
		const body = await readJson(response);
		expect(response.status).toBe(400);
		expect(body.error).toBe('INVALID_REQUEST_BODY');
	});

	test('rejects invalid delta', async () => {
		resetMocks();
		const POST = createHandler();
		const request = new Request('http://test.local', {
			method: 'POST',
			body: JSON.stringify({ delta: 1.5, gameType: 'blackjack' }),
		});

		const response = await POST({
			request,
			locals: createLocals({ user: { id: 'user-delta' } }),
		} as any);
		const body = await readJson(response);
		expect(response.status).toBe(400);
		expect(body.error).toBe('INVALID_DELTA');
	});

	test('rejects non-finite delta values', async () => {
		resetMocks();
		const POST = createHandler();

		const request = new Request('http://test.local', {
			method: 'POST',
			body: JSON.stringify({ delta: Infinity, gameType: 'blackjack' }),
		});

		const response = await POST({
			request,
			locals: createLocals({ user: { id: 'user-infinity' } }),
		} as any);
		const body = await readJson(response);
		expect(response.status).toBe(400);
		expect(body.error).toBe('INVALID_DELTA');
	});

	test('rejects invalid game type', async () => {
		resetMocks();
		const POST = createHandler();
		const request = new Request('http://test.local', {
			method: 'POST',
			body: JSON.stringify({ delta: 10, gameType: 'slots' }),
		});

		const response = await POST({
			request,
			locals: createLocals({ user: { id: 'user-game' } }),
		} as any);
		const body = await readJson(response);
		expect(response.status).toBe(400);
		expect(body.error).toBe('INVALID_GAME_TYPE');
	});

	test('rejects non-string game type', async () => {
		resetMocks();
		const POST = createHandler();
		const request = new Request('http://test.local', {
			method: 'POST',
			body: JSON.stringify({ delta: 10, gameType: 123 }),
		});

		const response = await POST({
			request,
			locals: createLocals({ user: { id: 'user-game-type' } }),
		} as any);
		const body = await readJson(response);
		expect(response.status).toBe(400);
		expect(body.error).toBe('INVALID_REQUEST_BODY');
	});

	test('rejects invalid outcome values', async () => {
		resetMocks();
		const POST = createHandler();
		const request = new Request('http://test.local', {
			method: 'POST',
			body: JSON.stringify({ delta: 10, gameType: 'blackjack', outcome: 'draw' }),
		});

		const response = await POST({
			request,
			locals: createLocals({ user: { id: 'user-outcome' } }),
		} as any);
		const body = await readJson(response);
		expect(response.status).toBe(400);
		expect(body.error).toBe('INVALID_OUTCOME');
	});

	test('rejects invalid split-hand consistency', async () => {
		resetMocks();
		const POST = createHandler();
		const request = new Request('http://test.local', {
			method: 'POST',
			body: JSON.stringify({
				delta: 10,
				gameType: 'blackjack',
				winsIncrement: 1,
				lossesIncrement: 1,
				// handCount missing
			}),
		});

		const response = await POST({
			request,
			locals: createLocals({ user: { id: 'user-consistency' } }),
		} as any);
		const body = await readJson(response);
		expect(response.status).toBe(400);
		expect(body.error).toBe('INVALID_SPLIT_HAND_CONSISTENCY');
	});

	test('rejects invalid handCount values', async () => {
		resetMocks();
		const POST = createHandler();
		const request = new Request('http://test.local', {
			method: 'POST',
			body: JSON.stringify({
				delta: 10,
				gameType: 'blackjack',
				handCount: 0,
			}),
		});

		const response = await POST({
			request,
			locals: createLocals({ user: { id: 'user-handcount-invalid' } }),
		} as any);
		const body = await readJson(response);
		expect(response.status).toBe(400);
		expect(body.error).toBe('INVALID_HAND_COUNT');
	});

	test('rejects invalid winsIncrement values', async () => {
		resetMocks();
		const POST = createHandler();
		const request = new Request('http://test.local', {
			method: 'POST',
			body: JSON.stringify({
				delta: 10,
				gameType: 'blackjack',
				handCount: 2,
				winsIncrement: -1,
			}),
		});

		const response = await POST({
			request,
			locals: createLocals({ user: { id: 'user-wins-invalid' } }),
		} as any);
		const body = await readJson(response);
		expect(response.status).toBe(400);
		expect(body.error).toBe('INVALID_WINS_INCREMENT');
	});

	test('rejects invalid lossesIncrement values', async () => {
		resetMocks();
		const POST = createHandler();
		const request = new Request('http://test.local', {
			method: 'POST',
			body: JSON.stringify({
				delta: 10,
				gameType: 'blackjack',
				handCount: 2,
				lossesIncrement: -1,
			}),
		});

		const response = await POST({
			request,
			locals: createLocals({ user: { id: 'user-losses-invalid' } }),
		} as any);
		const body = await readJson(response);
		expect(response.status).toBe(400);
		expect(body.error).toBe('INVALID_LOSSES_INCREMENT');
	});

	test('rejects invalid biggestWinCandidate values', async () => {
		resetMocks();
		const POST = createHandler();
		const request = new Request('http://test.local', {
			method: 'POST',
			body: JSON.stringify({
				delta: 10,
				gameType: 'blackjack',
				handCount: 2,
				biggestWinCandidate: -5,
			}),
		});

		const response = await POST({
			request,
			locals: createLocals({ user: { id: 'user-biggest-invalid' } }),
		} as any);
		const body = await readJson(response);
		expect(response.status).toBe(400);
		expect(body.error).toBe('INVALID_BIGGEST_WIN_CANDIDATE');
	});

	test('rejects decided hands exceeding handCount', async () => {
		resetMocks();
		const POST = createHandler();
		const request = new Request('http://test.local', {
			method: 'POST',
			body: JSON.stringify({
				delta: 10,
				gameType: 'blackjack',
				winsIncrement: 2,
				lossesIncrement: 2,
				handCount: 3,
			}),
		});

		const response = await POST({
			request,
			locals: createLocals({ user: { id: 'user-handcount' } }),
		} as any);
		const body = await readJson(response);
		expect(response.status).toBe(400);
		expect(body.error).toBe('INVALID_SPLIT_HAND_CONSISTENCY');
	});

	test('rejects win exceeding game limit', async () => {
		resetMocks();
		const POST = createHandler();
		const request = new Request('http://test.local', {
			method: 'POST',
			body: JSON.stringify({ delta: 60001, gameType: 'blackjack' }),
		});

		const response = await POST({
			request,
			locals: createLocals({ user: { id: 'user-maxwin' } }),
		} as any);
		const body = await readJson(response);
		expect(response.status).toBe(400);
		expect(body.error).toBe('DELTA_EXCEEDS_LIMIT');
	});

	test('rate limits repeated updates', async () => {
		resetMocks();
		const rateLimitMap = new Map<string, number>();
		rateLimitMap.set('user-rate', Date.now());
		const POST = createHandler({ lastUpdateByUser: rateLimitMap });
		const request = new Request('http://test.local', {
			method: 'POST',
			body: JSON.stringify({ delta: 10, gameType: 'blackjack' }),
		});

		const response = await POST({
			request,
			locals: createLocals({ user: { id: 'user-rate', chipBalance: 1000 } }),
		} as any);
		const body = await readJson(response);
		expect(response.status).toBe(429);
		expect(body.error).toBe('RATE_LIMITED');
	});

	test('rejects loss exceeding game limit', async () => {
		resetMocks();
		const POST = createHandler();
		const request = new Request('http://test.local', {
			method: 'POST',
			body: JSON.stringify({ delta: -100001, gameType: 'baccarat' }),
		});

		const response = await POST({
			request,
			locals: createLocals({ user: { id: 'user-maxloss' } }),
		} as any);
		const body = await readJson(response);
		expect(response.status).toBe(400);
		expect(body.error).toBe('DELTA_EXCEEDS_LIMIT');
	});

	test('rejects non-integer previousBalance', async () => {
		resetMocks();
		const POST = createHandler();
		mockCreateDb.db = createMockDb({ chipBalance: 1000 });
		const request = new Request('http://test.local', {
			method: 'POST',
			body: JSON.stringify({
				delta: 10,
				gameType: 'blackjack',
				previousBalance: 1000.5,
			}),
		});

		const response = await POST({
			request,
			locals: createLocals({ user: { id: 'user-prev' } }),
		} as any);
		const body = await readJson(response);
		expect(response.status).toBe(400);
		expect(body.error).toBe('INVALID_REQUEST_BODY');
	});

	test('rejects when balance goes negative', async () => {
		resetMocks();
		const POST = createHandler();
		mockCreateDb.db = createMockDb({ chipBalance: 100 });
		const request = new Request('http://test.local', {
			method: 'POST',
			body: JSON.stringify({ delta: -150, gameType: 'blackjack' }),
		});

		const response = await POST({
			request,
			locals: createLocals({ user: { id: 'user-negative', chipBalance: 100 } }),
		} as any);
		const body = await readJson(response);
		expect(response.status).toBe(400);
		expect(body.error).toBe('INSUFFICIENT_BALANCE');
	});

	test('returns database error on DB failure', async () => {
		resetMocks();
		const POST = createHandler();
		mockCreateDb.db = createMockDb({ selectThrows: true });
		const request = new Request('http://test.local', {
			method: 'POST',
			body: JSON.stringify({ delta: 10, gameType: 'blackjack' }),
		});

		const response = await POST({
			request,
			locals: createLocals({ user: { id: 'user-db-error' } }),
		} as any);
		const body = await readJson(response);
		expect(response.status).toBe(500);
		expect(body.error).toBe('DATABASE_ERROR');
	});

	test('rejects missing DB binding', async () => {
		resetMocks();
		const POST = createHandler();
		const request = new Request('http://test.local', {
			method: 'POST',
			body: JSON.stringify({ delta: 10, gameType: 'blackjack' }),
		});

		const response = await POST({
			request,
			locals: createLocals({ user: { id: 'user-db' }, withDb: false }),
		} as any);
		const body = await readJson(response);
		expect(response.status).toBe(500);
		expect(body.error).toBe('DATABASE_UNAVAILABLE');
	});

	test('returns balance mismatch when optimistic lock fails', async () => {
		resetMocks();
		const POST = createHandler();
		mockCreateDb.db = createMockDb({ updateChanges: 0 });
		const request = new Request('http://test.local', {
			method: 'POST',
			body: JSON.stringify({ delta: 10, gameType: 'blackjack' }),
		});

		const response = await POST({
			request,
			locals: createLocals({ user: { id: 'user-lock', chipBalance: 1000 } }),
		} as any);
		const body = await readJson(response);
		expect(response.status).toBe(409);
		expect(body.error).toBe('BALANCE_MISMATCH');
	});

	test('updates balance and returns achievements for valid request', async () => {
		resetMocks();
		const POST = createHandler();
		mockCreateDb.db = createMockDb({ chipBalance: 1000 });
		const request = new Request('http://test.local', {
			method: 'POST',
			body: JSON.stringify({
				delta: 50,
				gameType: 'blackjack',
				outcome: 'win',
				handCount: 1,
			}),
		});

		const response = await POST({
			request,
			locals: createLocals({ user: { id: 'user-success', chipBalance: 1000 } }),
		} as any);
		const body = await readJson(response);
		expect(response.status).toBe(200);
		expect(body.success).toBe(true);
		expect(body.balance).toBe(1050);
		expect(body.newAchievements?.length).toBe(1);
		expect(mockRecordGameRound.calls.length).toBe(1);
		expect(mockCheckAndGrantAchievements.calls.length).toBe(1);
	});

	test('uses biggestWinCandidate for split-hand win stats', async () => {
		resetMocks();
		const POST = createHandler();
		mockCreateDb.db = createMockDb({ chipBalance: 1000 });
		const request = new Request('http://test.local', {
			method: 'POST',
			body: JSON.stringify({
				delta: 200,
				gameType: 'blackjack',
				outcome: 'win',
				handCount: 2,
				winsIncrement: 2,
				lossesIncrement: 0,
				biggestWinCandidate: 150,
			}),
		});

		const response = await POST({
			request,
			locals: createLocals({ user: { id: 'user-split', chipBalance: 1000 } }),
		} as any);
		const body = await readJson(response);
		expect(response.status).toBe(200);
		expect(body.balance).toBe(1200);
		const record = mockRecordGameRound.calls[0]?.[2] as { biggestWinCandidate?: number };
		expect(record?.biggestWinCandidate).toBe(150);
		const achievementOptions = mockCheckAndGrantAchievements.calls[0]?.[3] as {
			recentWinAmount?: number;
		};
		expect(achievementOptions?.recentWinAmount).toBe(150);
	});

	test('uses delta for single-hand wins even when increments are provided', async () => {
		resetMocks();
		const POST = createHandler();
		mockCreateDb.db = createMockDb({ chipBalance: 1000 });
		const request = new Request('http://test.local', {
			method: 'POST',
			body: JSON.stringify({
				delta: 120,
				gameType: 'blackjack',
				outcome: 'win',
				handCount: 1,
				winsIncrement: 1,
				lossesIncrement: 0,
			}),
		});

		const response = await POST({
			request,
			locals: createLocals({ user: { id: 'user-single', chipBalance: 1000 } }),
		} as any);
		const body = await readJson(response);
		expect(response.status).toBe(200);
		expect(body.balance).toBe(1120);
		const record = mockRecordGameRound.calls[0]?.[2] as { biggestWinCandidate?: number };
		expect(record?.biggestWinCandidate).toBe(120);
		const achievementOptions = mockCheckAndGrantAchievements.calls[0]?.[3] as {
			recentWinAmount?: number;
		};
		expect(achievementOptions?.recentWinAmount).toBe(120);
	});

	test('repairs fractional stored balances', async () => {
		resetMocks();
		const POST = createHandler();
		const mockDb = createMockDb({ chipBalance: 1000, readChipBalance: 1000.75 });
		mockCreateDb.db = mockDb;
		const request = new Request('http://test.local', {
			method: 'POST',
			body: JSON.stringify({ delta: 10, gameType: 'blackjack' }),
		});

		const response = await POST({
			request,
			locals: createLocals({ user: { id: 'user-fraction', chipBalance: 1000 } }),
		} as any);
		const body = await readJson(response);
		expect(response.status).toBe(200);
		expect(body.balance).toBe(1010);
		expect(mockDb.updateCalls).toBeGreaterThan(1);
	});

	test('returns warning when stats tracking fails', async () => {
		resetMocks();
		const POST = createHandler();
		mockCreateDb.db = createMockDb({ chipBalance: 1000 });
		mockRecordGameRound.impl = async () => {
			throw new Error('stats fail');
		};
		const request = new Request('http://test.local', {
			method: 'POST',
			body: JSON.stringify({ delta: 10, gameType: 'blackjack', outcome: 'win' }),
		});

		const response = await POST({
			request,
			locals: createLocals({ user: { id: 'user-warning', chipBalance: 1000 } }),
		} as any);
		const body = await readJson(response);
		expect(response.status).toBe(200);
		expect(body.warnings?.[0]).toContain('Stats tracking failed');
	});
});
