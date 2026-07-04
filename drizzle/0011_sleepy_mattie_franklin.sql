ALTER TABLE "agents" ADD COLUMN "chat_memory_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "chat_memory_prompt" text;