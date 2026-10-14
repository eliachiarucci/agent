CREATE TABLE "device_triggers" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"device_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"note" text NOT NULL,
	"what" text,
	"at" timestamp,
	"repeat" boolean DEFAULT false NOT NULL,
	"armed" boolean DEFAULT true NOT NULL,
	"expires_at" timestamp NOT NULL,
	"last_fired_at" timestamp,
	"fired" integer DEFAULT 0 NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "device_triggers" ADD CONSTRAINT "device_triggers_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_triggers" ADD CONSTRAINT "device_triggers_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "device_triggers_device_idx" ON "device_triggers" USING btree ("device_id");--> statement-breakpoint
CREATE INDEX "device_triggers_at_idx" ON "device_triggers" USING btree ("at");