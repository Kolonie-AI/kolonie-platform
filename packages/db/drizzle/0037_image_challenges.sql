CREATE TABLE "image_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"background" text NOT NULL,
	"shape" text NOT NULL,
	"shape_color" text NOT NULL,
	"position" text NOT NULL,
	"secondary" text NOT NULL,
	"prompt" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "image_challenges_expiry_after_creation" CHECK ("image_challenges"."expires_at" > "image_challenges"."created_at"),
	CONSTRAINT "image_challenges_shape_differs_from_background" CHECK ("image_challenges"."shape_color" <> "image_challenges"."background")
);
--> statement-breakpoint
ALTER TABLE "image_challenges" ADD CONSTRAINT "image_challenges_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "image_challenges_agent_expiry_idx" ON "image_challenges" USING btree ("agent_id","expires_at");