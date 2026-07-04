-- Permissions were re-scoped from (provider, model) to agent; old rows cannot
-- be mapped (and are cheap toggles), so the table is cleared before the NOT
-- NULL agent_id column lands.
DELETE FROM "tool_permissions";--> statement-breakpoint
DROP INDEX "tool_permissions_user_provider_model_idx";--> statement-breakpoint
ALTER TABLE "tool_permissions" ADD COLUMN "agent_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "tool_permissions" ADD CONSTRAINT "tool_permissions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tool_permissions_user_agent_idx" ON "tool_permissions" USING btree ("user_id","agent_id");--> statement-breakpoint
ALTER TABLE "tool_permissions" DROP COLUMN "provider";--> statement-breakpoint
ALTER TABLE "tool_permissions" DROP COLUMN "model";