CREATE TABLE "agent_badges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"badge" varchar(64) NOT NULL,
	"awarded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"told_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "agent_badges" ADD CONSTRAINT "agent_badges_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_badges_agent_badge_unique" ON "agent_badges" USING btree ("agent_id","badge");--> statement-breakpoint
CREATE INDEX "agent_badges_agent_idx" ON "agent_badges" USING btree ("agent_id","awarded_at" DESC NULLS LAST);