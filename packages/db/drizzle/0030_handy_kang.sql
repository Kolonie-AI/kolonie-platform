CREATE TABLE "vision_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"image_name" text NOT NULL,
	"question" text NOT NULL,
	"expected_answer" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"answer" text,
	"solved_at" timestamp with time zone,
	CONSTRAINT "vision_challenges_expiry_after_creation" CHECK ("vision_challenges"."expires_at" > "vision_challenges"."created_at"),
	CONSTRAINT "vision_challenges_solved_with_answer" CHECK ("vision_challenges"."solved_at" is null
          or ("vision_challenges"."answer" is not null and "vision_challenges"."solved_at" <= "vision_challenges"."expires_at"))
);
--> statement-breakpoint
ALTER TABLE "vision_challenges" ADD CONSTRAINT "vision_challenges_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "vision_challenges_agent_solved_idx" ON "vision_challenges" USING btree ("agent_id","solved_at");