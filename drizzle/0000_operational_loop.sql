CREATE TABLE `analysis_receipts` (
  `id` text PRIMARY KEY NOT NULL,
  `flow` text NOT NULL,
  `stage` text NOT NULL,
  `status` text NOT NULL,
  `source_hash` text NOT NULL,
  `provider` text,
  `model` text,
  `prompt_tokens` integer DEFAULT 0 NOT NULL,
  `completion_tokens` integer DEFAULT 0 NOT NULL,
  `estimated_cost_cny` real DEFAULT 0 NOT NULL,
  `latency_ms` integer DEFAULT 0 NOT NULL,
  `redaction_count` integer DEFAULT 0 NOT NULL,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `analysis_receipts_created_idx` ON `analysis_receipts` (`created_at`);
--> statement-breakpoint
CREATE INDEX `analysis_receipts_flow_idx` ON `analysis_receipts` (`flow`, `stage`);
--> statement-breakpoint
CREATE TABLE `feedback` (
  `id` text PRIMARY KEY NOT NULL,
  `receipt_id` text,
  `flow` text NOT NULL,
  `target` text NOT NULL,
  `verdict` text NOT NULL,
  `tags_json` text DEFAULT '[]' NOT NULL,
  `comment` text,
  `consent` integer DEFAULT false NOT NULL,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`receipt_id`) REFERENCES `analysis_receipts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `feedback_created_idx` ON `feedback` (`created_at`);
--> statement-breakpoint
CREATE INDEX `feedback_verdict_idx` ON `feedback` (`verdict`);
--> statement-breakpoint
CREATE TABLE `review_queue` (
  `id` text PRIMARY KEY NOT NULL,
  `flow` text NOT NULL,
  `status` text DEFAULT 'pending' NOT NULL,
  `risk_flags_json` text DEFAULT '[]' NOT NULL,
  `redacted_payload_json` text NOT NULL,
  `reviewer_note` text,
  `resolution` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `review_queue_status_idx` ON `review_queue` (`status`, `created_at`);
--> statement-breakpoint
CREATE TABLE `rate_limits` (
  `client_hash` text NOT NULL,
  `window_start` integer NOT NULL,
  `request_count` integer DEFAULT 0 NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rate_limits_client_window_idx` ON `rate_limits` (`client_hash`, `window_start`);
--> statement-breakpoint
CREATE INDEX `rate_limits_updated_idx` ON `rate_limits` (`updated_at`);
--> statement-breakpoint
CREATE TABLE `model_health` (
  `provider` text PRIMARY KEY NOT NULL,
  `consecutive_failures` integer DEFAULT 0 NOT NULL,
  `open_until` integer DEFAULT 0 NOT NULL,
  `last_failure` text,
  `updated_at` integer NOT NULL
);
