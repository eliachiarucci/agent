CREATE TABLE "cron_job_runs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"job_id" uuid,
	"user_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"prompt" text NOT NULL,
	"conversation_id" uuid,
	"status" text NOT NULL,
	"error" text,
	"started_at" timestamp NOT NULL,
	"finished_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cron_jobs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"agent_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"prompt" text NOT NULL,
	"days_of_week" integer[] NOT NULL,
	"time" text NOT NULL,
	"recurrence" text NOT NULL,
	"provider" text,
	"model" text,
	"timezone" text NOT NULL,
	"next_run_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cron_job_runs" ADD CONSTRAINT "cron_job_runs_job_id_cron_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."cron_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cron_job_runs" ADD CONSTRAINT "cron_job_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cron_job_runs" ADD CONSTRAINT "cron_job_runs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cron_job_runs" ADD CONSTRAINT "cron_job_runs_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cron_jobs" ADD CONSTRAINT "cron_jobs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cron_jobs" ADD CONSTRAINT "cron_jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cron_job_runs_job_idx" ON "cron_job_runs" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "cron_job_runs_user_idx" ON "cron_job_runs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "cron_jobs_next_run_idx" ON "cron_jobs" USING btree ("next_run_at");--> statement-breakpoint
CREATE INDEX "cron_jobs_user_idx" ON "cron_jobs" USING btree ("user_id");