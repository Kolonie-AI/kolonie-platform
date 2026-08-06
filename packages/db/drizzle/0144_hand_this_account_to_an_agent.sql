CREATE TABLE "agent_adoption_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"code" varchar(32) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "agent_adoption_codes" ADD CONSTRAINT "agent_adoption_codes_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_adoption_codes_code_unique" ON "agent_adoption_codes" USING btree ("code");--> statement-breakpoint
CREATE INDEX "agent_adoption_codes_agent_idx" ON "agent_adoption_codes" USING btree ("agent_id");