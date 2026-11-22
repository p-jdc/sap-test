CREATE TABLE `run` (
	`id` text PRIMARY KEY NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`status` text NOT NULL,
	`files` text NOT NULL,
	`grep` text,
	`total` integer NOT NULL,
	`passed` integer NOT NULL,
	`failed` integer NOT NULL,
	`skipped` integer NOT NULL,
	`exit_code` integer,
	`artifacts_removed_at` integer,
	`details_removed_at` integer
);
--> statement-breakpoint
CREATE INDEX `run_started_at` ON `run` (`started_at`);--> statement-breakpoint
CREATE TABLE `run_test` (
	`run_id` text NOT NULL,
	`position` integer NOT NULL,
	`key` text NOT NULL,
	`file` text NOT NULL,
	`title` text NOT NULL,
	`status` text,
	`setup` integer NOT NULL,
	`failed_at` text,
	`details_removed` integer NOT NULL,
	`result` text NOT NULL,
	PRIMARY KEY(`run_id`, `position`),
	FOREIGN KEY (`run_id`) REFERENCES `run`(`id`) ON UPDATE no action ON DELETE cascade
);
