CREATE TABLE `roulette_round` (
	`syncId` text NOT NULL,
	`userId` text NOT NULL,
	`winningNumber` integer NOT NULL,
	`betsJson` text NOT NULL,
	`totalBet` integer NOT NULL,
	`totalPayout` integer NOT NULL,
	`netDelta` integer NOT NULL,
	`previousBalance` integer NOT NULL,
	`newBalance` integer NOT NULL,
	`createdAt` integer NOT NULL,
	PRIMARY KEY(`userId`, `syncId`),
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
