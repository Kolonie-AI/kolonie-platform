-- Every profile written before `#827` landed, queued for the read it never had
-- (`kolonie-platform#1222`).
--
-- `0225` created `agent_profile_reviews` empty and nothing filled it: a review
-- row is only ever written by `queueProfileReview`, which runs on an edit. So a
-- citizen that wrote a careful bio in July and has not touched it since has no
-- row, no published copy, and is therefore absent from its own page and
-- unfindable by any capability it declared -- `publicCitizenRecord` and
-- `byCapability` both read `published` and are right to, so the hole is here
-- and not in either query.
--
-- **`pending`, never `published`.** The whole point of `#827` is that nothing
-- reaches a stranger before a pass has read it, and a backfill that wrote
-- `published` directly would publish the entire pre-`#827` corpus unread in one
-- statement -- exactly the thing the split was built to make impossible. What
-- this does is put those fields where a fresh write would have put them and let
-- the ordinary pass decide.
--
-- **`do nothing`, never `do update`.** A row that already exists was written by
-- a real edit and may be mid-check, approved, or refused; overwriting its
-- `pending` would unpublish a checked value or re-queue a refusal, and this
-- migration knows nothing that `queueProfileReview` did not already know
-- better.
--
-- **Every agent, with no filter on status, type or the three switches.** They
-- all change without touching the profile -- a candidate becomes a citizen, a
-- citizen throws `discoverable` on months later -- and a filter here would
-- reopen precisely this hole for whoever moves afterwards. Nothing is published
-- by queueing, so the cost of being generous is a model call and the cost of
-- being narrow is the bug again.
--
-- Six fields, not the five `#1222` names: `availability` joined
-- `MODERATED_PROFILE_FIELDS` at `#1066`, after the issue was written, and it is
-- moderated and published like the rest.
INSERT INTO "agent_profile_reviews" ("agent_id", "field", "pending", "state")
SELECT "agents"."id", "declared"."field"::"profile_review_field", to_jsonb("declared"."value"), 'pending'
FROM "agents"
CROSS JOIN LATERAL (VALUES
  ('bio', "agents"."bio"),
  ('pronouns', "agents"."pronouns"),
  ('vocation', "agents"."vocation"),
  ('availability', "agents"."availability")
) AS "declared"("field", "value")
WHERE "declared"."value" IS NOT NULL AND btrim("declared"."value") <> ''
ON CONFLICT ("agent_id", "field") DO NOTHING;
--> statement-breakpoint
-- `to_jsonb` on the array and not on its elements: `byCapability` searches with
-- `jsonb_array_elements_text` over `published`, so a list has to arrive as a
-- JSON array of strings, which is what a live write already stores.
INSERT INTO "agent_profile_reviews" ("agent_id", "field", "pending", "state")
SELECT "id", 'capabilities', to_jsonb("capabilities"), 'pending'
FROM "agents"
WHERE array_length("capabilities", 1) > 0
ON CONFLICT ("agent_id", "field") DO NOTHING;
--> statement-breakpoint
-- `avatar` decided, and decided yes -- the third checkbox on `#1222`, which
-- suspected it might want a different backfill or none.
--
-- What is reviewed for this field is not `agents.avatar_url`. `storeAvatar`
-- queues `avatarDescription(image)`, which is `format width x height bytesB`
-- read off the Colony's own copy (`#823`), and that string is a pure function
-- of four columns on `agent_avatars` -- so this reproduces byte for byte what a
-- re-upload would have queued, rather than inventing a value the checker has
-- never been handed.
--
-- Sourced from `agent_avatars` and not from `agents`, which also settles the
-- other half: a citizen holding an `avatar_url` with no stored copy behind it
-- has nothing publishable at all, and queueing the URL would ask a pass to
-- approve a string that is never served.
INSERT INTO "agent_profile_reviews" ("agent_id", "field", "pending", "state")
SELECT "agent_id", 'avatar',
       to_jsonb("format" || ' ' || "width" || 'x' || "height" || ' ' || octet_length("bytes") || 'B'),
       'pending'
FROM "agent_avatars"
ON CONFLICT ("agent_id", "field") DO NOTHING;
