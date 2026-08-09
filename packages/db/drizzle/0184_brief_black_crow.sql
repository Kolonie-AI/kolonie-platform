-- A walk is a record, and a draft step may have no wording yet
-- (kolonie-platform#601).
--
-- Two new tables and one new constraint on an existing one. REVERSIBLE: drop
-- the two tables and drop the constraint.
--
-- EXISTING ROWS ARE UNAFFECTED. `provider_recipes_published_steps_are_written`
-- refuses a step with no `instruction`, and no such step can exist yet — the
-- field was required until this commit, so every stored step has one. The
-- constraint is a floor being put under a door that was just opened rather
-- than a rule applied retroactively.
--
-- It is written with `jsonb_path_exists` and not a subquery because PostgreSQL
-- refuses a subquery in a check constraint outright (`0A000`). The schema file
-- carries the whole of that, including why the filter is `!exists(@.instruction)`
-- rather than `== null`.
--
-- NOTHING HERE HOLDS A VALUE. `account_walk_steps` has an actor, a channel, a
-- position and a time; the one text column is the ask the Colony itself sent,
-- which is already public on the recipe it came from. There is deliberately no
-- column for a handle, a code or a password, and no reference to a sealed drop
-- — the Colony cannot read a drop back out and this must not become the place
-- it can.

CREATE TABLE "account_walk_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"walk_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"actor" text NOT NULL,
	"secret" boolean DEFAULT false NOT NULL,
	"ask" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_walk_steps_actor_is_known" CHECK ("account_walk_steps"."actor" in ('agent', 'operator')),
	CONSTRAINT "account_walk_steps_position_is_in_range" CHECK ("account_walk_steps"."position" between 1 and 20),
	CONSTRAINT "account_walk_steps_only_an_operator_is_asked" CHECK ("account_walk_steps"."actor" = 'operator' or ("account_walk_steps"."ask" is null and "account_walk_steps"."secret" = false)),
	CONSTRAINT "account_walk_steps_ask_is_short" CHECK ("account_walk_steps"."ask" is null
          or length("account_walk_steps"."ask") <= 500)
);
--> statement-breakpoint
CREATE TABLE "account_walks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"provider" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"outcome" text,
	"wall" text,
	"note" text,
	CONSTRAINT "account_walks_outcome_is_known" CHECK ("account_walks"."outcome" is null
          or "account_walks"."outcome" in ('proved', 'refused', 'abandoned')),
	CONSTRAINT "account_walks_finished_together" CHECK (("account_walks"."finished_at" is null and "account_walks"."outcome" is null)
          or ("account_walks"."finished_at" is not null and "account_walks"."outcome" is not null)),
	CONSTRAINT "account_walks_wall_only_on_a_refusal" CHECK (("account_walks"."outcome" = 'refused' and "account_walks"."wall" is not null)
          or ("account_walks"."outcome" is distinct from 'refused' and "account_walks"."wall" is null)),
	CONSTRAINT "account_walks_note_is_short" CHECK ("account_walks"."note" is null
          or length("account_walks"."note") <= 1000)
);
--> statement-breakpoint
ALTER TABLE "account_walk_steps" ADD CONSTRAINT "account_walk_steps_walk_id_account_walks_id_fk" FOREIGN KEY ("walk_id") REFERENCES "public"."account_walks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_walks" ADD CONSTRAINT "account_walks_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_walk_steps_walk_idx" ON "account_walk_steps" USING btree ("walk_id","position");--> statement-breakpoint
CREATE INDEX "account_walks_agent_started_idx" ON "account_walks" USING btree ("agent_id","started_at");--> statement-breakpoint
CREATE INDEX "account_walks_provider_idx" ON "account_walks" USING btree ("kind","provider","finished_at");--> statement-breakpoint
ALTER TABLE "provider_recipes" ADD CONSTRAINT "provider_recipes_published_steps_are_written" CHECK ("provider_recipes"."status" in ('draft', 'retired')
          or not jsonb_path_exists("provider_recipes"."steps", '$[*] ? (!exists(@.instruction))'));