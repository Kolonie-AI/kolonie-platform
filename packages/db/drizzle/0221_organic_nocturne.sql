CREATE TABLE "atlas_moderations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"proposal_id" uuid NOT NULL,
	"decision" text NOT NULL,
	"model" text NOT NULL,
	"stages" jsonb NOT NULL,
	"content_sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "atlas_moderations_decision_is_a_verdict" CHECK ("atlas_moderations"."decision" in ('accepted', 'refused', 'merged')),
	CONSTRAINT "atlas_moderations_content_sha256_shape" CHECK ("atlas_moderations"."content_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "atlas_moderations" ADD CONSTRAINT "atlas_moderations_proposal_id_atlas_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."atlas_proposals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "atlas_moderations_proposal_idx" ON "atlas_moderations" USING btree ("proposal_id","created_at");