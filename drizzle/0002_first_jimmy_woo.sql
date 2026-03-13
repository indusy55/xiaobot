CREATE TABLE `chat_participants` (
	`chatId` text NOT NULL,
	`userId` text NOT NULL,
	`observedUsername` text,
	`observedFirstName` text,
	`observedLastName` text,
	`observedLanguageCode` text,
	`isBot` integer DEFAULT false NOT NULL,
	`firstSeenAt` integer NOT NULL,
	`lastSeenAt` integer NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	PRIMARY KEY(`chatId`, `userId`),
	FOREIGN KEY (`chatId`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `chat_participants_user_idx` ON `chat_participants` (`userId`);--> statement-breakpoint
CREATE INDEX `chat_participants_last_seen_idx` ON `chat_participants` (`chatId`,`lastSeenAt`);