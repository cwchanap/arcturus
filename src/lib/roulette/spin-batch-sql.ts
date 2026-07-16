/**
 * D1 batch SQL for the roulette spin optimistic-lock cascade.
 *
 * Shared by the production endpoint and tests so mocks cannot silently
 * diverge from the real statements (especially the `WHERE changes() = 1`
 * gates on cascade inserts).
 *
 * Statement order:
 *   1. UPDATE user (optimistic lock on chipBalance)
 *   2. INSERT roulette_round … WHERE changes() = 1
 *   3. INSERT chip_sync_receipt … WHERE changes() = 1
 *   4. INSERT game_stats … WHERE changes() = 1 (optional)
 *
 * Statements 2–4 only run when statement 1 matched a row (`changes() = 1`).
 */
export const SPIN_UPDATE_USER_SQL =
	'UPDATE user SET chipBalance = ?, updatedAt = ? WHERE id = ? AND chipBalance = ? AND heldChips = 0';

export const SPIN_INSERT_ROUND_SQL =
	'INSERT INTO roulette_round (syncId, userId, winningNumber, betsJson, totalBet, totalPayout, netDelta, previousBalance, newBalance, createdAt) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE changes() = 1';

export const SPIN_INSERT_RECEIPT_SQL =
	'INSERT INTO chip_sync_receipt (userId, syncId, gameType, previousBalance, balance, delta, statsDelta, outcome, handCount, winsIncrement, lossesIncrement, biggestWinCandidate, overallRank, achievementPayload, createdAt) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT COUNT(*) + 1 FROM user leaderboard_user WHERE leaderboard_user.chipBalance > ? OR (leaderboard_user.chipBalance = ? AND leaderboard_user.id < ?)), ?, ? WHERE changes() = 1';

export const SPIN_UPSERT_STATS_SQL =
	'INSERT INTO game_stats (userId, gameType, totalWins, totalLosses, handsPlayed, biggestWin, netProfit, updatedAt) SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE changes() = 1 ON CONFLICT(userId, gameType) DO UPDATE SET totalWins = game_stats.totalWins + excluded.totalWins, totalLosses = game_stats.totalLosses + excluded.totalLosses, handsPlayed = game_stats.handsPlayed + excluded.handsPlayed, biggestWin = CASE WHEN ? IS NULL THEN game_stats.biggestWin WHEN ? > 0 AND ? > game_stats.biggestWin THEN ? ELSE game_stats.biggestWin END, netProfit = game_stats.netProfit + excluded.netProfit, updatedAt = excluded.updatedAt';

/** Cascade inserts must gate on the optimistic-lock UPDATE succeeding. */
export function isSpinCascadeGatedSql(sql: string): boolean {
	return sql.includes('WHERE changes() = 1');
}
