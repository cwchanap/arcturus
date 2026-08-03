/**
 * Global retention cleanup for D1 tables that grow without bound.
 *
 * Previously this ran inline on spin/chip-sync requests (amortized once
 * per hour per isolate, per-user). That left one-off users' expired rows
 * uncleaned forever. Moving to a Cron Trigger ensures ALL expired rows
 * across ALL users are cleaned on a schedule, independent of user traffic.
 *
 * Called from the Worker's `scheduled()` handler (see src/worker.ts and
 * wrangler.toml `[triggers]` crons).
 */

import { getDailyPeriodKey } from '../lib/missions/periods';

export const RETENTION_DAYS = 30;
const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;

/**
 * Daily period keys use the `YYYY-MM-DD` format (10 chars, hyphen-separated
 * numeric). Weekly keys use `YYYY-Www` (8 chars, contains a `W`). This
 * predicate lets cleanup target only daily rows explicitly, so weekly rows
 * are never affected by daily retention — regardless of lexicographic
 * ordering or year boundaries.
 */
export function isDailyPeriodKey(key: string): boolean {
	return /^\d{4}-\d{2}-\d{2}$/.test(key);
}

// Roulette receipts serve as idempotency tombstones after roulette_round
// rows are reaped at RETENTION_DAYS. They must outlive the round rows so
// a replay of an old committed syncId (after the round is gone) is still
// rejected instead of being treated as a fresh spin. But they must not
// live forever — every successful spin inserts one, so permanent retention
// grows the shared D1 receipt table without bound. A window longer than
// the round retention (30d) bounds the tombstone while preserving replay
// protection for 60 days past round reaping.
export const ROULETTE_RECEIPT_RETENTION_DAYS = 90;
const ROULETTE_RECEIPT_RETENTION_MS = ROULETTE_RECEIPT_RETENTION_DAYS * 24 * 60 * 60 * 1000;

export interface ScheduledJobEnv {
	[key: string]: unknown;
	DB?: D1Database;
	arcturus?: DurableObjectNamespace;
}

export interface ScheduledJobDeps {
	rankedExpiration(
		db: D1Database,
		namespace: DurableObjectNamespace | undefined,
		nowSeconds: number,
	): Promise<void>;
	rankedRateCleanup(db: D1Database, nowSeconds: number): Promise<void>;
	retentionCleanup(db: D1Database): Promise<void>;
	dailyChallengeExpiration(db: D1Database, nowSeconds: number): Promise<void>;
	dailyChallengeRetention(db: D1Database, nowSeconds: number): Promise<void>;
	nowSeconds(): number;
	warn(message: string, error?: unknown): void;
}

/**
 * Run each scheduled database job behind its own error boundary. Ranked
 * history is deliberately absent: HPA-170 keeps sessions and results as
 * replayable audit material. Daily Challenge expiration flips active-but-
 * expired attempts to terminal; retention then reaps terminal attempt rows
 * older than 90 days (results and challenges are preserved).
 */
export async function runScheduledJobs(
	env: ScheduledJobEnv,
	deps: ScheduledJobDeps,
): Promise<void> {
	const db = env.DB;
	if (!db) {
		deps.warn('[SCHEDULED] DB binding unavailable, skipping cleanup');
		return;
	}

	try {
		await deps.rankedExpiration(db, env.arcturus, deps.nowSeconds());
	} catch (error) {
		deps.warn('[SCHEDULED] Ranked expiration failed', error);
	}
	try {
		await deps.rankedRateCleanup(db, deps.nowSeconds());
	} catch (error) {
		deps.warn('[SCHEDULED] Ranked rate-limit cleanup failed', error);
	}
	try {
		await deps.retentionCleanup(db);
	} catch (error) {
		deps.warn('[SCHEDULED] Retention cleanup failed', error);
	}
	try {
		await deps.dailyChallengeExpiration(db, deps.nowSeconds());
	} catch (error) {
		deps.warn('[SCHEDULED] Daily Challenge expiration failed', error);
	}
	try {
		await deps.dailyChallengeRetention(db, deps.nowSeconds());
	} catch (error) {
		deps.warn('[SCHEDULED] Daily Challenge retention failed', error);
	}
}

/**
 * Delete rows older than RETENTION_DAYS from roulette_round and
 * chip_sync_receipt. Uses the createdAt indexes for efficiency.
 * Failures are logged and swallowed — cleanup is best-effort and must
 * not crash the scheduled handler.
 */
export async function runRetentionCleanup(dbBinding: D1Database): Promise<void> {
	const retentionCutoff = Math.trunc((Date.now() - RETENTION_MS) / 1000);
	try {
		await dbBinding
			.prepare('DELETE FROM roulette_round WHERE createdAt < ?')
			.bind(retentionCutoff)
			.run();
	} catch (error) {
		console.warn('[CLEANUP] Failed to delete expired roulette_round rows:', error);
	}
	try {
		// Exclude poker_mp receipts: multiplayer settlement retries
		// /api/mp/settle indefinitely (every 30s while the room is frozen)
		// using chip_sync_receipt as its idempotency record. Deleting a
		// settled hand's receipt while the DO can still retry would let a
		// late retry re-apply the delta (heldChips is already 0), double-
		// settling the hand. Roulette receipts are also excluded from this
		// 30-day pass: the spin endpoint uses them as idempotency
		// tombstones when roulette_round rows have been reaped (see
		// spin.ts). Without the receipt, a replay of an old committed
		// syncId after cleanup would be treated as a fresh spin and
		// double-settle. Roulette receipts are reaped on their own longer
		// schedule below (ROULETTE_RECEIPT_RETENTION_DAYS) so the
		// tombstone still outlives the round rows without growing
		// forever. Single-player poker (MAX_RETRIES=3) has a bounded
		// retry lifecycle, so its receipts remain safe to reap at
		// RETENTION_DAYS.
		await dbBinding
			.prepare('DELETE FROM chip_sync_receipt WHERE createdAt < ? AND gameType NOT IN (?, ?)')
			.bind(retentionCutoff, 'poker_mp', 'roulette')
			.run();
	} catch (error) {
		console.warn('[CLEANUP] Failed to delete expired chip_sync_receipt rows:', error);
	}
	try {
		// Bounded tombstone reaping for roulette receipts. See
		// ROULETTE_RECEIPT_RETENTION_DAYS above for the window rationale.
		const rouletteReceiptCutoff = Math.trunc((Date.now() - ROULETTE_RECEIPT_RETENTION_MS) / 1000);
		await dbBinding
			.prepare('DELETE FROM chip_sync_receipt WHERE createdAt < ? AND gameType = ?')
			.bind(rouletteReceiptCutoff, 'roulette')
			.run();
	} catch (error) {
		console.warn('[CLEANUP] Failed to delete expired roulette chip_sync_receipt rows:', error);
	}

	// Mission board row retention. mission_progress and mission_override are
	// partitioned by period key: daily keys use `YYYY-MM-DD`, weekly keys
	// use `YYYY-Www`. Only daily rows are reaped here — weekly rows are NOT
	// reaped by this pass and accumulate indefinitely (~52 rows/user/year for
	// each weekly mission). That growth rate is low enough to be acceptable
	// for now, but weekly retention is not handled here. The
	// `isDailyPeriodKey` predicate (encoded in SQL as `periodKey LIKE
	// '____-__-__'`) explicitly targets only daily-format keys, so weekly
	// rows are unaffected regardless of lexicographic ordering or year
	// boundaries. At ~6 rows/user/day the daily tables would otherwise grow
	// ~1,850 rows/user/year, so reap any daily period key older than
	// RETENTION_DAYS. Compare on periodKey rather than completedAt so
	// uncompleted/abandoned rows also get reaped.
	const missionCutoffDate = new Date();
	missionCutoffDate.setUTCDate(missionCutoffDate.getUTCDate() - RETENTION_DAYS);
	const missionCutoffKey = getDailyPeriodKey(missionCutoffDate);
	try {
		await dbBinding
			.prepare("DELETE FROM mission_progress WHERE periodKey < ? AND periodKey LIKE '____-__-__'")
			.bind(missionCutoffKey)
			.run();
	} catch (error) {
		console.warn('[CLEANUP] Failed to delete expired mission_progress rows:', error);
	}
	try {
		await dbBinding
			.prepare("DELETE FROM mission_override WHERE periodKey < ? AND periodKey LIKE '____-__-__'")
			.bind(missionCutoffKey)
			.run();
	} catch (error) {
		console.warn('[CLEANUP] Failed to delete expired mission_override rows:', error);
	}
	try {
		await dbBinding
			.prepare("DELETE FROM mission_game_tried WHERE periodKey < ? AND periodKey LIKE '____-__-__'")
			.bind(missionCutoffKey)
			.run();
	} catch (error) {
		console.warn('[CLEANUP] Failed to delete expired mission_game_tried rows:', error);
	}
}
