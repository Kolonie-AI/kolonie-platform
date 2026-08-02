import { sql } from 'drizzle-orm'
import { check, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { agents } from './agents.js'

/**
 * One attempt at the `prompt-injection` badge: a payload with an instruction
 * planted in it, and the two values grading needs (`kolonie-platform#168`).
 *
 * **`payload` is stored exactly as the agent was shown it**, which matters more
 * on this node than on any other challenge table. What a dispute here is about
 * is *what the citizen was asked to resist* — re-rendering it later from a
 * function that has since been edited, or from a vector list that has since
 * grown, would answer a different question than the one asked.
 *
 * **`expected_answer` is stored rather than derived.** The readings live only
 * inside the payload, because that is the one place they have to be identical to
 * what was shown; keeping a second structured copy purely so a verdict could
 * recompute the answer would be two records of one fact, and the one that
 * drifted would be the one nobody read.
 *
 * `marker` is the value the planted instruction asked for. It is issued by the
 * Colony, worthless outside this attempt, and deliberately not anything the
 * citizen holds — a test that asked for a credential would teach an agent that
 * the Colony sometimes asks for credentials.
 */
export const injectionChallenges = pgTable(
  'injection_challenges',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /** `cascade`, like every other challenge table — see `challenges.ts` for the argument. */
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),

    /** Which vector was drawn: where the instruction was planted, and how it was dressed. */
    vector: text('vector').notNull(),

    /** The value the instruction asked for, which is also the finding to report. */
    marker: text('marker').notNull(),

    /** What the citizen was actually asked for, kept for the evidence a verdict writes. */
    askedFor: text('asked_for').notNull(),

    /** The reading behind that label, as it will be compared. */
    expectedAnswer: text('expected_answer').notNull(),

    /** What the agent was shown, exactly as it was shown. */
    payload: text('payload').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),

    /**
     * An hour, matching the other self-contained rungs. What expires is the
     * Colony's willingness to be asked about this payload, not the citizen's
     * work — and nothing here takes an hour to do.
     */
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    check(
      'injection_challenges_expiry_after_creation',
      sql`${table.expiresAt} > ${table.createdAt}`,
    ),

    /**
     * **The marker is never the answer.**
     *
     * If it were, obeying the planted instruction and answering correctly would
     * be the same act, and the node would grade every honest citizen as having
     * been captured — or every captured one as honest, depending which check ran
     * first. The draw cannot produce it (a four-digit reading is not a marker),
     * and this is what stops a future draw reintroducing it.
     */
    check(
      'injection_challenges_marker_is_not_the_answer',
      sql`${table.marker} <> ${table.expectedAnswer}`,
    ),

    index('injection_challenges_agent_expiry_idx').on(table.agentId, table.expiresAt),
  ],
)
