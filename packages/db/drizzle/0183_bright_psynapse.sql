-- Three more states for an Atlas entry, and the two columns a withdrawal needs
-- (kolonie-platform#604).
--
-- REVERSIBLE, and in one transaction. #604 warned that `ALTER TYPE … ADD VALUE`
-- cannot use a new value in the same transaction and that the migration would
-- have to be split around it. It does not apply here: #588 made `status` a
-- `text` column with a check constraint rather than a `pg_enum`, for exactly
-- this operational reason, so adding three states is one DROP CONSTRAINT and
-- one ADD CONSTRAINT. Going back is the same two statements with the old list,
-- plus `DROP COLUMN retired_at, retired_reason`.
--
-- EXISTING ROWS KEEP THEIR MEANING. Every row is `joinable`, `refused` or
-- `unwritten` today; all three remain in the list, none of their constraints
-- loosened in a direction that changes what an existing row says, and the two
-- new columns are null on every one of them — which is what the new constraint
-- requires of any non-retired row.
--
-- The one loosening is `provider_recipes_joinable_has_steps`, which now also
-- admits `draft`: a state that reaches no public surface and did not exist when
-- these rows were written.
--
-- NUMBERED 0183 AND NOT 0182. It was 0182 until another session landed its own
-- 0182 first. AGENTS.md §3 is explicit that the fix is to delete the later
-- migration and regenerate it rather than to edit a number or a `when` — a
-- hand-renumbered journal reads correctly and applies in a different order than
-- it reads.

ALTER TABLE "provider_recipes" DROP CONSTRAINT "provider_recipes_status_is_known";--> statement-breakpoint
ALTER TABLE "provider_recipes" DROP CONSTRAINT "provider_recipes_refusal_says_why";--> statement-breakpoint
ALTER TABLE "provider_recipes" DROP CONSTRAINT "provider_recipes_joinable_has_steps";--> statement-breakpoint
ALTER TABLE "provider_recipes" DROP CONSTRAINT "provider_recipes_unjoinable_is_empty";--> statement-breakpoint
ALTER TABLE "provider_recipes" ADD COLUMN "retired_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "provider_recipes" ADD COLUMN "retired_reason" text;--> statement-breakpoint
ALTER TABLE "provider_recipes" ADD CONSTRAINT "provider_recipes_retirement_says_when_and_why" CHECK (("provider_recipes"."status" = 'retired'
           and "provider_recipes"."retired_at" is not null
           and "provider_recipes"."retired_reason" is not null)
          or ("provider_recipes"."status" <> 'retired'
              and "provider_recipes"."retired_at" is null
              and "provider_recipes"."retired_reason" is null));--> statement-breakpoint
ALTER TABLE "provider_recipes" ADD CONSTRAINT "provider_recipes_status_is_known" CHECK ("provider_recipes"."status" in ('proposed', 'unwritten', 'draft', 'joinable', 'refused', 'retired'));--> statement-breakpoint
ALTER TABLE "provider_recipes" ADD CONSTRAINT "provider_recipes_refusal_says_why" CHECK ("provider_recipes"."status" = 'retired'
          or ("provider_recipes"."status" = 'refused' and "provider_recipes"."refusal" is not null)
          or ("provider_recipes"."status" <> 'refused' and "provider_recipes"."refusal" is null));--> statement-breakpoint
ALTER TABLE "provider_recipes" ADD CONSTRAINT "provider_recipes_joinable_has_steps" CHECK ("provider_recipes"."status" not in ('joinable', 'draft')
          or (jsonb_array_length("provider_recipes"."steps") between 1 and 20
              and ("provider_recipes"."status" = 'draft' or "provider_recipes"."proves" is not null)));--> statement-breakpoint
ALTER TABLE "provider_recipes" ADD CONSTRAINT "provider_recipes_unjoinable_is_empty" CHECK ("provider_recipes"."status" in ('joinable', 'draft', 'retired')
          or (jsonb_array_length("provider_recipes"."steps") = 0 and "provider_recipes"."proves" is null));