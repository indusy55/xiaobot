CREATE TABLE `chats` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`title` text,
	`username` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`conversationId` text NOT NULL,
	`chatId` text NOT NULL,
	`userId` text,
	`chatType` text NOT NULL,
	`chatTitle` text,
	`threadId` integer,
	`telegramMessageId` integer,
	`telegramUpdateId` integer,
	`replyToTelegramMessageId` integer,
	`role` text NOT NULL,
	`contentType` text NOT NULL,
	`fromId` text,
	`fromUsername` text,
	`fromFirstName` text,
	`fromLastName` text,
	`fromLanguageCode` text,
	`textContent` text,
	`rawMessage` text NOT NULL,
	`aiModel` text,
	`promptTokens` integer,
	`completionTokens` integer,
	`totalTokens` integer,
	`status` text NOT NULL,
	`errorMessage` text,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`chatId`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `messages_conversation_created_at_idx` ON `messages` (`conversationId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `messages_chat_created_at_idx` ON `messages` (`chatId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `messages_user_created_at_idx` ON `messages` (`userId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `messages_telegram_message_idx` ON `messages` (`chatId`,`telegramMessageId`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text,
	`firstName` text,
	`lastName` text,
	`languageCode` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
