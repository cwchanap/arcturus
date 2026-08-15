-- HPA-553 review follow-up: serve the Daily leaderboard query from an index
-- instead of a full blackjack_run scan. Matches the leaderboard filter
-- (mode, periodKey, status='completed') and the leading sort keys
-- (dailyEndingBankroll, dailyRoundsCompleted); settledAt/userId remain the
-- in-scan tie-breakers. 0018 is already applied, so this ships as a new
-- additive migration.
CREATE INDEX `blackjack_run_daily_leaderboard_idx` ON `blackjack_run` (`mode`,`periodKey`,`status`,`dailyEndingBankroll`,`dailyRoundsCompleted`);
