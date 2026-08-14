-- HPA-553 cutover: delete the legacy Ranked/Daily Challenge stacks.
-- Step 1: refund committed wagers from still-active legacy ranked sessions
-- before their table is dropped (the active-owner unique constraint means
-- at most one active legacy ranked session per user). No session/result/
-- history rows are copied into Blackjack Run.
UPDATE user
SET chipBalance = chipBalance + (
  SELECT ranked_session.committedWager
  FROM ranked_session
  WHERE ranked_session.userId = user.id
    AND ranked_session.status = 'active'
  LIMIT 1
),
updatedAt = unixepoch()
WHERE EXISTS (
  SELECT 1
  FROM ranked_session
  WHERE ranked_session.userId = user.id
    AND ranked_session.status = 'active'
);
--> statement-breakpoint
-- Step 2: drop the legacy Ranked/Daily tables (their indexes drop with them).
DROP TABLE `ranked_session`;--> statement-breakpoint
DROP TABLE `ranked_result`;--> statement-breakpoint
DROP TABLE `ranked_game_stats`;--> statement-breakpoint
DROP TABLE `ranked_reward_grant`;--> statement-breakpoint
DROP TABLE `ranked_rate_limit`;--> statement-breakpoint
DROP TABLE `daily_challenge`;--> statement-breakpoint
DROP TABLE `daily_challenge_attempt`;--> statement-breakpoint
DROP TABLE `daily_challenge_result`;
