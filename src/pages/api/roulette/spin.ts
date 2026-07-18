import type { APIRoute } from 'astro';
import { createDb } from '../../../lib/db';
import { user } from '../../../db/schema';
import { eq } from 'drizzle-orm';
import { evaluateBets } from '../../../lib/roulette/betEvaluator';
import {
	MAX_BET_PER_POSITION,
	MAX_BETS,
	MAX_TOTAL_BET,
	MIN_BET,
	ROULETTE_MAX_LOSS,
	ROULETTE_MAX_WIN,
} from '../../../lib/roulette/constants';
import {
	SPIN_INSERT_RECEIPT_SQL,
	SPIN_INSERT_ROUND_SQL,
	SPIN_UPDATE_USER_SQL,
	SPIN_UPSERT_STATS_SQL,
} from '../../../lib/roulette/spin-batch-sql';
import type { BetType, RouletteBet } from '../../../lib/roulette/types';
import { type GameType } from '../../../lib/game-stats/game-stats';
import { checkAndGrantAchievements } from '../../../lib/achievements/achievements';
import { redactUserId } from '../../../lib/achievements/achievement-repository';
import { isValidGameType } from '../../../lib/game-stats/constants';

const VALID_OUTSIDE_BET_TYPES = new Set<BetType>(['red', 'black', 'odd', 'even', 'low', 'high']);
const VALID_TARGET_BET_TYPES = new Set<BetType>(['straight', 'dozen', 'column']);
const SYNC_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
// Bet IDs are client-generated UUIDs (36 chars) or short fallback IDs.
// Cap length/character class so an authenticated caller cannot persist
// arbitrarily large IDs in roulette_round.betsJson (up to MAX_BETS=64
// per spin), which would bloat D1 rows and be re-parsed on every replay.
const BET_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export function isValidBet(b: unknown): b is RouletteBet {
	if (!b || typeof b !== 'object') return false;
	const bet = b as Record<string, unknown>;
	if (typeof bet.id !== 'string' || !BET_ID_RE.test(bet.id)) return false;
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

// Reconstruct a bet from only the known fields. `isValidBet` is a type guard
// that keeps the original object, so `filter(isValidBet)` would otherwise
// retain arbitrary caller-supplied properties (e.g. a large blob) and
// `JSON.stringify(bets)` would persist them into roulette_round.betsJson,
// inflating D1 rows and replay parsing. Normalizing to {id,type,amount,target?}
// enforces the storage-bloat guard the BET_ID_RE cap intends.
export function normalizeBet(b: unknown): RouletteBet | null {
	if (!isValidBet(b)) return null;
	const bet = b as Record<string, unknown>;
	const type = bet.type as BetType;
	const normalized: RouletteBet = {
		id: bet.id as string,
		type,
		amount: bet.amount as number,
	};
	if (bet.target !== undefined) {
		normalized.target = bet.target as number;
	}
	return normalized;
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

const MIN_UPDATE_INTERVAL_MS = 2000;
const MAX_RATE_LIMIT_MAP_SIZE = 10000;
// Per-isolate rate-limit map. Cloudflare Workers may run multiple isolates,
// so this is a best-effort throttle, not a hard guarantee. Matches the
// pattern in src/pages/api/chips/update.ts.
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
		try {
			return await handleSpinRequest(request, locals, {
				createDbImpl,
				checkAndGrantAchievementsImpl,
				evaluateBetsImpl,
				generateWinningNumberImpl,
				lastUpdateByUserImpl,
			});
		} catch (error) {
			// Catch-all so unexpected throws (DB binding gaps, programming
			// errors) surface as a structured 500 instead of an unhandled
			// Worker exception with an empty body.
			console.error('[ROULETTE] Unhandled spin error:', error);
			return new Response(JSON.stringify({ error: 'INTERNAL_ERROR' }), {
				status: 500,
				headers: { 'Content-Type': 'application/json' },
			});
		}
	}) as APIRoute;
}

type SpinHandlerDeps = {
	createDbImpl: typeof createDb;
	checkAndGrantAchievementsImpl: typeof checkAndGrantAchievements;
	evaluateBetsImpl: typeof evaluateBets;
	generateWinningNumberImpl: () => number;
	lastUpdateByUserImpl: Map<string, number>;
};

async function handleSpinRequest(
	request: Request,
	locals: App.Locals,
	{
		createDbImpl,
		checkAndGrantAchievementsImpl,
		evaluateBetsImpl,
		generateWinningNumberImpl,
		lastUpdateByUserImpl,
	}: SpinHandlerDeps,
): Promise<Response> {
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

	if (!body || typeof body !== 'object' || Array.isArray(body)) {
		return new Response(JSON.stringify({ error: 'INVALID_REQUEST_BODY' }), {
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

	if (rawBets.length > MAX_BETS) {
		return new Response(JSON.stringify({ error: 'TOO_MANY_BETS' }), {
			status: 400,
			headers: { 'Content-Type': 'application/json' },
		});
	}

	const normalized = rawBets.map(normalizeBet);
	if (normalized.some((b) => b === null) || normalized.length !== rawBets.length) {
		return new Response(JSON.stringify({ error: 'INVALID_BETS' }), {
			status: 400,
			headers: { 'Content-Type': 'application/json' },
		});
	}
	// normalizeBet reconstructs each bet from only the known fields, so
	// arbitrary caller-supplied properties are dropped before persistence.
	const bets = normalized as RouletteBet[];

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
		let storedBets: RouletteBet[];
		try {
			storedBets = JSON.parse(existing.betsJson as string) as RouletteBet[];
		} catch {
			console.warn(
				`[ROULETTE] Corrupted betsJson for user ${redactUserId(userId)} syncId ${syncId}`,
			);
			return new Response(JSON.stringify({ error: 'CORRUPTED_ROUND_DATA' }), {
				status: 500,
				headers: { 'Content-Type': 'application/json' },
			});
		}
		const storedCanonical = canonicalizeBets(storedBets);
		const requestCanonical = canonicalizeBets(bets);
		if (storedCanonical !== requestCanonical || existing.totalBet !== totalBet) {
			return new Response(JSON.stringify({ error: 'SYNC_ID_REUSE_MISMATCH' }), {
				status: 409,
				headers: { 'Content-Type': 'application/json' },
			});
		}
		const receipt = await dbBinding
			.prepare(
				'SELECT achievementPayload, overallRank FROM chip_sync_receipt WHERE userId = ? AND syncId = ?',
			)
			.bind(userId, syncId)
			.first<{ achievementPayload: string | null; overallRank: number | null }>();
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
		} else if (isValidGameType('roulette')) {
			// Achievement payload is null — the batch committed but the
			// Worker was evicted before achievement grant/persist. Re-run
			// achievement resolution (idempotent — already-granted
			// achievements are skipped) and persist the result, mirroring
			// the replay path in src/pages/api/chips/update.ts. Persist the
			// result even when no achievements were earned, so subsequent
			// replays of this syncId (which bypass the rate limit) read the
			// cached result instead of re-running the check on every replay.
			try {
				const replayDb = createDbImpl(dbBinding);
				const netDelta = existing.netDelta as number;
				const earned = await checkAndGrantAchievementsImpl(
					replayDb,
					userId,
					existing.newBalance as number,
					{
						recentWinAmount: netDelta > 0 ? netDelta : undefined,
						gameType: 'roulette' as GameType,
						overallRank: receipt?.overallRank ?? null,
					},
				);
				replayedAchievements = earned.map((a) => ({
					id: a.id,
					name: a.name,
					icon: a.icon,
				}));
				try {
					await dbBinding
						.prepare(
							'UPDATE chip_sync_receipt SET achievementPayload = ? WHERE userId = ? AND syncId = ?',
						)
						.bind(
							JSON.stringify({ newAchievements: replayedAchievements, warnings: [] }),
							userId,
							syncId,
						)
						.run();
				} catch (receiptPayloadError) {
					console.error(
						'[ROULETTE] Failed to persist replayed achievement payload:',
						receiptPayloadError,
					);
				}
			} catch (replayAchievementError) {
				console.error('[ROULETTE] Replay achievement resolution error:', replayAchievementError);
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
				newAchievements:
					replayedAchievements && replayedAchievements.length > 0
						? replayedAchievements
						: undefined,
			}),
			{ headers: { 'Content-Type': 'application/json' } },
		);
	}

	// Idempotency tombstone: if roulette_round was reaped by retention
	// cleanup but chip_sync_receipt survives (see src/server/cleanup.ts —
	// roulette receipts are reaped on a longer bounded schedule), this
	// syncId was already committed. Reject instead of creating a fresh
	// random settlement — an authenticated caller can bypass the
	// client-side 7-day localStorage TTL by POSTing directly, so the
	// server must not treat an expired syncId as a new spin. No
	// currentBalance is returned because the receipt's historical balance
	// may be stale (other games/spins since); the client falls through to
	// its balance-recovery branch and fetches the authoritative current
	// balance.
	//
	// The chip_sync_receipt PK is (userId, syncId) without gameType, so a
	// receipt may exist for a *different* game using the same syncId. That
	// is a permanent collision — the spin batch can never commit (PK
	// violation on every attempt), so returning CONCURRENT_MODIFICATION
	// would make the client retry an idempotent conflict that can never
	// resolve. Detect the collision here and return a definitive
	// non-retriable mismatch instead.
	const tombstone = await dbBinding
		.prepare('SELECT gameType FROM chip_sync_receipt WHERE userId = ? AND syncId = ?')
		.bind(userId, syncId)
		.first<{ gameType: string }>();
	if (tombstone) {
		if (tombstone.gameType === 'roulette') {
			return new Response(JSON.stringify({ error: 'SYNC_ID_REPLAY_EXPIRED' }), {
				status: 409,
				headers: { 'Content-Type': 'application/json' },
			});
		}
		return new Response(JSON.stringify({ error: 'SYNC_ID_REUSE_MISMATCH' }), {
			status: 409,
			headers: { 'Content-Type': 'application/json' },
		});
	}

	// Rate-limit check — fail-fast before the user row DB read. Placed
	// after the idempotency existence check so that replays of already-
	// settled spins still return the cached result without being blocked.
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
	const rawChipBalance = userRow.chipBalance;
	const previousBalance = Number.isFinite(rawChipBalance) ? Math.trunc(rawChipBalance) : 0;
	if (heldChips > 0) {
		// Include the authoritative spendable balance so the client can adopt
		// it instead of preserving a stale local balance/bet layout while
		// chips are locked in multiplayer poker escrow.
		return new Response(
			JSON.stringify({ error: 'MP_ESCROW_ACTIVE', currentBalance: previousBalance }),
			{
				status: 409,
				headers: { 'Content-Type': 'application/json' },
			},
		);
	}
	// Use the raw (possibly fractional) stored value as the optimistic-lock
	// match value when it differs from the truncated balance. If the stored
	// balance is e.g. 1000.5, binding the truncated 1000 in the WHERE clause
	// would never match, causing every spin to return CONCURRENT_MODIFICATION.
	// The UPDATE still writes the integer newBalance, repairing the fraction.
	const lockedBalance = rawChipBalance !== previousBalance ? rawChipBalance : previousBalance;
	if (totalBet > previousBalance) {
		return new Response(
			JSON.stringify({ error: 'INSUFFICIENT_BALANCE', currentBalance: previousBalance }),
			{ status: 400, headers: { 'Content-Type': 'application/json' } },
		);
	}

	const winningNumber = generateWinningNumberImpl();
	const results = evaluateBetsImpl(bets, winningNumber);
	const totalPayout = results.reduce((sum, r) => sum + r.payout, 0);
	const netDelta = totalPayout - totalBet;

	if (netDelta > ROULETTE_MAX_WIN || (netDelta < 0 && Math.abs(netDelta) > ROULETTE_MAX_LOSS)) {
		console.warn(`[ROULETTE_AUDIT] User ${redactUserId(userId)} delta ${netDelta} exceeds limits`);
		return new Response(JSON.stringify({ error: 'DELTA_EXCEEDS_LIMIT' }), {
			status: 400,
			headers: { 'Content-Type': 'application/json' },
		});
	}

	const newBalance = previousBalance + netDelta;

	const nowSeconds = Math.trunc(now / 1000);
	const outcome = netDelta > 0 ? 'win' : netDelta < 0 ? 'loss' : 'push';
	const winsIncrement = netDelta > 0 ? 1 : 0;
	const lossesIncrement = netDelta < 0 ? 1 : 0;
	const biggestWinCandidate = netDelta > 0 ? netDelta : null;
	const shouldRecordStats = isValidGameType('roulette');

	// nowSeconds is unix epoch seconds — matches Drizzle integer({ mode: 'timestamp' })
	// storage for user.updatedAt / roulette_round.createdAt / chip_sync_receipt.createdAt.
	const batchStatements: D1PreparedStatement[] = [
		dbBinding.prepare(SPIN_UPDATE_USER_SQL).bind(newBalance, nowSeconds, userId, lockedBalance),
		dbBinding
			.prepare(SPIN_INSERT_ROUND_SQL)
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
			.prepare(SPIN_INSERT_RECEIPT_SQL)
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
				.prepare(SPIN_UPSERT_STATS_SQL)
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

	let batchResults: Awaited<ReturnType<typeof dbBinding.batch>>;
	try {
		batchResults = await dbBinding.batch(batchStatements);
	} catch (batchError) {
		// A concurrent request with the same syncId may have committed
		// between our existence check and the batch, causing a PRIMARY KEY
		// violation on roulette_round. D1 batch is atomic so this rolls
		// back cleanly. Return 409 so the client retries via idempotency
		// and picks up the stored result.
		console.warn(
			`[ROULETTE] Batch failed for user ${redactUserId(userId)} syncId ${syncId}:`,
			batchError,
		);
		const errMsg = batchError instanceof Error ? batchError.message : String(batchError);
		// Only the expected optimistic-lock race (PRIMARY KEY / UNIQUE
		// constraint violation from a concurrent same-syncId insert) is a
		// retriable 409. Schema, service, or other unexpected failures are
		// server errors — reporting them as 409 would mask the real cause
		// and the client would retry an idempotent conflict that doesn't
		// exist.
		const isConstraintViolation =
			errMsg.includes('UNIQUE constraint failed') || errMsg.includes('PRIMARY KEY');
		if (isConstraintViolation) {
			return new Response(JSON.stringify({ error: 'CONCURRENT_MODIFICATION' }), {
				status: 409,
				headers: { 'Content-Type': 'application/json' },
			});
		}
		return new Response(JSON.stringify({ error: 'BATCH_FAILED' }), {
			status: 500,
			headers: { 'Content-Type': 'application/json' },
		});
	}

	const updateResult = batchResults[0] as { meta?: { changes?: number } } | null;
	if ((updateResult?.meta?.changes ?? 0) === 0) {
		return new Response(JSON.stringify({ error: 'CONCURRENT_MODIFICATION' }), {
			status: 409,
			headers: { 'Content-Type': 'application/json' },
		});
	}

	lastUpdateByUserImpl.set(userId, now);
	if (lastUpdateByUserImpl.size > MAX_RATE_LIMIT_MAP_SIZE) {
		// Evict stale entries (older than the rate-limit window) instead
		// of clearing the entire map, so active rate limits survive the
		// cleanup and users can't bypass the throttle en masse.
		const cutoff = now - MIN_UPDATE_INTERVAL_MS;
		for (const [u, t] of lastUpdateByUserImpl) {
			if (t < cutoff) lastUpdateByUserImpl.delete(u);
		}
		// If all entries are still fresh (sustained unique-user traffic),
		// evict the oldest entries by timestamp to enforce a hard cap on
		// isolate memory regardless of traffic patterns.
		if (lastUpdateByUserImpl.size > MAX_RATE_LIMIT_MAP_SIZE) {
			const sorted = [...lastUpdateByUserImpl.entries()].sort((a, b) => a[1] - b[1]);
			const toRemove = sorted.length - MAX_RATE_LIMIT_MAP_SIZE;
			for (let i = 0; i < toRemove; i++) {
				lastUpdateByUserImpl.delete(sorted[i][0]);
			}
		}
	}

	// Retention cleanup for roulette_round and chip_sync_receipt is now
	// handled by the Cron Trigger scheduled() handler in src/worker.ts.
	// See wrangler.toml [triggers] crons and src/server/cleanup.ts.

	if (netDelta > 0) {
		console.warn(
			`[CHIP_AUDIT] User ${redactUserId(userId)} won ${netDelta} in roulette: ${previousBalance} -> ${newBalance}`,
		);
	}

	let newAchievements: Array<{ id: string; name: string; icon: string }> = [];
	let achievementsResolved = false;
	try {
		if (shouldRecordStats) {
			// Read the settlement-time overallRank captured by SPIN_INSERT_RECEIPT_SQL's
			// leaderboard subquery. Passing this (instead of letting
			// checkAndGrantAchievementsImpl re-fetch the current rank) prevents a
			// concurrent balance update from granting or missing rank-based achievements
			// for the wrong settlement — the result is cached in achievementPayload, so
			// the wrong rank would be sticky. Mirrors /api/chips/update's
			// achievementReceipt?.overallRank path.
			let settlementOverallRank: number | null = null;
			try {
				const settledReceipt = await dbBinding
					.prepare('SELECT overallRank FROM chip_sync_receipt WHERE userId = ? AND syncId = ?')
					.bind(userId, syncId)
					.first<{ overallRank: number | null }>();
				settlementOverallRank = settledReceipt?.overallRank ?? null;
			} catch (rankFetchError) {
				console.error('[ROULETTE] Failed to read settlement overallRank:', rankFetchError);
			}
			const earned = await checkAndGrantAchievementsImpl(db, userId, newBalance, {
				recentWinAmount: netDelta > 0 ? netDelta : undefined,
				gameType: 'roulette' as GameType,
				overallRank: settlementOverallRank,
			});
			newAchievements = earned.map((a) => ({ id: a.id, name: a.name, icon: a.icon }));
			achievementsResolved = true;
		}
	} catch (statsError) {
		console.error('[ROULETTE] Stats/achievement error:', statsError);
	}

	// Persist the achievement payload whenever the check completed — even
	// when no achievements were earned — so that replays of this syncId
	// (which bypass the rate limit via the existing-round branch) read the
	// cached result instead of re-running checkAndGrantAchievements and
	// repeating the achievement DB work on every replay. A NULL payload is
	// only left when the check threw, so a replay can retry resolution.
	if (achievementsResolved) {
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
}

export const POST: APIRoute = createPostHandler();
