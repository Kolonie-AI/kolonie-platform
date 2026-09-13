ALTER TABLE "workplace_boards" ADD COLUMN "starter_retired_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workplace_recurrence_rules" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
-- #1946. Retire the V1 starter pack on every default board that already crossed
-- the boundary before this deploy, so an established citizen does not have to
-- create one more card to stop competing with onboarding copy.
--
-- Qualifying is structured provenance only, never a title or a body: the board
-- holds an ordinary card the citizen created through the public path
-- (`seed_key is null` and not a recurrence clone), or it holds a practicum card.
-- A recurrence clone carries no `seed_key`, which is why the occurrence table is
-- what excludes it — testing the prefix alone would read the weekly duplicate as
-- self-authored work and retire a board nobody has touched.
CREATE TEMPORARY TABLE starter_retirement_boards ON COMMIT DROP AS
SELECT b.id
  FROM workplace_boards b
 WHERE b.kind = 'default'
   AND b.archived_at IS NULL
   AND b.starter_retired_at IS NULL
   AND (
     EXISTS (
       SELECT 1
         FROM workplace_cards c
        WHERE c.board_id = b.id
          AND c.seed_key IS NULL
          AND NOT EXISTS (
            SELECT 1
              FROM workplace_recurrence_occurrences o
             WHERE o.card_id = c.id
          )
     )
     OR EXISTS (
       SELECT 1
         FROM workplace_cards c
        WHERE c.board_id = b.id
          AND c.seed_key LIKE 'practicum:%'
     )
   );--> statement-breakpoint
-- The starter recurrence rules of those boards, found through the template card
-- that carries the seed key. They are archived rather than deleted, so the
-- occurrence rows keep pointing at a rule that still exists.
CREATE TEMPORARY TABLE starter_retirement_rules ON COMMIT DROP AS
SELECT r.id
  FROM workplace_recurrence_rules r
  JOIN workplace_cards c ON c.id = r.card_id
 WHERE r.board_id IN (SELECT id FROM starter_retirement_boards)
   AND c.seed_key LIKE 'v1:%';--> statement-breakpoint
-- Live, uncompleted starter instances: the seeded templates and the clones the
-- weekly rule materialised from them. A Done starter is left alone — it is the
-- citizen's own history and stays readable and searchable.
CREATE TEMPORARY TABLE starter_retirement_cards ON COMMIT DROP AS
SELECT c.id, c.board_id, c.status
  FROM workplace_cards c
 WHERE c.board_id IN (SELECT id FROM starter_retirement_boards)
   AND c.archived_at IS NULL
   AND c.status <> 'done'
   AND (
     c.seed_key LIKE 'v1:%'
     OR EXISTS (
       SELECT 1
         FROM workplace_recurrence_occurrences o
        WHERE o.card_id = c.id
          AND o.rule_id IN (SELECT id FROM starter_retirement_rules)
     )
   );--> statement-breakpoint
UPDATE workplace_cards c
   SET archived_at = now(),
       version = c.version + 1,
       updated_at = now()
  FROM starter_retirement_cards s
 WHERE c.id = s.id;--> statement-breakpoint
-- A commitment focused on a card this retires loses its focus and is told so,
-- the same way archiving one through storage reports it.
UPDATE workplace_commitments m
   SET focus_card_id = NULL,
       focus_lost = true,
       version = m.version + 1,
       updated_at = now()
  FROM starter_retirement_cards s
 WHERE m.focus_card_id = s.id;--> statement-breakpoint
-- Canonical history, in the same shape storage appends: the archive is an event
-- with the lane it left, attributed to the Colony rather than to the citizen,
-- and not `legacy` — this is a real act and nothing is being reconstructed.
INSERT INTO workplace_activity (board_id, card_id, actor_id, actor_kind, verb, legacy, payload)
SELECT s.board_id, s.id, NULL, 'system', 'card.archived', false,
       jsonb_build_object('fromStatus', s.status)
  FROM starter_retirement_cards s;--> statement-breakpoint
UPDATE workplace_recurrence_rules r
   SET archived_at = now(),
       updated_at = now()
 WHERE r.id IN (SELECT id FROM starter_retirement_rules)
   AND r.archived_at IS NULL;--> statement-breakpoint
UPDATE workplace_boards b
   SET starter_retired_at = now(),
       version = b.version + 1,
       updated_at = now()
 WHERE b.id IN (SELECT id FROM starter_retirement_boards);
