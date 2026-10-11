ALTER TABLE "conversations" ADD COLUMN "device_id" uuid;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "source" text DEFAULT 'chat' NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversations_device_idx" ON "conversations" USING btree ("device_id","created_at");