import { sql } from 'drizzle-orm'
import { check, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'

/**
 * The handles that have been held, so that none of them is ever held twice
 * (`#824`).
 *
 * A citizen has a public page at `/@{handle}`, and once that URL is in a
 * bookmark, a post or somebody else's link, the handle stops being only the
 * citizen's business. `state/decisions/a-citizen-has-a-page.md` takes the one
 * irreversible decision in the set:
 *
 * > A handle that has been used is never issued again.
 *
 * Reissuing would silently redirect every existing link to a different citizen.
 * The reader followed a link to somebody, and there is no moment at which they
 * are told that the somebody changed — which is the one failure a `404` cannot
 * produce and a reissued handle produces by default.
 *
 * **Its own table rather than a `ban_marks` row of a new kind**, and the
 * argument is in `ban_marks`' own doc: rows go there only for an agent that was
 * `banned` or `suspended`, which is *the difference between a ban register and
 * a register of everyone who ever left*. The decision record is explicit that
 * this is the second thing:
 *
 * > And it is not a sanction: it survives the erasure of a citizen in good
 * > standing, because what it protects is the reader of a link rather than the
 * > Colony's reach over the citizen that left.
 *
 * A `kind` column with `handle` in it would have put every departing citizen
 * into the table the Colony points at when it says *we keep nothing about
 * citizens who left in good standing*, and no amount of filtering afterwards
 * takes that sentence back.
 *
 * **Two limits carried over from `erasure.md` §4 unchanged**, in the record's
 * own words: the tombstone holds no plaintext handle and nothing that answers
 * *who was this*. There is no `agent_id` here, no foreign key, and no column a
 * name could be written into — see `handleMarkHash` in `../handle-mark.js` for
 * why the digest is keyed rather than salted, and where the key is not.
 *
 * **What it does not defend against, stated rather than implied.** Anybody who
 * holds both this table and the key can ask *was this particular handle ever
 * held* — that is the question it exists to answer, and the door asks it on
 * every registration. Combined with the live `agents` table, the answer for a
 * handle nobody holds now is *somebody left*. This is not a hole to be closed
 * later: an answer the front door needs cannot be one the table refuses. What
 * it buys is that neither the row nor the table can be turned into a *list* of
 * departed handles without guessing them one at a time, and that guessing costs
 * the key.
 */
export const handleMarks = pgTable(
  'handle_marks',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /**
     * The keyed digest. Sixty-four lowercase hex characters, like
     * `ban_marks.hash` and for the same reason — a shape the database enforces
     * is one no writer can get subtly wrong.
     *
     * **There is deliberately no column for the handle it was made from**, not
     * a truncated copy and not a first character, for the reason `ban_marks`
     * gives: every one of those turns an unsearchable digest into a searchable
     * one. Here it would do something worse than in `ban_marks`, because the
     * plaintext this table hashes is the citizen's name.
     */
    hash: text('hash').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check('handle_marks_hash_shape', sql`${table.hash} ~ '^[0-9a-f]{64}$'`),
    /**
     * One row per handle, and it is the read path as well as the rule.
     *
     * Unique because a second row would say nothing the first does not, and
     * because two erasures cannot both be allowed to fail on each other — the
     * write is `on conflict do nothing` for that reason. And it is the index
     * both doors read: *has this handle been held* is one lookup rather than a
     * scan, on the two calls an unregistered stranger can make.
     */
    uniqueIndex('handle_marks_hash_unique').on(table.hash),
  ],
)
