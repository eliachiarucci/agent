ALTER TABLE "conversations" ADD COLUMN "archived" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "cron_jobs" ADD COLUMN "ask_policy" text DEFAULT 'deny' NOT NULL;