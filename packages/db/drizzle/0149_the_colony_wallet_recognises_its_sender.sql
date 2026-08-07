CREATE TABLE "colony_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"signature" varchar(120) NOT NULL,
	"sender" varchar(64) NOT NULL,
	"recipient" varchar(64) NOT NULL,
	"lamports" bigint NOT NULL,
	"agent_id" uuid,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attributed_at" timestamp with time zone,
	"quarantine" text,
	"resolved_at" timestamp with time zone,
	"resolution" text,
	CONSTRAINT "colony_payments_attributed_xor_quarantined" CHECK (("colony_payments"."attributed_at" is null) <> ("colony_payments"."quarantine" is null)),
	CONSTRAINT "colony_payments_agent_only_when_attributed" CHECK ("colony_payments"."agent_id" is null or "colony_payments"."attributed_at" is not null),
	CONSTRAINT "colony_payments_resolution_complete" CHECK (("colony_payments"."resolved_at" is null and "colony_payments"."resolution" is null)
          or ("colony_payments"."resolved_at" is not null and "colony_payments"."resolution" is not null
              and "colony_payments"."quarantine" is not null)),
	CONSTRAINT "colony_payments_lamports_non_negative" CHECK ("colony_payments"."lamports" >= 0)
);
--> statement-breakpoint
ALTER TABLE "colony_payments" ADD CONSTRAINT "colony_payments_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "colony_payments_signature_unique" ON "colony_payments" USING btree ("signature");--> statement-breakpoint
CREATE INDEX "colony_payments_agent_idx" ON "colony_payments" USING btree ("agent_id","observed_at");--> statement-breakpoint
CREATE INDEX "colony_payments_open_quarantine_idx" ON "colony_payments" USING btree ("observed_at") WHERE "colony_payments"."quarantine" is not null and "colony_payments"."resolved_at" is null;