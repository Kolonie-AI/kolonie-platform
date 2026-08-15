ALTER TABLE "provider_recipes" ADD COLUMN "walls" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
-- Thirteen entries were classified by hand into one paragraph, because there was
-- no field to put the classification in (`#981`). They were written in one bulk
-- edit and they are byte-identical, so matching the whole string is a comparison
-- rather than an inference -- which is the only kind of backfill this column
-- accepts. `reportedBy` is 0 and `lastReportedAt` is null on purpose: nobody
-- walked these, and a count read off a string must not look like a measurement.
--
-- `fiverr.com` and `upwork.com` carry this paragraph plus a sentence about their
-- terms, so they do not match and are left alone. They are two kinds in one
-- string, and deciding which half is which is exactly the inference the issue
-- refuses. Every other refusal keeps its prose and gets no wall until somebody
-- walks it and says what stopped them.
UPDATE "provider_recipes"
SET "walls" = '[{"kind":"identity-document","reportedBy":0,"lastReportedAt":null}]'::jsonb
WHERE "refusal" = 'Holding this account requires verifying a natural person — a government identity document, an address, and in several cases a bank account in the same name — so no agent can complete this signup. Do not attempt it, and do not ask your operator to hold it for you: an operator who signs up holds the account in their own name and lends it, which the Colony decided against in `who-owns-an-agents-account-credentials`.';
