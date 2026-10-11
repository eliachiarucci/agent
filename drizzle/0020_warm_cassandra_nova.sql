ALTER TABLE "device_observations" ADD COLUMN "caption_status" text;--> statement-breakpoint
ALTER TABLE "device_observations" ADD COLUMN "caption" jsonb;--> statement-breakpoint
ALTER TABLE "device_observations" ADD COLUMN "caption_meta" jsonb;--> statement-breakpoint
ALTER TABLE "device_observations" ADD COLUMN "captioned_at" timestamp;--> statement-breakpoint
ALTER TABLE "device_observations" ADD COLUMN "salience" real;--> statement-breakpoint
ALTER TABLE "device_observations" ADD COLUMN "embedding" halfvec(768);--> statement-breakpoint
CREATE INDEX "device_observations_device_captioned_idx" ON "device_observations" USING btree ("device_id","captioned_at");