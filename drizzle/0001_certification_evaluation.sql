CREATE TABLE `provider_attempts` (
  `id` text PRIMARY KEY NOT NULL,
  `flow` text NOT NULL,
  `stage` text NOT NULL,
  `provider` text NOT NULL,
  `model` text NOT NULL,
  `status` text NOT NULL,
  `latency_ms` integer DEFAULT 0 NOT NULL,
  `prompt_tokens` integer DEFAULT 0 NOT NULL,
  `completion_tokens` integer DEFAULT 0 NOT NULL,
  `estimated_cost_cny` real DEFAULT 0 NOT NULL,
  `route_reason` text,
  `failure_reason` text,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `provider_attempts_created_idx` ON `provider_attempts` (`created_at`);
--> statement-breakpoint
CREATE INDEX `provider_attempts_provider_idx` ON `provider_attempts` (`provider`, `model`, `status`);
--> statement-breakpoint
CREATE TABLE `evidence_submissions` (
  `id` text PRIMARY KEY NOT NULL,
  `owner_token_hash` text NOT NULL,
  `capability_name` text NOT NULL,
  `atom_id` text,
  `evidence_type` text NOT NULL,
  `description` text NOT NULL,
  `source_reference` text,
  `redaction_terms_json` text DEFAULT '[]' NOT NULL,
  `file_key` text,
  `file_name` text,
  `content_type` text,
  `byte_size` integer DEFAULT 0 NOT NULL,
  `file_sha256` text,
  `level` text DEFAULT 'L0' NOT NULL,
  `status` text DEFAULT 'material_pending' NOT NULL,
  `reviewer_note` text,
  `reviewer_key` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `evidence_submissions_status_idx` ON `evidence_submissions` (`status`, `created_at`);
--> statement-breakpoint
CREATE TABLE `microtask_challenges` (
  `id` text PRIMARY KEY NOT NULL,
  `evidence_id` text NOT NULL UNIQUE,
  `prompt` text NOT NULL,
  `rubric_json` text DEFAULT '[]' NOT NULL,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`evidence_id`) REFERENCES `evidence_submissions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `microtask_submissions` (
  `id` text PRIMARY KEY NOT NULL,
  `challenge_id` text NOT NULL,
  `answer` text NOT NULL,
  `status` text DEFAULT 'submitted' NOT NULL,
  `score` integer,
  `reviewer_note` text,
  `submitted_at` integer NOT NULL,
  `reviewed_at` integer,
  FOREIGN KEY (`challenge_id`) REFERENCES `microtask_challenges`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `microtask_submissions_challenge_idx` ON `microtask_submissions` (`challenge_id`, `submitted_at`);
--> statement-breakpoint
CREATE TABLE `certification_events` (
  `id` text PRIMARY KEY NOT NULL,
  `evidence_id` text NOT NULL,
  `actor_kind` text NOT NULL,
  `actor_key` text,
  `action` text NOT NULL,
  `from_level` text NOT NULL,
  `to_level` text NOT NULL,
  `note` text,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`evidence_id`) REFERENCES `evidence_submissions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `certification_events_evidence_idx` ON `certification_events` (`evidence_id`, `created_at`);
--> statement-breakpoint
CREATE TABLE `eval_cases` (
  `case_id` text PRIMARY KEY NOT NULL,
  `flow` text NOT NULL,
  `input_text` text NOT NULL,
  `proposed_expected_json` text NOT NULL,
  `status` text DEFAULT 'pending' NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `eval_cases_status_idx` ON `eval_cases` (`status`, `flow`);
--> statement-breakpoint
CREATE TABLE `eval_reviews` (
  `id` text PRIMARY KEY NOT NULL,
  `case_id` text NOT NULL,
  `reviewer_key` text NOT NULL,
  `expected_json` text NOT NULL,
  `decision` text NOT NULL,
  `note` text,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`case_id`) REFERENCES `eval_cases`(`case_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `eval_reviews_case_reviewer_idx` ON `eval_reviews` (`case_id`, `reviewer_key`);
--> statement-breakpoint
CREATE TABLE `eval_adjudications` (
  `case_id` text PRIMARY KEY NOT NULL,
  `reviewer_key` text NOT NULL,
  `final_expected_json` text NOT NULL,
  `note` text,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`case_id`) REFERENCES `eval_cases`(`case_id`) ON UPDATE no action ON DELETE cascade
);
