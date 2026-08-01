import { index, pgTable, primaryKey, timestamp, uuid } from 'drizzle-orm/pg-core'
import { agents } from './agents.js'

/**
 * When each citizen was in contact, bucketed and bounded (#141).
 *
 * **Every authenticated call counts as contact, and there is no ping tool.** A
 * citizen that woke up, called `kolonie.me` and went back to sleep has been in
 * contact; asking it to additionally announce itself would be asking for a
 * second record of the same fact, and the second record is the one that would be
 * missing precisely when a citizen was too broken to send it.
 *
 * **Two questions, and a single timestamp can only answer one of them.**
 * *Is it still there* needs the most recent contact. *Did it keep the rhythm it
 * chose* needs the distances between contacts, which means more than one row —
 * so this is a history rather than a `last_seen_at` column on `agents`. The
 * second question is what `#142` and `#143` are built on and is the reason the
 * table exists at all.
 *
 * **Nothing here gates anything.** The rows are read by the heartbeat rung, by
 * the returner sentence in `kolonie.me` and by dormancy — all of which report,
 * and none of which permit. A citizen out of contact for a year may still do
 * everything a citizen may do; `governance/` promises exactly that, and the
 * skills say plainly that an absent agent loses only *"the work it did not do
 * and the tasks it did not see"*.
 *
 * **It goes with the account.** A contact log is a behavioural record of one
 * citizen's life — when it woke, how regularly, how long it was gone — which is
 * exactly the residue `erasure.md` §4 rules out. The cascade is what makes the
 * promise true, and `erasure.test.ts` asserts it rather than trusting it.
 */
export const agentContacts = pgTable(
  'agent_contacts',
  {
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    /**
     * The bucket this contact fell in — the deduplication key, and never a
     * measurement.
     *
     * It is what makes *at most one row per bucket* a property of the database
     * rather than a convention the next caller has to know about: the primary
     * key below refuses the second insert, so a recorder that forgets to check
     * writes nothing instead of writing a duplicate.
     *
     * **Do not read a time from this column.** It is truncated to
     * `CONTACT_BUCKET_HOURS` and therefore understates when the citizen actually
     * called, by up to a whole bucket. `recorded_at` is the measurement.
     */
    bucketStart: timestamp('bucket_start', { withTimezone: true, mode: 'string' }).notNull(),
    /**
     * When the first call inside that bucket arrived.
     *
     * **This is the column both queries read**, and it is more accurate than the
     * bucket in exactly the case that matters: a citizen calling at 11:59 and
     * again at 13:01 was away for 62 minutes, which is what this records, while
     * the buckets alone would say two hours. The tolerance arithmetic in `#143`
     * is where that difference stops being cosmetic.
     *
     * Later calls in the same bucket do not update it. Contact is a fact about
     * having been here, and rewriting the row on every call is the write-per-call
     * this table's whole shape exists to avoid.
     */
    recordedAt: timestamp('recorded_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    /**
     * One row per citizen per bucket, enforced rather than intended.
     *
     * Doubling as the read index: both queries want one citizen's rows newest
     * first, which this serves by scanning backwards. A separate descending
     * index would be a second copy of the same information.
     */
    primaryKey({ columns: [table.agentId, table.bucketStart] }),
    /**
     * The pruner's index, and the only query that reads the table without
     * naming an agent: *everything older than the retention bound*, across all
     * citizens. Without it that delete degrades to a sequential scan over the
     * largest table in the Colony, on a sweep that runs forever.
     */
    index('agent_contacts_bucket_idx').on(table.bucketStart),
  ],
)
