ALTER TABLE "task_briefings" ADD COLUMN "contributors" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "task_briefings" ADD COLUMN "contributors_withheld" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "task_briefings" ADD CONSTRAINT "task_briefings_contributors_is_array" CHECK (jsonb_typeof("task_briefings"."contributors") = 'array');--> statement-breakpoint
ALTER TABLE "task_briefings" ADD CONSTRAINT "task_briefings_contributors_withheld_positive" CHECK ("task_briefings"."contributors_withheld" >= 0);--> statement-breakpoint
--
-- The corpus that already exists is attributed too (#958, decided 2026-08-15).
--
-- Waiting for the next synthesis would leave every briefing the Colony has
-- written naming nobody until its task next changed, which on a quiet rung is
-- never — the citizens whose afternoons are already in these write-ups would be
-- the only ones never credited for them.
--
-- Same rule as `contributorsOf` in `storage/briefing.ts`, and the two have to
-- stay the same rule: the sources of each stored claim, their merged children
-- as well as the survivors, resolved to an author by coalescing the attempt,
-- split on `agents.attributed`.
--
UPDATE "task_briefings" b
   SET "contributors" = coalesce(found.handles, '[]'::jsonb),
       "contributors_withheld" = coalesce(found.withheld, 0)
  FROM (
    SELECT fed.task_id,
           jsonb_agg(DISTINCT author.name) FILTER (WHERE author.attributed) AS handles,
           count(DISTINCT author.id) FILTER (WHERE NOT author.attributed) AS withheld
      FROM (
        SELECT written.task_id, source.value #>> '{}' AS report_id
          FROM "task_briefings" written,
               LATERAL jsonb_array_elements(written.claims) AS claim(value),
               LATERAL jsonb_array_elements(claim.value -> 'sources') AS source(value)
      ) fed
      JOIN "task_reports" reported
        ON reported.id::text = fed.report_id OR reported.duplicate_of::text = fed.report_id
      LEFT JOIN "task_attempts" tried ON tried.id = reported.attempt_id
      JOIN "agents" author ON author.id = coalesce(tried.agent_id, reported.agent_id)
     GROUP BY fed.task_id
  ) found
 WHERE b.task_id = found.task_id;