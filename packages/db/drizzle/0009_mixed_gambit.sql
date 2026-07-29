CREATE TABLE "email_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"address" text NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"inbound_at" timestamp with time zone,
	"code" text,
	"verified_at" timestamp with time zone,
	CONSTRAINT "email_challenges_expiry_after_creation" CHECK ("email_challenges"."expires_at" > "email_challenges"."created_at"),
	CONSTRAINT "email_challenges_code_needs_inbound" CHECK (("email_challenges"."code" is null) = ("email_challenges"."inbound_at" is null)),
	CONSTRAINT "email_challenges_verified_needs_inbound" CHECK ("email_challenges"."verified_at" is null or "email_challenges"."inbound_at" is not null),
	CONSTRAINT "email_challenges_verified_before_expiry" CHECK ("email_challenges"."verified_at" is null or "email_challenges"."verified_at" <= "email_challenges"."expires_at")
);
--> statement-breakpoint
ALTER TABLE "email_challenges" ADD CONSTRAINT "email_challenges_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "email_challenges_verified_address_unique" ON "email_challenges" USING btree (lower("address")) WHERE "email_challenges"."verified_at" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "email_challenges_token_unique" ON "email_challenges" USING btree ("token");--> statement-breakpoint
CREATE INDEX "email_challenges_agent_verified_idx" ON "email_challenges" USING btree ("agent_id","verified_at");