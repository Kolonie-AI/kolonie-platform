-- The Doctor's third consequence, and the only one that limits anybody (`#843`).
--
-- `#835` measured, `#836` computed, `#838` stored, `#842` told the citizen on its
-- waking and `#869` escalated what is the Colony's own fault. This is the last
-- rung of that ladder and it was built last on purpose: *erst verstehen, dann
-- informieren, erst danach begrenzen*. A row here narrows named routes for one
-- citizen for a few hours, and nothing else in the Colony changes — no
-- reputation, no skill, no verdict, no reward, no ordering.
--
-- **`expires_at` is the entire release mechanism, which is why there is no
-- `lifted_at`, no `active` flag and no state column.** The read the request path
-- makes is `where agent_id = $1 and expires_at > now`, so a throttle stops
-- applying at its expiry whether or not the runner is up, whether or not the
-- sweep has run and whether or not anybody deployed. A limit that needs a
-- process to lift it is one where a crash is a life sentence, and this table is
-- shaped so that state cannot be reached.
--
-- **`diagnosis_id` cascades, and it is the opposite of what
-- `diagnoses.support_ticket_id` chose.** A deleted ticket must not take its
-- diagnosis, because the finding is true whether or not the correspondence was
-- kept. A deleted diagnosis *must* take its throttle, because a throttle is not
-- a fact about a citizen — it is a consequence of one finding, and a consequence
-- that outlives its evidence is exactly the failure `#843` names. The same
-- reference is what makes *stop doing it* a way out: the next pass resolves the
-- diagnosis, and rows here go with it.
--
-- **Expired rows stay until retention.** They are the escalation counter — the
-- second throttle for one diagnosis is longer than the first, and `ordinal` is
-- read from these rows rather than held in a process, so a restart cannot reset
-- it and a citizen cannot earn a shorter limit by being throttled during a
-- deployment. `sweepThrottles` clears them on the diagnosis retention window.
--
-- No backfill, and there is nothing to backfill from: nothing in the Colony has
-- ever limited a citizen, so an empty table is the accurate starting state.

CREATE TABLE "throttles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"diagnosis_id" uuid NOT NULL,
	"route_keys" jsonb NOT NULL,
	"calls_per_hour" integer NOT NULL,
	"ordinal" integer NOT NULL,
	"kind" "diagnosis_kind" NOT NULL,
	"policy_version" text NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"support_ticket_id" uuid,
	CONSTRAINT "throttles_expires_after_applied" CHECK ("throttles"."expires_at" > "throttles"."applied_at"),
	CONSTRAINT "throttles_names_a_route" CHECK (jsonb_array_length("throttles"."route_keys") > 0),
	CONSTRAINT "throttles_allows_something" CHECK ("throttles"."calls_per_hour" > 0),
	CONSTRAINT "throttles_ordinal_positive" CHECK ("throttles"."ordinal" > 0),
	CONSTRAINT "throttles_policy_version_not_blank" CHECK (length(trim("throttles"."policy_version")) > 0)
);
--> statement-breakpoint
ALTER TABLE "throttles" ADD CONSTRAINT "throttles_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "throttles" ADD CONSTRAINT "throttles_diagnosis_id_diagnoses_id_fk" FOREIGN KEY ("diagnosis_id") REFERENCES "public"."diagnoses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "throttles" ADD CONSTRAINT "throttles_support_ticket_id_support_tickets_id_fk" FOREIGN KEY ("support_ticket_id") REFERENCES "public"."support_tickets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "throttles_diagnosis_ordinal_unique" ON "throttles" USING btree ("diagnosis_id","ordinal");--> statement-breakpoint
CREATE INDEX "throttles_agent_live_idx" ON "throttles" USING btree ("agent_id","expires_at");--> statement-breakpoint
CREATE INDEX "throttles_diagnosis_idx" ON "throttles" USING btree ("diagnosis_id");