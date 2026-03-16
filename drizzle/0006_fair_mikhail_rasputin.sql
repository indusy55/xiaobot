ALTER TABLE `tasks` ADD `workerOwner` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `leaseExpiresAt` integer;--> statement-breakpoint
CREATE INDEX `tasks_worker_owner_idx` ON `tasks` (`workerOwner`,`leaseExpiresAt`);