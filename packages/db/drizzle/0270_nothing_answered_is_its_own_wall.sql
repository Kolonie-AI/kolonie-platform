-- The walks converted from a `no-service` report are re-typed onto the wall they
-- always described (#1091).
--
-- `0264` turned every provider verdict into the walk it was, and mapped all four
-- refusing outcomes onto wall kind `other` because there was nothing better to
-- map them to. `WALL_KIND_MEANINGS` glosses `other` as *none of the above*, so
-- the clearest finding a walker can bring back — nothing answers behind this
-- name at all — published as the vaguest sentence the Colony can say. `#1091`
-- adds `absent`; `packages/core/src/account/report-as-walk.ts` maps `no-service`
-- onto it from here on, and this catches up the rows already written.
--
-- **Why this re-typing is honest and a wider one would not be.** The `symptom`
-- being matched is not a citizen's sentence: it is a constant this repository
-- wrote, in `CONVERTED_WALL['no-service']`, reproduced to the character in
-- `0264` and written by nothing else. Matched together with
-- `from_provider_report`, the rows it selects are exactly the rows `0264`
-- synthesised from a `no-service` verdict — so this changes the label on a fact
-- the Colony itself asserted, and touches no wall any walker typed. The other
-- three outcomes stay `other`, because for them `other` is true: nobody recorded
-- which wall it was.
--
-- Written against the wall's own object rather than by rebuilding the array, so
-- a converted walk that somehow carries a second wall keeps it. `jsonb_set` on
-- element 0 is safe here for the same reason the match is: `0264` wrote exactly
-- one wall per row.
UPDATE "account_walks"
SET "recipe" = jsonb_set("recipe", '{walls,0,kind}', '"absent"'::jsonb)
WHERE "from_provider_report" = true
  AND "recipe" -> 'walls' -> 0 ->> 'kind' = 'other'
  AND "recipe" -> 'walls' -> 0 ->> 'symptom'
      = 'Nothing answered at this provider — no working service behind the name at all.';
--> statement-breakpoint

-- `provider_recipes.walls` is not rebuilt here, for the reason `0264` gives at
-- length: the published aggregate is `publishWalls`'s, its one caller is
-- `republishWalls`, and reproducing the grouping in SQL would be a second
-- implementation of it. An entry picks the re-typed walk up at its next walk or
-- report, and until then it publishes the count it published yesterday under the
-- old kind — which is what it has been publishing since `0264` either way.
SELECT 1;
