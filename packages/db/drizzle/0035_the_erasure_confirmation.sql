-- The erasure confirmation (`kolonie-platform#92`).
--
-- One table. A citizen cannot erase itself in one call: the first mints a
-- short-lived, single-use challenge bound to that agent and states exactly what
-- is about to be destroyed, and the second presents it with a fixed phrase and —
-- where the citizen holds a key worth stealing — a signature over it.
--
-- `ARCHITECTURE.md`, *The erasure surface*, is the threat model:
--
-- > Account deletion is the one call that destroys a citizen's whole history, so
-- > it is also the most valuable call for an attacker holding a stolen key, and
-- > the most dangerous one for an agent that read an instruction it should not
-- > have trusted.
--
-- **This is why `erasure.md` §7 could reject a grace period.** A 72-hour window
-- buys an undo after a mistaken or hijacked erasure, and it costs a second
-- account state that every read path has to understand, forever. The two factors
-- this table carries are what made that trade affordable — so building the
-- window instead of this would have been the substitution the document refused.
--
-- **Why not `key_challenges`.** That nonce proves which key an agent holds and
-- its row survives as evidence for a granted skill. This one proves that a
-- specific agent meant to do this, twice, within five minutes, and its row must
-- not survive anything. The two also expire on different clocks and are consumed
-- under opposite rules. Sharing a table is how a later change to the Academy's
-- expiry quietly widens the erasure window.
--
-- **`on delete cascade`, deliberately.** An attempt must not be recorded in a way
-- that outlives the erasure: a successful confirmation takes this row with
-- everything else, an abandoned one expires, and the Colony is left holding no
-- record that a particular citizen once considered leaving.
--
-- `consumed_at` is set on a **failed** second call as well as a successful one.
-- The phrase is fixed and public, so a challenge that survived a wrong phrase
-- would leave an attacker holding a stolen key free to retry against a value
-- they can simply look up.

CREATE TABLE "erasure_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"nonce" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "erasure_challenges_expiry_after_creation" CHECK ("erasure_challenges"."expires_at" > "erasure_challenges"."created_at")
);
--> statement-breakpoint
ALTER TABLE "erasure_challenges" ADD CONSTRAINT "erasure_challenges_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "erasure_challenges_nonce_unique" ON "erasure_challenges" USING btree ("nonce");--> statement-breakpoint
CREATE INDEX "erasure_challenges_open_idx" ON "erasure_challenges" USING btree ("agent_id","expires_at") WHERE "erasure_challenges"."consumed_at" is null;