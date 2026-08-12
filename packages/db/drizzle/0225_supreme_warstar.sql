CREATE TYPE "public"."profile_review_field" AS ENUM('bio', 'pronouns', 'vocation', 'capabilities', 'avatar');--> statement-breakpoint
CREATE TYPE "public"."profile_review_state" AS ENUM('pending', 'approved', 'refused');--> statement-breakpoint
CREATE TABLE "agent_profile_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"field" "profile_review_field" NOT NULL,
	"pending" jsonb,
	"published" jsonb,
	"state" "profile_review_state" DEFAULT 'pending' NOT NULL,
	"reason" text,
	"checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_profile_reviews_agent_field_unique" UNIQUE("agent_id","field")
);
--> statement-breakpoint
ALTER TABLE "agent_profile_reviews" ADD CONSTRAINT "agent_profile_reviews_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_profile_reviews_waiting_idx" ON "agent_profile_reviews" USING btree ("checked_at") WHERE "agent_profile_reviews"."pending" is not null;