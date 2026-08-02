CREATE TABLE `daily_challenge` (
	`id` text PRIMARY KEY NOT NULL,
	`challengeKind` text NOT NULL,
	`periodKey` text NOT NULL,
	`challengeRulesetVersion` text NOT NULL,
	`gameRulesetVersion` text NOT NULL,
	`scoreVersion` text NOT NULL,
	`configJson` text NOT NULL,
	`configHash` text NOT NULL,
	`rankedSeed` text NOT NULL,
	`rankedSeedCommitment` text NOT NULL,
	`practiceSeed` text NOT NULL,
	`startsAt` integer NOT NULL,
	`rankedEntryClosesAt` integer NOT NULL,
	`endsAt` integer NOT NULL,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `daily_challenge_kind_period_idx` ON `daily_challenge` (`challengeKind`,`periodKey`);--> statement-breakpoint
CREATE INDEX `daily_challenge_ends_at_idx` ON `daily_challenge` (`endsAt`);--> statement-breakpoint
CREATE TABLE `daily_challenge_attempt` (
	`id` text PRIMARY KEY NOT NULL,
	`challengeId` text NOT NULL,
	`userId` text NOT NULL,
	`startRequestId` text NOT NULL,
	`startPayloadHash` text NOT NULL,
	`status` text NOT NULL,
	`actionLogJson` text NOT NULL,
	`actionLogHash` text NOT NULL,
	`nextCommandSequence` integer DEFAULT 0 NOT NULL,
	`availableBankroll` integer NOT NULL,
	`roundsCompleted` integer DEFAULT 0 NOT NULL,
	`expiresAt` integer NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	`settledAt` integer,
	FOREIGN KEY (`challengeId`) REFERENCES `daily_challenge`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `daily_challenge_attempt_challenge_user_idx` ON `daily_challenge_attempt` (`challengeId`,`userId`);--> statement-breakpoint
CREATE UNIQUE INDEX `daily_challenge_attempt_user_start_request_idx` ON `daily_challenge_attempt` (`userId`,`startRequestId`);--> statement-breakpoint
CREATE INDEX `daily_challenge_attempt_status_expiry_idx` ON `daily_challenge_attempt` (`status`,`expiresAt`);--> statement-breakpoint
CREATE INDEX `daily_challenge_attempt_user_created_idx` ON `daily_challenge_attempt` (`userId`,`createdAt`);--> statement-breakpoint
CREATE TABLE `daily_challenge_result` (
	`attemptId` text NOT NULL,
	`challengeId` text NOT NULL,
	`userId` text NOT NULL,
	`endingBankroll` integer NOT NULL,
	`roundsCompleted` integer NOT NULL,
	`eligible` integer NOT NULL,
	`terminalReason` text NOT NULL,
	`durationSeconds` integer NOT NULL,
	`scoreVersion` text NOT NULL,
	`configHash` text NOT NULL,
	`rankedSeedCommitment` text NOT NULL,
	`actionLogHash` text NOT NULL,
	`receiptHash` text NOT NULL,
	`createdAt` integer NOT NULL,
	`settledAt` integer NOT NULL,
	PRIMARY KEY(`challengeId`, `userId`),
	FOREIGN KEY (`challengeId`) REFERENCES `daily_challenge`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `daily_challenge_result_attemptId_unique` ON `daily_challenge_result` (`attemptId`);--> statement-breakpoint
CREATE INDEX `daily_challenge_result_leaderboard_idx` ON `daily_challenge_result` (`challengeId`,`eligible`,`endingBankroll`,`roundsCompleted`,`settledAt`,`userId`);--> statement-breakpoint
CREATE INDEX `daily_challenge_result_user_settled_idx` ON `daily_challenge_result` (`userId`,`settledAt`);
