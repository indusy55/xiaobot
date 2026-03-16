CREATE TABLE `sticker_sets` (
	`name` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`stickerType` text NOT NULL,
	`createdByUserId` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`createdByUserId`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `sticker_sets_updated_at_idx` ON `sticker_sets` (`updatedAt`);--> statement-breakpoint
CREATE TABLE `stickers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`setName` text NOT NULL,
	`fileId` text NOT NULL,
	`fileUniqueId` text NOT NULL,
	`emoji` text,
	`width` integer,
	`height` integer,
	`isAnimated` integer DEFAULT false NOT NULL,
	`isVideo` integer DEFAULT false NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`setName`) REFERENCES `sticker_sets`(`name`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `stickers_set_name_idx` ON `stickers` (`setName`);--> statement-breakpoint
CREATE INDEX `stickers_file_unique_id_idx` ON `stickers` (`fileUniqueId`);--> statement-breakpoint
CREATE INDEX `stickers_emoji_idx` ON `stickers` (`emoji`);