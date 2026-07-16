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

export const RETENTION_DAYS = 30;
const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;

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
		// settling the hand. Roulette (7d client TTL) and single-player
		// poker (MAX_RETRIES=3) have bounded retry lifecycles, so their
		// receipts remain safe to reap at RETENTION_DAYS.
		await dbBinding
			.prepare('DELETE FROM chip_sync_receipt WHERE createdAt < ? AND gameType != ?')
			.bind(retentionCutoff, 'poker_mp')
			.run();
	} catch (error) {
		console.warn('[CLEANUP] Failed to delete expired chip_sync_receipt rows:', error);
	}
}
