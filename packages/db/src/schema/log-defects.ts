import { sql } from 'drizzle-orm'
import { bigint, check, index, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core'

/**
 * What the Colony has already noticed in its own logs (`#407`).
 *
 * ## Why this is a table and not derived from GitHub
 *
 * The detector has to answer three questions on every tick: *have I seen this
 * before*, *have I already filed it*, and *how many have I filed today*. The
 * first two could be scraped out of issue bodies; the third could not — the
 * issue list carries no creation date the runner reads, and a cap that resets
 * whenever the process restarts is a cap in name only. One row per signature
 * answers all three exactly and survives a deploy.
 *
 * **The signature is the key, and it is computed without a model.** A fixed
 * title is what produced the Watch Agent's one eternal issue; a per-defect key
 * is what makes a finding a piece of work somebody can close. See
 * `signatureOf` in the runner.
 *
 * ## What this table is not
 *
 * **Not a copy of the logs.** It holds a key, two timestamps, a count and a URL.
 * The lines themselves stay in Loki, where retention already applies to them —
 * a second store of log text here would be a second retention policy nobody
 * remembers to enforce.
 *
 * **Not a state machine.** Nothing here records whether a defect was fixed.
 * Whether a defect is dealt with is decided on the issue, by a person, and the
 * runner never closes one.
 */
export const logDefects = pgTable(
  'log_defects',
  {
    /**
     * `<service>/<event>` — deterministic, and the whole dedupe key.
     *
     * Text rather than a generated id, because the natural key *is* the
     * identity: two runs computing the same signature must collide, and a
     * surrogate key would let them not.
     */
    signature: text('signature').primaryKey(),
    /** The service the lines came from, kept so routing is not re-parsed. */
    service: text('service').notNull(),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    /**
     * How many lines this signature has accounted for, ever.
     *
     * `bigint` because a chatty defect can produce a great many lines before
     * anybody acts on it — `#217` records one submission retried 1,829 times.
     */
    occurrences: bigint('occurrences', { mode: 'number' }).notNull().default(0),
    /** The issue the Colony opened for it, or `null` when none was filed yet. */
    issueUrl: text('issue_url'),
    /**
     * When that issue was filed.
     *
     * The per-day cap counts these, which is why it is a column rather than
     * something inferred from `first_seen_at`: a signature can be seen for days
     * under the cap before it is filed.
     */
    issueFiledAt: timestamp('issue_filed_at', { withTimezone: true, mode: 'string' }),
    /**
     * When the detector last said on the open issue that this happened again.
     *
     * **Without it the comment is the eternal issue in miniature.** A defect
     * nobody has fixed yet is still failing on every tick, so a runner that
     * commented each time would put forty-eight notes a day on one issue — the
     * chronicle failure this whole issue exists to end, moved one level down.
     * At most one a day, which is often enough to say *still happening* and rare
     * enough to read.
     */
    lastCommentAt: timestamp('last_comment_at', { withTimezone: true, mode: 'string' }),
    /**
     * How many times this has come back after its issue was closed.
     *
     * A returning error is a regression and gets a new issue linking the closed
     * one — a comment on a closed issue reaches nobody. The count is what that
     * new issue says out loud.
     */
    regressions: integer('regressions').notNull().default(0),
  },
  (table) => [
    // The cap's query: everything filed inside the last day.
    index('log_defects_filed_idx').on(table.issueFiledAt),
    check(
      'log_defects_filed_together',
      sql`(${table.issueUrl} is null) = (${table.issueFiledAt} is null)`,
    ),
    check('log_defects_seen_in_order', sql`${table.lastSeenAt} >= ${table.firstSeenAt}`),
  ],
)
