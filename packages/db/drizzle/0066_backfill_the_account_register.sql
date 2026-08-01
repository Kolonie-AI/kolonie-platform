-- Fill the account register from the evidence that already exists.
--
-- `0065` created the table; nothing put a row in it, and a register that starts
-- empty is worse than no register: every read would answer *this citizen holds
-- nothing* about citizens that hold six things, and the first thing built on top
-- of it would be built on that answer.
--
-- ## Where each identifier actually lives, which is not where #150 said
--
-- The issue names six challenge tables. Two of them carry the identifier —
-- `email_challenges.address` and `solana_wallet_challenges.address` — and four
-- do not: `github_challenges`, `social_challenges`, `domain_challenges` and
-- `website_challenges` hold a nonce and an expiry, because on those rungs the
-- thing being proved is published *outside* the Colony and the identifier is
-- whatever the verifier admitted. So it lives on the verdict, under the key that
-- verifier writes, and `citizenForGithubAuthor`, `socialAccountOf` and
-- `domainGrantOf` already read it exactly this way.
--
--     github    verifications.metadata->>'author'
--     social    verifications.metadata->>'account'
--     domain    verifications.metadata->>'name'
--     website   submissions.payload->>'url'   -- website-verify records no metadata
--
-- `website` is the odd one and it is worth stating rather than hiding: that
-- verifier returns a verdict and no metadata, so the only record of *which URL*
-- is the payload the citizen submitted. It is trustworthy here for one narrow
-- reason — the verdict passed, and it passed by fetching that URL and finding
-- the Colony's token in it (D-018 is about what a verifier *reads*, and this
-- reads the payload's URL rather than believing a claim about it).
--
-- ## Joining through the grant, not through the task type
--
-- `agent_skills` is one row per (agent, skill) carrying the submission that
-- earned it, and every reader in `verifications.ts` joins that way for a reason
-- given at length there: a query keyed on what a task's `grants_skills` says
-- *today* answers nothing for accounts certified through a task that has since
-- been changed. `github-contribution` granted `github` until 2026-07-29 and is a
-- badge now. The grant happened; the row recording it is permanent.
--
-- ## What this deliberately does not do
--
-- No verifier changes, no rewrite of any challenge table, and nothing here
-- writes a preference. `preferred` stays false everywhere: for mail the reach
-- address is `email_challenges.primary_at` and stays there, and for every other
-- kind a preference is the citizen's to express — inventing one on its behalf
-- would be the Colony deciding which of a citizen's handles it likes.
--
-- Provenance is `self-acquired` for every row, by column default. Nothing that
-- exists today came through a quest, because no quest exists.
--
-- `on conflict do nothing` throughout, so this is safe to re-run and cannot
-- clobber a row written between the deploy and the migration.

-- Mailboxes, from the proof log. `receive` is what an `inbox` verdict proves;
-- `send` is added where the badge was passed for the same mailbox, compared with
-- the same `mailboxIdentity` expression the unique index is built on, because
-- two comparisons of one pair of addresses disagreeing would be its own bug.
INSERT INTO "accounts" ("agent_id", "kind", "identifier", "proved", "proved_at", "capabilities")
SELECT
    inbox."agent_id",
    'mailbox',
    inbox."address",
    true,
    inbox."verified_at",
    CASE WHEN EXISTS (
        SELECT 1 FROM "email_challenges" sent
         WHERE sent."agent_id" = inbox."agent_id"
           AND sent."purpose" = 'send'
           AND sent."verified_at" IS NOT NULL
           AND (split_part(split_part(lower(sent."address"), '@', 1), '+', 1) || '@' || split_part(lower(sent."address"), '@', 2))
             = (split_part(split_part(lower(inbox."address"), '@', 1), '+', 1) || '@' || split_part(lower(inbox."address"), '@', 2))
    ) THEN ARRAY['receive', 'send'] ELSE ARRAY['receive'] END
FROM "email_challenges" inbox
WHERE inbox."purpose" = 'inbox' AND inbox."verified_at" IS NOT NULL
ON CONFLICT DO NOTHING;

-- Wallets, from the proof log. `sign` and nothing else: the rung certifies that
-- a keypair signed the Colony's nonce, which says nothing about what the wallet
-- holds or may spend.
INSERT INTO "accounts" ("agent_id", "kind", "identifier", "proved", "proved_at", "capabilities")
SELECT "agent_id", 'wallet', "address", true, "verified_at", ARRAY['sign']
FROM "solana_wallet_challenges"
WHERE "verified_at" IS NOT NULL AND "address" IS NOT NULL
ON CONFLICT DO NOTHING;

-- GitHub, from the grant. `control` rather than `publish`: D-031 split those
-- two, and holding the account is what this skill certifies.
INSERT INTO "accounts" ("agent_id", "kind", "identifier", "proved", "proved_at", "capabilities")
SELECT s."agent_id", 'github', v."metadata"->>'author', true, s."granted_at", ARRAY['control']
FROM "agent_skills" s
JOIN "verifications" v ON v."submission_id" = s."submission_id"
WHERE s."skill" = 'github' AND v."status" = 'pass' AND v."metadata"->>'author' IS NOT NULL
ON CONFLICT DO NOTHING;

-- Social, from the grant. `publish` is what a public network account is for, and
-- it is the capability `social-post` reads one node along.
INSERT INTO "accounts" ("agent_id", "kind", "identifier", "proved", "proved_at", "capabilities")
SELECT s."agent_id", 'social', v."metadata"->>'account', true, s."granted_at", ARRAY['publish']
FROM "agent_skills" s
JOIN "verifications" v ON v."submission_id" = s."submission_id"
WHERE s."skill" = 'social' AND v."status" = 'pass' AND v."metadata"->>'account' IS NOT NULL
ON CONFLICT DO NOTHING;

-- Domains, from the grant.
INSERT INTO "accounts" ("agent_id", "kind", "identifier", "proved", "proved_at", "capabilities")
SELECT s."agent_id", 'domain', v."metadata"->>'name', true, s."granted_at", ARRAY['control']
FROM "agent_skills" s
JOIN "verifications" v ON v."submission_id" = s."submission_id"
WHERE s."skill" = 'domain' AND v."status" = 'pass' AND v."metadata"->>'name' IS NOT NULL
ON CONFLICT DO NOTHING;

-- Websites, from the submission the grant points at. See the note above on why
-- this one reads a payload where the others read a verdict.
INSERT INTO "accounts" ("agent_id", "kind", "identifier", "proved", "proved_at", "capabilities")
SELECT s."agent_id", 'website', sub."payload"->>'url', true, s."granted_at", ARRAY['control']
FROM "agent_skills" s
JOIN "submissions" sub ON sub."id" = s."submission_id"
WHERE s."skill" = 'website' AND sub."payload"->>'url' IS NOT NULL
ON CONFLICT DO NOTHING;
