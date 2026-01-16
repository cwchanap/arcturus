CREATE TABLE `game_stats` (
	`userId` text NOT NULL,
	`gameType` text NOT NULL,
	`totalWins` integer DEFAULT 0 NOT NULL,
	`totalLosses` integer DEFAULT 0 NOT NULL,
	`handsPlayed` integer DEFAULT 0 NOT NULL,
	`biggestWin` integer DEFAULT 0 NOT NULL,
	`netProfit` integer DEFAULT 0 NOT NULL,
	`updatedAt` integer NOT NULL,
	PRIMARY KEY(`userId`, `gameType`),
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `game_stats_type_wins_idx` ON `game_stats` (`gameType`,`totalWins`);--> statement-breakpoint
CREATE INDEX `game_stats_type_profit_idx` ON `game_stats` (`gameType`,`netProfit`);--> statement-breakpoint
CREATE INDEX `game_stats_type_biggest_win_idx` ON `game_stats` (`gameType`,`biggestWin`);--> statement-breakpoint
CREATE TABLE `user_achievement` (
	`userId` text NOT NULL,
	`achievementId` text NOT NULL,
	`earnedAt` integer NOT NULL,
	`gameType` text,
	PRIMARY KEY(`userId`, `achievementId`),
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `user_achievement_user_earned_idx` ON `user_achievement` (`userId`,`earnedAt`);