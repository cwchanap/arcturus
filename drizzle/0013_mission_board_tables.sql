CREATE TABLE `login_streak` (
	`userId` text PRIMARY KEY NOT NULL,
	`currentStreak` integer DEFAULT 0 NOT NULL,
	`longestStreak` integer DEFAULT 0 NOT NULL,
	`lastClaimPeriodKey` text DEFAULT '' NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `mission_override` (
	`userId` text NOT NULL,
	`periodKey` text NOT NULL,
	`originalMissionDefId` text NOT NULL,
	`replacementMissionDefId` text NOT NULL,
	`rerolledAt` integer NOT NULL,
	PRIMARY KEY(`userId`, `periodKey`, `originalMissionDefId`),
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mission_override_one_per_day` ON `mission_override` (`userId`, `periodKey`);
--> statement-breakpoint
CREATE TABLE `mission_progress` (
	`userId` text NOT NULL,
	`missionDefId` text NOT NULL,
	`periodKey` text NOT NULL,
	`progress` integer DEFAULT 0 NOT NULL,
	`metadataJson` text,
	`completedAt` integer,
	`claimedAt` integer,
	PRIMARY KEY(`userId`, `missionDefId`, `periodKey`),
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
