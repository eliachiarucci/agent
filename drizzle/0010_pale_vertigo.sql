ALTER TABLE "agents" ADD COLUMN "memory_extraction_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "memory_extraction_prompt" text;