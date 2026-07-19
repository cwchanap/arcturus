/**
 * D1 batch SQL shared by the chip-sync cascade paths.
 *
 * Both the roulette spin endpoint (`src/pages/api/roulette/spin.ts`) and the
 * generic chip-sync endpoint (`src/pages/api/chips/update.ts`) write a
 * `chip_sync_receipt` row and (optionally) upsert `game_stats` as part of an
 * optimistic-lock cascade gated on `WHERE changes() = 1`. Extracting these
 * statements here keeps the two callers from silently diverging on the
 * receipt schema or the stats upsert CASE expression — both are chip-safety-
 * critical (the receipt is the idempotency tombstone; the stats row feeds
 * leaderboard/achievement queries).
 *
 * Column order for the receipt INSERT is `... overallRank, achievementPayload,
 * createdAt` — achievement before timestamp. Callers must bind params in this
 * order.
 *
 * Statement order within a cascade:
 *   1. UPDATE user (optimistic lock on chipBalance) — caller-specific, NOT shared
 *   2. (roulette only) INSERT roulette_round … WHERE changes() = 1
 *   3. INSERT chip_sync_receipt … WHERE changes() = 1
 *   4. INSERT game_stats … WHERE changes() = 1 (optional)
 *
 * Statements 3–4 only run when the optimistic-lock UPDATE matched a row.
 */
export const CHIP_SYNC_RECEIPT_INSERT_SQL =
	'INSERT INTO chip_sync_receipt (userId, syncId, gameType, previousBalance, balance, delta, statsDelta, outcome, handCount, winsIncrement, lossesIncrement, biggestWinCandidate, overallRank, achievementPayload, createdAt) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT COUNT(*) + 1 FROM user leaderboard_user WHERE leaderboard_user.chipBalance > ? OR (leaderboard_user.chipBalance = ? AND leaderboard_user.id < ?)), ?, ? WHERE changes() = 1';

export const CHIP_SYNC_STATS_UPSERT_SQL =
	'INSERT INTO game_stats (userId, gameType, totalWins, totalLosses, handsPlayed, biggestWin, netProfit, updatedAt) SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE changes() = 1 ON CONFLICT(userId, gameType) DO UPDATE SET totalWins = game_stats.totalWins + excluded.totalWins, totalLosses = game_stats.totalLosses + excluded.totalLosses, handsPlayed = game_stats.handsPlayed + excluded.handsPlayed, biggestWin = CASE WHEN ? IS NULL THEN game_stats.biggestWin WHEN ? > 0 AND ? > game_stats.biggestWin THEN ? ELSE game_stats.biggestWin END, netProfit = game_stats.netProfit + excluded.netProfit, updatedAt = excluded.updatedAt';

/** Cascade inserts must gate on the optimistic-lock UPDATE succeeding. */
export function isChipSyncCascadeGatedSql(sql: string): boolean {
	return sql.includes('WHERE changes() = 1');
}
