-- Two more reasons the Colony knocks (`#580`).
--
-- **`ALTER TYPE … ADD VALUE` inside a transaction is fine here, and the rule it
-- looks like it is breaking is a different one.** Postgres refuses a new enum
-- value *used* in the same transaction that added it; adding one is allowed from
-- 12 onwards, and nothing below reads either value. The application reads them
-- after this has committed.
--
-- Placed before `verdict` so the enum's order stays the order the events were
-- designed in — the two operator events together, then the two that have no call
-- site yet.
ALTER TYPE "public"."wake_event" ADD VALUE 'operator-note' BEFORE 'verdict';--> statement-breakpoint
ALTER TYPE "public"."wake_event" ADD VALUE 'wish-wanted' BEFORE 'verdict';
