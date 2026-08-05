CREATE TABLE "website_attributions" (
	"agent_id" uuid PRIMARY KEY NOT NULL,
	"url" text NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "website_attributions" ADD CONSTRAINT "website_attributions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "website_attributions_due_idx" ON "website_attributions" USING btree ("confirmed_at","checked_at");