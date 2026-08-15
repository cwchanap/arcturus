import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Miniflare } from 'miniflare';
import type { D1Database } from '@cloudflare/workers-types';
import {
	MAX_ABSOLUTE_SETTLEMENT_DELTA,
	MAX_ABSOLUTE_SETTLEMENT_STAT,
	WalletSettlementDomainError,
	settleWalletRound,
	validate,
} from './settle';
import type { SettleRoundCommand } from './types';

function command(overrides: Partial<SettleRoundCommand> = {}): SettleRoundCommand {
	return {
		settlementId: 'blackjack-round-1',
		game: 'blackjack',
		delta: 100,
		stats: { rounds: 1, wins: 1, losses: 0, biggestWin: 100 },
		...overrides,
	};
}

function expectInvalid(input: unknown): void {
	expect(() => validate(input)).toThrow(WalletSettlementDomainError);
}

describe('wallet settlement validation', () => {
	test('rejects unsafe command numbers', () => {
		expectInvalid(command({ delta: Number.MAX_SAFE_INTEGER + 1 }));
		expectInvalid(
			command({
				stats: { rounds: 1, wins: Number.MAX_SAFE_INTEGER + 1, losses: 0, biggestWin: 0 },
			}),
		);
	});

	test('rejects malformed settlement IDs and unknown games', () => {
		expectInvalid(command({ settlementId: 'bad id' }));
		expectInvalid(command({ settlementId: 'x'.repeat(129) }));
		expectInvalid({ ...command(), game: 'unknown-game' as never });
	});

	test('rejects invalid round statistics', () => {
		expectInvalid(command({ stats: { rounds: 0, wins: 0, losses: 0, biggestWin: 0 } }));
		expectInvalid(command({ stats: { rounds: 1, wins: -1, losses: 0, biggestWin: 0 } }));
		expectInvalid(command({ stats: { rounds: 1, wins: 0, losses: -1, biggestWin: 0 } }));
		expectInvalid(command({ stats: { rounds: 1, wins: 0, losses: 0, biggestWin: -1 } }));
		expectInvalid(command({ stats: { rounds: 1, wins: 1, losses: 1, biggestWin: 0 } }));
	});

	test('accepts the global settlement delta boundary and rejects values beyond it', () => {
		expect(() => validate(command({ delta: MAX_ABSOLUTE_SETTLEMENT_DELTA }))).not.toThrow();
		expect(() => validate(command({ delta: -MAX_ABSOLUTE_SETTLEMENT_DELTA }))).not.toThrow();
		expectInvalid(command({ delta: MAX_ABSOLUTE_SETTLEMENT_DELTA + 1 }));
		expectInvalid(command({ delta: -MAX_ABSOLUTE_SETTLEMENT_DELTA - 1 }));
	});

	test('rejects unsafe or out-of-bound netProfit statistics', () => {
		// JSON-relevant non-numeric values (null, numeric string) must be
		// rejected by requireSafeInteger, not coerced.
		expectInvalid(
			command({
				stats: {
					rounds: 1,
					wins: 0,
					losses: 0,
					biggestWin: 0,
					netProfit: null as never,
				},
			}),
		);
		expectInvalid(
			command({
				stats: {
					rounds: 1,
					wins: 0,
					losses: 0,
					biggestWin: 0,
					netProfit: '100' as never,
				},
			}),
		);
		expectInvalid(
			command({
				stats: {
					rounds: 1,
					wins: 0,
					losses: 0,
					biggestWin: 0,
					netProfit: Number.MAX_SAFE_INTEGER + 1,
				},
			}),
		);
		expectInvalid(
			command({
				stats: {
					rounds: 1,
					wins: 0,
					losses: 0,
					biggestWin: 0,
					netProfit: MAX_ABSOLUTE_SETTLEMENT_STAT + 1,
				},
			}),
		);
		expectInvalid(
			command({
				stats: {
					rounds: 1,
					wins: 0,
					losses: 0,
					biggestWin: 0,
					netProfit: -(MAX_ABSOLUTE_SETTLEMENT_STAT + 1),
				},
			}),
		);
		expect(() =>
			validate(
				command({
					stats: {
						rounds: 1,
						wins: 0,
						losses: 0,
						biggestWin: 0,
						netProfit: MAX_ABSOLUTE_SETTLEMENT_STAT,
					},
				}),
			),
		).not.toThrow();
		expect(() =>
			validate(
				command({
					stats: {
						rounds: 1,
						wins: 0,
						losses: 0,
						biggestWin: 0,
						netProfit: -MAX_ABSOLUTE_SETTLEMENT_STAT,
					},
				}),
			),
		).not.toThrow();
	});

	test('rejects a zero-round settlement even when netProfit is present', () => {
		expectInvalid(
			command({
				stats: { rounds: 0, wins: 0, losses: 0, biggestWin: 0, netProfit: 0 },
			}),
		);
	});

	test('rejects excessive statistic values even with a zero delta', () => {
		expectInvalid(
			command({
				delta: 0,
				stats: { rounds: MAX_ABSOLUTE_SETTLEMENT_STAT + 1, wins: 0, losses: 0, biggestWin: 0 },
			}),
		);
		expectInvalid(
			command({
				delta: 0,
				stats: {
					rounds: 1,
					wins: 1,
					losses: 0,
					biggestWin: MAX_ABSOLUTE_SETTLEMENT_STAT + 1,
				},
			}),
		);
		expect(() =>
			validate(
				command({
					delta: 0,
					stats: {
						rounds: MAX_ABSOLUTE_SETTLEMENT_STAT,
						wins: 0,
						losses: 0,
						biggestWin: 0,
					},
				}),
			),
		).not.toThrow();
	});
});

describe('settleWalletRound', () => {
	test('returns an existing receipt as a duplicate without reading balance again', async () => {
		const calls: string[] = [];
		const d1 = {
			prepare(sql: string) {
				calls.push(sql);
				return {
					bind() {
						return {
							first: async () => ({ balance: 1200, attemptId: 'winner' }),
						};
					},
				};
			},
		} as unknown as D1Database;

		await expect(settleWalletRound(d1, 'user-1', command())).resolves.toEqual({
			balance: 1200,
			duplicate: true,
		});
		expect(calls).toHaveLength(1);
	});

	test('rejects a missing user before attempting a settlement batch', async () => {
		let prepareCount = 0;
		const d1 = {
			prepare(sql: string) {
				prepareCount += 1;
				return {
					bind() {
						return {
							first: async () => (sql.startsWith('SELECT balance') ? null : null),
						};
					},
				};
			},
		} as unknown as D1Database;

		await expect(settleWalletRound(d1, 'missing-user', command())).rejects.toMatchObject({
			code: 'USER_NOT_FOUND',
		});
		expect(prepareCount).toBe(2);
	});

	test('rejects a loss that would make the wallet negative', async () => {
		const d1 = {
			prepare(sql: string) {
				return {
					bind() {
						return {
							first: async () => (sql.includes('FROM user') ? { chipBalance: 5 } : null),
						};
					},
				};
			},
		} as unknown as D1Database;

		await expect(
			settleWalletRound(
				d1,
				'poor-user',
				command({ delta: -10, stats: { rounds: 1, wins: 0, losses: 1, biggestWin: 0 } }),
			),
		).rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE' });
	});

	test('rejects an underfunded winning bet via requiredFunds before settling', async () => {
		const d1 = {
			prepare(sql: string) {
				return {
					bind() {
						return {
							first: async () => (sql.includes('FROM user') ? { chipBalance: 5 } : null),
						};
					},
				};
			},
		} as unknown as D1Database;

		// A winning result with delta +340 would normally succeed, but
		// requiredFunds=10 exceeds the $5 balance so it must be rejected.
		await expect(
			settleWalletRound(
				d1,
				'underfunded-user',
				command({ delta: 340, stats: { rounds: 1, wins: 1, losses: 0, biggestWin: 340 } }),
				10,
			),
		).rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE' });
	});

	test('rejects an invalid requiredFunds argument', async () => {
		const d1 = {
			prepare() {
				return {
					bind() {
						return { first: async () => null };
					},
				};
			},
		} as unknown as D1Database;

		await expect(settleWalletRound(d1, 'user-1', command(), -1)).rejects.toMatchObject({
			code: 'INVALID_COMMAND',
		});
		await expect(settleWalletRound(d1, 'user-1', command(), 1.5)).rejects.toMatchObject({
			code: 'INVALID_COMMAND',
		});
	});

	test('still returns a duplicate receipt when requiredFunds would fail', async () => {
		const d1 = {
			prepare(sql: string) {
				return {
					bind() {
						return {
							first: async () =>
								sql.includes('wallet_settlement')
									? { balance: 1200, attemptId: 'winner' }
									: { chipBalance: 5 },
						};
					},
				};
			},
		} as unknown as D1Database;

		// The settlement already committed (duplicate), so requiredFunds must
		// not block the duplicate return even though balance < requiredFunds.
		await expect(settleWalletRound(d1, 'user-1', command({ delta: 340 }), 10)).resolves.toEqual({
			balance: 1200,
			duplicate: true,
		});
	});
});

const MIGRATIONS_DIR = join(process.cwd(), 'drizzle');
const MIGRATION_FILES = readdirSync(MIGRATIONS_DIR)
	.filter((file) => file.endsWith('.sql'))
	.sort();

async function applyMigrations(d1: D1Database): Promise<void> {
	for (const file of MIGRATION_FILES) {
		const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
		const statements = sql
			.split('--> statement-breakpoint')
			.map((statement) => statement.trim())
			.filter(Boolean);
		await d1.batch(statements.map((statement) => d1.prepare(statement)));
	}
}

async function insertIntegrationUser(d1: D1Database, userId: string): Promise<void> {
	await d1
		.prepare(
			'INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt, chipBalance) VALUES (?, ?, ?, ?, ?, ?, ?)',
		)
		.bind(userId, userId, `${userId}@example.test`, 0, 1000, 1000, 1000)
		.run();
}

function injectUnrelatedConflicts(
	base: D1Database,
	conflictCount: number,
): { d1: D1Database; batchCalls: () => number } {
	let batchCalls = 0;
	const d1 = {
		prepare: (sql: string) => base.prepare(sql),
		batch: async (statements: Parameters<D1Database['batch']>[0]) => {
			batchCalls += 1;
			if (batchCalls <= conflictCount) {
				return [{ meta: { changes: 0 } }];
			}
			return base.batch(statements);
		},
	} as unknown as D1Database;
	return { d1, batchCalls: () => batchCalls };
}

describe('settleWalletRound (Miniflare D1 integration)', () => {
	let mf: Miniflare | null = null;
	let d1: D1Database | null = null;

	beforeAll(async () => {
		mf = new Miniflare({
			modules: [
				{
					type: 'ESModule',
					path: 'file:///entry.js',
					contents: 'export default { fetch() { return new Response("ok"); } }',
				},
			],
			d1Databases: { DB: 'wallet-settle-concurrency-test' },
			d1Persist: false,
		});
		await mf.ready;
		d1 = (await mf.getD1Database('DB')) as unknown as D1Database;
		await applyMigrations(d1);
	});

	afterAll(async () => {
		if (mf) await mf.dispose();
	});

	test('commits one fresh same-ID settlement when two D1 requests race', async () => {
		const userId = 'same-id-race';
		await insertIntegrationUser(d1!, userId);
		const settlement = command({
			settlementId: 'blackjack-race-same-id',
			delta: 100,
			stats: { rounds: 1, wins: 1, losses: 0, biggestWin: 100 },
		});

		const results = await Promise.all([
			settleWalletRound(d1!, userId, settlement),
			settleWalletRound(d1!, userId, settlement),
		]);

		expect(results.filter((result) => !result.duplicate)).toHaveLength(1);
		expect(results.filter((result) => result.duplicate)).toHaveLength(1);
		expect(results.map((result) => result.balance)).toEqual([1100, 1100]);

		const receipt = await d1!
			.prepare(
				'SELECT COUNT(*) AS count FROM wallet_settlement WHERE userId = ? AND settlementId = ?',
			)
			.bind(userId, settlement.settlementId)
			.first<{ count: number }>();
		const balance = await d1!
			.prepare('SELECT chipBalance FROM user WHERE id = ?')
			.bind(userId)
			.first<{ chipBalance: number }>();
		const stats = await d1!
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
		const mission = await d1!
			.prepare('SELECT progress FROM mission_progress WHERE userId = ? AND missionDefId = ?')
			.bind(userId, 'daily-win-3')
			.first<{ progress: number }>();

		expect(receipt?.count).toBe(1);
		expect(balance?.chipBalance).toBe(1100);
		expect(stats).toEqual({
			totalWins: 1,
			totalLosses: 0,
			handsPlayed: 1,
			biggestWin: 100,
			netProfit: 100,
		});
		expect(mission?.progress).toBe(1);
	});

	test('retries one unrelated optimistic conflict and succeeds', async () => {
		const userId = 'unrelated-conflict-retry';
		await insertIntegrationUser(d1!, userId);
		const injected = injectUnrelatedConflicts(d1!, 1);

		await expect(
			settleWalletRound(
				injected.d1,
				userId,
				command({ settlementId: 'blackjack-unrelated-retry' }),
			),
		).resolves.toMatchObject({ balance: 1100, duplicate: false });
		expect(injected.batchCalls()).toBe(2);
	});

	test('fails after the bounded second unrelated optimistic conflict', async () => {
		const userId = 'unrelated-conflict-failure';
		await insertIntegrationUser(d1!, userId);
		const injected = injectUnrelatedConflicts(d1!, 2);

		await expect(
			settleWalletRound(
				injected.d1,
				userId,
				command({ settlementId: 'blackjack-unrelated-failure' }),
			),
		).rejects.toMatchObject({ code: 'SETTLEMENT_CONFLICT' });
		expect(injected.batchCalls()).toBe(2);

		const balance = await d1!
			.prepare('SELECT chipBalance FROM user WHERE id = ?')
			.bind(userId)
			.first<{ chipBalance: number }>();
		expect(balance?.chipBalance).toBe(1000);
	});
});
