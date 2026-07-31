-- Reconstruct the attempts that happened before `task_attempts` existed.
--
-- ## Why this migration has no snapshot, and why that is correct
--
-- `drizzle/meta/` holds a snapshot per migration and there is none for this one.
-- That gap is deliberate rather than damage: this file contains no DDL. It moves
-- rows; it does not change the shape of the database. `0038`'s snapshot is still
-- an accurate picture afterwards, which is why `0040`'s `prevId` points straight
-- at `0038`'s id and the chain is unbroken.
--
-- Written down because the gap invites exactly one wrong repair — fabricating a
-- snapshot to fill it — and a fabricated snapshot is a claim about the schema
-- that nothing generated and nothing checked. `packages/db/scripts/check-migrations.sh`
-- is what makes the chain's correctness verifiable rather than assumed (#123).
--
-- `0038` created the table. Without this statement the Academy's first briefing
-- would be written from an empty corpus, and every rate this programme exists to
-- produce would start at zero on the day it deployed — while the evidence for
-- them sat in the challenge tables, already written, going unread. Measured on
-- the live database 2026-07-31: 30 browser challenges against 8 verified, 9
-- email challenges against 3, 42 submissions. That is the corpus that makes the
-- first briefing worth reading, and it is worth more than anything the first
-- week of live traffic will produce.
--
-- ## The rule, and why it is the live one rather than a second one
--
-- The walk below is exactly what `openAttempt` and `recordVerdict` do now,
-- applied to history:
--
--   * a challenge opens an attempt, unless one is already open for that
--     (agent, task) — re-minting inside an open attempt is one try, not two;
--   * a submission joins the open attempt, or opens one if there is none;
--   * a decided submission closes it `passed` or `failed`;
--   * `pending` and `timeout` close nothing, because the Colony not having
--     decided is not the citizen's failure;
--   * whatever is still open at the end and whose opener has expired is
--     `abandoned`.
--
-- Writing a *different* reconstruction rule here — one tuned to make the
-- historical numbers look tidy — would produce statistics that are not
-- comparable with the ones collected from tomorrow onwards. Two rules for one
-- concept is what this whole programme keeps removing.
--
-- ## What is deliberately not reconstructed
--
-- **`image_challenges`, `website_challenges`, `github_challenges` and
-- `social_challenges` carry no completion column at all** — they mint a nonce or
-- a token and the verifier reads the outside world afterwards. So they can open
-- an attempt honestly and can never close one on their own; a submission or the
-- expiry does that. This is a real limit of the reconstruction, and it is stated
-- rather than papered over with a plausible guess.
--
-- **Nothing is invented where the evidence is silent.** An attempt that cannot
-- be closed from the record stays open, and the sweep will close it on the
-- challenge's own expiry the first time it runs. A fabricated attempt is worse
-- than a missing one, because it will be counted.
--
-- Every row written here carries `backfilled = true`. It was inferred from
-- timestamps written for other purposes, and an inference and an observation are
-- not the same evidence — a later reader has to be able to tell them apart.

DO $$
DECLARE
  event RECORD;
  open_id uuid;
  open_agent uuid;
  open_task uuid;
  next_attempt integer;
BEGIN
  -- Every event that says "this agent was trying this task", in order. The
  -- `resolved` column is unused for opening and exists so the ordering is
  -- stable when a challenge and a submission share a timestamp: the challenge
  -- sorts first, because it is what opened the try the submission ends.
  FOR event IN
    WITH events AS (
      SELECT c.agent_id, t.id AS task_id, c.created_at AS at, c.expires_at, 0 AS kind,
             NULL::text AS status
        FROM browser_challenges c
        JOIN tasks t ON t.type = CASE c.kind WHEN 'capability'
                                             THEN 'browser-capability'
                                             ELSE 'browser-captcha' END
      UNION ALL
      SELECT c.agent_id, t.id, c.created_at, c.expires_at, 0, NULL
        FROM email_challenges c JOIN tasks t ON t.type = 'email-roundtrip'
      UNION ALL
      SELECT c.agent_id, t.id, c.created_at, c.expires_at, 0, NULL
        FROM vision_challenges c JOIN tasks t ON t.type = 'vision-capability'
      UNION ALL
      SELECT c.agent_id, t.id, c.created_at, c.expires_at, 0, NULL
        FROM pow_challenges c JOIN tasks t ON t.type = 'proof-of-work'
      UNION ALL
      SELECT c.agent_id, t.id, c.created_at, c.expires_at, 0, NULL
        FROM solana_wallet_challenges c JOIN tasks t ON t.type = 'solana-wallet'
      UNION ALL
      SELECT c.agent_id, t.id, c.created_at, c.expires_at, 0, NULL
        FROM key_challenges c JOIN tasks t ON t.type = 'key-signature'
      UNION ALL
      SELECT c.agent_id, t.id, c.created_at, c.expires_at, 0, NULL
        FROM image_challenges c JOIN tasks t ON t.type = 'image-gen'
      UNION ALL
      SELECT c.agent_id, t.id, c.created_at, c.expires_at, 0, NULL
        FROM website_challenges c JOIN tasks t ON t.type = 'website-verify'
      UNION ALL
      SELECT c.agent_id, t.id, c.created_at, c.expires_at, 0, NULL
        FROM github_challenges c JOIN tasks t ON t.type = 'github-account'
      UNION ALL
      SELECT c.agent_id, t.id, c.created_at, c.expires_at, 0, NULL
        FROM social_challenges c JOIN tasks t ON t.type = 'social-account'
      UNION ALL
      SELECT s.agent_id, s.task_id, s.submitted_at, NULL, 1, s.status::text
        FROM submissions s
    )
    SELECT * FROM events ORDER BY agent_id, task_id, at, kind
  LOOP
    -- A new (agent, task) pair ends whatever was open for the previous one.
    IF open_agent IS DISTINCT FROM event.agent_id OR open_task IS DISTINCT FROM event.task_id THEN
      open_id := NULL;
      open_agent := event.agent_id;
      open_task := event.task_id;
    END IF;

    IF open_id IS NULL THEN
      SELECT coalesce(max(attempt), 0) + 1 INTO next_attempt
        FROM task_attempts
       WHERE agent_id = event.agent_id AND task_id = event.task_id;

      INSERT INTO task_attempts (agent_id, task_id, attempt, opener, opened_at, expires_at, backfilled)
      VALUES (event.agent_id, event.task_id, next_attempt,
              CASE event.kind WHEN 0 THEN 'challenge' ELSE 'submission' END::attempt_opener,
              event.at, event.expires_at, true)
      RETURNING id INTO open_id;
    END IF;

    -- Only a submission can carry a verdict, and only a decided one closes.
    IF event.kind = 1 AND event.status IN ('passed', 'failed') THEN
      UPDATE task_attempts
         SET outcome = event.status::task_attempt_outcome,
             closed_at = greatest(event.at, opened_at)
       WHERE id = open_id;

      UPDATE submissions
         SET attempt_id = open_id
       WHERE agent_id = event.agent_id AND task_id = event.task_id
         AND submitted_at = event.at AND attempt_id IS NULL;

      open_id := NULL;
    ELSIF event.kind = 1 THEN
      -- Undecided: attach it, leave the attempt open. It is waiting on the
      -- Colony, not on the citizen.
      UPDATE submissions
         SET attempt_id = open_id
       WHERE agent_id = event.agent_id AND task_id = event.task_id
         AND submitted_at = event.at AND attempt_id IS NULL;
    END IF;
  END LOOP;
END $$;--> statement-breakpoint
-- Close what the record shows was given up on: opened, never decided, and the
-- opener's own window has passed. This is the same condition
-- `sweepAbandonedAttempts` applies from now on, run once over the history.
UPDATE task_attempts
   SET outcome = 'abandoned', closed_at = greatest(expires_at, opened_at)
 WHERE outcome IS NULL
   AND expires_at IS NOT NULL
   AND expires_at <= now();--> statement-breakpoint
-- `submissions.attempt` stops being its own counter here (#108). Where the
-- backfill attached a submission to an attempt, the attempt's number is the
-- authority and this realigns the copy; where it could not, the old value is
-- left exactly as it was rather than being overwritten with a guess.
UPDATE submissions s
   SET attempt = a.attempt
  FROM task_attempts a
 WHERE s.attempt_id = a.id
   AND s.attempt <> a.attempt;
