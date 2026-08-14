CREATE TABLE `blackjack_daily` (
	`periodKey` text PRIMARY KEY NOT NULL,
	`seed` text NOT NULL,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `blackjack_run` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`activeUserId` text,
	`mode` text NOT NULL,
	`periodKey` text,
	`startRequestId` text NOT NULL,
	`initialWager` integer,
	`seed` text NOT NULL,
	`commandsJson` text NOT NULL,
	`nextSequence` integer DEFAULT 0 NOT NULL,
	`status` text NOT NULL,
	`resultJson` text,
	`dailyEndingBankroll` integer,
	`dailyRoundsCompleted` integer,
	`expiresAt` integer NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	`settledAt` integer,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`activeUserId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `blackjack_run_user_start_request_idx` ON `blackjack_run` (`userId`,`startRequestId`);--> statement-breakpoint
CREATE UNIQUE INDEX `blackjack_run_active_user_mode_idx` ON `blackjack_run` (`activeUserId`,`mode`);--> statement-breakpoint
CREATE UNIQUE INDEX `blackjack_run_user_mode_period_idx` ON `blackjack_run` (`userId`,`mode`,`periodKey`);--> statement-breakpoint
CREATE INDEX `blackjack_run_status_expiry_idx` ON `blackjack_run` (`status`,`expiresAt`);