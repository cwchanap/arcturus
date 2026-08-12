import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Miniflare } from 'miniflare';
import type { APIRoute } from 'astro';
import {
	createPostHandler,
	isValidBet,
	normalizeBet,
	generateWinningNumber,
} from '../../pages/api/roulette/spin';
import { evaluateBets } from './betEvaluator';
import type { RouletteBet } from './types';
import type { SettleRoundCommand, SettleRoundResult } from '../wallet/types';
import { WalletSettlementDomainError } from '../wallet/settle';

function makeBet(type: RouletteBet['type'], amount: number, target?: number): RouletteBet {
	return {
		id: `bet-${type}-${target ?? 'none'}-${amount}`,
		type,
		amount,
		...(target === undefined ? {} : { target }),
	};
}

function context({
	user = { id: 'user-1' },
	db = {} as D1Database,
	body = { syncId: 'spin-1', bets: [makeBet('red', 10)] },
}: {
	user?: { id: string } | null;
	db?: D1Database;
	body?: unknown;
} = {}): Parameters<APIRoute>[0] {
	return {
		locals: {
			user,
			runtime: { env: { DB: db } },
		},
		request: new Request('https://arcturus.example/api/roulette/spin', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body),
		}),
	} as unknown as Parameters<APIRoute>[0];
}

async function json(response: Response): Promise<Record<string, unknown>> {
	return (await response.json()) as Record<string, unknown>;
}

function createHandler({
	settle,
	evaluate = evaluateBets,
	winningNumber = 17,
}: {
	settle?: (
		d1: D1Database,
		userId: string,
		command: SettleRoundCommand,
		requiredFunds?: number,
	) => Promise<SettleRoundResult>;
	evaluate?: typeof evaluateBets;
	winningNumber?: number;
} = {}) {
	const calls: Array<{
		d1: D1Database;
		userId: string;
		command: SettleRoundCommand;
		requiredFunds?: number;
	}> = [];
	const settlement =
		settle ??
		(async (_d1: D1Database, _userId: string, command: SettleRoundCommand) => {
			return { balance: 1_000 + command.delta, duplicate: false };
		});
	const handler = createPostHandler({
		settleWalletRound: async (d1, userId, command, requiredFunds) => {
			calls.push({ d1, userId, command, requiredFunds });
			return settlement(d1, userId, command, requiredFunds);
		},
		evaluateBets: evaluate,
		generateWinningNumber: () => winningNumber,
	});
	return { handler, calls };
}

describe('POST /api/roulette/spin', () => {
	test('rejects unauthenticated requests', async () => {
		const { handler } = createHandler();
		const response = await handler(context({ user: null }));
		expect(response.status).toBe(401);
		expect(await json(response)).toEqual({ error: 'UNAUTHORIZED' });
	});

	test('rejects malformed JSON before evaluating or settling', async () => {
		let evaluated = false;
		const { handler } = createHandler({
			evaluate: () => {
				evaluated = true;
				return [];
			},
		});
		const request = new Request('https://arcturus.example/api/roulette/spin', {
			method: 'POST',
			body: '{not-json',
		});
		const response = await handler({ ...context(), request });
		expect(response.status).toBe(400);
		expect(await json(response)).toEqual({ error: 'INVALID_JSON' });
		expect(evaluated).toBe(false);
	});

	test('keeps server bet validation', async () => {
		const { handler, calls } = createHandler();
		const response = await handler(
			context({ body: { syncId: 'spin-1', bets: [{ id: 'bad', type: 'unknown', amount: 10 }] } }),
		);
		expect(response.status).toBe(400);
		expect(await json(response)).toEqual({ error: 'INVALID_BETS' });
		expect(calls).toHaveLength(0);
	});

	test('keeps server-generated winning number and evaluation while delegating one wallet command', async () => {
		const d1 = {} as D1Database;
		const bets = [makeBet('straight', 10, 17)];
		const { handler, calls } = createHandler({ winningNumber: 17 });
		const response = await handler(context({ db: d1, body: { syncId: 'spin-1', bets } }));
		const body = await json(response);

		expect(response.status).toBe(200);
		expect(body.winningNumber).toBe(17);
		expect(body.results).toEqual(evaluateBets(bets, 17));
		expect(body.netDelta).toBe(350);
		expect(body.newBalance).toBe(1_350);
		expect(body.previousBalance).toBe(1_000);
		expect(body.syncId).toBe('spin-1');
		expect(calls).toEqual([
			{
				d1,
				userId: 'user-1',
				command: {
					settlementId: 'spin-1',
					game: 'roulette',
					delta: 350,
					stats: { rounds: 1, wins: 1, losses: 0, biggestWin: 350 },
				},
				requiredFunds: 10,
			},
		]);
	});

	test('passes totalBet as requiredFunds so the wallet can reject underfunded bets', async () => {
		const d1 = {} as D1Database;
		const bets = [makeBet('red', 25), makeBet('straight', 100, 17)];
		const { handler, calls } = createHandler({ winningNumber: 17 });
		await handler(context({ db: d1, body: { syncId: 'spin-funds', bets } }));
		expect(calls[0]?.requiredFunds).toBe(125);
	});

	test('passes loss and push normalization to generic wallet stats', async () => {
		const bets = [makeBet('red', 10)];
		const { handler, calls } = createHandler({ winningNumber: 0 });
		await handler(context({ body: { syncId: 'loss-sync', bets } }));
		expect(calls[0]?.command.stats).toEqual({
			rounds: 1,
			wins: 0,
			losses: 1,
			biggestWin: 0,
		});

		const pushHandler = createHandler({
			evaluate: (placedBets) => placedBets.map((bet) => ({ bet, won: true, payout: bet.amount })),
		});
		await pushHandler.handler(context({ body: { syncId: 'push-sync', bets } }));
		expect(pushHandler.calls[0]?.command).toMatchObject({
			delta: 0,
			stats: { rounds: 1, wins: 0, losses: 0, biggestWin: 0 },
		});
	});

	test('returns only authoritative balance for a duplicate settlement', async () => {
		const { handler, calls } = createHandler({
			settle: async () => ({ balance: 925, duplicate: true }),
		});
		const response = await handler(
			context({ body: { syncId: 'duplicate-sync', bets: [makeBet('straight', 10, 17)] } }),
		);

		expect(response.status).toBe(200);
		expect(await json(response)).toEqual({ duplicate: true, newBalance: 925 });
		expect(calls).toHaveLength(1);
	});

	test('allows roulette deltas below the shared global bound without route-specific caps', async () => {
		const evaluate: typeof evaluateBets = (bets) =>
			bets.map((bet) => ({ bet, won: true, payout: 99_999 }));
		const { handler, calls } = createHandler({ evaluate });
		const response = await handler(
			context({ body: { syncId: 'large-win', bets: [makeBet('straight', 10, 17)] } }),
		);

		expect(response.status).toBe(200);
		expect(calls[0]?.command.delta).toBe(99_989);
	});

	test('maps wallet domain failures to stable spin responses', async () => {
		const cases: Array<[string, number]> = [
			['INVALID_COMMAND', 400],
			['INSUFFICIENT_BALANCE', 400],
			['USER_NOT_FOUND', 500],
			['SETTLEMENT_CONFLICT', 409],
		];
		for (const [code, status] of cases) {
			const { handler } = createHandler({
				settle: async () => {
					throw new WalletSettlementDomainError(code as never);
				},
			});
			const response = await handler(context());
			expect(response.status).toBe(status);
			expect(await json(response)).toEqual({ error: code });
		}
	});

	test('includes newAchievements when wallet returns them', async () => {
		const { handler } = createHandler({
			settle: async () => ({
				balance: 1_350,
				duplicate: false,
				newAchievements: [{ id: 'rising_star', name: 'Rising Star', icon: 'star' }],
			}),
		});
		const response = await handler(
			context({ body: { syncId: 'achv-sync', bets: [makeBet('straight', 10, 17)] } }),
		);
		const body = await json(response);
		expect(response.status).toBe(200);
		expect(body.newAchievements).toEqual([
			{ id: 'rising_star', name: 'Rising Star', icon: 'star' },
		]);
	});

	test('wraps unexpected (non-domain) errors in a 500 INTERNAL_ERROR response', async () => {
		const { handler } = createHandler({
			settle: async () => {
				throw new Error('unexpected database crash');
			},
		});
		const response = await handler(
			context({ body: { syncId: 'crash-sync', bets: [makeBet('red', 10)] } }),
		);
		expect(response.status).toBe(500);
		expect(await json(response)).toEqual({ error: 'INTERNAL_ERROR' });
	});
});

describe('isValidBet', () => {
	test('rejects non-object values', () => {
		expect(isValidBet(null)).toBe(false);
		expect(isValidBet('string')).toBe(false);
		expect(isValidBet(42)).toBe(false);
		expect(isValidBet(undefined)).toBe(false);
	});

	test('rejects bets with invalid id', () => {
		expect(isValidBet({ id: '', type: 'red', amount: 10 })).toBe(false);
		expect(isValidBet({ id: 'bad space', type: 'red', amount: 10 })).toBe(false);
		expect(isValidBet({ id: 123, type: 'red', amount: 10 })).toBe(false);
	});

	test('rejects bets with invalid type', () => {
		expect(isValidBet({ id: 'bet-1', type: 'unknown', amount: 10 })).toBe(false);
		expect(isValidBet({ id: 'bet-1', type: 123, amount: 10 })).toBe(false);
	});

	test('rejects bets with non-integer or below-min amount', () => {
		expect(isValidBet({ id: 'bet-1', type: 'red', amount: 0 })).toBe(false);
		expect(isValidBet({ id: 'bet-1', type: 'red', amount: 0.5 })).toBe(false);
		expect(isValidBet({ id: 'bet-1', type: 'red', amount: -5 })).toBe(false);
		expect(isValidBet({ id: 'bet-1', type: 'red', amount: '10' })).toBe(false);
	});

	test('rejects outside bets that include a target', () => {
		expect(isValidBet({ id: 'bet-1', type: 'red', amount: 10, target: 5 })).toBe(false);
		expect(isValidBet({ id: 'bet-1', type: 'even', amount: 10, target: 0 })).toBe(false);
	});

	test('rejects straight bets with out-of-range target', () => {
		expect(isValidBet({ id: 'bet-1', type: 'straight', amount: 10, target: -1 })).toBe(false);
		expect(isValidBet({ id: 'bet-1', type: 'straight', amount: 10, target: 37 })).toBe(false);
		expect(isValidBet({ id: 'bet-1', type: 'straight', amount: 10, target: 0.5 })).toBe(false);
		expect(isValidBet({ id: 'bet-1', type: 'straight', amount: 10, target: '5' })).toBe(false);
	});

	test('rejects dozen/column bets with invalid target', () => {
		expect(isValidBet({ id: 'bet-1', type: 'dozen', amount: 10, target: 3 })).toBe(false);
		expect(isValidBet({ id: 'bet-1', type: 'dozen', amount: 10, target: -1 })).toBe(false);
		expect(isValidBet({ id: 'bet-1', type: 'column', amount: 10, target: '0' })).toBe(false);
	});

	test('accepts valid outside bets without target', () => {
		expect(isValidBet({ id: 'bet-1', type: 'red', amount: 10 })).toBe(true);
		expect(isValidBet({ id: 'bet-1', type: 'low', amount: 5 })).toBe(true);
	});

	test('accepts valid straight bets with target 0-36', () => {
		expect(isValidBet({ id: 'bet-1', type: 'straight', amount: 10, target: 0 })).toBe(true);
		expect(isValidBet({ id: 'bet-1', type: 'straight', amount: 10, target: 36 })).toBe(true);
	});

	test('accepts valid dozen/column bets with target 0-2', () => {
		expect(isValidBet({ id: 'bet-1', type: 'dozen', amount: 10, target: 0 })).toBe(true);
		expect(isValidBet({ id: 'bet-1', type: 'dozen', amount: 10, target: 2 })).toBe(true);
		expect(isValidBet({ id: 'bet-1', type: 'column', amount: 10, target: 1 })).toBe(true);
	});
});

describe('normalizeBet', () => {
	test('returns null for invalid bets', () => {
		expect(normalizeBet(null)).toBeNull();
		expect(normalizeBet({ id: 'bad', type: 'unknown', amount: 10 })).toBeNull();
		expect(normalizeBet({ id: 'bet-1', type: 'red', amount: 0 })).toBeNull();
	});

	test('normalizes valid outside bet without target', () => {
		const result = normalizeBet({ id: 'bet-1', type: 'red', amount: 10 });
		expect(result).toEqual({ id: 'bet-1', type: 'red', amount: 10 });
		expect(result?.target).toBeUndefined();
	});

	test('normalizes valid straight bet with target', () => {
		const result = normalizeBet({ id: 'bet-1', type: 'straight', amount: 10, target: 17 });
		expect(result).toEqual({ id: 'bet-1', type: 'straight', amount: 10, target: 17 });
	});

	test('strips extra fields from valid bets', () => {
		const result = normalizeBet({
			id: 'bet-1',
			type: 'red',
			amount: 10,
			extra: 'should be removed',
			target: undefined,
		});
		expect(result).toEqual({ id: 'bet-1', type: 'red', amount: 10 });
		expect(result).not.toHaveProperty('extra');
	});
});

describe('generateWinningNumber', () => {
	test('returns a number between 0 and 36 inclusive', () => {
		for (let i = 0; i < 100; i++) {
			const num = generateWinningNumber();
			expect(num).toBeGreaterThanOrEqual(0);
			expect(num).toBeLessThanOrEqual(36);
			expect(Number.isInteger(num)).toBe(true);
		}
	});

	test('returns different numbers across multiple calls (probabilistic)', () => {
		const numbers = new Set<number>();
		for (let i = 0; i < 50; i++) {
			numbers.add(generateWinningNumber());
		}
		// With 37 possible values and 50 calls, we expect significant variety
		expect(numbers.size).toBeGreaterThan(5);
	});
});

describe('POST /api/roulette/spin - validation error paths', () => {
	test('rejects non-object request body (array)', async () => {
		const { handler, calls } = createHandler();
		const response = await handler(context({ body: [1, 2, 3] }));
		expect(response.status).toBe(400);
		expect(await json(response)).toEqual({ error: 'INVALID_REQUEST_BODY' });
		expect(calls).toHaveLength(0);
	});

	test('rejects non-object request body (string)', async () => {
		const { handler, calls } = createHandler();
		const response = await handler(context({ body: 'not-an-object' }));
		expect(response.status).toBe(400);
		expect(await json(response)).toEqual({ error: 'INVALID_REQUEST_BODY' });
		expect(calls).toHaveLength(0);
	});

	test('rejects invalid syncId', async () => {
		const { handler, calls } = createHandler();
		const response = await handler(
			context({ body: { syncId: 'bad space!', bets: [makeBet('red', 10)] } }),
		);
		expect(response.status).toBe(400);
		expect(await json(response)).toEqual({ error: 'INVALID_SYNC_ID' });
		expect(calls).toHaveLength(0);
	});

	test('rejects missing syncId', async () => {
		const { handler, calls } = createHandler();
		const response = await handler(context({ body: { bets: [makeBet('red', 10)] } }));
		expect(response.status).toBe(400);
		expect(await json(response)).toEqual({ error: 'INVALID_SYNC_ID' });
		expect(calls).toHaveLength(0);
	});

	test('rejects empty bets array', async () => {
		const { handler, calls } = createHandler();
		const response = await handler(context({ body: { syncId: 'spin-1', bets: [] } }));
		expect(response.status).toBe(400);
		expect(await json(response)).toEqual({ error: 'INVALID_BETS' });
		expect(calls).toHaveLength(0);
	});

	test('rejects non-array bets', async () => {
		const { handler, calls } = createHandler();
		const response = await handler(context({ body: { syncId: 'spin-1', bets: 'not-an-array' } }));
		expect(response.status).toBe(400);
		expect(await json(response)).toEqual({ error: 'INVALID_BETS' });
		expect(calls).toHaveLength(0);
	});

	test('rejects too many bets', async () => {
		const { handler, calls } = createHandler();
		const tooManyBets = Array.from({ length: 65 }, (_, i) => makeBet('red', 1, undefined));
		const response = await handler(context({ body: { syncId: 'spin-1', bets: tooManyBets } }));
		expect(response.status).toBe(400);
		expect(await json(response)).toEqual({ error: 'TOO_MANY_BETS' });
		expect(calls).toHaveLength(0);
	});

	test('rejects total bet below minimum', async () => {
		const { handler, calls } = createHandler();
		const response = await handler(
			context({ body: { syncId: 'spin-1', bets: [makeBet('red', 0)] } }),
		);
		// amount 0 is invalid → INVALID_BETS is returned before total check
		expect(response.status).toBe(400);
		expect(await json(response)).toEqual({ error: 'INVALID_BETS' });
		expect(calls).toHaveLength(0);
	});

	test('rejects total bet exceeding maximum', async () => {
		const { handler, calls } = createHandler();
		// MAX_TOTAL_BET = 5000, use 6 bets of 1000 each = 6000
		const bets = Array.from({ length: 6 }, (_, i) => makeBet('straight', 1000, i));
		const response = await handler(context({ body: { syncId: 'spin-1', bets } }));
		expect(response.status).toBe(400);
		expect(await json(response)).toEqual({ error: 'INVALID_TOTAL_BET' });
		expect(calls).toHaveLength(0);
	});

	test('rejects position limit exceeded', async () => {
		const { handler, calls } = createHandler();
		// MAX_BET_PER_POSITION = 500; place 2 bets on same position = 600
		const bets = [makeBet('red', 300), makeBet('red', 300)];
		const response = await handler(context({ body: { syncId: 'spin-1', bets } }));
		expect(response.status).toBe(400);
		expect(await json(response)).toEqual({ error: 'POSITION_LIMIT_EXCEEDED' });
		expect(calls).toHaveLength(0);
	});

	test('rejects when database binding is unavailable', async () => {
		const { handler, calls } = createHandler();
		const response = await handler({
			locals: {
				user: { id: 'user-1' },
				runtime: { env: {} },
			},
			request: new Request('https://arcturus.example/api/roulette/spin', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ syncId: 'spin-1', bets: [makeBet('red', 10)] }),
			}),
		} as unknown as Parameters<APIRoute>[0]);
		expect(response.status).toBe(500);
		expect(await json(response)).toEqual({ error: 'DATABASE_UNAVAILABLE' });
		expect(calls).toHaveLength(0);
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

describe('POST /api/roulette/spin (Miniflare D1 integration)', () => {
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
			d1Databases: { DB: 'roulette-spin-wallet-test' },
			d1Persist: false,
		});
		await mf.ready;
		d1 = (await mf.getD1Database('DB')) as unknown as D1Database;
		await applyMigrations(d1);
	});

	afterAll(async () => {
		if (mf) await mf.dispose();
	});

	test('fresh and duplicate spins update wallet and generic mission exactly once', async () => {
		const userId = 'roulette-mission-fresh';
		await insertIntegrationUser(d1!, userId);
		const handler = createPostHandler({ generateWinningNumber: () => 17 });
		const body = { syncId: 'roulette-mission-round', bets: [makeBet('straight', 10, 17)] };

		const firstResponse = await handler(context({ db: d1!, user: { id: userId }, body }));
		expect(firstResponse.status).toBe(200);
		expect(await json(firstResponse)).toMatchObject({
			winningNumber: 17,
			newBalance: 1350,
			netDelta: 350,
			syncId: 'roulette-mission-round',
		});

		const firstMission = await d1!
			.prepare('SELECT progress FROM mission_progress WHERE userId = ? AND missionDefId = ?')
			.bind(userId, 'daily-win-3')
			.first<{ progress: number }>();
		expect(firstMission?.progress).toBe(1);

		const duplicateResponse = await handler(context({ db: d1!, user: { id: userId }, body }));
		expect(duplicateResponse.status).toBe(200);
		expect(await json(duplicateResponse)).toEqual({ duplicate: true, newBalance: 1350 });

		const duplicateMission = await d1!
			.prepare('SELECT progress FROM mission_progress WHERE userId = ? AND missionDefId = ?')
			.bind(userId, 'daily-win-3')
			.first<{ progress: number }>();
		const receipt = await d1!
			.prepare(
				'SELECT COUNT(*) AS count FROM wallet_settlement WHERE userId = ? AND settlementId = ?',
			)
			.bind(userId, 'roulette-mission-round')
			.first<{ count: number }>();
		const stats = await d1!
			.prepare(
				'SELECT totalWins, totalLosses, handsPlayed, biggestWin, netProfit FROM game_stats WHERE userId = ? AND gameType = ?',
			)
			.bind(userId, 'roulette')
			.first<{
				totalWins: number;
				totalLosses: number;
				handsPlayed: number;
				biggestWin: number;
				netProfit: number;
			}>();

		expect(duplicateMission?.progress).toBe(1);
		expect(receipt?.count).toBe(1);
		expect(stats).toEqual({
			totalWins: 1,
			totalLosses: 0,
			handsPlayed: 1,
			biggestWin: 350,
			netProfit: 350,
		});
	});

	test('rejects an underfunded winning bet via requiredFunds before settling', async () => {
		const userId = 'roulette-underfunded-win';
		await d1!
			.prepare(
				'INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt, chipBalance) VALUES (?, ?, ?, ?, ?, ?, ?)',
			)
			.bind(userId, userId, `${userId}@example.test`, 0, 1000, 1000, 5)
			.run();

		const handler = createPostHandler({ generateWinningNumber: () => 17 });
		// $10 straight on 17 — a winning result would produce netDelta +340,
		// but the wallet only has $5 so requiredFunds ($10) must reject it.
		const body = { syncId: 'roulette-underfunded-win', bets: [makeBet('straight', 10, 17)] };
		const response = await handler(context({ db: d1!, user: { id: userId }, body }));

		expect(response.status).toBe(400);
		expect(await json(response)).toEqual({ error: 'INSUFFICIENT_BALANCE' });

		const balance = await d1!
			.prepare('SELECT chipBalance FROM user WHERE id = ?')
			.bind(userId)
			.first<{ chipBalance: number }>();
		expect(balance?.chipBalance).toBe(5);

		const receipt = await d1!
			.prepare(
				'SELECT COUNT(*) AS count FROM wallet_settlement WHERE userId = ? AND settlementId = ?',
			)
			.bind(userId, 'roulette-underfunded-win')
			.first<{ count: number }>();
		expect(receipt?.count).toBe(0);
	});
});
