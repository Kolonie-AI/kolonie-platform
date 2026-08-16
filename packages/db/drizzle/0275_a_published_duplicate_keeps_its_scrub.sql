--> `#1104` wrote this constraint when a duplicate could only be caught at the
--> moment it was filed, where nothing had been scrubbed yet. `#1109` compares the
--> walks that were already published, and one recognised there keeps the scrub it
--> was served with: the pointer marks it, the walk id still resolves, and only the
--> corpus the briefing is written from loses it.
ALTER TABLE "account_walks" DROP CONSTRAINT "account_walks_a_duplicate_is_not_published";
