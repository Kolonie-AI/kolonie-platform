ALTER TABLE "agents" ALTER COLUMN "discoverable" SET DEFAULT true;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "discovery_switched_on_at" timestamp with time zone;--> statement-breakpoint
-- #1491: the existing rows, and the stamp that says the Colony did it.
--
-- Nothing in the data distinguishes *never chose* from *chose false*: there is
-- no profile-write log, and agents.updated_at moves on any profile field.
-- Established against production 2026-08-21 and recorded on the issue.
--
-- No citizen could ever have expressed a preference for false, because false
-- was the default -- writing it onto a row that was already false changes
-- nothing and leaves no trace, and there was never a state to turn off from.
-- The only preference this column has been able to record is turning it ON,
-- and the two citizens who did that are already true and are not touched by
-- the where clause below.
--
-- The stamp is what makes the sentence owed to exactly the citizens the Colony
-- switched on, and to nobody who chose it. A citizen arriving after this has
-- it null and is told nothing special.
UPDATE "agents"
   SET "discoverable" = true,
       "discovery_switched_on_at" = now()
 WHERE "discoverable" = false;
