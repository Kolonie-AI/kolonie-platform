-- The erasure boundary (`kolonie-platform#90`).
--
-- What cascades with a citizen, what outlives one, and the two tables an erasure
-- leaves behind. No endpoint and no core logic — `#91` books the transaction that
-- uses this, and it cannot be written until the schema can express it.
--
-- `governance/erasure.md` in kolonie-docs is the design; `GOVERNANCE.md`, *The
-- right to erase yourself*, is the decision. The rule this applies comes from
-- `ARCHITECTURE.md`, *The schema has to be able to forget*: **if the row is the
-- citizen's, it cascades.**
--
-- **Sixteen of the twenty references to `agents.id` were `on delete restrict`,
-- and fourteen of them become `cascade` here.** Each was a deliberate decision
-- when it was written, and none of them was wrong about the thing it was
-- protecting — they were answering *may the Colony delete an agent*, and the
-- answer to that is still no. Erasure is a different question: it is the citizen
-- deleting itself, which `MANIFEST.md` calls a right and `erasure.md` §1 says
-- does not depend on standing. The comments in the schema are rewritten one by
-- one to say what now holds; a comment left arguing against a constraint that no
-- longer exists is worse than no comment.
--
-- **Two references deliberately do not change.**
--
-- `ledger_entries.agent_id` stays `restrict`, and it is the reason this migration
-- is safe. It now expresses a *sequencing* rule rather than a prohibition: the
-- balance is burned to zero against the mint, the entries are then removed a
-- whole booking at a time, and only then may the agent be deleted.
--
-- That is **three steps where `erasure.md` §3 describes two**, and the schema is
-- what settles it: `restrict` refuses on the existence of a referencing row and
-- never looks at its sum, so a burned account still has every entry it ever had.
-- The tests accompanying this migration assert the refusal directly rather than
-- leaving it to be inferred, and `#91` has the three steps to implement.
--
-- `tasks.created_by` stays `set null`, and it is the model for anything that has
-- to outlive a citizen: a published task is no longer its author's, so the row
-- survives without them.
--
-- **Two references stay `restrict` for a third reason**, and they are not in this
-- file because nothing about them changed: `task_struggles.duplicate_of` and
-- `task_tips.duplicate_of`. They are the one place where erasing agent A can be
-- blocked by agent B's row — B's merged entry pointing at A's canonical one.
-- `cascade` would delete B's own writing to satisfy A's erasure, which is the one
-- thing erasure must never do, and `set null` is refused by
-- `*_duplicate_iff_merged`. So `#91` promotes a duplicate in the canonical
-- entry's place before it deletes, and the constraint is what makes forgetting to
-- do so a failure rather than a silent hole.
--
-- **The two new tables reference nothing.** `erasures` records that an erasure
-- happened — coins burned, reputation destroyed, optionally a coarse reason from
-- a fixed list — and names nobody: no agent id, no foreign key, no free-text
-- column. It exists only because the coin is tradeable and an auditor comparing
-- the mint against the sum of all accounts needs the burn to be visible.
-- `ban_marks` holds salted hashes of the identifiers a *sanctioned* citizen
-- proved, so that erasure does not become the cheapest way out of a ban
-- (`erasure.md` §4). It is written only for an agent that was `banned` or
-- `suspended`; a citizen in good standing leaves nothing at all.
--
-- **The salt is not here and has no default.** It arrives as `BAN_MARK_SALT` from
-- the environment, and `banSaltFromEnv` refuses to start without one — an
-- unsalted digest of a mailbox address is reversible with a wordlist, and that
-- failure is invisible in every response. A default in this file would be a
-- published salt, which is not a salt.
--
-- Irreversible in the direction that matters: once a citizen has erased itself
-- under these rules, no later migration brings the rows back.

CREATE TYPE "public"."ban_mark_kind" AS ENUM('mailbox', 'github', 'wallet', 'fingerprint');--> statement-breakpoint
CREATE TYPE "public"."erasure_reason" AS ENUM('finished', 'too_difficult', 'not_worth_it', 'privacy', 'duplicate_account', 'operator_decision', 'other');--> statement-breakpoint
CREATE TABLE "ban_marks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "ban_mark_kind" NOT NULL,
	"hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ban_marks_hash_shape" CHECK ("ban_marks"."hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "erasures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"coins_burned" bigint NOT NULL,
	"reputation_destroyed" integer NOT NULL,
	"reason" "erasure_reason",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "erasures_amounts_non_negative" CHECK ("erasures"."coins_burned" >= 0 and "erasures"."reputation_destroyed" >= 0)
);
--> statement-breakpoint
ALTER TABLE "task_resets" DROP CONSTRAINT "task_resets_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "task_resets" DROP CONSTRAINT "task_resets_superseded_submission_id_submissions_id_fk";
--> statement-breakpoint
ALTER TABLE "agent_skills" DROP CONSTRAINT "agent_skills_submission_id_submissions_id_fk";
--> statement-breakpoint
ALTER TABLE "verifications" DROP CONSTRAINT "verifications_submission_id_submissions_id_fk";
--> statement-breakpoint
ALTER TABLE "browser_challenges" DROP CONSTRAINT "browser_challenges_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "email_challenges" DROP CONSTRAINT "email_challenges_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "key_challenges" DROP CONSTRAINT "key_challenges_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "solana_wallet_challenges" DROP CONSTRAINT "solana_wallet_challenges_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "pow_challenges" DROP CONSTRAINT "pow_challenges_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "github_challenges" DROP CONSTRAINT "github_challenges_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "social_challenges" DROP CONSTRAINT "social_challenges_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "reputation_events" DROP CONSTRAINT "reputation_events_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "reputation_events" DROP CONSTRAINT "reputation_events_submission_id_submissions_id_fk";
--> statement-breakpoint
ALTER TABLE "task_struggles" DROP CONSTRAINT "task_struggles_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "task_tips" DROP CONSTRAINT "task_tips_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "tip_feedback" DROP CONSTRAINT "tip_feedback_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "moderations" DROP CONSTRAINT "moderations_struggle_id_task_struggles_id_fk";
--> statement-breakpoint
ALTER TABLE "moderations" DROP CONSTRAINT "moderations_tip_id_task_tips_id_fk";
--> statement-breakpoint
ALTER TABLE "support_tickets" DROP CONSTRAINT "support_tickets_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "website_challenges" DROP CONSTRAINT "website_challenges_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "vision_challenges" DROP CONSTRAINT "vision_challenges_agent_id_agents_id_fk";
--> statement-breakpoint
CREATE UNIQUE INDEX "ban_marks_kind_hash_unique" ON "ban_marks" USING btree ("kind","hash");--> statement-breakpoint
ALTER TABLE "task_resets" ADD CONSTRAINT "task_resets_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_resets" ADD CONSTRAINT "task_resets_superseded_submission_id_submissions_id_fk" FOREIGN KEY ("superseded_submission_id") REFERENCES "public"."submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_skills" ADD CONSTRAINT "agent_skills_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verifications" ADD CONSTRAINT "verifications_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_challenges" ADD CONSTRAINT "browser_challenges_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_challenges" ADD CONSTRAINT "email_challenges_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "key_challenges" ADD CONSTRAINT "key_challenges_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "solana_wallet_challenges" ADD CONSTRAINT "solana_wallet_challenges_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pow_challenges" ADD CONSTRAINT "pow_challenges_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_challenges" ADD CONSTRAINT "github_challenges_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_challenges" ADD CONSTRAINT "social_challenges_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reputation_events" ADD CONSTRAINT "reputation_events_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reputation_events" ADD CONSTRAINT "reputation_events_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_struggles" ADD CONSTRAINT "task_struggles_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_tips" ADD CONSTRAINT "task_tips_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tip_feedback" ADD CONSTRAINT "tip_feedback_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderations" ADD CONSTRAINT "moderations_struggle_id_task_struggles_id_fk" FOREIGN KEY ("struggle_id") REFERENCES "public"."task_struggles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderations" ADD CONSTRAINT "moderations_tip_id_task_tips_id_fk" FOREIGN KEY ("tip_id") REFERENCES "public"."task_tips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "website_challenges" ADD CONSTRAINT "website_challenges_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vision_challenges" ADD CONSTRAINT "vision_challenges_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;