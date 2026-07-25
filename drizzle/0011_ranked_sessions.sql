CREATE TABLE `ranked_game_stats` (
	`userId` text NOT NULL,
	`gameType` text NOT NULL,
	`sessionsPlayed` integer DEFAULT 0 NOT NULL,
	`totalWins` integer DEFAULT 0 NOT NULL,
	`totalLosses` integer DEFAULT 0 NOT NULL,
	`totalPushes` integer DEFAULT 0 NOT NULL,
	`totalForfeits` integer DEFAULT 0 NOT NULL,
	`netProfit` integer DEFAULT 0 NOT NULL,
	`biggestWin` integer DEFAULT 0 NOT NULL,
	`updatedAt` integer NOT NULL,
	PRIMARY KEY(`userId`, `gameType`),
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `ranked_rate_limit` (
	`userId` text NOT NULL,
	`operation` text NOT NULL,
	`windowStart` integer NOT NULL,
	`count` integer NOT NULL,
	`expiresAt` integer NOT NULL,
	PRIMARY KEY(`userId`, `operation`, `windowStart`),
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ranked_rate_limit_expiry_idx` ON `ranked_rate_limit` (`expiresAt`);
--> statement-breakpoint
CREATE TABLE `ranked_result` (
	`sessionId` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`gameType` text NOT NULL,
	`rulesetVersion` text NOT NULL,
	`seedCommitment` text NOT NULL,
	`configHash` text NOT NULL,
	`actionLogHash` text NOT NULL,
	`outcomeJson` text NOT NULL,
	`initialWager` integer NOT NULL,
	`committedWager` integer NOT NULL,
	`payout` integer NOT NULL,
	`gameNetDelta` integer NOT NULL,
	`rewardDelta` integer NOT NULL,
	`balanceAfter` integer NOT NULL,
	`statsEffectsJson` text NOT NULL,
	`achievementEffectsJson` text NOT NULL,
	`rewardEffectsJson` text NOT NULL,
	`receiptHash` text NOT NULL,
	`settledAt` integer NOT NULL,
	FOREIGN KEY (`sessionId`) REFERENCES `ranked_session`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `ranked_reward_grant` (
	`userId` text NOT NULL,
	`rewardId` text NOT NULL,
	`sourceSessionId` text NOT NULL,
	`achievementId` text NOT NULL,
	`chipAmount` integer NOT NULL,
	`grantedAt` integer NOT NULL,
	PRIMARY KEY(`userId`, `rewardId`),
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`sourceSessionId`) REFERENCES `ranked_session`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `ranked_session` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`startRequestId` text NOT NULL,
	`startPayloadHash` text NOT NULL,
	`activeUserId` text,
	`gameType` text NOT NULL,
	`rulesetVersion` text NOT NULL,
	`configJson` text NOT NULL,
	`configHash` text NOT NULL,
	`seed` text NOT NULL,
	`seedCommitment` text NOT NULL,
	`actionLogJson` text NOT NULL,
	`actionLogHash` text NOT NULL,
	`nextSequence` integer DEFAULT 0 NOT NULL,
	`initialWager` integer NOT NULL,
	`committedWager` integer NOT NULL,
	`status` text NOT NULL,
	`expiresAt` integer NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	`settledAt` integer,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`activeUserId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ranked_session_user_start_request_idx` ON `ranked_session` (`userId`,`startRequestId`);
--> statement-breakpoint
CREATE UNIQUE INDEX `ranked_session_active_user_idx` ON `ranked_session` (`activeUserId`);
--> statement-breakpoint
CREATE INDEX `ranked_session_status_expiry_idx` ON `ranked_session` (`status`,`expiresAt`);
--> statement-breakpoint
CREATE INDEX `ranked_session_user_created_idx` ON `ranked_session` (`userId`,`createdAt`);
