import { beforeAll, describe, expect, mock, test } from 'bun:test';
import { Database as SQLiteDatabase } from 'bun:sqlite';
import type { D1Database } from '@cloudflare/workers-types';
import type { MissionGameEvent } from '../missions/types';
import type { SettleRoundCommand } from './types';

let sqlite: SQLiteDatabase;
let db: D1Database;

// Captures every mission event passed to prepareMissionProgressStatements so
// tests can assert the outcome classification and event delta directly (the
// mission subsystem does not persist `outcome` or `delta` anywhere).
const capturedMissionEvents: MissionGameEvent[] = [];

let applyWalletSettlementBatch: typeof import('./repository').applyWalletSettlementBatch;
let findWalletSettlement: typeof import('./repository').findWalletSettlement;
let getRowsAffected: typeof import('./repository').getRowsAffected;
let readWalletBalance: typeof import('./repository').readWalletBalance;

beforeAll(async () => {
	// Load the real mission module (cache-busted to bypass the override) and
	// wrap prepareMissionProgressStatements with a delegating spy. The mock is
	// registered before ./repository is imported so its internal import of
	// ../missions/progress resolves to the spy.
	const realProgress = await import(`../missions/progress?spy=${Date.now()}`);
	mock.module('../missions/progress', () => ({
		...realProgress,
		prepareMissionProgressStatements: async (...args: unknown[]) => {
			const entries = args[1] as Array<{ event: MissionGameEvent }>;
			for (const entry of entries) capturedMissionEvents.push(entry.event);
			return realProgress.prepareMissionProgressStatements(
				...(args as Parameters<typeof realProgress.prepareMissionProgressStatements>),
			);
		},
	}));
	({ applyWalletSettlementBatch, findWalletSettlement, getRowsAffected, readWalletBalance } =
		await import('./repository'));
});

function createDatabase(): D1Database {
	sqlite = new SQLiteDatabase(':memory:');
	sqlite.run(`
		CREATE TABLE user (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			email TEXT NOT NULL UNIQUE,
			emailVerified INTEGER NOT NULL,
			chipBalance INTEGER NOT NULL DEFAULT 10000,
			createdAt INTEGER NOT NULL,
			updatedAt INTEGER NOT NULL
		);
		CREATE TABLE game_stats (
			userId TEXT NOT NULL,
			gameType TEXT NOT NULL,
			totalWins INTEGER NOT NULL DEFAULT 0,
			totalLosses INTEGER NOT NULL DEFAULT 0,
			handsPlayed INTEGER NOT NULL DEFAULT 0,
			biggestWin INTEGER NOT NULL DEFAULT 0,
			netProfit INTEGER NOT NULL DEFAULT 0,
			updatedAt INTEGER NOT NULL,
			PRIMARY KEY (userId, gameType)
		);
		CREATE TABLE mission_override (
			userId TEXT NOT NULL,
			periodKey TEXT NOT NULL,
			originalMissionDefId TEXT NOT NULL,
			replacementMissionDefId TEXT NOT NULL,
			PRIMARY KEY (userId, periodKey, originalMissionDefId)
		);
		CREATE TABLE mission_progress (
			userId TEXT NOT NULL,
			missionDefId TEXT NOT NULL,
			periodKey TEXT NOT NULL,
			progress INTEGER NOT NULL DEFAULT 0,
			metadataJson TEXT,
			completedAt INTEGER,
			claimedAt INTEGER,
			PRIMARY KEY (userId, missionDefId, periodKey)
		);
		CREATE TABLE mission_game_tried (
			userId TEXT NOT NULL,
			missionDefId TEXT NOT NULL,
			periodKey TEXT NOT NULL,
			gameType TEXT NOT NULL,
			firstTriedAt INTEGER NOT NULL,
			PRIMARY KEY (userId, missionDefId, periodKey, gameType)
		);
		CREATE TABLE wallet_settlement (
			userId TEXT NOT NULL,
			settlementId TEXT NOT NULL,
			attemptId TEXT NOT NULL,
			balance INTEGER NOT NULL,
			createdAt INTEGER NOT NULL,
			PRIMARY KEY (userId, settlementId)
		);
	`);

	return {
		prepare(sql: string) {
			return {
				bind(...args: unknown[]) {
					return {
						async first<T = Record<string, unknown>>(): Promise<T | null> {
							return (sqlite.query(sql).get(...args) as T | null) ?? null;
						},
						async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
							return { results: sqlite.query(sql).all(...args) as T[] };
						},
						async run(): Promise<{ meta: { changes: number }; rowsAffected: number }> {
							sqlite.run(sql, args);
							const changes = Number(
								sqlite.query('SELECT changes() AS changes').get()?.changes ?? 0,
							);
							return { meta: { changes }, rowsAffected: changes };
						},
					};
				},
			};
		},
		async batch<T = { meta: { changes: number }; rowsAffected: number }>(
			statements: Array<{ run(): Promise<T> }>,
		): Promise<T[]> {
			sqlite.run('BEGIN');
			try {
				const results: T[] = [];
				for (const statement of statements) results.push(await statement.run());
				sqlite.run('COMMIT');
				return results;
			} catch (error) {
				sqlite.run('ROLLBACK');
				throw error;
			}
		},
	} as unknown as D1Database;
}

async function insertUser(userId: string, chipBalance = 1000): Promise<void> {
	await db!
		.prepare(
			'INSERT INTO user (id, name, email, emailVerified, chipBalance, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)',
		)
		.bind(userId, userId, `${userId}@example.test`, 0, chipBalance, 1, 1)
		.run();
}

async function readGameStats(userId: string): Promise<{
	totalWins: number;
	totalLosses: number;
	handsPlayed: number;
	biggestWin: number;
	netProfit: number;
} | null> {
	return db!
		.prepare(
			'SELECT totalWins, totalLosses, handsPlayed, biggestWin, netProfit FROM game_stats WHERE userId = ? AND gameType = ?',
		)
		.bind(userId, 'blackjack')
		.first();
}

async function insertWalletSettlement(
	userId: string,
	settlementId: string,
	attemptId: string,
	balance: number,
): Promise<void> {
	await db!
		.prepare(
			'INSERT INTO wallet_settlement (userId, settlementId, attemptId, balance, createdAt) VALUES (?, ?, ?, ?, ?)',
		)
		.bind(userId, settlementId, attemptId, balance, 1)
		.run();
}

function command(overrides: Partial<SettleRoundCommand> = {}): SettleRoundCommand {
	return {
		settlementId: 'blackjack-win-1',
		game: 'blackjack',
		delta: 100,
		stats: { rounds: 1, wins: 1, losses: 0, biggestWin: 100 },
		...overrides,
	};
}

describe('wallet settlement repository', () => {
	db = createDatabase();

	test('normalizes D1 and Miniflare affected-row metadata', () => {
		expect(getRowsAffected({ meta: { changes: 1 }, rowsAffected: 0 })).toBe(1);
		expect(getRowsAffected({ rowsAffected: 1 })).toBe(1);
		expect(getRowsAffected(null)).toBe(0);
	});

	test('applies a fresh win and records its receipt and stats', async () => {
		const userId = 'fresh-win';
		await insertUser(userId);
		const fresh = await applyWalletSettlementBatch(db!, {
			userId,
			attemptId: 'attempt-win',
			expectedBalance: 1000,
			nextBalance: 1100,
			command: command(),
			nowSeconds: 10,
		});

		expect(fresh).toBe(true);
		expect(await readWalletBalance(db!, userId)).toBe(1100);
		expect(await findWalletSettlement(db!, userId, 'blackjack-win-1')).toEqual({
			balance: 1100,
			attemptId: 'attempt-win',
		});
		const stats = await db!
			.prepare(
				'SELECT totalWins, totalLosses, handsPlayed, biggestWin, netProfit FROM game_stats WHERE userId = ? AND gameType = ?',
			)
			.bind(userId, 'blackjack')
			.first<{
				totalWins: number;
				totalLosses: number;
				handsPlayed: number;
				biggestWin: number;
				netProfit: number;
			}>();
		expect(stats).toEqual({
			totalWins: 1,
			totalLosses: 0,
			handsPlayed: 1,
			biggestWin: 100,
			netProfit: 100,
		});
	});

	test('applies fresh loss and push deltas', async () => {
		const userId = 'loss-push';
		await insertUser(userId);
		expect(
			await applyWalletSettlementBatch(db!, {
				userId,
				attemptId: 'attempt-loss',
				expectedBalance: 1000,
				nextBalance: 900,
				command: command({
					settlementId: 'blackjack-loss-1',
					delta: -100,
					stats: { rounds: 1, wins: 0, losses: 1, biggestWin: 0 },
				}),
				nowSeconds: 11,
			}),
		).toBe(true);
		expect(
			await applyWalletSettlementBatch(db!, {
				userId,
				attemptId: 'attempt-push',
				expectedBalance: 900,
				nextBalance: 900,
				command: command({
					settlementId: 'blackjack-push-1',
					delta: 0,
					stats: { rounds: 1, wins: 0, losses: 0, biggestWin: 0 },
				}),
				nowSeconds: 12,
			}),
		).toBe(true);
		const stats = await db!
			.prepare(
				'SELECT totalWins, totalLosses, handsPlayed, biggestWin, netProfit FROM game_stats WHERE userId = ? AND gameType = ?',
			)
			.bind(userId, 'blackjack')
			.first<{
				totalWins: number;
				totalLosses: number;
				handsPlayed: number;
				biggestWin: number;
				netProfit: number;
			}>();
		expect(stats).toEqual({
			totalWins: 0,
			totalLosses: 1,
			handsPlayed: 2,
			biggestWin: 0,
			netProfit: -100,
		});
	});

	test('does not apply when the expected balance is stale', async () => {
		const userId = 'stale-balance';
		await insertUser(userId, 900);
		const applied = await applyWalletSettlementBatch(db!, {
			userId,
			attemptId: 'attempt-stale',
			expectedBalance: 1000,
			nextBalance: 1100,
			command: command({ settlementId: 'blackjack-stale-1' }),
			nowSeconds: 13,
		});
		expect(applied).toBe(false);
		expect(await findWalletSettlement(db!, userId, 'blackjack-stale-1')).toBeNull();
		expect(await readWalletBalance(db!, userId)).toBe(900);
	});

	test('finds an existing duplicate receipt without applying it again', async () => {
		const userId = 'duplicate';
		await insertUser(userId, 1200);
		await insertWalletSettlement(userId, 'blackjack-duplicate-1', 'winner-attempt', 1200);
		expect(await findWalletSettlement(db!, userId, 'blackjack-duplicate-1')).toEqual({
			balance: 1200,
			attemptId: 'winner-attempt',
		});
	});

	test('guards a zero-delta duplicate even though the balance is unchanged', async () => {
		const userId = 'duplicate-push';
		await insertUser(userId, 1200);
		await insertWalletSettlement(userId, 'blackjack-duplicate-push', 'winner-attempt', 1200);
		const applied = await applyWalletSettlementBatch(db!, {
			userId,
			attemptId: 'replay-attempt',
			expectedBalance: 1200,
			nextBalance: 1200,
			command: command({
				settlementId: 'blackjack-duplicate-push',
				delta: 0,
				stats: { rounds: 1, wins: 0, losses: 0, biggestWin: 0 },
			}),
			nowSeconds: 16,
		});
		expect(applied).toBe(false);
		expect(
			await db!.prepare('SELECT * FROM game_stats WHERE userId = ?').bind(userId).all(),
		).toEqual({ results: [] });
	});

	test('preserves an existing biggest win when a push has no candidate', async () => {
		const userId = 'biggest-win';
		await insertUser(userId, 1000);
		await db!
			.prepare(
				'INSERT INTO game_stats (userId, gameType, totalWins, totalLosses, handsPlayed, biggestWin, netProfit, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
			)
			.bind(userId, 'blackjack', 2, 1, 3, 250, 100, 1)
			.run();
		await applyWalletSettlementBatch(db!, {
			userId,
			attemptId: 'attempt-push-biggest',
			expectedBalance: 1000,
			nextBalance: 1000,
			command: command({
				settlementId: 'blackjack-push-biggest',
				delta: 0,
				stats: { rounds: 1, wins: 0, losses: 0, biggestWin: 0 },
			}),
			nowSeconds: 14,
		});
		const row = await db!
			.prepare('SELECT biggestWin FROM game_stats WHERE userId = ? AND gameType = ?')
			.bind(userId, 'blackjack')
			.first<{ biggestWin: number }>();
		expect(row?.biggestWin).toBe(250);
	});

	test('uses winsIncrement for missions even when net delta is negative', async () => {
		const userId = 'negative-win-mission';
		await insertUser(userId, 1000);
		await applyWalletSettlementBatch(db!, {
			userId,
			attemptId: 'attempt-negative-win',
			expectedBalance: 1000,
			nextBalance: 990,
			command: command({
				settlementId: 'blackjack-negative-win',
				delta: -10,
				stats: { rounds: 1, wins: 2, losses: 0, biggestWin: 0 },
			}),
			nowSeconds: 15,
		});
		const mission = await db!
			.prepare('SELECT progress FROM mission_progress WHERE userId = ? AND missionDefId = ?')
			.bind(userId, 'daily-win-3')
			.first<{ progress: number }>();
		expect(mission?.progress).toBe(2);
	});

	test('records command.delta as net profit when stats.netProfit is omitted', async () => {
		const userId = 'net-profit-omitted';
		await insertUser(userId);
		capturedMissionEvents.length = 0;
		await applyWalletSettlementBatch(db!, {
			userId,
			attemptId: 'attempt-omitted',
			expectedBalance: 1000,
			nextBalance: 1100,
			command: command({ settlementId: 'blackjack-omitted-net-profit' }),
			nowSeconds: 20,
		});
		expect(await readWalletBalance(db!, userId)).toBe(1100);
		const stats = await readGameStats(userId);
		expect(stats).toEqual({
			totalWins: 1,
			totalLosses: 0,
			handsPlayed: 1,
			biggestWin: 100,
			netProfit: 100,
		});
		expect(capturedMissionEvents.at(-1)).toMatchObject({ outcome: 'win', delta: 100 });
	});

	test('records stats.netProfit in game_stats while the balance moves by delta', async () => {
		const userId = 'net-profit-provided';
		await insertUser(userId);
		capturedMissionEvents.length = 0;
		await applyWalletSettlementBatch(db!, {
			userId,
			attemptId: 'attempt-provided',
			expectedBalance: 1000,
			nextBalance: 1300,
			command: command({
				settlementId: 'blackjack-provided-net-profit',
				delta: 300,
				stats: { rounds: 1, wins: 1, losses: 0, biggestWin: 300, netProfit: 100 },
			}),
			nowSeconds: 21,
		});
		expect(await readWalletBalance(db!, userId)).toBe(1300);
		const stats = await readGameStats(userId);
		expect(stats).toEqual({
			totalWins: 1,
			totalLosses: 0,
			handsPlayed: 1,
			biggestWin: 300,
			netProfit: 100,
		});
		expect(capturedMissionEvents.at(-1)).toMatchObject({ outcome: 'win', delta: 100 });
	});

	test('classifies a payout-only ranked loss as a loss mission event, not push', async () => {
		const userId = 'ranked-loss-classification';
		await insertUser(userId);
		capturedMissionEvents.length = 0;
		await applyWalletSettlementBatch(db!, {
			userId,
			attemptId: 'attempt-ranked-loss',
			expectedBalance: 1000,
			nextBalance: 1000,
			command: command({
				settlementId: 'blackjack-ranked-loss',
				delta: 0,
				stats: { rounds: 1, wins: 0, losses: 1, biggestWin: 0, netProfit: -100 },
			}),
			nowSeconds: 22,
		});
		expect(await readWalletBalance(db!, userId)).toBe(1000);
		const stats = await readGameStats(userId);
		expect(stats).toEqual({
			totalWins: 0,
			totalLosses: 1,
			handsPlayed: 1,
			biggestWin: 0,
			netProfit: -100,
		});
		expect(capturedMissionEvents.at(-1)).toMatchObject({ outcome: 'loss', delta: -100 });
	});

	test('classifies wins=1 as a win mission event even when payout differs from net profit', async () => {
		const userId = 'ranked-win-classification';
		await insertUser(userId);
		capturedMissionEvents.length = 0;
		await applyWalletSettlementBatch(db!, {
			userId,
			attemptId: 'attempt-ranked-win',
			expectedBalance: 1000,
			nextBalance: 1000,
			command: command({
				settlementId: 'blackjack-ranked-win',
				delta: 0,
				stats: { rounds: 1, wins: 1, losses: 0, biggestWin: 0, netProfit: -50 },
			}),
			nowSeconds: 23,
		});
		expect(await readWalletBalance(db!, userId)).toBe(1000);
		const stats = await readGameStats(userId);
		expect(stats).toEqual({
			totalWins: 1,
			totalLosses: 0,
			handsPlayed: 1,
			biggestWin: 0,
			netProfit: -50,
		});
		expect(capturedMissionEvents.at(-1)).toMatchObject({ outcome: 'win', delta: -50 });
	});
});
