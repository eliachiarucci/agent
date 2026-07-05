CREATE TABLE "memory_pools" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"owner_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memories" RENAME COLUMN "agent_id" TO "pool_id";--> statement-breakpoint
ALTER TABLE "memories" DROP CONSTRAINT "memories_agent_id_agents_id_fk";
--> statement-breakpoint
DROP INDEX "memories_agent_idx";--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "memory_pool_id" uuid;--> statement-breakpoint
-- Data backfill (hand-written): every agent gets a pool named after it, reusing
-- the agent's id as the pool id — the renamed memories.pool_id values (old agent
-- ids) then already point at the right pool, and each agent attaches to its own.
INSERT INTO "memory_pools" ("id", "owner_id", "name", "created_at")
SELECT "id", "owner_id", "name", "created_at" FROM "agents";--> statement-breakpoint
UPDATE "agents" SET "memory_pool_id" = "id";--> statement-breakpoint
ALTER TABLE "memory_pools" ADD CONSTRAINT "memory_pools_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memory_pools_owner_idx" ON "memory_pools" USING btree ("owner_id");--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_memory_pool_id_memory_pools_id_fk" FOREIGN KEY ("memory_pool_id") REFERENCES "public"."memory_pools"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_pool_id_memory_pools_id_fk" FOREIGN KEY ("pool_id") REFERENCES "public"."memory_pools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memories_pool_idx" ON "memories" USING btree ("pool_id");