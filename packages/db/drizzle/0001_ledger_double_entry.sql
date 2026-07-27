-- The double-entry invariant: the entries sharing a transaction_id must sum to
-- exactly zero, and there must be at least two of them.
--
-- Why this is not a CHECK constraint: a CHECK sees one row. The invariant spans
-- the whole transaction, so it needs a trigger that can query siblings.
--
-- Why the trigger is DEFERRABLE INITIALLY DEFERRED: the entries of one booking
-- are necessarily inserted one at a time, so the invariant is false in between.
-- It only has to hold when the database transaction commits, which is exactly
-- what a deferred constraint trigger checks. A non-deferred trigger would reject
-- the first INSERT of every valid booking ever written.
--
-- This is the constraint that makes the ledger trustworthy (D-003): total supply
-- is auditable at any moment as the negative of the mint balance, and that only
-- holds if no unbalanced transaction can exist. Written by hand rather than
-- generated, and reviewed as SQL, because it is the most important object in the
-- schema.

CREATE OR REPLACE FUNCTION ledger_assert_balanced() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  affected_transaction uuid := COALESCE(NEW.transaction_id, OLD.transaction_id);
  entry_count bigint;
  entry_sum bigint;
  distinct_references bigint;
BEGIN
  SELECT count(*), COALESCE(sum(amount), 0), count(DISTINCT reference)
    INTO entry_count, entry_sum, distinct_references
    FROM ledger_entries
   WHERE transaction_id = affected_transaction;

  -- A transaction whose rows were all deleted has nothing left to be wrong.
  -- Deleting *some* of them is caught by the sum check below.
  IF entry_count = 0 THEN
    RETURN NULL;
  END IF;

  IF entry_count < 2 THEN
    RAISE EXCEPTION
      'ledger transaction % has % entries, but double-entry requires at least 2',
      affected_transaction, entry_count
      USING ERRCODE = 'check_violation';
  END IF;

  IF entry_sum <> 0 THEN
    RAISE EXCEPTION
      'ledger transaction % sums to %, but double-entry requires 0',
      affected_transaction, entry_sum
      USING ERRCODE = 'check_violation';
  END IF;

  -- There is no ledger_transactions table, so `reference` is carried on every
  -- entry of the set. That is only sound if the set agrees with itself —
  -- otherwise a booking would have two answers to "what caused this?" and the
  -- audit trail would be worth less than no audit trail at all.
  IF distinct_references > 1 THEN
    RAISE EXCEPTION
      'ledger transaction % carries % different references; the entries of one transaction must agree',
      affected_transaction, distinct_references
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER ledger_entries_balanced
  AFTER INSERT OR UPDATE OR DELETE ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_assert_balanced();
