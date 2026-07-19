/**
 * D1 batch SQL for the roulette spin optimistic-lock cascade.
 *
 * Shared by the production endpoint and tests so mocks cannot silently
 * diverge from the real statements (especially the `WHERE changes() = 1`
 * gates on cascade inserts).
 *
 * The receipt INSERT and stats upsert statements are shared with the generic
 * chip-sync endpoint (`src/pages/api/chips/update.ts`) via
 * `src/lib/chip-sync-batch-sql.ts` so the two cascade paths cannot drift on
 * the receipt schema or the stats CASE expression.
 *
 * Statement order:
 *   1. UPDATE user (optimistic lock on chipBalance)
 *   2. INSERT roulette_round … WHERE changes() = 1
 *   3. INSERT chip_sync_receipt … WHERE changes() = 1
 *   4. INSERT game_stats … WHERE changes() = 1 (optional)
 *
 * Statements 2–4 only run when statement 1 matched a row (`changes() = 1`).
 */
import {
	CHIP_SYNC_RECEIPT_INSERT_SQL,
	CHIP_SYNC_STATS_UPSERT_SQL,
	isChipSyncCascadeGatedSql,
} from '../chip-sync-batch-sql';

export const SPIN_UPDATE_USER_SQL =
	'UPDATE user SET chipBalance = ?, updatedAt = ? WHERE id = ? AND chipBalance = ? AND heldChips = 0';

export const SPIN_INSERT_ROUND_SQL =
	'INSERT INTO roulette_round (syncId, userId, winningNumber, betsJson, totalBet, totalPayout, netDelta, previousBalance, newBalance, createdAt) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE changes() = 1';

// Re-exported from the shared chip-sync module so the roulette cascade and
// the generic chip-sync cascade use identical SQL for the receipt INSERT and
// stats upsert. Kept under the SPIN_* names for backward compatibility with
// existing imports in spin.ts and the spin tests.
export const SPIN_INSERT_RECEIPT_SQL = CHIP_SYNC_RECEIPT_INSERT_SQL;

export const SPIN_UPSERT_STATS_SQL = CHIP_SYNC_STATS_UPSERT_SQL;

/** Cascade inserts must gate on the optimistic-lock UPDATE succeeding. */
export function isSpinCascadeGatedSql(sql: string): boolean {
	return isChipSyncCascadeGatedSql(sql);
}
