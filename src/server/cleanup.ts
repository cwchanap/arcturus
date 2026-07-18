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
}
