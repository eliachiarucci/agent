ALTER TABLE "devices" ADD COLUMN "pairing_code_hash" text;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "pairing_expires_at" timestamp;--> statement-breakpoint
CREATE UNIQUE INDEX "devices_pairing_code_hash_idx" ON "devices" USING btree ("pairing_code_hash");