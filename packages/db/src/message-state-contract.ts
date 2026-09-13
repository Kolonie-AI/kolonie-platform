import { sql } from 'drizzle-orm'
import type { Database } from './client.js'

/** The generated contract migration that closes the retraction expand window (`#1961`). */
export const MESSAGE_STATE_CONTRACT_MIGRATION = '0373_yellow_lorna_dane.sql'

/**
 * The row predicate shared by the schema CHECK and the migration preflight.
 *
 * Exactly one state is valid: an active message has a body and no retraction
 * timestamp; a retracted message has a timestamp and no body. Kept as SQL text
 * because a migration cannot import TypeScript, while a test can still prove the
 * text it drives is the text the migration ran.
 */
export const MESSAGE_STATE_PREDICATE_SQL =
  '("body" IS NOT NULL AND "retracted_at" IS NULL) OR ("body" IS NULL AND "retracted_at" IS NOT NULL)'

/** The one constraint this contract migration adds. */
export const MESSAGE_STATE_CONSTRAINT_NAME = 'messages_active_or_retracted'

/** The generated DDL, named so the test can compare and execute the exact statement. */
export const ADD_MESSAGE_STATE_CONSTRAINT_SQL =
  `ALTER TABLE "messages" ADD CONSTRAINT "${MESSAGE_STATE_CONSTRAINT_NAME}" ` +
  `CHECK (${MESSAGE_STATE_PREDICATE_SQL});`

/**
 * The complete rollback: remove only the CHECK.
 *
 * A rollback cannot restore erased bodies and must not touch a message's id,
 * timestamp or position. Keeping the statement this narrow makes that property
 * visible and lets the integration test prove it against both legal states.
 */
export const DROP_MESSAGE_STATE_CONSTRAINT_SQL = `ALTER TABLE "messages" DROP CONSTRAINT "${MESSAGE_STATE_CONSTRAINT_NAME}";`

/**
 * Refuse the contract migration when any existing message is in neither state.
 *
 * ## Why this raises instead of repairing
 *
 * `body = null, retracted_at = null` and `body != null, retracted_at != null`
 * carry no trustworthy intent. Synthesising a timestamp would invent a
 * retraction; keeping a body would undo one. The migration therefore counts and
 * stops, naming the issue and the number of rows somebody must diagnose.
 */
export const MESSAGE_STATE_PREFLIGHT_SQL = `DO $$
DECLARE offending bigint;
BEGIN
  SELECT count(*) INTO offending
  FROM "messages"
  WHERE NOT (${MESSAGE_STATE_PREDICATE_SQL});
  IF offending > 0 THEN
    RAISE EXCEPTION 'kolonie-platform#1961 cannot enforce messages_active_or_retracted: % message row(s) are neither exactly active nor exactly retracted; diagnose them rather than rewriting bodies, timestamps, or message ids.', offending;
  END IF;
END $$;`

/** Run the exact guard a deployment runs before it adds the CHECK. */
export async function assertMessagesAreActiveOrRetracted(db: Database): Promise<void> {
  await db.execute(sql.raw(MESSAGE_STATE_PREFLIGHT_SQL))
}
