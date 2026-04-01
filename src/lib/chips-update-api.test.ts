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

function createHandler(
	options: {
		lastUpdateByUser?: Map<string, number>;
		hasOwn?: (target: object, key: PropertyKey) => boolean;
	} = {},
) {
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
		hasOwn: options.hasOwn ?? Object.hasOwn,
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

function createMockChipSyncBinding({
	chipBalance,
	overallRank = null,
}: {
	chipBalance: number;
	overallRank?: number | null;
}) {
	const receipts = new Map<
		string,
		{
			userId: string;
			syncId: string;
			gameType: string;
			previousBalance: number;
			balance: number;
			delta: number;
			statsDelta: number | null;
			outcome: string | null;
			handCount: number | null;
			winsIncrement: number | null;
			lossesIncrement: number | null;
			biggestWinCandidate: number | null;
			overallRank: number | null;
			achievementPayload: string | null;
		}
	>();
	let currentChipBalance = chipBalance;
	let gameStatsBatchCount = 0;

	const binding = {
		prepare(sql: string) {
			return {
				sql,
				bind(...args: unknown[]) {
					return {
						sql,
						args,
						first: async <T>() => {
							if (sql.startsWith('SELECT userId, syncId, gameType, previousBalance')) {
								return (receipts.get(`${args[0]}:${args[1]}`) ?? null) as T;
							}

							throw new Error(`Unexpected first() query: ${sql}`);
						},
						run: async () => {
							if (sql.startsWith('UPDATE chip_sync_receipt SET achievementPayload = ?')) {
								const [achievementPayload, userId, syncId] = args as [string, string, string];
								const existingReceipt = receipts.get(`${userId}:${syncId}`);

								if (existingReceipt) {
									receipts.set(`${userId}:${syncId}`, {
										...existingReceipt,
										achievementPayload,
									});
									return { meta: { changes: 1 } };
								}

								return { meta: { changes: 0 } };
							}

							throw new Error(`Unexpected run() query: ${sql}`);
						},
					};
				},
			};
		},
		async batch(statements: Array<{ sql: string; args: unknown[] }>) {
			let previousChanges = 0;
			const results: Array<{ meta: { changes: number } }> = [];

			for (const statement of statements) {
				if (statement.sql.startsWith('UPDATE user SET chipBalance = ?')) {
					const [nextBalance, _userId, matchedBalanceValue] = statement.args as [
						number,
						string,
						number,
					];

					if (currentChipBalance === matchedBalanceValue) {
						currentChipBalance = nextBalance;
						previousChanges = 1;
						results.push({ meta: { changes: 1 } });
					} else {
						previousChanges = 0;
						results.push({ meta: { changes: 0 } });
					}
					continue;
				}

				if (statement.sql.startsWith('INSERT INTO chip_sync_receipt')) {
					if (previousChanges === 1) {
						const [
							userId,
							syncId,
							gameType,
							previousBalance,
							balance,
							delta,
							statsDelta,
							outcome,
							handCount,
							winsIncrement,
							lossesIncrement,
							biggestWinCandidate,
							_newBalanceForHigherBalanceCount,
							_newBalanceForTieBreak,
							_rankUserId,
							_createdAt,
							achievementPayload,
						] = statement.args as [
							string,
							string,
							string,
							number,
							number,
							number,
							number | null,
							string | null,
							number | null,
							number | null,
							number | null,
							number | null,
							number,
							number,
							string,
							number,
							string,
						];

						receipts.set(`${userId}:${syncId}`, {
							userId,
							syncId,
							gameType,
							previousBalance,
							balance,
							delta,
							statsDelta,
							outcome,
							handCount,
							winsIncrement,
							lossesIncrement,
							biggestWinCandidate,
							overallRank,
							achievementPayload,
						});
						previousChanges = 1;
						results.push({ meta: { changes: 1 } });
					} else {
						previousChanges = 0;
						results.push({ meta: { changes: 0 } });
					}
					continue;
				}

				if (statement.sql.startsWith('INSERT INTO game_stats')) {
					if (previousChanges === 1) {
						gameStatsBatchCount += 1;
						previousChanges = 1;
						results.push({ meta: { changes: 1 } });
					} else {
						previousChanges = 0;
						results.push({ meta: { changes: 0 } });
					}
					continue;
				}

				throw new Error(`Unexpected batch SQL: ${statement.sql}`);
			}

			return results;
		},
	};

	return {
		binding: binding as unknown as D1Database,
		getCurrentChipBalance: () => currentChipBalance,
		getGameStatsBatchCount: () => gameStatsBatchCount,
	};
}

function createLocals({
	user,
	withDb = true,
	dbBinding,
}: {
	user?: { id: string; chipBalance?: number } | null;
	withDb?: boolean;
	dbBinding?: unknown;
}) {
	return {
		user: user ?? null,
		runtime: withDb ? { env: { DB: dbBinding ?? { binding: true } } } : { env: {} },
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

		// JSON.stringify({ delta: Infinity }) serializes Infinity to null,
		// so we test with the string "NaN" which exercises type validation
		// (rejecting a string value for the numeric delta field).
		const requestNaN = new Request('http://test.local', {
			method: 'POST',
			body: '{"delta":"NaN","gameType":"blackjack"}',
			headers: { 'Content-Type': 'application/json' },
		});

		const responseNaN = await POST({
			request: requestNaN,
			locals: createLocals({ user: { id: 'user-nan' } }),
		} as any);
		const bodyNaN = await readJson(responseNaN);
		expect(responseNaN.status).toBe(400);
		expect(bodyNaN.error).toBe('INVALID_DELTA');

		// Also verify that Infinity serialized as null is rejected
		const requestNull = new Request('http://test.local', {
			method: 'POST',
			body: JSON.stringify({ delta: Infinity, gameType: 'blackjack' }),
			headers: { 'Content-Type': 'application/json' },
		});

		const responseNull = await POST({
			request: requestNull,
			locals: createLocals({ user: { id: 'user-infinity' } }),
		} as any);
		const bodyNull = await readJson(responseNull);
		expect(responseNull.status).toBe(400);
		expect(bodyNull.error).toBe('INVALID_DELTA');
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

	test('returns INVALID_GAME_TYPE when limits are unexpectedly missing', async () => {
		resetMocks();
		const POST = createHandler({
			hasOwn: (target: object, key: PropertyKey) => {
				if (target && typeof target === 'object' && key === 'slots') {
					return true;
				}
				return Object.hasOwn(target, key);
			},
		});
		const request = new Request('http://test.local', {
			method: 'POST',
			body: JSON.stringify({ delta: 10, gameType: 'slots' }),
		});

		const response = await POST({
			request,
			locals: createLocals({ user: { id: 'user-missing-limits' } }),
		} as any);
		const body = await readJson(response);
		expect(response.status).toBe(400);
		expect(body.error).toBe('INVALID_GAME_TYPE');
		expect(body.message).toContain('No limits configured');
	});

	test('rejects inherited object keys as invalid game type', async () => {
		resetMocks();
		const POST = createHandler();
		const request = new Request('http://test.local', {
			method: 'POST',
			body: JSON.stringify({ delta: 10, gameType: '__proto__' }),
		});

		const response = await POST({
			request,
			locals: createLocals({ user: { id: 'user-proto-key' } }),
		} as any);
		const body = await readJson(response);
		expect(response.status).toBe(400);
		expect(body.error).toBe('INVALID_GAME_TYPE');
	});

	test('accepts poker updates and records stats and achievements', async () => {
		resetMocks();
		const POST = createHandler();
		mockCreateDb.db = createMockDb({ chipBalance: 1000 });
		const request = new Request('http://test.local', {
			method: 'POST',
			body: JSON.stringify({
				delta: 25,
				gameType: 'poker',
				outcome: 'win',
				handCount: 1,
			}),
		});

		const response = await POST({
			request,
			locals: createLocals({ user: { id: 'user-poker', chipBalance: 1000 } }),
		} as any);
		const body = await readJson(response);
		expect(response.status).toBe(200);
		expect(body.success).toBe(true);
		expect(body.balance).toBe(1025);
		expect(mockRecordGameRound.calls.length).toBe(1);
		expect(mockCheckAndGrantAchievements.calls.length).toBe(1);
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

	test('rejects statsDelta for games that do not support it', async () => {
		resetMocks();
		const POST = createHandler();
		const request = new Request('http://test.local', {
			method: 'POST',
			body: JSON.stringify({
				delta: 10,
				gameType: 'blackjack',
				statsDelta: 10,
			}),
		});

		const response = await POST({
			request,
			locals: createLocals({ user: { id: 'user-stats-not-allowed' } }),
		} as any);
		const body = await readJson(response);
		expect(response.status).toBe(400);
		expect(body.error).toBe('STATS_DELTA_NOT_ALLOWED');
	});

	test('rejects invalid statsDelta values for supported games', async () => {
		resetMocks();
		const POST = createHandler();
		const request = new Request('http://test.local', {
			method: 'POST',
			body: JSON.stringify({
				delta: 10,
				gameType: 'craps',
				statsDelta: 1.5,
			}),
		});

		const response = await POST({
			request,
			locals: createLocals({ user: { id: 'user-stats-invalid' } }),
		} as any);
		const body = await readJson(response);
		expect(response.status).toBe(400);
		expect(body.error).toBe('INVALID_STATS_DELTA');
	});

	test('rejects statsDelta that exceeds max win/loss limits', async () => {
		resetMocks();
		const POST = createHandler();

		const winOverflowRequest = new Request('http://test.local', {
			method: 'POST',
			body: JSON.stringify({
				delta: 10,
				gameType: 'craps',
				statsDelta: 200001,
			}),
		});

		const winOverflowResponse = await POST({
			request: winOverflowRequest,
			locals: createLocals({ user: { id: 'user-stats-overflow-win' } }),
		} as any);
		const winOverflowBody = await readJson(winOverflowResponse);
		expect(winOverflowResponse.status).toBe(400);
		expect(winOverflowBody.error).toBe('STATS_DELTA_EXCEEDS_LIMIT');

		const lossOverflowRequest = new Request('http://test.local', {
			method: 'POST',
			body: JSON.stringify({
				delta: -10,
				gameType: 'craps',
				statsDelta: -200001,
			}),
		});

		const lossOverflowResponse = await POST({
			request: lossOverflowRequest,
			locals: createLocals({ user: { id: 'user-stats-overflow-loss' } }),
		} as any);
		const lossOverflowBody = await readJson(lossOverflowResponse);
		expect(lossOverflowResponse.status).toBe(400);
		expect(lossOverflowBody.error).toBe('STATS_DELTA_EXCEEDS_LIMIT');
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

	test('returns USER_NOT_FOUND and logs redacted user id when user row is missing', async () => {
		resetMocks();
		const POST = createHandler();
		mockCreateDb.db = {
			select: () => ({
				from: () => ({
					where: () => ({
						limit: () => Promise.resolve([]),
					}),
				}),
			}),
			update: () => ({
				set: () => ({
					where: () => Promise.resolve({ meta: { changes: 0 } }),
				}),
			}),
		} as unknown as Database;

		const errorSpy = console.error;
		const errors: string[] = [];
		console.error = (...args: unknown[]) => {
			errors.push(String(args[0] ?? ''));
		};

		const request = new Request('http://test.local', {
			method: 'POST',
			body: JSON.stringify({ delta: 10, gameType: 'blackjack' }),
		});

		try {
			const response = await POST({
				request,
				locals: createLocals({ user: { id: 'abcd1234' } }),
			} as any);
			const body = await readJson(response);
			expect(response.status).toBe(500);
			expect(body.error).toBe('USER_NOT_FOUND');
		} finally {
			console.error = errorSpy;
		}

		expect(errors.some((message) => message.includes('user abcd***'))).toBe(true);
		expect(errors.some((message) => message.includes('abcd1234'))).toBe(false);
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
		mockCreateDb.db = createMockDb({ updateChanges: 0, readChipBalance: 975 });
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
		expect(body.currentBalance).toBe(975);
	});

	test('returns balance mismatch when provided previousBalance differs from server balance', async () => {
		resetMocks();
		const POST = createHandler();
		mockCreateDb.db = createMockDb({ chipBalance: 1000 });
		const request = new Request('http://test.local', {
			method: 'POST',
			body: JSON.stringify({
				delta: 10,
				gameType: 'blackjack',
				previousBalance: 900,
			}),
		});

		const response = await POST({
			request,
			locals: createLocals({ user: { id: 'user-prev-mismatch', chipBalance: 1000 } }),
		} as any);
		const body = await readJson(response);
		expect(response.status).toBe(409);
		expect(body.error).toBe('BALANCE_MISMATCH');
		expect(body.currentBalance).toBe(1000);
	});

	test('replays a completed syncId request from its receipt without re-recording stats', async () => {
		resetMocks();
		const POST = createHandler();
		const chipSyncBinding = createMockChipSyncBinding({ chipBalance: 1000 });
		mockCreateDb.db = createMockDb({ chipBalance: 1000 });

		const requestBody = {
			delta: 50,
			gameType: 'poker',
			syncId: 'poker-sync-1',
			previousBalance: 1000,
			outcome: 'win',
			handCount: 1,
		};
		const request = new Request('http://test.local', {
			method: 'POST',
			body: JSON.stringify(requestBody),
		});

		const firstResponse = await POST({
			request,
			locals: createLocals({
				user: { id: 'user-sync-replay', chipBalance: 1000 },
				dbBinding: chipSyncBinding.binding,
			}),
		} as any);
		const firstBody = await readJson(firstResponse);

		expect(firstResponse.status).toBe(200);
		expect(firstBody.balance).toBe(1050);
		expect(firstBody.newAchievements).toEqual([
			{ id: mockAchievement.id, name: mockAchievement.name, icon: mockAchievement.icon },
		]);
		expect(mockRecordGameRound.calls.length).toBe(0);
		expect(mockCheckAndGrantAchievements.calls.length).toBe(1);
		expect(chipSyncBinding.getCurrentChipBalance()).toBe(1050);
		expect(chipSyncBinding.getGameStatsBatchCount()).toBe(1);

		mockCheckAndGrantAchievements.impl = async () => [];

		const replayResponse = await POST({
			request: new Request('http://test.local', {
				method: 'POST',
				body: JSON.stringify(requestBody),
			}),
			locals: createLocals({
				user: { id: 'user-sync-replay', chipBalance: 1000 },
				dbBinding: chipSyncBinding.binding,
			}),
		} as any);
		const replayBody = await readJson(replayResponse);

		expect(replayResponse.status).toBe(200);
		expect(replayBody.balance).toBe(1050);
		expect(replayBody.newAchievements).toEqual([
			{ id: mockAchievement.id, name: mockAchievement.name, icon: mockAchievement.icon },
		]);
		expect(mockRecordGameRound.calls.length).toBe(0);
		expect(mockCheckAndGrantAchievements.calls.length).toBe(1);
		expect(chipSyncBinding.getCurrentChipBalance()).toBe(1050);
		expect(chipSyncBinding.getGameStatsBatchCount()).toBe(1);
	});

	test('preserves the original overallRank snapshot when replaying a sync receipt', async () => {
		resetMocks();
		const POST = createHandler();
		const chipSyncBinding = createMockChipSyncBinding({ chipBalance: 1000, overallRank: 7 });
		mockCreateDb.db = createMockDb({ chipBalance: 1000 });
		mockCheckAndGrantAchievements.impl = async () => [];

		const requestBody = {
			delta: 50,
			gameType: 'poker',
			syncId: 'poker-rank-sync-1',
			previousBalance: 1000,
			outcome: 'win',
			handCount: 1,
		};

		const firstResponse = await POST({
			request: new Request('http://test.local', {
				method: 'POST',
				body: JSON.stringify(requestBody),
			}),
			locals: createLocals({
				user: { id: 'user-rank-replay', chipBalance: 1000 },
				dbBinding: chipSyncBinding.binding,
			}),
		} as any);
		expect(firstResponse.status).toBe(200);
		const firstAchievementOptions = mockCheckAndGrantAchievements.calls[0]?.[3] as {
			overallRank?: number | null;
		};
		expect(firstAchievementOptions?.overallRank).toBe(7);

		const replayResponse = await POST({
			request: new Request('http://test.local', {
				method: 'POST',
				body: JSON.stringify(requestBody),
			}),
			locals: createLocals({
				user: { id: 'user-rank-replay', chipBalance: 1000 },
				dbBinding: chipSyncBinding.binding,
			}),
		} as any);
		expect(replayResponse.status).toBe(200);
		expect(mockCheckAndGrantAchievements.calls.length).toBe(1);
		const replayAchievementOptions = mockCheckAndGrantAchievements.calls[0]?.[3] as {
			overallRank?: number | null;
		};
		expect(replayAchievementOptions?.overallRank).toBe(7);
	});

	test('does not pass recentWinAmount for poker push sync achievements, including receipt replay', async () => {
		resetMocks();
		const POST = createHandler();
		const chipSyncBinding = createMockChipSyncBinding({ chipBalance: 1000 });
		mockCreateDb.db = createMockDb({ chipBalance: 1000 });
		mockCheckAndGrantAchievements.impl = async () => [];

		const requestBody = {
			delta: 50,
			gameType: 'poker',
			syncId: 'poker-push-sync-1',
			previousBalance: 1000,
			outcome: 'push',
			handCount: 1,
		};

		const firstResponse = await POST({
			request: new Request('http://test.local', {
				method: 'POST',
				body: JSON.stringify(requestBody),
			}),
			locals: createLocals({
				user: { id: 'user-poker-push-sync', chipBalance: 1000 },
				dbBinding: chipSyncBinding.binding,
			}),
		} as any);
		const firstBody = await readJson(firstResponse);

		expect(firstResponse.status).toBe(200);
		expect(firstBody.balance).toBe(1050);
		const firstAchievementOptions = mockCheckAndGrantAchievements.calls[0]?.[3] as {
			recentWinAmount?: number;
			gameType?: string;
		};
		expect(firstAchievementOptions?.gameType).toBe('poker');
		expect(firstAchievementOptions?.recentWinAmount).toBeUndefined();

		const replayResponse = await POST({
			request: new Request('http://test.local', {
				method: 'POST',
				body: JSON.stringify(requestBody),
			}),
			locals: createLocals({
				user: { id: 'user-poker-push-sync', chipBalance: 1000 },
				dbBinding: chipSyncBinding.binding,
			}),
		} as any);
		const replayBody = await readJson(replayResponse);

		expect(replayResponse.status).toBe(200);
		expect(replayBody.balance).toBe(1050);
		expect(mockCheckAndGrantAchievements.calls.length).toBe(1);
		const replayAchievementOptions = mockCheckAndGrantAchievements.calls[0]?.[3] as {
			recentWinAmount?: number;
			gameType?: string;
		};
		expect(replayAchievementOptions?.gameType).toBe('poker');
		expect(replayAchievementOptions?.recentWinAmount).toBeUndefined();
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

	test('updates balance without recording stats when outcome is omitted', async () => {
		resetMocks();
		const POST = createHandler();
		mockCreateDb.db = createMockDb({ chipBalance: 1000 });
		const request = new Request('http://test.local', {
			method: 'POST',
			body: JSON.stringify({
				delta: -25,
				gameType: 'craps',
				previousBalance: 1000,
			}),
		});

		const response = await POST({
			request,
			locals: createLocals({ user: { id: 'user-balance-only', chipBalance: 1000 } }),
		} as any);
		const body = await readJson(response);
		expect(response.status).toBe(200);
		expect(body.success).toBe(true);
		expect(body.balance).toBe(975);
		expect(mockRecordGameRound.calls.length).toBe(0);
		expect(mockCheckAndGrantAchievements.calls.length).toBe(0);
	});

	test('uses split-round biggestWinCandidate for recentWinAmount when available', async () => {
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
		// For split rounds, recentWinAmount prefers the per-hand biggest win
		// so comeback checks still work even when round net delta is not representative.
		expect(achievementOptions?.recentWinAmount).toBe(150);
	});

	test('uses statsDelta for stats tracking in craps', async () => {
		resetMocks();
		const POST = createHandler();
		mockCreateDb.db = createMockDb({ chipBalance: 1000 });
		const request = new Request('http://test.local', {
			method: 'POST',
			body: JSON.stringify({
				delta: -5,
				statsDelta: 120,
				gameType: 'craps',
				outcome: 'win',
				handCount: 1,
			}),
		});

		const response = await POST({
			request,
			locals: createLocals({ user: { id: 'user-stats-delta', chipBalance: 1000 } }),
		} as any);
		const body = await readJson(response);
		expect(response.status).toBe(200);
		expect(body.balance).toBe(995);
		const record = mockRecordGameRound.calls[0]?.[2] as { chipDelta?: number };
		expect(record?.chipDelta).toBe(120);
		const achievementOptions = mockCheckAndGrantAchievements.calls[0]?.[3] as {
			recentWinAmount?: number;
		};
		expect(achievementOptions?.recentWinAmount).toBe(120);
	});

	test('clamps biggestWinCandidate to maxWin for batched craps stats', async () => {
		resetMocks();
		const POST = createHandler();
		mockCreateDb.db = createMockDb({ chipBalance: 1000 });
		const request = new Request('http://test.local', {
			method: 'POST',
			body: JSON.stringify({
				delta: 20,
				statsDelta: 500,
				gameType: 'craps',
				outcome: 'win',
				handCount: 10,
				winsIncrement: 3,
				lossesIncrement: 2,
				biggestWinCandidate: 300000,
			}),
		});

		const response = await POST({
			request,
			locals: createLocals({ user: { id: 'user-stats-clamp', chipBalance: 1000 } }),
		} as any);
		const body = await readJson(response);
		expect(response.status).toBe(200);
		expect(body.balance).toBe(1020);
		const record = mockRecordGameRound.calls[0]?.[2] as { biggestWinCandidate?: number };
		expect(record?.biggestWinCandidate).toBe(200000);
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

	test('rejects statsDelta that implies wager exceeding previous balance', async () => {
		resetMocks();
		const POST = createHandler();
		mockCreateDb.db = createMockDb({ chipBalance: 100 });
		const request = new Request('http://test.local', {
			method: 'POST',
			body: JSON.stringify({
				delta: 0,
				statsDelta: 200000,
				gameType: 'craps',
				outcome: 'win',
				handCount: 1,
			}),
		});

		const response = await POST({
			request,
			locals: createLocals({ user: { id: 'user-stats-wager', chipBalance: 100 } }),
		} as any);
		const body = await readJson(response);
		expect(response.status).toBe(400);
		expect(body.error).toBe('STATS_DELTA_WAGER_INCONSISTENCY');
		expect(mockRecordGameRound.calls).toHaveLength(0);
	});

	test('allows statsDelta within the bound of previous balance', async () => {
		resetMocks();
		const POST = createHandler();
		mockCreateDb.db = createMockDb({ chipBalance: 1000 });
		const request = new Request('http://test.local', {
			method: 'POST',
			body: JSON.stringify({
				delta: -500,
				statsDelta: 400,
				gameType: 'craps',
				outcome: 'win',
				handCount: 1,
			}),
		});

		const response = await POST({
			request,
			locals: createLocals({ user: { id: 'user-stats-ok', chipBalance: 1000 } }),
		} as any);
		expect(response.status).toBe(200);
		const record = mockRecordGameRound.calls[0]?.[2] as { chipDelta?: number };
		expect(record?.chipDelta).toBe(400);
	});

	test('rejects biggestWinCandidate exceeding net delta on pure-win craps batch', async () => {
		resetMocks();
		const POST = createHandler();
		mockCreateDb.db = createMockDb({ chipBalance: 1000 });
		const request = new Request('http://test.local', {
			method: 'POST',
			body: JSON.stringify({
				delta: -1,
				statsDelta: -1,
				gameType: 'craps',
				outcome: 'loss',
				handCount: 100,
				winsIncrement: 1,
				lossesIncrement: 0,
				biggestWinCandidate: 200000,
			}),
		});

		const response = await POST({
			request,
			locals: createLocals({ user: { id: 'user-bwc-attack', chipBalance: 1000 } }),
		} as any);
		const body = await readJson(response);
		expect(response.status).toBe(200);
		const record = mockRecordGameRound.calls[0]?.[2] as { biggestWinCandidate?: number | null };
		expect(record?.biggestWinCandidate).toBeNull();
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
		// Balance is truncated (1000) + delta (10) = 1010
		expect(body.balance).toBe(1010);
		// Repair is now folded into the single atomic update (no separate repair call)
		expect(mockDb.updateCalls).toBe(1);
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
