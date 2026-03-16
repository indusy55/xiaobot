ALTER TABLE `messages` ADD `parentMessageId` integer;--> statement-breakpoint
ALTER TABLE `messages` ADD `referenceMessageId` integer;--> statement-breakpoint
CREATE INDEX `messages_parent_message_idx` ON `messages` (`parentMessageId`);--> statement-breakpoint
CREATE INDEX `messages_reference_message_idx` ON `messages` (`referenceMessageId`);