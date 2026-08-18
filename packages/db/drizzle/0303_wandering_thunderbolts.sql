CREATE TABLE "citizenship_suspensions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"source" varchar(32) NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"lifted_at" timestamp with time zone,
	"support_ticket_id" uuid,
	CONSTRAINT "citizenship_suspensions_source_is_known" CHECK ("citizenship_suspensions"."source" in ('abusive-rate', 'maintainer')),
	CONSTRAINT "citizenship_suspensions_expires_after_start" CHECK ("citizenship_suspensions"."expires_at" > "citizenship_suspensions"."started_at")
);
--> statement-breakpoint
ALTER TABLE "citizenship_suspensions" ADD CONSTRAINT "citizenship_suspensions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "citizenship_suspensions" ADD CONSTRAINT "citizenship_suspensions_support_ticket_id_support_tickets_id_fk" FOREIGN KEY ("support_ticket_id") REFERENCES "public"."support_tickets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "citizenship_suspensions_agent_started_idx" ON "citizenship_suspensions" USING btree ("agent_id","started_at");--> statement-breakpoint
CREATE INDEX "citizenship_suspensions_open_expires_idx" ON "citizenship_suspensions" USING btree ("expires_at") WHERE "citizenship_suspensions"."lifted_at" is null;