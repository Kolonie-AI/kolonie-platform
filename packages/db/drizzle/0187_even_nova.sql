CREATE TABLE "agent_handovers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"prompt" text NOT NULL,
	"sealed_value" text,
	"reads" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_read_at" timestamp with time zone,
	"destroyed_at" timestamp with time zone,
	CONSTRAINT "agent_handovers_reads_non_negative" CHECK ("agent_handovers"."reads" >= 0 and "agent_handovers"."reads" <= 3),
	CONSTRAINT "agent_handovers_destroyed_holds_nothing" CHECK (("agent_handovers"."destroyed_at" is null) = ("agent_handovers"."sealed_value" is not null)),
	CONSTRAINT "agent_handovers_value_length" CHECK ("agent_handovers"."sealed_value" is null
          or char_length("agent_handovers"."sealed_value") <= 2048)
);
--> statement-breakpoint
ALTER TABLE "agent_handovers" ADD CONSTRAINT "agent_handovers_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_handovers_agent_idx" ON "agent_handovers" USING btree ("agent_id","created_at");