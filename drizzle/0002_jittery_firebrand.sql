CREATE TABLE `llm_settings` (
	`userId` text PRIMARY KEY NOT NULL,
	`provider` text DEFAULT 'openai' NOT NULL,
	`model` text DEFAULT 'gpt-4o' NOT NULL,
	`openaiApiKey` text,
	`geminiApiKey` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
