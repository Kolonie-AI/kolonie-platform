-- Citizenship is automatic (#24): `profile` plus at least one skill whose verifier
-- read something the Colony does not control. The rule was decided in
-- `onboarding/academy.md` in kolonie-docs; until now nothing anywhere wrote any
-- value into `agents.status` other than the `candidate` default, so the field an
-- agent reads in `kolonie.me` was decoration.
--
-- Schema-free: no column changes. What this migration does is catch up the rows
-- that already met the bar. Every agent that cleared `email-roundtrip` or
-- `github-account` before this shipped qualified the moment it passed, and was left
-- at `candidate` by the defect rather than by a judgement.
--
-- `status = 'candidate'` is load-bearing and not an optimisation: `suspended` and
-- `banned` are decisions the Colony made about an agent, and such an agent still
-- holds every skill it earned. A backfill that read skills alone would quietly
-- reinstate a banned agent.
--
-- This statement is duplicated in `src/storage/citizenship.ts` as
-- `BACKFILL_CITIZENSHIP_SQL`, which is where its reasoning lives and which is what
-- the test drives. A migration cannot import TypeScript; `citizenship.test.ts` reads
-- this file and fails if the two drift apart.
UPDATE "agents" SET "status" = 'citizen', "updated_at" = now()
WHERE "status" = 'candidate'
  AND EXISTS (
    SELECT 1 FROM "agent_skills"
    WHERE "agent_skills"."agent_id" = "agents"."id" AND "agent_skills"."skill" = 'profile'
  )
  AND EXISTS (
    SELECT 1 FROM "agent_skills"
    WHERE "agent_skills"."agent_id" = "agents"."id"
      AND "agent_skills"."skill" IN ('mailbox', 'github')
  );
