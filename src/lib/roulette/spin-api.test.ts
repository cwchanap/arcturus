import { describe, expect, test } from 'bun:test';
import type { Database } from '../db';
import type { AchievementDefinition } from '../achievements/types';
import { checkAndGrantAchievements } from '../achievements/achievements';
import { createPostHandler } from '../../pages/api/roulette/spin';
import { evaluateBets } from './betEvaluator';
import {
	isSpinCascadeGatedSql,
	SPIN_INSERT_RECEIPT_SQL,
	SPIN_INSERT_ROUND_SQL,
	SPIN_UPDATE_USER_SQL,
	SPIN_UPSERT_STATS_SQL,
} from './spin-batch-sql';
import type { RouletteBet } from './types';

const mockAchievement: AchievementDefinition = {
	id: 'rising_star',
	name: 'Rising Star',
	description: 'Test achievement',
	category: 'milestone',
	icon: '🌟',
};

const mockCheckAndGrantAchievements: typeof checkAndGrantAchievements = async () => [
	mockAchievement,
];

function createMockDb({
	chipBalance = 1000,
	heldChips = 0,
	selectThrows = false,
}: {
	chipBalance?: number;
	heldChips?: number;
	selectThrows?: boolean;
} = {}): Database {
	return {
		select: () => {
			if (selectThrows) {
				throw new Error('select failed');
			}
			return {
				from: () => ({
					where: () => ({
						limit: () => Promise.resolve([{ chipBalance, heldChips }]),
					}),
				}),
			};
		},
	} as unknown as Database;
}

interface MockRound {
	userId: string;
	syncId: string;
	winningNumber: number;
	betsJson: string;
	totalBet: number;
	totalPayout: number;
	netDelta: number;
	previousBalance: number;
	newBalance: number;
}

interface MockReceipt {
	userId: string;
	syncId: string;
	achievementPayload: string | null;
}

function createMockDbBinding({
	chipBalance = 1000,
	heldChips = 0,
	updateChanges = 1,
	existingRound = null as MockRound | null,
	existingReceipt = null as MockReceipt | null,
	batchError = null as Error | null,
}: {
	chipBalance?: number;
	heldChips?: number;
	updateChanges?: number;
	existingRound?: MockRound | null;
	existingReceipt?: MockReceipt | null;
	batchError?: Error | null;
} = {}) {
	let currentChipBalance = chipBalance;
	const currentHeldChips = heldChips;
	const rounds = new Map<string, MockRound>();
	const receipts = new Map<string, MockReceipt>();
	if (existingRound) {
		rounds.set(`${existingRound.userId}:${existingRound.syncId}`, existingRound);
	}
	if (existingReceipt) {
		receipts.set(`${existingReceipt.userId}:${existingReceipt.syncId}`, existingReceipt);
	}

	const db = createMockDb({ chipBalance: currentChipBalance, heldChips });

	const binding = {
		prepare(sql: string) {
			return {
				sql,
				bind(...args: unknown[]) {
					return {
						sql,
						args,
						first: async <T>(): Promise<T | null> => {
							if (
								sql.startsWith(
									'SELECT winningNumber, newBalance, previousBalance, netDelta, betsJson, totalBet FROM roulette_round',
								)
							) {
								const [userId, syncId] = args as [string, string];
								return (rounds.get(`${userId}:${syncId}`) ?? null) as T | null;
							}
							if (sql.startsWith('SELECT achievementPayload FROM chip_sync_receipt')) {
								const [userId, syncId] = args as [string, string];
								return (receipts.get(`${userId}:${syncId}`) ?? null) as T | null;
							}
							throw new Error(`Unexpected first() query: ${sql}`);
						},
						run: async () => {
							if (sql.startsWith('UPDATE chip_sync_receipt SET achievementPayload = ?')) {
								const [payload, userId, syncId] = args as [string, string, string];
								const existing = receipts.get(`${userId}:${syncId}`);
								if (existing) {
									receipts.set(`${userId}:${syncId}`, {
										...existing,
										achievementPayload: payload,
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
			if (batchError) throw batchError;
			let previousChanges = 0;
			const results: Array<{ meta: { changes: number } }> = [];

			for (const statement of statements) {
				// Match production SQL constants (exact) so the mock fails closed
				// if cascade gates are removed or statements drift.
				if (statement.sql === SPIN_UPDATE_USER_SQL) {
					const [nextBalance, _updatedAt, _userId, matchedBalanceValue] = statement.args as [
						number,
						number,
						string,
						number,
					];
					if (
						updateChanges > 0 &&
						currentChipBalance === matchedBalanceValue &&
						currentHeldChips === 0
					) {
						currentChipBalance = nextBalance;
						previousChanges = 1;
						results.push({ meta: { changes: 1 } });
					} else {
						previousChanges = 0;
						results.push({ meta: { changes: 0 } });
					}
					continue;
				}
				// Cascade inserts only apply when the production SQL still
				// gates on `WHERE changes() = 1`. Without the gate, a concurrent
				// balance change would still insert phantom rows — the mock
				// must not simulate cascade success for ungated SQL.
				if (statement.sql === SPIN_INSERT_ROUND_SQL) {
					if (previousChanges === 1 && isSpinCascadeGatedSql(statement.sql)) {
						const [
							syncId,
							userId,
							winningNumber,
							betsJson,
							totalBet,
							totalPayout,
							netDelta,
							previousBalance,
							newBalance,
						] = statement.args as [
							string,
							string,
							number,
							string,
							number,
							number,
							number,
							number,
							number,
						];
						rounds.set(`${userId}:${syncId}`, {
							userId,
							syncId,
							winningNumber,
							betsJson,
							totalBet,
							totalPayout,
							netDelta,
							previousBalance,
							newBalance,
						});
						results.push({ meta: { changes: 1 } });
					} else {
						results.push({ meta: { changes: 0 } });
					}
					continue;
				}
				if (statement.sql === SPIN_INSERT_RECEIPT_SQL) {
					if (previousChanges === 1 && isSpinCascadeGatedSql(statement.sql)) {
						const [userId, syncId] = statement.args as [string, string];
						receipts.set(`${userId}:${syncId}`, {
							userId,
							syncId,
							achievementPayload: null,
						});
						results.push({ meta: { changes: 1 } });
					} else {
						results.push({ meta: { changes: 0 } });
					}
					continue;
				}
				if (statement.sql === SPIN_UPSERT_STATS_SQL) {
					if (previousChanges === 1 && isSpinCascadeGatedSql(statement.sql)) {
						results.push({ meta: { changes: 1 } });
					} else {
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
		db,
		getCurrentChipBalance: () => currentChipBalance,
		getCurrentHeldChips: () => currentHeldChips,
		rounds,
		receipts,
	};
}

function createLocals({
	user,
	withDb = true,
	dbBinding,
}: {
	user?: { id: string } | null;
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

function makeBet(type: string, amount: number, target?: number): RouletteBet {
	return {
		id: `bet-${type}-${target ?? 'none'}-${amount}`,
		type: type as RouletteBet['type'],
		amount,
		...(target !== undefined ? { target } : {}),
	};
}

function createHandler(
	options: {
		lastUpdateByUser?: Map<string, number>;
		winningNumber?: number;
		chipBalance?: number;
		heldChips?: number;
		updateChanges?: number;
		existingRound?: MockRound | null;
		existingReceipt?: MockReceipt | null;
		checkAndGrantAchievements?: typeof checkAndGrantAchievements;
		evaluateBets?: typeof evaluateBets;
		batchError?: Error | null;
	} = {},
) {
	const {
		winningNumber = 17,
		chipBalance = 1000,
		heldChips = 0,
		updateChanges = 1,
		existingRound = null,
		existingReceipt = null,
		batchError = null,
	} = options;
	const mock = createMockDbBinding({
		chipBalance,
		heldChips,
		updateChanges,
		existingRound,
		existingReceipt,
		batchError,
	});
	const handler = createPostHandler({
		createDb: () => mock.db,
		checkAndGrantAchievements: options.checkAndGrantAchievements ?? mockCheckAndGrantAchievements,
		evaluateBets: options.evaluateBets ?? evaluateBets,
		generateWinningNumber: () => winningNumber,
		lastUpdateByUser: options.lastUpdateByUser ?? new Map(),
	});
	return { handler, mock };
}

describe('roulette spin API', () => {
	test('cascade SQL constants gate inserts on changes() = 1', () => {
		// Guard: if the production gates are dropped, mocks that only match
		// statement prefixes would still simulate cascade success.
		expect(isSpinCascadeGatedSql(SPIN_INSERT_ROUND_SQL)).toBe(true);
		expect(isSpinCascadeGatedSql(SPIN_INSERT_RECEIPT_SQL)).toBe(true);
		expect(isSpinCascadeGatedSql(SPIN_UPSERT_STATS_SQL)).toBe(true);
		expect(SPIN_UPDATE_USER_SQL).toContain('chipBalance = ?');
		expect(SPIN_UPDATE_USER_SQL).toContain('heldChips = 0');
	});

	test('rejects unauthenticated requests', async () => {
		const { handler } = createHandler();
		const request = new Request('http://test.local', {
			method: 'POST',
			body: JSON.stringify({ syncId: 'test-sync', bets: [makeBet('red', 10)] }),
		});
		const response = await handler({ request, locals: createLocals({ user: null }) } as any);
		const body = await readJson(response);
		expect(response.status).toBe(401);
		expect(body.error).toBe('UNAUTHORIZED');
	});

	test('rejects invalid JSON body', async () => {
		const { handler } = createHandler();
		const request = new Request('http://test.local', {
			method: 'POST',
			body: '{notjson',
			headers: { 'Content-Type': 'application/json' },
		});
		const response = await handler({
			request,
			locals: createLocals({ user: { id: 'user-json' } }),
		} as any);
		const body = await readJson(response);
		expect(response.status).toBe(400);
		expect(body.error).toBe('INVALID_JSON');
	});

	test('rejects invalid syncId', async () => {
		const { handler } = createHandler();
		const request = new Request('http://test.local', {
			method: 'POST',
			body: JSON.stringify({ syncId: '', bets: [makeBet('red', 10)] }),
		});
		const response = await handler({
			request,
			locals: createLocals({ user: { id: 'user-sync' } }),
		} as any);
		const body = await readJson(response);
		expect(response.status).toBe(400);
		expect(body.error).toBe('INVALID_SYNC_ID');
	});

	test('rejects empty bets array', async () => {
		const { handler } = createHandler();
		const request = new Request('http://test.local', {
			method: 'POST',
			body: JSON.stringify({ syncId: 'test-sync', bets: [] }),
		});
		const response = await handler({
			request,
			locals: createLocals({ user: { id: 'user-empty' } }),
		} as any);
		const body = await readJson(response);
		expect(response.status).toBe(400);
		expect(body.error).toBe('INVALID_BETS');
	});

	test('rejects invalid bet type', async () => {
		const { handler } = createHandler();
		const request = new Request('http://test.local', {
			method: 'POST',
			body: JSON.stringify({
				syncId: 'test-sync',
				bets: [{ id: 'bet-1', type: 'invalid', amount: 10 }],
			}),
		});
		const response = await handler({
			request,
			locals: createLocals({ user: { id: 'user-badtype' } }),
		} as any);
		const body = await readJson(response);
		expect(response.status).toBe(400);
		expect(body.error).toBe('INVALID_BETS');
	});

	test('rejects bet below MIN_BET', async () => {
		const { handler } = createHandler();
		const request = new Request('http://test.local', {
			method: 'POST',
			body: JSON.stringify({
				syncId: 'test-sync',
				bets: [{ id: 'bet-1', type: 'red', amount: 0 }],
			}),
		});
		const response = await handler({
			request,
			locals: createLocals({ user: { id: 'user-minbet' } }),
		} as any);
		const body = await readJson(response);
		expect(response.status).toBe(400);
		expect(body.error).toBe('INVALID_BETS');
	});

	test('rejects when total bet exceeds MAX_TOTAL_BET', async () => {
		const { handler } = createHandler();
		const request = new Request('http://test.local', {
			method: 'POST',
			body: JSON.stringify({
				syncId: 'test-sync',
				bets: [makeBet('red', 5001)],
			}),
		});
		const response = await handler({
			request,
			locals: createLocals({ user: { id: 'user-maxtotal' } }),
		} as any);
		const body = await readJson(response);
		expect(response.status).toBe(400);
		expect(body.error).toBe('INVALID_TOTAL_BET');
	});

	test('rejects when per-position total exceeds MAX_BET_PER_POSITION', async () => {
		const { handler } = createHandler();
		const bets = [makeBet('red', 300), makeBet('red', 300)];
		const request = new Request('http://test.local', {
			method: 'POST',
			body: JSON.stringify({ syncId: 'test-sync', bets }),
		});
		const response = await handler({
			request,
			locals: createLocals({ user: { id: 'user-maxpos' } }),
		} as any);
		const body = await readJson(response);
		expect(response.status).toBe(400);
		expect(body.error).toBe('POSITION_LIMIT_EXCEEDED');
	});

	test('rejects when bet count exceeds MAX_BETS', async () => {
		const { handler } = createHandler();
		const bets = Array.from({ length: 65 }, (_, i) => makeBet('red', 1, undefined));
		const request = new Request('http://test.local', {
			method: 'POST',
			body: JSON.stringify({ syncId: 'test-sync', bets }),
		});
		const response = await handler({
			request,
			locals: createLocals({ user: { id: 'user-toomany' } }),
		} as any);
		const body = await readJson(response);
		expect(response.status).toBe(400);
		expect(body.error).toBe('TOO_MANY_BETS');
	});

	test('rejects outside bet with a target (red + target)', async () => {
		const { handler } = createHandler();
		const bets = [{ id: 'bet-1', type: 'red', amount: 10, target: 5 }];
		const request = new Request('http://test.local', {
			method: 'POST',
			body: JSON.stringify({ syncId: 'test-sync', bets }),
		});
		const response = await handler({
			request,
			locals: createLocals({ user: { id: 'user-outside-target' } }),
		} as any);
		const body = await readJson(response);
		expect(response.status).toBe(400);
		expect(body.error).toBe('INVALID_BETS');
	});

	test('rejects when net delta exceeds ROULETTE_MAX_WIN backstop', async () => {
		// Simulate a logic bug / tampering where evaluateBets returns an
		// impossibly large payout. The DELTA_EXCEEDS_LIMIT backstop must
		// reject the spin before it reaches the batch.
		const mockEvaluateBets: typeof evaluateBets = (_bets, _winningNumber) => {
			const bet = _bets[0];
			return [{ bet, won: true, payout: 999_999 }];
		};
		const { handler, mock } = createHandler({
			chipBalance: 1_000_000,
			evaluateBets: mockEvaluateBets,
		});
		const bets = [makeBet('straight', 10, 17)];
		const request = new Request('http://test.local', {
			method: 'POST',
			body: JSON.stringify({ syncId: 'test-sync', bets }),
		});
		const response = await handler({
			request,
			locals: createLocals({ user: { id: 'user-delta-win' }, dbBinding: mock.binding }),
		} as any);
		const body = await readJson(response);
		expect(response.status).toBe(400);
		expect(body.error).toBe('DELTA_EXCEEDS_LIMIT');
	});

	test('returns 500 on corrupted betsJson during replay', async () => {
		const existingRound: MockRound = {
			userId: 'user-corrupt',
			syncId: 'corrupt-sync',
			winningNumber: 17,
			betsJson: '{not valid json',
			totalBet: 10,
			totalPayout: 360,
			netDelta: 350,
			previousBalance: 1000,
			newBalance: 1350,
		};
		const { handler, mock } = createHandler({ existingRound });
		const bets = [makeBet('straight', 10, 17)];
		const request = new Request('http://test.local', {
			method: 'POST',
			body: JSON.stringify({ syncId: 'corrupt-sync', bets }),
		});
		const response = await handler({
			request,
			locals: createLocals({ user: { id: 'user-corrupt' }, dbBinding: mock.binding }),
		} as any);
		const body = await readJson(response);
		expect(response.status).toBe(500);
		expect(body.error).toBe('CORRUPTED_ROUND_DATA');
	});

	test('rejects when database binding is missing', async () => {
		const { handler } = createHandler();
		const request = new Request('http://test.local', {
			method: 'POST',
			body: JSON.stringify({ syncId: 'test-sync', bets: [makeBet('red', 10)] }),
		});
		const response = await handler({
			request,
			locals: createLocals({ user: { id: 'user-nodb' }, withDb: false }),
		} as any);
		const body = await readJson(response);
		expect(response.status).toBe(500);
		expect(body.error).toBe('DATABASE_UNAVAILABLE');
	});

	test('rejects when MP escrow is active (heldChips > 0)', async () => {
		const { handler, mock } = createHandler({ heldChips: 500 });
		const request = new Request('http://test.local', {
			method: 'POST',
			body: JSON.stringify({ syncId: 'test-sync', bets: [makeBet('red', 10)] }),
		});
		const response = await handler({
			request,
			locals: createLocals({ user: { id: 'user-escrow' }, dbBinding: mock.binding }),
		} as any);
		const body = await readJson(response);
		expect(response.status).toBe(409);
		expect(body.error).toBe('MP_ESCROW_ACTIVE');
	});

	test('rejects when total bet exceeds balance', async () => {
		const { handler, mock } = createHandler({ chipBalance: 5 });
		const request = new Request('http://test.local', {
			method: 'POST',
			body: JSON.stringify({ syncId: 'test-sync', bets: [makeBet('red', 10)] }),
		});
		const response = await handler({
			request,
			locals: createLocals({ user: { id: 'user-poor' }, dbBinding: mock.binding }),
		} as any);
		const body = await readJson(response);
		expect(response.status).toBe(400);
		expect(body.error).toBe('INSUFFICIENT_BALANCE');
		expect(body.currentBalance).toBe(5);
	});

	test('rejects when rate limited', async () => {
		const rateMap = new Map<string, number>();
		rateMap.set('user-rate', Date.now());
		const { handler, mock } = createHandler({ lastUpdateByUser: rateMap });
		const request = new Request('http://test.local', {
			method: 'POST',
			body: JSON.stringify({ syncId: 'test-sync', bets: [makeBet('red', 10)] }),
		});
		const response = await handler({
			request,
			locals: createLocals({ user: { id: 'user-rate' }, dbBinding: mock.binding }),
		} as any);
		const body = await readJson(response);
		expect(response.status).toBe(429);
		expect(body.error).toBe('RATE_LIMITED');
	});

	test('returns 409 on concurrent modification (batch update changes = 0)', async () => {
		const { handler, mock } = createHandler({ updateChanges: 0 });
		const request = new Request('http://test.local', {
			method: 'POST',
			body: JSON.stringify({ syncId: 'test-sync', bets: [makeBet('red', 10)] }),
		});
		const response = await handler({
			request,
			locals: createLocals({ user: { id: 'user-concurrent' }, dbBinding: mock.binding }),
		} as any);
		const body = await readJson(response);
		expect(response.status).toBe(409);
		expect(body.error).toBe('CONCURRENT_MODIFICATION');
	});

	test('returns 409 when batch throws a PRIMARY KEY constraint violation', async () => {
		const { handler, mock } = createHandler({
			batchError: new Error('UNIQUE constraint failed: roulette_round.primaryKey'),
		});
		const request = new Request('http://test.local', {
			method: 'POST',
			body: JSON.stringify({ syncId: 'test-sync', bets: [makeBet('red', 10)] }),
		});
		const response = await handler({
			request,
			locals: createLocals({ user: { id: 'user-pk' }, dbBinding: mock.binding }),
		} as any);
		const body = await readJson(response);
		expect(response.status).toBe(409);
		expect(body.error).toBe('CONCURRENT_MODIFICATION');
	});

	test('returns 500 when batch throws an unexpected (non-constraint) error', async () => {
		const { handler, mock } = createHandler({
			batchError: new Error('D1 service unavailable'),
		});
		const request = new Request('http://test.local', {
			method: 'POST',
			body: JSON.stringify({ syncId: 'test-sync', bets: [makeBet('red', 10)] }),
		});
		const response = await handler({
			request,
			locals: createLocals({ user: { id: 'user-batchfail' }, dbBinding: mock.binding }),
		} as any);
		const body = await readJson(response);
		expect(response.status).toBe(500);
		expect(body.error).toBe('BATCH_FAILED');
	});

	test('repairs fractional stored balance instead of failing with CONCURRENT_MODIFICATION', async () => {
		// A fractional chipBalance (e.g. 1000.5) must use the raw value as the
		// optimistic-lock match value. Binding the truncated 1000 would never
		// match the stored 1000.5, causing every spin to return 409.
		const { handler, mock } = createHandler({
			chipBalance: 1000.5,
			winningNumber: 0,
		});
		const bets = [makeBet('red', 50)];
		const request = new Request('http://test.local', {
			method: 'POST',
			body: JSON.stringify({ syncId: 'test-sync', bets }),
		});
		const response = await handler({
			request,
			locals: createLocals({ user: { id: 'user-fractional' }, dbBinding: mock.binding }),
		} as any);
		const body = await readJson(response);
		expect(response.status).toBe(200);
		expect(body.previousBalance).toBe(1000);
		expect(body.newBalance).toBe(950);
		expect(mock.getCurrentChipBalance()).toBe(950);
	});

	test('processes a successful spin with a loss', async () => {
		const { handler, mock } = createHandler({ winningNumber: 0 });
		const bets = [makeBet('red', 50)];
		const request = new Request('http://test.local', {
			method: 'POST',
			body: JSON.stringify({ syncId: 'test-sync', bets }),
		});
		const response = await handler({
			request,
			locals: createLocals({ user: { id: 'user-loss' }, dbBinding: mock.binding }),
		} as any);
		const body = await readJson(response);
		expect(response.status).toBe(200);
		expect(body.winningNumber).toBe(0);
		expect(body.newBalance).toBe(950);
		expect(body.previousBalance).toBe(1000);
		expect(body.netDelta).toBe(-50);
		expect(body.syncId).toBe('test-sync');
		expect(mock.getCurrentChipBalance()).toBe(950);
	});

	test('processes a successful spin with a win', async () => {
		const { handler, mock } = createHandler({ winningNumber: 17 });
		const bets = [makeBet('straight', 10, 17)];
		const request = new Request('http://test.local', {
			method: 'POST',
			body: JSON.stringify({ syncId: 'test-sync', bets }),
		});
		const response = await handler({
			request,
			locals: createLocals({ user: { id: 'user-win' }, dbBinding: mock.binding }),
		} as any);
		const body = await readJson(response);
		expect(response.status).toBe(200);
		expect(body.winningNumber).toBe(17);
		expect(body.netDelta).toBe(350);
		expect(body.newBalance).toBe(1350);
		expect(mock.getCurrentChipBalance()).toBe(1350);
	});

	test('idempotent replay returns same result', async () => {
		const { handler, mock } = createHandler({ winningNumber: 17 });
		const bets = [makeBet('straight', 10, 17)];
		const request1 = new Request('http://test.local', {
			method: 'POST',
			body: JSON.stringify({ syncId: 'replay-sync', bets }),
		});
		const locals = createLocals({ user: { id: 'user-replay' }, dbBinding: mock.binding });
		const response1 = await handler({ request: request1, locals } as any);
		const body1 = await readJson(response1);
		expect(response1.status).toBe(200);

		const request2 = new Request('http://test.local', {
			method: 'POST',
			body: JSON.stringify({ syncId: 'replay-sync', bets }),
		});
		const response2 = await handler({ request: request2, locals } as any);
		const body2 = await readJson(response2);
		expect(response2.status).toBe(200);
		expect(body2.winningNumber).toBe(body1.winningNumber);
		expect(body2.newBalance).toBe(body1.newBalance);
		expect(body2.netDelta).toBe(body1.netDelta);
		expect(body2.syncId).toBe('replay-sync');
	});

	test('replay with mismatched bets returns 409', async () => {
		const { handler, mock } = createHandler({ winningNumber: 17 });
		const originalBets = [makeBet('straight', 10, 17)];
		const request1 = new Request('http://test.local', {
			method: 'POST',
			body: JSON.stringify({ syncId: 'mismatch-sync', bets: originalBets }),
		});
		const locals = createLocals({ user: { id: 'user-mismatch' }, dbBinding: mock.binding });
		await handler({ request: request1, locals } as any);

		const differentBets = [makeBet('red', 10)];
		const request2 = new Request('http://test.local', {
			method: 'POST',
			body: JSON.stringify({ syncId: 'mismatch-sync', bets: differentBets }),
		});
		const response2 = await handler({ request: request2, locals } as any);
		const body2 = await readJson(response2);
		expect(response2.status).toBe(409);
		expect(body2.error).toBe('SYNC_ID_REUSE_MISMATCH');
	});

	test('persists achievement payload to receipt on fresh spin', async () => {
		const { handler, mock } = createHandler({ winningNumber: 17 });
		const bets = [makeBet('straight', 10, 17)];
		const request = new Request('http://test.local', {
			method: 'POST',
			body: JSON.stringify({ syncId: 'achv-sync', bets }),
		});
		const response = await handler({
			request,
			locals: createLocals({ user: { id: 'user-achv' }, dbBinding: mock.binding }),
		} as any);
		const body = await readJson(response);
		expect(response.status).toBe(200);
		expect(body.newAchievements).toBeDefined();
		expect(body.newAchievements).toHaveLength(1);
		expect(body.newAchievements[0].id).toBe('rising_star');

		const receipt = mock.receipts.get('user-achv:achv-sync');
		expect(receipt).toBeDefined();
		expect(receipt!.achievementPayload).not.toBeNull();
		const payload = JSON.parse(receipt!.achievementPayload!);
		expect(payload.newAchievements).toHaveLength(1);
		expect(payload.newAchievements[0].id).toBe('rising_star');
	});

	test('replays achievements from persisted receipt payload', async () => {
		const existingReceipt: MockReceipt = {
			userId: 'user-replay-achv',
			syncId: 'replay-achv-sync',
			achievementPayload: JSON.stringify({
				newAchievements: [{ id: 'rising_star', name: 'Rising Star', icon: '🌟' }],
				warnings: [],
			}),
		};
		const existingRound: MockRound = {
			userId: 'user-replay-achv',
			syncId: 'replay-achv-sync',
			winningNumber: 17,
			betsJson: JSON.stringify([makeBet('straight', 10, 17)]),
			totalBet: 10,
			totalPayout: 360,
			netDelta: 350,
			previousBalance: 1000,
			newBalance: 1350,
		};
		const { handler, mock } = createHandler({
			existingRound,
			existingReceipt,
		});
		const bets = [makeBet('straight', 10, 17)];
		const request = new Request('http://test.local', {
			method: 'POST',
			body: JSON.stringify({ syncId: 'replay-achv-sync', bets }),
		});
		const response = await handler({
			request,
			locals: createLocals({
				user: { id: 'user-replay-achv' },
				dbBinding: mock.binding,
			}),
		} as any);
		const body = await readJson(response);
		expect(response.status).toBe(200);
		expect(body.newAchievements).toBeDefined();
		expect(body.newAchievements).toHaveLength(1);
		expect(body.newAchievements[0].id).toBe('rising_star');
	});

	test('replay with null achievement payload re-grants achievements and persists result', async () => {
		const existingReceipt: MockReceipt = {
			userId: 'user-replay-null',
			syncId: 'replay-null-sync',
			achievementPayload: null,
		};
		const existingRound: MockRound = {
			userId: 'user-replay-null',
			syncId: 'replay-null-sync',
			winningNumber: 0,
			betsJson: JSON.stringify([makeBet('red', 50)]),
			totalBet: 50,
			totalPayout: 0,
			netDelta: -50,
			previousBalance: 1000,
			newBalance: 950,
		};
		const { handler, mock } = createHandler({
			existingRound,
			existingReceipt,
		});
		const bets = [makeBet('red', 50)];
		const request = new Request('http://test.local', {
			method: 'POST',
			body: JSON.stringify({ syncId: 'replay-null-sync', bets }),
		});
		const response = await handler({
			request,
			locals: createLocals({
				user: { id: 'user-replay-null' },
				dbBinding: mock.binding,
			}),
		} as any);
		const body = await readJson(response);
		expect(response.status).toBe(200);
		// Achievement payload was null → re-ran checkAndGrantAchievements
		// (idempotent) and returned the re-granted achievements.
		expect(body.newAchievements).toBeDefined();
		expect(body.newAchievements).toHaveLength(1);
		expect(body.newAchievements[0].id).toBe('rising_star');
		// Persisted to the receipt
		const receipt = mock.receipts.get('user-replay-null:replay-null-sync');
		expect(receipt).toBeDefined();
		expect(receipt!.achievementPayload).not.toBeNull();
		const payload = JSON.parse(receipt!.achievementPayload!);
		expect(payload.newAchievements).toHaveLength(1);
		expect(payload.newAchievements[0].id).toBe('rising_star');
	});

	test('replay with null achievement payload and no achievements earned returns undefined', async () => {
		const noAchievements: typeof checkAndGrantAchievements = async () => [];
		const existingReceipt: MockReceipt = {
			userId: 'user-replay-null-empty',
			syncId: 'replay-null-empty-sync',
			achievementPayload: null,
		};
		const existingRound: MockRound = {
			userId: 'user-replay-null-empty',
			syncId: 'replay-null-empty-sync',
			winningNumber: 0,
			betsJson: JSON.stringify([makeBet('red', 50)]),
			totalBet: 50,
			totalPayout: 0,
			netDelta: -50,
			previousBalance: 1000,
			newBalance: 950,
		};
		const { handler, mock } = createHandler({
			existingRound,
			existingReceipt,
			checkAndGrantAchievements: noAchievements,
		});
		const bets = [makeBet('red', 50)];
		const request = new Request('http://test.local', {
			method: 'POST',
			body: JSON.stringify({ syncId: 'replay-null-empty-sync', bets }),
		});
		const response = await handler({
			request,
			locals: createLocals({
				user: { id: 'user-replay-null-empty' },
				dbBinding: mock.binding,
			}),
		} as any);
		const body = await readJson(response);
		expect(response.status).toBe(200);
		expect(body.newAchievements).toBeUndefined();
	});

	test('does not persist achievement payload when no achievements earned', async () => {
		const noAchievements: typeof checkAndGrantAchievements = async () => [];
		const { handler, mock } = createHandler({
			winningNumber: 17,
			checkAndGrantAchievements: noAchievements,
		});
		const bets = [makeBet('straight', 10, 17)];
		const request = new Request('http://test.local', {
			method: 'POST',
			body: JSON.stringify({ syncId: 'no-achv-sync', bets }),
		});
		const response = await handler({
			request,
			locals: createLocals({ user: { id: 'user-no-achv' }, dbBinding: mock.binding }),
		} as any);
		const body = await readJson(response);
		expect(response.status).toBe(200);
		expect(body.newAchievements).toBeUndefined();
		const receipt = mock.receipts.get('user-no-achv:no-achv-sync');
		expect(receipt).toBeDefined();
		expect(receipt!.achievementPayload).toBeNull();
	});

	test('rate limit map evicts stale entries when exceeding MAX_RATE_LIMIT_MAP_SIZE', async () => {
		const rateMap = new Map<string, number>();
		const now = Date.now();
		// 5000 stale entries (older than the 2s rate-limit window)
		for (let i = 0; i < 5000; i++) {
			rateMap.set(`stale-${i}`, now - 5000);
		}
		// 5000 fresh entries (within the rate-limit window)
		for (let i = 0; i < 5000; i++) {
			rateMap.set(`fresh-${i}`, now);
		}
		expect(rateMap.size).toBe(10000);
		const { handler, mock } = createHandler({
			lastUpdateByUser: rateMap,
			winningNumber: 0,
		});
		const bets = [makeBet('red', 10)];
		const request = new Request('http://test.local', {
			method: 'POST',
			body: JSON.stringify({ syncId: 'evict-sync', bets }),
		});
		await handler({
			request,
			locals: createLocals({ user: { id: 'user-evict' }, dbBinding: mock.binding }),
		} as any);
		// After the spin: set adds 1 (10001), triggering eviction.
		// Stale entries are removed; fresh entries + the new user remain.
		expect(rateMap.size).toBe(5001);
		expect(rateMap.has('stale-0')).toBe(false);
		expect(rateMap.has('fresh-0')).toBe(true);
		expect(rateMap.has('user-evict')).toBe(true);
	});

	test('rate limit map enforces hard cap when all entries are fresh', async () => {
		const rateMap = new Map<string, number>();
		const now = Date.now();
		// 10000 fresh entries — all within the 2s rate-limit window (timestamps
		// span 0..999ms) so stale eviction removes none. The hard-cap eviction
		// must then remove the oldest entries to stay at the cap.
		for (let i = 0; i < 10000; i++) {
			rateMap.set(`user-${i}`, now - (i % 1000));
		}
		expect(rateMap.size).toBe(10000);
		const { handler, mock } = createHandler({
			lastUpdateByUser: rateMap,
			winningNumber: 0,
		});
		const bets = [makeBet('red', 10)];
		const request = new Request('http://test.local', {
			method: 'POST',
			body: JSON.stringify({ syncId: 'hardcap-sync', bets }),
		});
		await handler({
			request,
			locals: createLocals({ user: { id: 'user-hardcap' }, dbBinding: mock.binding }),
		} as any);
		// After set: 10001 entries. Stale eviction removes none (all fresh).
		// Hard-cap eviction removes 1 oldest entry to get back to 10000.
		expect(rateMap.size).toBe(10000);
		// The new user must survive.
		expect(rateMap.has('user-hardcap')).toBe(true);
		// Exactly one of the original entries was evicted.
		const originalSurvivors = Array.from({ length: 10000 }, (_, i) => `user-${i}`).filter((u) =>
			rateMap.has(u),
		);
		expect(originalSurvivors.length).toBe(9999);
	});
});
