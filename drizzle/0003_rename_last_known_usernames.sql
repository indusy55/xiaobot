ALTER TABLE `chats` RENAME COLUMN `username` TO `lastKnownUsername`;
--> statement-breakpoint
ALTER TABLE `users` RENAME COLUMN `username` TO `lastKnownUsername`;
