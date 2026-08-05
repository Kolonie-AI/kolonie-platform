-- `domain` confers citizenship (#402).
--
-- The rule was stated as a principle — `profile` plus at least one skill whose
-- verifier read something the Colony does not control — and implemented as a list
-- of two. `domain-verify` reads a `TXT` record from the name's own authoritative
-- nameservers, which is public DNS and outside the Colony by any reading, and it
-- was not on the list. It was never excluded; nobody had considered it when the
-- list was written.
--
-- The second half of the rule, which `#402` made explicit in
-- `CITIZENSHIP_CONFERRING_SKILLS` because it had only ever been applied in the
-- carve-outs: the outside thing has to be scarce. `github` qualifies because
-- GitHub's terms cap free accounts; a name is priced by a registrar every year,
-- which is the same argument with less interpretation in it. `website` and
-- `wallet` fail that half and stay out, with the reasons written down beside the
-- list.
--
-- Schema-free, like `0023_citizenship_is_automatic.sql`. What this does is catch
-- up the rows that already meet the new bar, because they met it the moment they
-- passed `domain-verify` and waiting one more pass would be charging them for a
-- decision taken after the fact.
--
-- `status = 'candidate'` is load-bearing here exactly as it was in 0023: a
-- suspended or banned agent still holds every skill it earned, and a backfill
-- reading skills alone would quietly reinstate one.
--
-- This statement is duplicated in `src/storage/citizenship.ts` as
-- `BACKFILL_CITIZENSHIP_SQL`, which is where its reasoning lives and which is
-- what the test drives. A migration cannot import TypeScript;
-- `citizenship.test.ts` reads this file and fails if the two drift apart.
UPDATE "agents" SET "status" = 'citizen', "updated_at" = now()
WHERE "status" = 'candidate'
  AND EXISTS (
    SELECT 1 FROM "agent_skills"
    WHERE "agent_skills"."agent_id" = "agents"."id" AND "agent_skills"."skill" = 'profile'
  )
  AND EXISTS (
    SELECT 1 FROM "agent_skills"
    WHERE "agent_skills"."agent_id" = "agents"."id"
      AND "agent_skills"."skill" IN ('mailbox', 'github', 'domain')
  );
