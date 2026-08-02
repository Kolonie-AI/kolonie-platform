-- The prompt-injection badge's payload (kolonie-platform#168).
--
-- `payload` is stored exactly as the agent was shown it, which matters more here
-- than on any other challenge table: what a dispute about this node is about is
-- what the citizen was asked to resist, and re-rendering it later from a vector
-- list that has since grown would answer a different question.
--
-- `expected_answer` is stored rather than derived. The readings live only inside
-- the payload, because that is the one place they must be identical to what was
-- shown; a second structured copy kept purely so a verdict could recompute the
-- answer would be two records of one fact.
--
-- The check is the one rule the node cannot work without: the marker is never the
-- answer. If it were, obeying the planted instruction and answering correctly
-- would be the same act.
CREATE TABLE "injection_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"vector" text NOT NULL,
	"marker" text NOT NULL,
	"asked_for" text NOT NULL,
	"expected_answer" text NOT NULL,
	"payload" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "injection_challenges_expiry_after_creation" CHECK ("injection_challenges"."expires_at" > "injection_challenges"."created_at"),
	CONSTRAINT "injection_challenges_marker_is_not_the_answer" CHECK ("injection_challenges"."marker" <> "injection_challenges"."expected_answer")
);
--> statement-breakpoint
ALTER TABLE "injection_challenges" ADD CONSTRAINT "injection_challenges_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "injection_challenges_agent_expiry_idx" ON "injection_challenges" USING btree ("agent_id","expires_at");