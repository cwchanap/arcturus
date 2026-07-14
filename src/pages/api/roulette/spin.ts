import type { APIRoute } from 'astro';
import { createDb } from '../../../lib/db';
import { user } from '../../../db/schema';
import { eq } from 'drizzle-orm';
import { evaluateBets } from '../../../lib/roulette/betEvaluator';
import { MAX_BET_PER_POSITION, MAX_TOTAL_BET, MIN_BET } from '../../../lib/roulette/constants';
import type { BetType, RouletteBet } from '../../../lib/roulette/types';
import { type GameType } from '../../../lib/game-stats/game-stats';
import { checkAndGrantAchievements } from '../../../lib/achievements/achievements';
import { redactUserId } from '../../../lib/achievements/achievement-repository';
import { isValidGameType } from '../../../lib/game-stats/constants';

const VALID_OUTSIDE_BET_TYPES = new Set<BetType>(['red', 'black', 'odd', 'even', 'low', 'high']);
const VALID_TARGET_BET_TYPES = new Set<BetType>(['straight', 'dozen', 'column']);
const SYNC_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export function isValidBet(b: unknown): b is RouletteBet {
	if (!b || typeof b !== 'object') return false;
	const bet = b as Record<string, unknown>;
	if (typeof bet.id !== 'string' || !bet.id) return false;
	if (typeof bet.type !== 'string') return false;
	const type = bet.type as BetType;
	if (!VALID_OUTSIDE_BET_TYPES.has(type) && !VALID_TARGET_BET_TYPES.has(type)) {
		return false;
	}
	if (typeof bet.amount !== 'number' || !Number.isInteger(bet.amount) || bet.amount < MIN_BET) {
		return false;
	}
	if (VALID_OUTSIDE_BET_TYPES.has(type) && bet.target !== undefined) {
		return false;
	}
	if (type === 'straight') {
		if (
			typeof bet.target !== 'number' ||
			!Number.isInteger(bet.target) ||
			bet.target < 0 ||
			bet.target > 36
		) {
			return false;
		}
	}
	if (type === 'dozen' || type === 'column') {
		if (typeof bet.target !== 'number' || ![0, 1, 2].includes(bet.target)) {
			return false;
		}
	}
	return true;
}

export function generateWinningNumber(): number {
	const buf = new Uint8Array(1);
	const LIMIT = 222;
	do {
		crypto.getRandomValues(buf);
	} while (buf[0] >= LIMIT);
	return buf[0] % 37;
}

export function canonicalizeBets(bets: RouletteBet[]): string {
	return JSON.stringify(
		bets
			.map((b) => ({ type: b.type, amount: b.amount, target: b.target ?? null }))
			.sort((a, b) => {
				if (a.type !== b.type) return a.type < b.type ? -1 : 1;
				if (a.target !== b.target) return (a.target ?? -1) - (b.target ?? -1);
				return a.amount - b.amount;
			}),
	);
}

const ROULETTE_MAX_WIN = 50000;
const ROULETTE_MAX_LOSS = 10000;
const MIN_UPDATE_INTERVAL_MS = 2000;
const MAX_RATE_LIMIT_MAP_SIZE = 10000;
const lastUpdateByUser = new Map<string, number>();

type PostHandlerDeps = {
	createDb: typeof createDb;
	checkAndGrantAchievements: typeof checkAndGrantAchievements;
	evaluateBets: typeof evaluateBets;
	generateWinningNumber: () => number;
	lastUpdateByUser: Map<string, number>;
};

export function createPostHandler(overrides: Partial<PostHandlerDeps> = {}) {
	const {
		createDb: createDbImpl = createDb,
		checkAndGrantAchievements: checkAndGrantAchievementsImpl = checkAndGrantAchievements,
		evaluateBets: evaluateBetsImpl = evaluateBets,
		generateWinningNumber: generateWinningNumberImpl = generateWinningNumber,
		lastUpdateByUser: lastUpdateByUserImpl = lastUpdateByUser,
	} = overrides;

	return (async ({ request, locals }) => {
		if (!locals.user) {
			return new Response(JSON.stringify({ error: 'UNAUTHORIZED' }), {
				status: 401,
				headers: { 'Content-Type': 'application/json' },
			});
		}

		const userId = locals.user.id;
		const now = Date.now();

		let body: {
			syncId?: unknown;
			bets?: unknown;
			totalBet?: unknown;
		};
		try {
			body = await request.json();
		} catch {
			return new Response(JSON.stringify({ error: 'INVALID_JSON' }), {
				status: 400,
				headers: { 'Content-Type': 'application/json' },
			});
		}

		const { syncId, bets: rawBets, totalBet: _rawTotalBet } = body;

		if (typeof syncId !== 'string' || !SYNC_ID_RE.test(syncId)) {
			return new Response(JSON.stringify({ error: 'INVALID_SYNC_ID' }), {
				status: 400,
				headers: { 'Content-Type': 'application/json' },
			});
		}

		if (!Array.isArray(rawBets) || rawBets.length === 0) {
			return new Response(JSON.stringify({ error: 'INVALID_BETS' }), {
				status: 400,
				headers: { 'Content-Type': 'application/json' },
			});
		}

		const bets = rawBets.filter(isValidBet);
		if (bets.length !== rawBets.length) {
			return new Response(JSON.stringify({ error: 'INVALID_BETS' }), {
				status: 400,
				headers: { 'Content-Type': 'application/json' },
			});
		}

		const totalBet = bets.reduce((sum, b) => sum + b.amount, 0);
		if (totalBet < MIN_BET || totalBet > MAX_TOTAL_BET) {
			return new Response(JSON.stringify({ error: 'INVALID_TOTAL_BET' }), {
				status: 400,
				headers: { 'Content-Type': 'application/json' },
			});
		}

		const positionTotals = new Map<string, number>();
		for (const bet of bets) {
			const key = `${bet.type}:${bet.target ?? 'none'}`;
			positionTotals.set(key, (positionTotals.get(key) ?? 0) + bet.amount);
		}
		for (const total of positionTotals.values()) {
			if (total > MAX_BET_PER_POSITION) {
				return new Response(JSON.stringify({ error: 'POSITION_LIMIT_EXCEEDED' }), {
					status: 400,
					headers: { 'Content-Type': 'application/json' },
				});
			}
		}

		const dbBinding = locals.runtime?.env?.DB;
		if (!dbBinding) {
			return new Response(JSON.stringify({ error: 'DATABASE_UNAVAILABLE' }), {
				status: 500,
				headers: { 'Content-Type': 'application/json' },
			});
		}

		const existing = await dbBinding
			.prepare(
				'SELECT winningNumber, newBalance, previousBalance, netDelta, betsJson, totalBet FROM roulette_round WHERE userId = ? AND syncId = ?',
			)
			.bind(userId, syncId)
			.first();

		if (existing) {
			const storedBets = JSON.parse(existing.betsJson as string) as RouletteBet[];
			const storedCanonical = canonicalizeBets(storedBets);
			const requestCanonical = canonicalizeBets(bets);
			if (storedCanonical !== requestCanonical || existing.totalBet !== totalBet) {
				return new Response(JSON.stringify({ error: 'SYNC_ID_REUSE_MISMATCH' }), {
					status: 409,
					headers: { 'Content-Type': 'application/json' },
				});
			}
			const receipt = await dbBinding
				.prepare('SELECT achievementPayload FROM chip_sync_receipt WHERE userId = ? AND syncId = ?')
				.bind(userId, syncId)
				.first<{ achievementPayload: string | null }>();
			let replayedAchievements: Array<{ id: string; name: string; icon: string }> | undefined;
			if (receipt?.achievementPayload) {
				try {
					const parsed = JSON.parse(receipt.achievementPayload) as {
						newAchievements?: Array<{ id: string; name: string; icon: string }>;
					};
					if (Array.isArray(parsed.newAchievements) && parsed.newAchievements.length > 0) {
						replayedAchievements = parsed.newAchievements;
					}
				} catch {
					// ignore corrupted payload
				}
			}
			return new Response(
				JSON.stringify({
					winningNumber: existing.winningNumber,
					newBalance: existing.newBalance,
					previousBalance: existing.previousBalance,
					netDelta: existing.netDelta,
					results: evaluateBetsImpl(storedBets, existing.winningNumber as number),
					syncId,
					newAchievements: replayedAchievements,
				}),
				{ headers: { 'Content-Type': 'application/json' } },
			);
		}

		const db = createDbImpl(dbBinding);
		const [userRow] = await db
			.select({ chipBalance: user.chipBalance, heldChips: user.heldChips })
			.from(user)
			.where(eq(user.id, userId))
			.limit(1);

		if (!userRow) {
			return new Response(JSON.stringify({ error: 'USER_NOT_FOUND' }), {
				status: 500,
				headers: { 'Content-Type': 'application/json' },
			});
		}

		const heldChips = Math.trunc(userRow.heldChips ?? 0);
		if (heldChips > 0) {
			return new Response(JSON.stringify({ error: 'MP_ESCROW_ACTIVE' }), {
				status: 409,
				headers: { 'Content-Type': 'application/json' },
			});
		}

		const previousBalance = Math.trunc(userRow.chipBalance);
		if (totalBet > previousBalance) {
			return new Response(
				JSON.stringify({ error: 'INSUFFICIENT_BALANCE', currentBalance: previousBalance }),
				{ status: 400, headers: { 'Content-Type': 'application/json' } },
			);
		}

		const lastUpdate = lastUpdateByUserImpl.get(userId) ?? 0;
		if (now - lastUpdate < MIN_UPDATE_INTERVAL_MS) {
			const waitTime = Math.ceil((MIN_UPDATE_INTERVAL_MS - (now - lastUpdate)) / 1000);
			return new Response(
				JSON.stringify({ error: 'RATE_LIMITED', message: `Please wait ${waitTime}s` }),
				{
					status: 429,
					headers: { 'Content-Type': 'application/json', 'Retry-After': String(waitTime) },
				},
			);
		}

		const winningNumber = generateWinningNumberImpl();
		const results = evaluateBetsImpl(bets, winningNumber);
		const totalPayout = results.reduce((sum, r) => sum + r.payout, 0);
		const netDelta = totalPayout - totalBet;

		if (netDelta > ROULETTE_MAX_WIN || (netDelta < 0 && Math.abs(netDelta) > ROULETTE_MAX_LOSS)) {
			console.warn(
				`[ROULETTE_AUDIT] User ${redactUserId(userId)} delta ${netDelta} exceeds limits`,
			);
			return new Response(JSON.stringify({ error: 'DELTA_EXCEEDS_LIMIT' }), {
				status: 400,
				headers: { 'Content-Type': 'application/json' },
			});
		}

		const newBalance = previousBalance + netDelta;
		if (newBalance < 0) {
			return new Response(JSON.stringify({ error: 'INSUFFICIENT_BALANCE' }), {
				status: 400,
				headers: { 'Content-Type': 'application/json' },
			});
		}

		const nowSeconds = Math.trunc(now / 1000);
		const outcome = netDelta > 0 ? 'win' : netDelta < 0 ? 'loss' : 'push';
		const winsIncrement = netDelta > 0 ? 1 : 0;
		const lossesIncrement = netDelta < 0 ? 1 : 0;
		const biggestWinCandidate = netDelta > 0 ? netDelta : null;
		const shouldRecordStats = isValidGameType('roulette');

		const batchStatements: D1PreparedStatement[] = [
			dbBinding
				.prepare('UPDATE user SET chipBalance = ?, updatedAt = ? WHERE id = ? AND chipBalance = ?')
				.bind(newBalance, nowSeconds, userId, previousBalance),
			dbBinding
				.prepare(
					'INSERT INTO roulette_round (syncId, userId, winningNumber, betsJson, totalBet, totalPayout, netDelta, previousBalance, newBalance, createdAt) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE changes() = 1',
				)
				.bind(
					syncId,
					userId,
					winningNumber,
					JSON.stringify(bets),
					totalBet,
					totalPayout,
					netDelta,
					previousBalance,
					newBalance,
					nowSeconds,
				),
			dbBinding
				.prepare(
					'INSERT INTO chip_sync_receipt (userId, syncId, gameType, previousBalance, balance, delta, statsDelta, outcome, handCount, winsIncrement, lossesIncrement, biggestWinCandidate, overallRank, achievementPayload, createdAt) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT COUNT(*) + 1 FROM user leaderboard_user WHERE leaderboard_user.chipBalance > ? OR (leaderboard_user.chipBalance = ? AND leaderboard_user.id < ?)), ?, ? WHERE changes() = 1',
				)
				.bind(
					userId,
					syncId,
					'roulette',
					previousBalance,
					newBalance,
					netDelta,
					netDelta,
					outcome,
					1,
					winsIncrement,
					lossesIncrement,
					netDelta > 0 ? netDelta : 0,
					newBalance,
					newBalance,
					userId,
					null,
					nowSeconds,
				),
		];

		if (shouldRecordStats) {
			batchStatements.push(
				dbBinding
					.prepare(
						'INSERT INTO game_stats (userId, gameType, totalWins, totalLosses, handsPlayed, biggestWin, netProfit, updatedAt) SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE changes() = 1 ON CONFLICT(userId, gameType) DO UPDATE SET totalWins = game_stats.totalWins + excluded.totalWins, totalLosses = game_stats.totalLosses + excluded.totalLosses, handsPlayed = game_stats.handsPlayed + excluded.handsPlayed, biggestWin = CASE WHEN ? IS NULL THEN game_stats.biggestWin WHEN ? > 0 AND ? > game_stats.biggestWin THEN ? ELSE game_stats.biggestWin END, netProfit = game_stats.netProfit + excluded.netProfit, updatedAt = excluded.updatedAt',
					)
					.bind(
						userId,
						'roulette',
						winsIncrement,
						lossesIncrement,
						1,
						Math.max(biggestWinCandidate ?? 0, 0),
						netDelta,
						nowSeconds,
						biggestWinCandidate,
						biggestWinCandidate,
						biggestWinCandidate,
						biggestWinCandidate,
					),
			);
		}

		const batchResults = await dbBinding.batch(batchStatements);

		const updateResult = batchResults[0] as { meta?: { changes?: number } } | null;
		if ((updateResult?.meta?.changes ?? 0) === 0) {
			return new Response(JSON.stringify({ error: 'CONCURRENT_MODIFICATION' }), {
				status: 409,
				headers: { 'Content-Type': 'application/json' },
			});
		}

		lastUpdateByUserImpl.set(userId, now);
		if (lastUpdateByUserImpl.size > MAX_RATE_LIMIT_MAP_SIZE) {
			lastUpdateByUserImpl.clear();
		}

		if (netDelta > 0) {
			console.warn(
				`[CHIP_AUDIT] User ${redactUserId(userId)} won ${netDelta} in roulette: ${previousBalance} -> ${newBalance}`,
			);
		}

		let newAchievements: Array<{ id: string; name: string; icon: string }> = [];
		try {
			if (shouldRecordStats) {
				const earned = await checkAndGrantAchievementsImpl(db, userId, newBalance, {
					recentWinAmount: netDelta > 0 ? netDelta : undefined,
					gameType: 'roulette' as GameType,
				});
				newAchievements = earned.map((a) => ({ id: a.id, name: a.name, icon: a.icon }));
			}
		} catch (statsError) {
			console.error('[ROULETTE] Stats/achievement error:', statsError);
		}

		if (newAchievements.length > 0) {
			try {
				await dbBinding
					.prepare(
						'UPDATE chip_sync_receipt SET achievementPayload = ? WHERE userId = ? AND syncId = ?',
					)
					.bind(JSON.stringify({ newAchievements, warnings: [] }), userId, syncId)
					.run();
			} catch (receiptPayloadError) {
				console.error('[ROULETTE] Failed to persist achievement payload:', receiptPayloadError);
			}
		}

		return new Response(
			JSON.stringify({
				winningNumber,
				newBalance,
				previousBalance,
				netDelta,
				results,
				syncId,
				newAchievements: newAchievements.length > 0 ? newAchievements : undefined,
			}),
			{ headers: { 'Content-Type': 'application/json' } },
		);
	}) as APIRoute;
}

export const POST: APIRoute = createPostHandler();
