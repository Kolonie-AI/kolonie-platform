import { pgTable, text, timestamp, varchar } from 'drizzle-orm/pg-core'

/**
 * The settings a maintainer has overridden — D-104 (`#488`, `#489`).
 *
 * ## Absence is the ordinary state, and it means *the environment's value*
 *
 * D-104: **the database wins, the environment is the boot default.** A row that
 * does not exist means the variable's value, so a deployment that has never
 * written a setting behaves exactly as it does today and the first write is what
 * starts overriding. That is why there is no `enabled` column and no row seeded
 * per known setting: a table pre-filled with the environment's values would make
 * *has anybody changed this* unanswerable.
 *
 * ## Why the key is a plain varchar and not an enum
 *
 * The closed vocabulary lives in `SETTINGS` in core, which is an **allow-list
 * the read and write paths consult** rather than a shape the column enforces.
 * An enum here would be a second copy of that list — the drift `enums.ts` exists
 * to prevent — and it would make adding a tunable a migration. The guarantee
 * that a secret cannot be written comes from the allow-list, not from this
 * column, and `settings.test.ts` is where that is held to.
 *
 * ## Why the value is text
 *
 * Every one of these is read out of `process.env` today, which is text. Storing
 * a typed column per group would mean four columns of which three are null on
 * every row, and a reader that has to know which one to look in — for values
 * whose parsing already exists at the point of use.
 *
 * ## No provenance column
 *
 * Who changed it and when is `authority_events`, on the rule that table states:
 * a permission is not derivable, and neither is a setting — the value says what
 * it is now and nothing about who decided that. `#485` added
 * `subject_human_id`, which is what a maintainer's write needs. Repeating it
 * here would be two records of one fact.
 */
export const settings = pgTable('settings', {
  /** The environment variable this overrides. Its name is its key. */
  name: varchar('name', { length: 128 }).primaryKey(),
  /**
   * What it is set to, as text.
   *
   * Never null: clearing a setting **deletes the row**, because that is what
   * *back to the environment's value* means. A null here would be a third state
   * between overridden and not, and nothing could say what it meant.
   */
  value: text('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
})
