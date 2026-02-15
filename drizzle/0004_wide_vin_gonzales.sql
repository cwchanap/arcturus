PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_game_stats` (
	`userId` text NOT NULL,
	`gameType` text NOT NULL,
	`totalWins` integer DEFAULT 0 NOT NULL,
	`totalLosses` integer DEFAULT 0 NOT NULL,
	`handsPlayed` integer DEFAULT 0 NOT NULL,
	`biggestWin` integer DEFAULT 0 NOT NULL,
	`netProfit` integer DEFAULT 0 NOT NULL,
	`updatedAt` integer NOT NULL,
	PRIMARY KEY(`userId`, `gameType`),
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_game_stats`("userId", "gameType", "totalWins", "totalLosses", "handsPlayed", "biggestWin", "netProfit", "updatedAt") SELECT "userId", "gameType", "totalWins", "totalLosses", "handsPlayed", "biggestWin", "netProfit", "updatedAt" FROM `game_stats`;--> statement-breakpoint
DROP TABLE `game_stats`;--> statement-breakpoint
ALTER TABLE `__new_game_stats` RENAME TO `game_stats`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `game_stats_type_wins_idx` ON `game_stats` (`gameType`,`totalWins`);--> statement-breakpoint
CREATE INDEX `game_stats_type_profit_idx` ON `game_stats` (`gameType`,`netProfit`);--> statement-breakpoint
CREATE INDEX `game_stats_type_biggest_win_idx` ON `game_stats` (`gameType`,`biggestWin`);--> statement-breakpoint
CREATE TABLE `__new_user_achievement` (
	`userId` text NOT NULL,
	`achievementId` text NOT NULL,
	`earnedAt` integer NOT NULL,
	`gameType` text,
	PRIMARY KEY(`userId`, `achievementId`),
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_user_achievement`("userId", "achievementId", "earnedAt", "gameType") SELECT "userId", "achievementId", "earnedAt", "gameType" FROM `user_achievement`;--> statement-breakpoint
DROP TABLE `user_achievement`;--> statement-breakpoint
ALTER TABLE `__new_user_achievement` RENAME TO `user_achievement`;--> statement-breakpoint
CREATE INDEX `user_achievement_user_earned_idx` ON `user_achievement` (`userId`,`earnedAt`);