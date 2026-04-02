/**
 * API endpoint for updating user chip balance after game round
 *
 * ⚠️ KNOWN SECURITY LIMITATION - DEMO/PLAY-MONEY ONLY ⚠️
 *
 * This endpoint trusts client-supplied delta values because the game runs
 * entirely client-side without server-side game state. This is a deliberate
 * architectural tradeoff for this demo casino with play-money chips.
 *
 * WHAT THIS MEANS:
 * - A malicious user CAN mint chips by calling this API directly
 * - The mitigations below only slow down and detect abuse, not prevent it
 * - This is acceptable for a demo but NOT for real-money gambling
 *
 * MITIGATIONS IMPLEMENTED:
 * 1. Wins capped per-game (60k–500k depending on game) - makes exploitation tedious
 * 2. Rate limiting (2s between updates) - limits abuse speed
 * 3. Audit logging - all wins are logged for detection
 * 4. Optimistic locking - prevents race conditions
 * 5. Authentication required - abuse is tied to user accounts
 *
 * FOR PRODUCTION REAL-MONEY CASINO:
 * - Game logic MUST run server-side
 * - Server must track: deck state, bets placed, cards dealt, actions taken
 * - Payouts computed from authoritative server state only
 * - Consider provably-fair algorithms with cryptographic verification
 * - This endpoint would only accept round IDs, not deltas
 */

import type { APIRoute } from 'astro';
import { createDb } from '../../../lib/db';
import { user } from '../../../db/schema';
import { and, eq } from 'drizzle-orm';
import {
	recordGameRound,
	type GameType,
	type GameRoundOutcome,
} from '../../../lib/game-stats/game-stats';
import { checkAndGrantAchievements } from '../../../lib/achievements/achievements';
import { redactUserId } from '../../../lib/achievements/achievement-repository';
import { isValidGameType } from '../../../lib/game-stats/constants';
import {
	MAX_CRAPS_SYNC_HANDS_PER_REQUEST,
	MAX_CRAPS_SYNC_LOSS_DELTA,
	MAX_CRAPS_SYNC_WIN_DELTA,
} from '../../../lib/craps/syncLimits';

type RowsAffectedResult = { meta?: { changes?: number }; rowsAffected?: number } | null | undefined;

type ChipSyncAchievementRecord = {
	id: string;
	name: string;
	icon: string;
};

type ChipSyncAchievementPayload = {
	newAchievements: ChipSyncAchievementRecord[];
	warnings: string[];
};

type ChipSyncReceiptRecord = {
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
};

type CanonicalChipSyncPayload = {
	syncId: string;
	gameType: string;
	previousBalance: number;
	delta: number;
	statsDelta: number | null;
	outcome: string | null;
	handCount: number | null;
	winsIncrement: number | null;
	lossesIncrement: number | null;
	biggestWinCandidate: number | null;
};

type ChipSyncBatchParams = {
	userId: string;
	gameType: string;
	syncId: string;
	previousBalance: number;
	newBalance: number;
	delta: number;
	matchedBalanceValue: number;
	statsDelta: number | null;
	outcome: string | null;
	handCount: number | null;
	winsIncrement: number | null;
	lossesIncrement: number | null;
	biggestWinCandidate: number | null;
	updatedAtUnixSeconds: number;
	shouldRecordStats: boolean;
};

export const BATCHED_GAME_TYPES = new Set(['craps']);
const MAX_HAND_COUNT = MAX_CRAPS_SYNC_HANDS_PER_REQUEST;

export function getRowsAffected(result: RowsAffectedResult): number {
	return result?.meta?.changes ?? result?.rowsAffected ?? 0;
}

function isValidSyncId(syncId: unknown): syncId is string {
	return typeof syncId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(syncId);
}

function doesChipSyncReceiptMatch(
	receipt: ChipSyncReceiptRecord,
	payload: CanonicalChipSyncPayload,
): boolean {
	return (
		receipt.syncId === payload.syncId &&
		receipt.gameType === payload.gameType &&
		receipt.previousBalance === payload.previousBalance &&
		receipt.delta === payload.delta &&
		receipt.statsDelta === payload.statsDelta &&
		receipt.outcome === payload.outcome &&
		receipt.handCount === payload.handCount &&
		receipt.winsIncrement === payload.winsIncrement &&
		receipt.lossesIncrement === payload.lossesIncrement &&
		receipt.biggestWinCandidate === payload.biggestWinCandidate
	);
}

function isChipSyncAchievementRecord(value: unknown): value is ChipSyncAchievementRecord {
	return (
		typeof value === 'object' &&
		value !== null &&
		typeof (value as Record<string, unknown>).id === 'string' &&
		typeof (value as Record<string, unknown>).name === 'string' &&
		typeof (value as Record<string, unknown>).icon === 'string'
	);
}

function parseChipSyncAchievementPayload(
	rawPayload: string | null | undefined,
): ChipSyncAchievementPayload | null {
	if (typeof rawPayload !== 'string' || rawPayload.length === 0) {
		return null;
	}

	try {
		const parsed = JSON.parse(rawPayload) as {
			newAchievements?: unknown;
			warnings?: unknown;
		};

		if (
			!Array.isArray(parsed.newAchievements) ||
			!parsed.newAchievements.every(isChipSyncAchievementRecord)
		) {
			return null;
		}

		if (
			!Array.isArray(parsed.warnings) ||
			!parsed.warnings.every((warning) => typeof warning === 'string')
		) {
			return null;
		}

		return {
			newAchievements: parsed.newAchievements,
			warnings: parsed.warnings,
		};
	} catch {
		return null;
	}
}

function serializeChipSyncAchievementPayload(payload: ChipSyncAchievementPayload): string {
	return JSON.stringify(payload);
}

async function readChipSyncReceipt(
	dbBinding: D1Database,
	userId: string,
	syncId: string,
): Promise<ChipSyncReceiptRecord | null> {
	return (
		(await dbBinding
			.prepare(
				`SELECT userId, syncId, gameType, previousBalance, balance, delta, statsDelta, outcome, handCount, winsIncrement, lossesIncrement, biggestWinCandidate, overallRank, achievementPayload FROM chip_sync_receipt WHERE userId = ? AND syncId = ? LIMIT 1`,
			)
			.bind(userId, syncId)
			.first<ChipSyncReceiptRecord>()) ?? null
	);
}

async function updateChipSyncAchievementPayload(
	dbBinding: D1Database,
	userId: string,
	syncId: string,
	payload: ChipSyncAchievementPayload,
): Promise<void> {
	await dbBinding
		.prepare(`UPDATE chip_sync_receipt SET achievementPayload = ? WHERE userId = ? AND syncId = ?`)
		.bind(serializeChipSyncAchievementPayload(payload), userId, syncId)
		.run();
}

async function applyChipSyncBatch(
	dbBinding: D1Database,
	params: ChipSyncBatchParams,
): Promise<number> {
	const statements: D1PreparedStatement[] = [
		dbBinding
			.prepare(`UPDATE user SET chipBalance = ? WHERE id = ? AND chipBalance = ?`)
			.bind(params.newBalance, params.userId, params.matchedBalanceValue),
		dbBinding
			.prepare(
				`INSERT INTO chip_sync_receipt (userId, syncId, gameType, previousBalance, balance, delta, statsDelta, outcome, handCount, winsIncrement, lossesIncrement, biggestWinCandidate, overallRank, createdAt, achievementPayload) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT COUNT(*) + 1 FROM user leaderboard_user WHERE leaderboard_user.chipBalance > ? OR (leaderboard_user.chipBalance = ? AND leaderboard_user.id < ?)), ?, ? WHERE changes() = 1`,
			)
			.bind(
				params.userId,
				params.syncId,
				params.gameType,
				params.previousBalance,
				params.newBalance,
				params.delta,
				params.statsDelta,
				params.outcome,
				params.handCount,
				params.winsIncrement,
				params.lossesIncrement,
				params.biggestWinCandidate,
				params.newBalance,
				params.newBalance,
				params.userId,
				params.updatedAtUnixSeconds,
				null,
			),
	];

	if (params.shouldRecordStats) {
		const insertedBiggestWin = Math.max(params.biggestWinCandidate ?? 0, 0);
		statements.push(
			dbBinding
				.prepare(
					`INSERT INTO game_stats (userId, gameType, totalWins, totalLosses, handsPlayed, biggestWin, netProfit, updatedAt) SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE changes() = 1 ON CONFLICT(userId, gameType) DO UPDATE SET totalWins = game_stats.totalWins + excluded.totalWins, totalLosses = game_stats.totalLosses + excluded.totalLosses, handsPlayed = game_stats.handsPlayed + excluded.handsPlayed, biggestWin = CASE WHEN ? IS NULL THEN game_stats.biggestWin WHEN ? > 0 AND ? > game_stats.biggestWin THEN ? ELSE game_stats.biggestWin END, netProfit = game_stats.netProfit + excluded.netProfit, updatedAt = excluded.updatedAt`,
				)
				.bind(
					params.userId,
					params.gameType,
					params.winsIncrement ?? 0,
					params.lossesIncrement ?? 0,
					params.handCount ?? 1,
					insertedBiggestWin,
					params.statsDelta ?? params.delta,
					params.updatedAtUnixSeconds,
					params.biggestWinCandidate,
					params.biggestWinCandidate,
					params.biggestWinCandidate,
					params.biggestWinCandidate,
				),
		);
	}

	const results = await dbBinding.batch(statements);
	return getRowsAffected(results[0] as RowsAffectedResult);
}

export function determineBiggestWinCandidate({
	delta,
	biggestWinCandidate,
	winsIncrement,
	lossesIncrement: _lossesIncrement,
	handCount,
	gameType,
}: {
	delta: number;
	biggestWinCandidate: number | undefined;
	winsIncrement: number | undefined;
	lossesIncrement: number | undefined;
	handCount: number;
	gameType?: string;
}): number | null | undefined {
	// Maximum realistic split hands in a single round (e.g., blackjack: split aces can resplit)
	const MAX_SPLIT_HANDS = 4;

	// Games that batch multiple rounds into a single sync (e.g., craps with rate limiting)
	// For these games, we trust the client-provided biggestWinCandidate even with handCount > 4
	const isBatchedGame = gameType !== undefined && BATCHED_GAME_TYPES.has(gameType);

	// Split-hand round with wins - use client-provided biggestWinCandidate
	// Heuristic: handCount <= MAX_SPLIT_HANDS indicates a split round, not aggregated sync
	// Note: We use winsIncrement, not delta, to detect wins - a hand can win even if net delta <= 0
	if (
		typeof biggestWinCandidate === 'number' &&
		typeof winsIncrement === 'number' &&
		winsIncrement >= 1 &&
		handCount > 1 &&
		handCount <= MAX_SPLIT_HANDS
	) {
		return biggestWinCandidate;
	}

	// Batched game (e.g., craps) with wins - use client-provided biggestWinCandidate
	// These games batch multiple rounds together due to rate limiting, so handCount > 4 is normal
	// The client correctly tracks the biggest win across all rounds in the batch
	if (
		isBatchedGame &&
		typeof biggestWinCandidate === 'number' &&
		typeof winsIncrement === 'number' &&
		winsIncrement >= 1
	) {
		// When the batch contains losses, individual round wins can exceed the net delta
		// (gross wins partially offset by losses), so biggestWinCandidate may legitimately
		// exceed delta. When there are no losses, the biggest win cannot exceed the net delta.
		const hasLosses = typeof _lossesIncrement === 'number' && _lossesIncrement >= 1;
		if (!hasLosses) {
			return delta > 0 ? Math.min(biggestWinCandidate, delta) : null;
		}
		return biggestWinCandidate;
	}

	// Single-hand win - use provided biggestWinCandidate if available, fallback to delta
	if (delta > 0 && handCount === 1) {
		return typeof biggestWinCandidate === 'number' ? biggestWinCandidate : delta;
	}

	// Aggregated multi-round sync (handCount > MAX_SPLIT_HANDS) or loss/push
	return null;
}

export function resolveRecentWinAmountForAchievements(
	actualBiggestWinCandidate: number | null | undefined,
	delta: number,
): number | undefined {
	if (
		typeof actualBiggestWinCandidate === 'number' &&
		Number.isFinite(actualBiggestWinCandidate) &&
		actualBiggestWinCandidate > 0
	) {
		return actualBiggestWinCandidate;
	}

	return delta > 0 ? delta : undefined;
}

function resolveAchievementRecentWinAmount(
	gameType: string | null | undefined,
	outcome: string | null | undefined,
	actualBiggestWinCandidate: number | null | undefined,
	delta: number,
): number | undefined {
	if (!outcome) {
		return undefined;
	}

	if (gameType === 'poker' && outcome === 'push') {
		return undefined;
	}

	return resolveRecentWinAmountForAchievements(actualBiggestWinCandidate, delta);
}

// Game-specific betting limits
// Different games have fundamentally different payout structures:
// - Blackjack: ~1.5:1 (Natural) to 6:1 (Split+Double scenarios)
// - Baccarat: 8:1 (Tie) or 11:1 (Pair)
// - Poker: Potentially huge multipliers (Royal Flush 250:1+) or deep stack play
//
// These limits are applied per-request to prevent massive exploitation
// while allowing legitimate high-roller wins.
const GAME_LIMITS: Record<string, { maxWin: number; maxLoss: number }> = {
	blackjack: {
		// Existing logic: 4 hands x 1.5x payout x 10k max bet = 60k
		maxWin: 60000,
		maxLoss: 40000,
	},
	baccarat: {
		// Tie (8:1) or Pair (11:1) with max bet (say 10k)
		// 10k * 11 = 110k profit. Safety buffer -> 200k.
		maxWin: 200000,
		maxLoss: 100000, // 5 simultaneous max bets
	},
	poker: {
		// Royal Flush (250:1) on 1k bet = 250k.
		// Deep stack all-ins can be even higher.
		maxWin: 500000,
		maxLoss: 500000,
	},
	craps: {
		// Boxcars/Aces (30:1) on max bet ($500) = $15,000 profit per prop.
		// Multiple established Come/Don't Come bets can all resolve in a single roll,
		// so the effective ceiling is higher than per-prop analysis suggests.
		maxWin: MAX_CRAPS_SYNC_WIN_DELTA,
		maxLoss: MAX_CRAPS_SYNC_LOSS_DELTA,
	},
};

// Minimum milliseconds between chip updates (rate limiting)
// Prevents rapid-fire exploitation; normal gameplay has natural delays
const MIN_UPDATE_INTERVAL_MS = 2000; // 2 seconds between updates

// In-memory rate limit store (per-user last update timestamp)
// Note: This resets on worker restart; for production, use KV or D1
const lastUpdateByUser = new Map<string, number>();

type PostHandlerDeps = {
	createDb: typeof createDb;
	recordGameRound: typeof recordGameRound;
	checkAndGrantAchievements: typeof checkAndGrantAchievements;
	lastUpdateByUser: Map<string, number>;
	hasOwn: (target: object, key: PropertyKey) => boolean;
};

export function createPostHandler(overrides: Partial<PostHandlerDeps> = {}) {
	const {
		createDb: createDbImpl = createDb,
		recordGameRound: recordGameRoundImpl = recordGameRound,
		checkAndGrantAchievements: checkAndGrantAchievementsImpl = checkAndGrantAchievements,
		lastUpdateByUser: lastUpdateByUserImpl = lastUpdateByUser,
		hasOwn: hasOwnImpl = Object.hasOwn,
	} = overrides;

	return async ({ request, locals }: Parameters<APIRoute>[0]) => {
		// Validate authentication
		if (!locals.user) {
			return new Response(
				JSON.stringify({
					success: false,
					error: 'UNAUTHORIZED',
					message: 'Authentication required',
				}),
				{
					status: 401,
					headers: { 'Content-Type': 'application/json' },
				},
			);
		}

		const userId = locals.user.id;
		const now = Date.now();

		// Parse request body with explicit error handling for malformed JSON
		let body: {
			delta?: unknown;
			gameType?: unknown;
			syncId?: unknown;
			previousBalance?: unknown;
			maxBet?: unknown;
			outcome?: unknown;
			handCount?: unknown;
			winsIncrement?: unknown;
			lossesIncrement?: unknown;
			biggestWinCandidate?: unknown;
			statsDelta?: unknown;
		};
		try {
			body = await request.json();
		} catch {
			return new Response(
				JSON.stringify({
					success: false,
					error: 'INVALID_REQUEST_BODY',
					message: 'Request body must be valid JSON',
				}),
				{
					status: 400,
					headers: { 'Content-Type': 'application/json' },
				},
			);
		}

		const {
			delta,
			gameType,
			syncId,
			previousBalance: clientPreviousBalance,
			outcome,
			handCount,
			winsIncrement,
			lossesIncrement,
			biggestWinCandidate,
			statsDelta,
		} = body;
		// Note: body.maxBet is intentionally NOT used for validation.
		// Trusting client-provided maxBet would allow attackers to claim higher bet limits.
		// Instead, we enforce server-side per-game caps (GAME_LIMITS[gameType].maxWin/maxLoss)
		// that apply uniformly regardless of what the client claims.

		// Validate delta is a finite integer
		if (typeof delta !== 'number' || !Number.isFinite(delta) || !Number.isInteger(delta)) {
			return new Response(
				JSON.stringify({
					success: false,
					error: 'INVALID_DELTA',
					message: 'Delta must be a finite integer',
				}),
				{
					status: 400,
					headers: { 'Content-Type': 'application/json' },
				},
			);
		}

		// Validate gameType is a string
		if (typeof gameType !== 'string') {
			return new Response(
				JSON.stringify({
					success: false,
					error: 'INVALID_REQUEST_BODY',
					message: 'gameType must be a string',
				}),
				{
					status: 400,
					headers: { 'Content-Type': 'application/json' },
				},
			);
		}

		if (!hasOwnImpl(GAME_LIMITS, gameType)) {
			return new Response(
				JSON.stringify({
					success: false,
					error: 'INVALID_GAME_TYPE',
					message: 'Invalid game type',
				}),
				{
					status: 400,
					headers: { 'Content-Type': 'application/json' },
				},
			);
		}

		// Validate outcome if provided (for game stats tracking)
		const validOutcomes = ['win', 'loss', 'push'];
		if (
			outcome !== undefined &&
			(typeof outcome !== 'string' || !validOutcomes.includes(outcome))
		) {
			return new Response(
				JSON.stringify({
					success: false,
					error: 'INVALID_OUTCOME',
					message: 'outcome must be one of: win, loss, push',
				}),
				{
					status: 400,
					headers: { 'Content-Type': 'application/json' },
				},
			);
		}

		// Validate handCount if provided
		if (
			handCount !== undefined &&
			(typeof handCount !== 'number' ||
				!Number.isInteger(handCount) ||
				handCount < 1 ||
				handCount > MAX_HAND_COUNT)
		) {
			return new Response(
				JSON.stringify({
					success: false,
					error: 'INVALID_HAND_COUNT',
					message: `handCount must be an integer between 1 and ${MAX_HAND_COUNT}`,
				}),
				{
					status: 400,
					headers: { 'Content-Type': 'application/json' },
				},
			);
		}

		// Validate winsIncrement if provided (for split-hand tracking)
		if (
			winsIncrement !== undefined &&
			(typeof winsIncrement !== 'number' || !Number.isInteger(winsIncrement) || winsIncrement < 0)
		) {
			return new Response(
				JSON.stringify({
					success: false,
					error: 'INVALID_WINS_INCREMENT',
					message: 'winsIncrement must be a non-negative integer',
				}),
				{
					status: 400,
					headers: { 'Content-Type': 'application/json' },
				},
			);
		}

		// Validate lossesIncrement if provided (for split-hand tracking)
		if (
			lossesIncrement !== undefined &&
			(typeof lossesIncrement !== 'number' ||
				!Number.isInteger(lossesIncrement) ||
				lossesIncrement < 0)
		) {
			return new Response(
				JSON.stringify({
					success: false,
					error: 'INVALID_LOSSES_INCREMENT',
					message: 'lossesIncrement must be a non-negative integer',
				}),
				{
					status: 400,
					headers: { 'Content-Type': 'application/json' },
				},
			);
		}

		// Validate biggestWinCandidate if provided (for split-hand stats tracking)
		if (
			biggestWinCandidate !== undefined &&
			(typeof biggestWinCandidate !== 'number' ||
				!Number.isInteger(biggestWinCandidate) ||
				biggestWinCandidate < 0)
		) {
			return new Response(
				JSON.stringify({
					success: false,
					error: 'INVALID_BIGGEST_WIN_CANDIDATE',
					message: 'biggestWinCandidate must be a non-negative integer',
				}),
				{
					status: 400,
					headers: { 'Content-Type': 'application/json' },
				},
			);
		}

		// Validate statsDelta if provided (for games where balance delta differs from round result delta)
		// Default to delta if not provided (backwards compatibility)
		//
		// NOTE: statsDelta is only meaningful for games that batch multiple rounds into one sync
		// (craps). For all other games the balance delta IS the round delta, so we reject any
		// attempt to supply a separate statsDelta — this removes the attack vector where a caller
		// sends delta:-5, statsDelta:50000 to inflate leaderboards at near-zero chip cost.
		// (A full fix requires server-side game state; this is the best mitigation available
		// for a client-authoritative, play-money platform.)
		let validatedStatsDelta: number | undefined;
		if (statsDelta !== undefined) {
			if (!BATCHED_GAME_TYPES.has(gameType)) {
				return new Response(
					JSON.stringify({
						success: false,
						error: 'STATS_DELTA_NOT_ALLOWED',
						message: `statsDelta is not supported for ${gameType}`,
					}),
					{
						status: 400,
						headers: { 'Content-Type': 'application/json' },
					},
				);
			}
			if (
				typeof statsDelta !== 'number' ||
				!Number.isFinite(statsDelta) ||
				!Number.isInteger(statsDelta)
			) {
				return new Response(
					JSON.stringify({
						success: false,
						error: 'INVALID_STATS_DELTA',
						message: 'statsDelta must be a finite integer',
					}),
					{
						status: 400,
						headers: { 'Content-Type': 'application/json' },
					},
				);
			}
			validatedStatsDelta = statsDelta;
		}

		// Validate consistency between winsIncrement, lossesIncrement, and handCount
		if (winsIncrement !== undefined || lossesIncrement !== undefined) {
			if (handCount === undefined) {
				return new Response(
					JSON.stringify({
						success: false,
						error: 'INVALID_SPLIT_HAND_CONSISTENCY',
						message:
							'handCount must be provided when winsIncrement or lossesIncrement is specified',
					}),
					{
						status: 400,
						headers: { 'Content-Type': 'application/json' },
					},
				);
			}

			const totalDecidedHands =
				(typeof winsIncrement === 'number' ? winsIncrement : 0) +
				(typeof lossesIncrement === 'number' ? lossesIncrement : 0);

			if (totalDecidedHands > handCount) {
				return new Response(
					JSON.stringify({
						success: false,
						error: 'INVALID_SPLIT_HAND_CONSISTENCY',
						message: 'The sum of winsIncrement and lossesIncrement cannot exceed handCount',
					}),
					{
						status: 400,
						headers: { 'Content-Type': 'application/json' },
					},
				);
			}
		}

		// Determine limits based on game type
		// GAME_LIMITS membership check above guarantees gameType is a supported key.
		const limits = GAME_LIMITS[gameType as keyof typeof GAME_LIMITS];
		if (!limits) {
			return new Response(
				JSON.stringify({
					success: false,
					error: 'INVALID_GAME_TYPE',
					message: `No limits configured for game type: ${gameType}`,
				}),
				{
					status: 400,
					headers: { 'Content-Type': 'application/json' },
				},
			);
		}
		const { maxWin, maxLoss } = limits;

		// Asymmetric delta validation:
		// - Losses (negative delta) allowed up to maxLoss
		// - Wins (positive delta) capped at maxWin
		if (delta > 0 && delta > maxWin) {
			console.warn(
				`[CHIP_AUDIT] User ${redactUserId(userId)} attempted win of ${delta} in ${gameType}, capped at ${maxWin}`,
			);
			return new Response(
				JSON.stringify({
					success: false,
					error: 'DELTA_EXCEEDS_LIMIT',
					message: `Win amount exceeds maximum allowed for ${gameType} (${maxWin})`,
				}),
				{
					status: 400,
					headers: { 'Content-Type': 'application/json' },
				},
			);
		}

		if (delta < 0 && Math.abs(delta) > maxLoss) {
			return new Response(
				JSON.stringify({
					success: false,
					error: 'DELTA_EXCEEDS_LIMIT',
					message: `Loss amount exceeds maximum allowed for ${gameType} (${maxLoss})`,
				}),
				{
					status: 400,
					headers: { 'Content-Type': 'application/json' },
				},
			);
		}

		// Enforce per-game caps on statsDelta to prevent stats inflation within craps.
		// Non-craps games are already rejected above; these caps bound the craps residual
		// risk where delta and statsDelta can legitimately differ due to unsettled wagers.
		if (validatedStatsDelta !== undefined) {
			if (validatedStatsDelta > 0 && validatedStatsDelta > maxWin) {
				return new Response(
					JSON.stringify({
						success: false,
						error: 'STATS_DELTA_EXCEEDS_LIMIT',
						message: `Stats delta exceeds maximum win allowed for ${gameType} (${maxWin})`,
					}),
					{
						status: 400,
						headers: { 'Content-Type': 'application/json' },
					},
				);
			}
			if (validatedStatsDelta < 0 && Math.abs(validatedStatsDelta) > maxLoss) {
				return new Response(
					JSON.stringify({
						success: false,
						error: 'STATS_DELTA_EXCEEDS_LIMIT',
						message: `Stats delta exceeds maximum loss allowed for ${gameType} (${maxLoss})`,
					}),
					{
						status: 400,
						headers: { 'Content-Type': 'application/json' },
					},
				);
			}
		}

		// Validate previousBalance if provided (for optimistic locking)
		// Consolidated validation: must be defined, a number, finite, and integer
		if (
			clientPreviousBalance !== undefined &&
			(typeof clientPreviousBalance !== 'number' ||
				!Number.isFinite(clientPreviousBalance) ||
				!Number.isInteger(clientPreviousBalance))
		) {
			return new Response(
				JSON.stringify({
					success: false,
					error: 'INVALID_REQUEST_BODY',
					message: 'previousBalance must be a finite integer if provided',
				}),
				{
					status: 400,
					headers: { 'Content-Type': 'application/json' },
				},
			);
		}

		if (syncId !== undefined && !isValidSyncId(syncId)) {
			return new Response(
				JSON.stringify({
					success: false,
					error: 'INVALID_SYNC_ID',
					message: 'syncId must be a non-empty alphanumeric identifier',
				}),
				{
					status: 400,
					headers: { 'Content-Type': 'application/json' },
				},
			);
		}

		if (syncId !== undefined && clientPreviousBalance === undefined) {
			return new Response(
				JSON.stringify({
					success: false,
					error: 'INVALID_REQUEST_BODY',
					message: 'previousBalance is required when syncId is provided',
				}),
				{
					status: 400,
					headers: { 'Content-Type': 'application/json' },
				},
			);
		}

		// Check DB binding exists (may be undefined in local dev without Cloudflare bindings)
		const dbBinding = locals.runtime?.env?.DB ?? null;
		if (!dbBinding) {
			return new Response(
				JSON.stringify({
					success: false,
					error: 'DATABASE_UNAVAILABLE',
					message: 'Database is not configured',
				}),
				{
					status: 500,
					headers: { 'Content-Type': 'application/json' },
				},
			);
		}

		// Database operations wrapped in try-catch
		try {
			const db = createDbImpl(dbBinding);

			// Load authoritative server balance from DB. This also lets us repair any historical
			// fractional balances caused by older payout logic.
			const [currentRow] = await db
				.select({ chipBalance: user.chipBalance })
				.from(user)
				.where(eq(user.id, locals.user.id))
				.limit(1);

			// Explicitly detect missing row - this indicates a data integrity issue
			// that should not be silently ignored
			if (currentRow === undefined) {
				console.error(
					`[CHIPS UPDATE] No database row found for user ${redactUserId(userId)} - data integrity issue`,
				);
				return new Response(
					JSON.stringify({
						success: false,
						error: 'USER_NOT_FOUND',
						message: 'User record not found in database',
					}),
					{
						status: 500,
						headers: { 'Content-Type': 'application/json' },
					},
				);
			}

			const rawServerBalance = currentRow.chipBalance;
			const serverBalance = Number.isFinite(rawServerBalance) ? Math.trunc(rawServerBalance) : 0;
			const needsRepair = rawServerBalance !== serverBalance;
			const shouldRecordStats = outcome !== undefined && validOutcomes.includes(outcome as string);
			const resolvedHandCount = typeof handCount === 'number' ? handCount : 1;
			const actualWinsIncrement =
				typeof winsIncrement === 'number'
					? winsIncrement
					: shouldRecordStats && outcome === 'win'
						? 1
						: 0;
			const actualLossesIncrement =
				typeof lossesIncrement === 'number'
					? lossesIncrement
					: shouldRecordStats && outcome === 'loss'
						? 1
						: 0;
			const clampedBiggestWinCandidate =
				typeof biggestWinCandidate === 'number' ? Math.min(biggestWinCandidate, maxWin) : undefined;
			const statsDeltaForTracking = validatedStatsDelta ?? delta;
			const actualBiggestWinCandidate = shouldRecordStats
				? determineBiggestWinCandidate({
						delta: statsDeltaForTracking,
						biggestWinCandidate: clampedBiggestWinCandidate,
						winsIncrement: actualWinsIncrement,
						lossesIncrement: actualLossesIncrement,
						handCount: resolvedHandCount,
						gameType,
					})
				: null;
			const canonicalSyncPayload =
				syncId !== undefined
					? {
							syncId,
							gameType,
							previousBalance: clientPreviousBalance as number,
							delta,
							statsDelta: shouldRecordStats ? statsDeltaForTracking : null,
							outcome: shouldRecordStats ? outcome : null,
							handCount: shouldRecordStats ? resolvedHandCount : null,
							winsIncrement: shouldRecordStats ? actualWinsIncrement : null,
							lossesIncrement: shouldRecordStats ? actualLossesIncrement : null,
							biggestWinCandidate: shouldRecordStats ? (actualBiggestWinCandidate ?? null) : null,
						}
					: null;

			const buildSuccessResponse = (
				balance: number,
				previousBalance: number,
				responseDelta: number,
				newAchievements: Array<{ id: string; name: string; icon: string }>,
				warnings: string[],
			) =>
				new Response(
					JSON.stringify({
						success: true,
						balance,
						previousBalance,
						delta: responseDelta,
						message: 'Chip balance updated successfully',
						newAchievements: newAchievements.length > 0 ? newAchievements : undefined,
						warnings: warnings.length > 0 ? warnings : undefined,
					}),
					{
						status: 200,
						headers: { 'Content-Type': 'application/json' },
					},
				);

			const resolveAchievementResponse = async ({
				balance,
				resolvedGameType,
				recentWinAmount,
				overallRank,
			}: {
				balance: number;
				resolvedGameType: string | null;
				recentWinAmount: number | undefined;
				overallRank?: number | null;
			}) => {
				const newAchievements: Array<{ id: string; name: string; icon: string }> = [];
				const warnings: string[] = [];

				if (!resolvedGameType || !isValidGameType(resolvedGameType)) {
					return { newAchievements, warnings };
				}

				try {
					const earnedAchievements = await checkAndGrantAchievementsImpl(db, userId, balance, {
						recentWinAmount,
						gameType: resolvedGameType as GameType,
						overallRank,
					});

					newAchievements.push(
						...earnedAchievements.map((achievement) => ({
							id: achievement.id,
							name: achievement.name,
							icon: achievement.icon,
						})),
					);

					if (newAchievements.length > 0) {
						console.warn(
							`[ACHIEVEMENT] User ${redactUserId(userId)} earned: ${newAchievements.map((achievement) => achievement.name).join(', ')}`,
						);
					}
				} catch (statsError) {
					console.error(
						'[STATS_ERROR] Failed to record game stats or check achievements:',
						statsError,
					);
					warnings.push('Stats tracking failed');
				}

				return { newAchievements, warnings };
			};

			if (canonicalSyncPayload !== null) {
				const existingReceipt = await readChipSyncReceipt(
					dbBinding,
					userId,
					canonicalSyncPayload.syncId,
				);

				if (existingReceipt !== null) {
					if (!doesChipSyncReceiptMatch(existingReceipt, canonicalSyncPayload)) {
						return new Response(
							JSON.stringify({
								success: false,
								error: 'SYNC_ID_REUSE_MISMATCH',
								message: 'syncId has already been used for a different chip sync payload',
							}),
							{
								status: 409,
								headers: { 'Content-Type': 'application/json' },
							},
						);
					}

					const persistedAchievementPayload = parseChipSyncAchievementPayload(
						existingReceipt.achievementPayload,
					);

					if (persistedAchievementPayload !== null) {
						return buildSuccessResponse(
							existingReceipt.balance,
							existingReceipt.previousBalance,
							existingReceipt.delta,
							persistedAchievementPayload.newAchievements,
							persistedAchievementPayload.warnings,
						);
					}

					const achievementResolution = await resolveAchievementResponse({
						balance: existingReceipt.balance,
						resolvedGameType: existingReceipt.outcome ? existingReceipt.gameType : null,
						recentWinAmount: resolveAchievementRecentWinAmount(
							existingReceipt.gameType,
							existingReceipt.outcome,
							existingReceipt.biggestWinCandidate,
							existingReceipt.statsDelta ?? existingReceipt.delta,
						),
						overallRank: existingReceipt.overallRank,
					});

					const recomputedPayload: ChipSyncAchievementPayload = {
						newAchievements: achievementResolution.newAchievements,
						warnings: [...achievementResolution.warnings],
					};

					try {
						await updateChipSyncAchievementPayload(
							dbBinding,
							userId,
							existingReceipt.syncId,
							recomputedPayload,
						);
					} catch (receiptPayloadError) {
						console.error(
							'[CHIP_SYNC_RECEIPT] Failed to persist recomputed achievement payload on replay:',
							receiptPayloadError,
						);
					}

					return buildSuccessResponse(
						existingReceipt.balance,
						existingReceipt.previousBalance,
						existingReceipt.delta,
						achievementResolution.newAchievements,
						achievementResolution.warnings,
					);
				}
			}

			const lastUpdate = lastUpdateByUserImpl.get(userId) ?? 0;
			if (now - lastUpdate < MIN_UPDATE_INTERVAL_MS) {
				const waitTime = Math.ceil((MIN_UPDATE_INTERVAL_MS - (now - lastUpdate)) / 1000);
				return new Response(
					JSON.stringify({
						success: false,
						error: 'RATE_LIMITED',
						message: `Please wait ${waitTime} second(s) before updating chips again`,
					}),
					{
						status: 429,
						headers: {
							'Content-Type': 'application/json',
							'Retry-After': String(waitTime),
						},
					},
				);
			}

			// Optimistic locking: reject if client's previousBalance doesn't match server
			if (clientPreviousBalance !== undefined) {
				if (clientPreviousBalance !== serverBalance) {
					return new Response(
						JSON.stringify({
							success: false,
							error: 'BALANCE_MISMATCH',
							message: 'Balance has changed. Please refresh and try again.',
							currentBalance: serverBalance,
						}),
						{
							status: 409,
							headers: { 'Content-Type': 'application/json' },
						},
					);
				}
			}

			// Cross-validate statsDelta against the authoritative server balance.
			// For craps, delta = pendingWagerDelta + statsDelta. A player cannot place more in
			// wagers than their current balance, so pendingWagerDelta >= -serverBalance, which
			// means statsDelta - delta <= serverBalance. Enforcing this prevents inflating
			// leaderboard stats with a statsDelta that implies impossible wager placements.
			if (validatedStatsDelta !== undefined && validatedStatsDelta - delta > serverBalance) {
				return new Response(
					JSON.stringify({
						success: false,
						error: 'STATS_DELTA_WAGER_INCONSISTENCY',
						message: 'statsDelta implies wager amount exceeding previous balance',
					}),
					{
						status: 400,
						headers: { 'Content-Type': 'application/json' },
					},
				);
			}

			// Compute new balance server-side
			const newBalance = serverBalance + delta;

			// Validate computed balance is non-negative
			if (newBalance < 0) {
				return new Response(
					JSON.stringify({
						success: false,
						error: 'INSUFFICIENT_BALANCE',
						message: 'Insufficient chip balance for this operation',
						currentBalance: serverBalance,
					}),
					{
						status: 400,
						headers: { 'Content-Type': 'application/json' },
					},
				);
			}

			let persistedReceipt: ChipSyncReceiptRecord | null = null;

			if (canonicalSyncPayload !== null) {
				const rowsAffected = await applyChipSyncBatch(dbBinding, {
					userId,
					gameType,
					syncId: canonicalSyncPayload.syncId,
					previousBalance: canonicalSyncPayload.previousBalance,
					newBalance,
					delta,
					matchedBalanceValue: needsRepair ? rawServerBalance : serverBalance,
					statsDelta: canonicalSyncPayload.statsDelta,
					outcome: canonicalSyncPayload.outcome,
					handCount: canonicalSyncPayload.handCount,
					winsIncrement: canonicalSyncPayload.winsIncrement,
					lossesIncrement: canonicalSyncPayload.lossesIncrement,
					biggestWinCandidate: canonicalSyncPayload.biggestWinCandidate,
					updatedAtUnixSeconds: Math.trunc(now / 1000),
					shouldRecordStats,
				});

				if (rowsAffected === 0) {
					const replayReceipt = await readChipSyncReceipt(
						dbBinding,
						userId,
						canonicalSyncPayload.syncId,
					);

					if (replayReceipt !== null) {
						if (!doesChipSyncReceiptMatch(replayReceipt, canonicalSyncPayload)) {
							return new Response(
								JSON.stringify({
									success: false,
									error: 'SYNC_ID_REUSE_MISMATCH',
									message: 'syncId has already been used for a different chip sync payload',
								}),
								{
									status: 409,
									headers: { 'Content-Type': 'application/json' },
								},
							);
						}

						const persistedAchievementPayload = parseChipSyncAchievementPayload(
							replayReceipt.achievementPayload,
						);

						if (persistedAchievementPayload !== null) {
							return buildSuccessResponse(
								replayReceipt.balance,
								replayReceipt.previousBalance,
								replayReceipt.delta,
								persistedAchievementPayload.newAchievements,
								persistedAchievementPayload.warnings,
							);
						}

						const achievementResolution = await resolveAchievementResponse({
							balance: replayReceipt.balance,
							resolvedGameType: replayReceipt.outcome ? replayReceipt.gameType : null,
							recentWinAmount: resolveAchievementRecentWinAmount(
								replayReceipt.gameType,
								replayReceipt.outcome,
								replayReceipt.biggestWinCandidate,
								replayReceipt.statsDelta ?? replayReceipt.delta,
							),
							overallRank: replayReceipt.overallRank,
						});

						const recomputedPayload: ChipSyncAchievementPayload = {
							newAchievements: achievementResolution.newAchievements,
							warnings: [...achievementResolution.warnings],
						};

						try {
							await updateChipSyncAchievementPayload(
								dbBinding,
								userId,
								replayReceipt.syncId,
								recomputedPayload,
							);
						} catch (receiptPayloadError) {
							console.error(
								'[CHIP_SYNC_RECEIPT] Failed to persist recomputed achievement payload on raced replay:',
								receiptPayloadError,
							);
						}

						return buildSuccessResponse(
							replayReceipt.balance,
							replayReceipt.previousBalance,
							replayReceipt.delta,
							achievementResolution.newAchievements,
							achievementResolution.warnings,
						);
					}

					const [latestRow] = await db
						.select({ chipBalance: user.chipBalance })
						.from(user)
						.where(eq(user.id, locals.user.id))
						.limit(1);
					const latestBalanceRaw = latestRow?.chipBalance;
					const latestBalance =
						typeof latestBalanceRaw === 'number' && Number.isFinite(latestBalanceRaw)
							? Math.trunc(latestBalanceRaw)
							: serverBalance;

					return new Response(
						JSON.stringify({
							success: false,
							error: 'BALANCE_MISMATCH',
							message: 'Balance was modified concurrently. Please refresh and try again.',
							currentBalance: latestBalance,
						}),
						{
							status: 409,
							headers: { 'Content-Type': 'application/json' },
						},
					);
				}

				persistedReceipt = await readChipSyncReceipt(
					dbBinding,
					userId,
					canonicalSyncPayload.syncId,
				);
			} else {
				const result = await db
					.update(user)
					.set({
						chipBalance: newBalance,
					})
					.where(
						and(
							eq(user.id, locals.user.id),
							eq(user.chipBalance, needsRepair ? rawServerBalance : serverBalance),
						),
					);

				const rowsAffected = getRowsAffected(result);
				if (rowsAffected === 0) {
					const [latestRow] = await db
						.select({ chipBalance: user.chipBalance })
						.from(user)
						.where(eq(user.id, locals.user.id))
						.limit(1);
					const latestBalanceRaw = latestRow?.chipBalance;
					const latestBalance =
						typeof latestBalanceRaw === 'number' && Number.isFinite(latestBalanceRaw)
							? Math.trunc(latestBalanceRaw)
							: serverBalance;

					return new Response(
						JSON.stringify({
							success: false,
							error: 'BALANCE_MISMATCH',
							message: 'Balance was modified concurrently. Please refresh and try again.',
							currentBalance: latestBalance,
						}),
						{
							status: 409,
							headers: { 'Content-Type': 'application/json' },
						},
					);
				}
			}

			lastUpdateByUserImpl.set(userId, now);

			// Audit log for wins (positive deltas) to help detect exploitation patterns
			if (delta > 0) {
				console.warn(
					`[CHIP_AUDIT] User ${redactUserId(userId)} won ${delta} chips: ${serverBalance} -> ${newBalance}`,
				);
			}

			// Track game stats and check achievements (awaited - blocks response)
			// This runs after the chip update succeeds and is awaited to return achievements in the response
			let newAchievements: Array<{ id: string; name: string; icon: string }> = [];
			const warnings: string[] = [];

			if (canonicalSyncPayload !== null) {
				const achievementReceipt = persistedReceipt;
				const achievementResolution = await resolveAchievementResponse({
					balance: achievementReceipt?.balance ?? newBalance,
					resolvedGameType:
						(achievementReceipt?.outcome ?? canonicalSyncPayload.outcome)
							? (achievementReceipt?.gameType ?? canonicalSyncPayload.gameType)
							: null,
					recentWinAmount: resolveAchievementRecentWinAmount(
						achievementReceipt?.gameType ?? canonicalSyncPayload.gameType,
						achievementReceipt?.outcome ?? canonicalSyncPayload.outcome,
						achievementReceipt?.biggestWinCandidate ?? canonicalSyncPayload.biggestWinCandidate,
						achievementReceipt?.statsDelta ??
							canonicalSyncPayload.statsDelta ??
							canonicalSyncPayload.delta,
					),
					overallRank: achievementReceipt?.overallRank,
				});
				newAchievements = achievementResolution.newAchievements;
				warnings.push(...achievementResolution.warnings);

				const persistedAchievementPayload: ChipSyncAchievementPayload = {
					newAchievements,
					warnings: [...warnings],
				};

				if (achievementReceipt !== null) {
					achievementReceipt.achievementPayload = serializeChipSyncAchievementPayload(
						persistedAchievementPayload,
					);
				}

				try {
					await updateChipSyncAchievementPayload(
						dbBinding,
						userId,
						canonicalSyncPayload.syncId,
						persistedAchievementPayload,
					);
				} catch (receiptPayloadError) {
					console.error(
						'[CHIP_SYNC_RECEIPT] Failed to persist achievement payload:',
						receiptPayloadError,
					);
				}
			} else if (outcome && validOutcomes.includes(outcome as string)) {
				try {
					// Record game stats (only for games with stats tracking enabled)
					// Poker is accepted for chip updates but excluded from stats until
					// round-stat payloads are wired for poker rounds
					if (isValidGameType(gameType)) {
						await recordGameRoundImpl(db, userId, {
							gameType: gameType as GameType,
							outcome: outcome as GameRoundOutcome,
							chipDelta: statsDeltaForTracking,
							handCount: resolvedHandCount,
							// Use provided winsIncrement/lossesIncrement for split-hand accuracy
							winsIncrement: actualWinsIncrement,
							lossesIncrement: actualLossesIncrement,
							// Use calculated biggestWinCandidate based on round type
							biggestWinCandidate: actualBiggestWinCandidate,
						});
					}

					// Check for newly earned achievements
					// Pass post-update balance (newBalance) and delta; comeback achievement
					// calculates pre-win balance internally as (currentChipBalance - recentWinAmount)
					const earnedAchievements = isValidGameType(gameType)
						? await checkAndGrantAchievementsImpl(db, userId, newBalance, {
								recentWinAmount: resolveAchievementRecentWinAmount(
									gameType,
									outcome as string,
									actualBiggestWinCandidate,
									statsDeltaForTracking,
								),
								gameType: gameType as GameType,
							})
						: [];

					// Map to simple objects for response
					newAchievements = earnedAchievements.map((a) => ({
						id: a.id,
						name: a.name,
						icon: a.icon,
					}));

					if (newAchievements.length > 0) {
						console.warn(
							`[ACHIEVEMENT] User ${redactUserId(userId)} earned: ${newAchievements.map((a) => a.name).join(', ')}`,
						);
					}
				} catch (statsError) {
					// Log detailed error server-side but send generic message to client
					console.error(
						'[STATS_ERROR] Failed to record game stats or check achievements:',
						statsError,
					);
					warnings.push('Stats tracking failed');
				}
			}

			return buildSuccessResponse(newBalance, serverBalance, delta, newAchievements, warnings);
		} catch (error) {
			console.error('Chip balance update error:', error);
			return new Response(
				JSON.stringify({
					success: false,
					error: 'DATABASE_ERROR',
					message: 'Failed to update chip balance. Please try again.',
				}),
				{
					status: 500,
					headers: { 'Content-Type': 'application/json' },
				},
			);
		}
	};
}

export const POST: APIRoute = createPostHandler();
