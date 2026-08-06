CREATE TABLE "human_agents" (
	"agent_id" uuid PRIMARY KEY NOT NULL,
	"human_id" uuid NOT NULL,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "human_link_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(32) NOT NULL,
	"human_id" uuid,
	"agent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"redeemed_note" text,
	CONSTRAINT "human_link_codes_one_side" CHECK ((human_id is null) <> (agent_id is null))
);
--> statement-breakpoint
ALTER TABLE "human_agents" ADD CONSTRAINT "human_agents_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "human_agents" ADD CONSTRAINT "human_agents_human_id_humans_id_fk" FOREIGN KEY ("human_id") REFERENCES "public"."humans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "human_link_codes" ADD CONSTRAINT "human_link_codes_human_id_humans_id_fk" FOREIGN KEY ("human_id") REFERENCES "public"."humans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "human_link_codes" ADD CONSTRAINT "human_link_codes_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "human_agents_human_idx" ON "human_agents" USING btree ("human_id");--> statement-breakpoint
CREATE UNIQUE INDEX "human_link_codes_code_unique" ON "human_link_codes" USING btree ("code");--> statement-breakpoint
CREATE INDEX "human_link_codes_human_idx" ON "human_link_codes" USING btree ("human_id");--> statement-breakpoint
CREATE INDEX "human_link_codes_agent_idx" ON "human_link_codes" USING btree ("agent_id");