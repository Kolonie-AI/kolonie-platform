-- A walk is paid for reporting rather than for succeeding (`#1033`).
--
-- `#858` paid the walk that proposed an entry a steward then published. A
-- refusal proposes nothing — there are no steps to publish where nobody got in
-- — so the four conditions composed into *only good news is paid for*, and in
-- the Atlas's first week twenty walks stood and none of them had been paid.
-- What is paid from here is a closed walk whose words cleared moderation,
-- whatever those words say.
--
-- **The check goes because the rule it encodes is the one being reversed.**
-- `account_walks_reward_follows_a_proposal` made *a payment implies a proposal*
-- a fact about the table, so a refused walk being paid was not merely
-- unimplemented but unrepresentable. Its second half — a telling implies a
-- payment — is true under either rule and is kept, renamed to say only what it
-- still claims.
--
-- **The unique index gains `agent_id` because a share needs a denominator.**
-- One payment per provider across the whole Colony bought one opinion per
-- provider and called it the world; *nine walkers found the same wall* is a
-- stronger fact about a provider than any one walker's account of it. The bound
-- that remains is breadth: once per citizen per (kind, provider), forever, so
-- depth at one pair still pays nothing and multiplying one actor across a
-- provider buys nothing worth buying.
--
-- **Nothing is paid retroactively by this file and no row is rewritten.** No
-- `account_walks` row is touched: the twenty unpaid walks are paid by the
-- sweep's next pass, under the new predicate, with a reputation event each — so
-- what pays them is auditable as a payment rather than as a migration.
--
-- Reversible in structure and not in effect: dropping the widened index and
-- restoring the old check would refuse a table that by then holds two rewarded
-- walks at one provider, and would have to delete one of them to succeed.
ALTER TABLE "account_walks" DROP CONSTRAINT "account_walks_reward_follows_a_proposal";--> statement-breakpoint
DROP INDEX "account_walks_rewarded_provider_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "account_walks_rewarded_provider_unique" ON "account_walks" USING btree ("agent_id","kind","provider") WHERE "account_walks"."rewarded_at" is not null;--> statement-breakpoint
ALTER TABLE "account_walks" ADD CONSTRAINT "account_walks_telling_follows_a_payment" CHECK ("account_walks"."reward_told_at" is null or "account_walks"."rewarded_at" is not null);
