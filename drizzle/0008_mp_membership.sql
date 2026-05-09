CREATE TABLE `mp_membership` (
	`userId` text PRIMARY KEY NOT NULL,
	`roomCode` text NOT NULL,
	`joinedAt` integer NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
