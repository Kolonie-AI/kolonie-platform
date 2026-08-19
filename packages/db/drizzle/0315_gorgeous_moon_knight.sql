CREATE TABLE "walk_prose_lifts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"lifted_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "walk_prose_lifts" ADD CONSTRAINT "walk_prose_lifts_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "walk_prose_lifts_agent_lifted_idx" ON "walk_prose_lifts" USING btree ("agent_id","lifted_at");