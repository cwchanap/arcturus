-- HPA-731 chip shop: owned/equipped cosmetics per user. Defaults stay
-- implicit (no rows); itemId values are validated against the closed shop
-- catalog in src/lib/shop/catalog.ts. No kind/index/catalog table — the
-- catalog module is the sole price/image/kind authority.
CREATE TABLE `user_cosmetic` (
	`userId` text NOT NULL,
	`itemId` text NOT NULL,
	`purchasedAt` integer NOT NULL,
	`equipped` integer DEFAULT false NOT NULL,
	PRIMARY KEY(`userId`, `itemId`),
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
