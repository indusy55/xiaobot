CREATE TABLE `tasks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`status` text NOT NULL,
	`conversationId` text NOT NULL,
	`chatId` text NOT NULL,
	`userId` text,
	`triggerTelegramMessageId` integer,
	`payload` text,
	`contextSnapshot` text,
	`result` text,
	`errorMessage` text,
	`retryCount` integer DEFAULT 0 NOT NULL,
	`cancelRequestedAt` integer,
	`startedAt` integer,
	`finishedAt` integer,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`chatId`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `tasks_status_created_at_idx` ON `tasks` (`status`,`createdAt`);--> statement-breakpoint
CREATE INDEX `tasks_conversation_created_at_idx` ON `tasks` (`conversationId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `tasks_chat_created_at_idx` ON `tasks` (`chatId`,`createdAt`);