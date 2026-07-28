CREATE TABLE `mission_game_tried` (
	`userId` text NOT NULL,
	`missionDefId` text NOT NULL,
	`periodKey` text NOT NULL,
	`gameType` text NOT NULL,
	`firstTriedAt` integer NOT NULL,
	PRIMARY KEY(`userId`, `missionDefId`, `periodKey`, `gameType`),
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `mission_progress_periodKey_idx` ON `mission_progress` (`periodKey`);
--> statement-breakpoint
CREATE INDEX `mission_override_periodKey_idx` ON `mission_override` (`periodKey`);
--> statement-breakpoint
CREATE INDEX `mission_game_tried_periodKey_idx` ON `mission_game_tried` (`periodKey`);
