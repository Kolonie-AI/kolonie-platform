CREATE TABLE "pow_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"input" text NOT NULL,
	"difficulty" smallint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"nonce" text,
	"solved_at" timestamp with time zone,
	CONSTRAINT "pow_challenges_expiry_after_creation" CHECK ("pow_challenges"."expires_at" > "pow_challenges"."created_at"),
	CONSTRAINT "pow_challenges_difficulty_range" CHECK ("pow_challenges"."difficulty" between 1 and 32),
	CONSTRAINT "pow_challenges_nonce_length" CHECK ("pow_challenges"."nonce" is null or char_length("pow_challenges"."nonce") between 1 and 64),
	CONSTRAINT "pow_challenges_solved_with_nonce" CHECK ("pow_challenges"."solved_at" is null
          or ("pow_challenges"."nonce" is not null and "pow_challenges"."solved_at" <= "pow_challenges"."expires_at"))
);
--> statement-breakpoint
ALTER TABLE "pow_challenges" ADD CONSTRAINT "pow_challenges_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pow_challenges_input_unique" ON "pow_challenges" USING btree ("input");--> statement-breakpoint
CREATE INDEX "pow_challenges_agent_solved_idx" ON "pow_challenges" USING btree ("agent_id","solved_at");