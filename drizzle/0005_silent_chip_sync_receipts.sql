CREATE TABLE `chip_sync_receipt` (
	`userId` text NOT NULL,
	`syncId` text NOT NULL,
	`gameType` text NOT NULL,
	`previousBalance` integer NOT NULL,
	`balance` integer NOT NULL,
	`delta` integer NOT NULL,
	`statsDelta` integer,
	`outcome` text,
	`handCount` integer,
	`winsIncrement` integer,
	`lossesIncrement` integer,
	`biggestWinCandidate` integer,
	`createdAt` integer NOT NULL,
	PRIMARY KEY(`userId`, `syncId`),
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `chip_sync_receipt_user_created_idx` ON `chip_sync_receipt` (`userId`,`createdAt`);
