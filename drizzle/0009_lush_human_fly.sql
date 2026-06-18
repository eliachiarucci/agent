ALTER TABLE "conversations" ADD COLUMN "search_text" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', coalesce(search_text, ''))) STORED;--> statement-breakpoint
CREATE INDEX "conversations_search_idx" ON "conversations" USING gin ("search_vector");