CREATE TABLE "agent_origins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"fingerprint" char(64) NOT NULL,
	"country" varchar(2),
	"colo" varchar(8),
	"asn" integer,
	"city" varchar(128),
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"calls" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_origins" ADD CONSTRAINT "agent_origins_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_origins_agent_fingerprint_unique" ON "agent_origins" USING btree ("agent_id","fingerprint");--> statement-breakpoint
CREATE INDEX "agent_origins_agent_idx" ON "agent_origins" USING btree ("agent_id","last_seen_at" DESC NULLS LAST);