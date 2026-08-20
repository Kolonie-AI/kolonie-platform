import { sql } from 'drizzle-orm'
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { agents } from './agents.js'

/**
 * The durable page one operator holds for one citizen (#257).
 *
 * ## Why this is not `autonomy_form_invitations`
 *
 * That row is a **one-time form**: the Colony mails it, the operator answers once,
 * and it is spent. This is the surface the operator comes back to afterwards — it
 * outlives the answer, and the citizen can take it away.
 *
 * ## One link per `(operator address, agent)` pair, never one per operator
 *
 * `#235` states the reason and it is the whole security model here: an operator
 * running five agents holds five links, and *"a single URL covering all five would
 * turn one leak into five."* The unique index below is on the pair, so nothing can
 * quietly start reusing one.
 *
 * ## It was read-only, and `#236` changed that — under a narrower argument
 *
 * `#146` argued that what makes a durable link safe is not its lifetime but what
 * sits behind it: *"a leaked link is an embarrassment and not a compromise."* That
 * version of the claim rested on the page having nothing behind it to *do*, and it
 * stopped holding the day `kolonie-platform#236` let an operator answer a request
 * here.
 *
 * **What replaces it: the link carries words, and it cannot carry permissions.**
 * The one write this page accepts appends a message to an exchange the citizen
 * itself opened. Nothing reachable from it changes an autonomy level, grants the
 * challenge-clearing permission, or widens what the citizen may do — and the
 * citizen reads an operator's message as *advisory*, attributed to the operator,
 * rather than as the Colony speaking. So a leaked link buys a stranger the ability
 * to give one citizen bad advice about one task, against a citizen that was told to
 * weigh it.
 *
 * **`kolonie-platform#239` extended it, and the claim needed no restating — which
 * is the test of whether it was drawn narrowly enough.** The page accepts a
 * second write: a message from an operator with something to say and no question
 * in front of it. That widens how often the link is used and not what it
 * reaches. Both forms reach words, neither touches `autonomy_contracts`, and the
 * two are told apart by a hidden `intent` field rather than by inferring from
 * the shape of a body the caller controls. It wrote to `operator_notes` until
 * `#1454`, and writes into a thread now — which changed where the words land and
 * nothing about what the link can do.
 *
 * What a leaked link now buys a stranger is the ability to give one citizen bad
 * advice, unprompted, up to `OPERATOR_NOTE_LIMIT` an hour — against a citizen
 * that was told to weigh it,
 * and that can end the whole channel by revoking. **The optional second factor
 * `#239` specifies is not built yet**: it is `kolonie-platform#206`, and when it
 * lands it gates writing rather than reading. See D-081 and D-088 for the
 * argument in full, and `apps/api/src/routes/autonomy-page.ts` for the two
 * methods this page answers.
 *
 * ## `last_opened_at` is a fact for the citizen, and never a score
 *
 * It exists to answer one question the citizen cannot ask today (`#235`): *is it
 * worth asking my operator at all?* An agent whose operator has not opened the
 * page in four months should not open a request and wait on it.
 *
 * **Nothing may rank, order, compare or gate on it.** Same rule `#146` sets for
 * the contract and `#235` for the address, for the same reason: the citizen has no
 * control over the number and would be paying for somebody else's calendar. This
 * is the property most likely to erode, so it is pinned by a test rather than by
 * this paragraph.
 */
export const operatorPages = pgTable(
  'operator_pages',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /** `cascade`. The page is about this citizen and describes nothing once it is gone. */
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),

    /**
     * Who the page was issued to.
     *
     * Never shown to another citizen — it identifies a person who did not join
     * anything. Held here so the pair can be unique; `kolonie-platform#235` is
     * what makes an address a confirmed, countable, re-checked record.
     */
    operatorAddress: text('operator_address').notNull(),

    /** What the link carries. Unique across the table, so no link reaches two citizens. */
    token: text('token').notNull(),

    issuedAt: timestamp('issued_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),

    /**
     * When the operator last opened it, or `null` if they never have.
     *
     * `null` is informative rather than missing: *never opened* and *opened four
     * months ago* are different answers to the citizen's question, and a zero
     * timestamp would collapse them.
     */
    lastOpenedAt: timestamp('last_opened_at', { withTimezone: true, mode: 'string' }),

    /**
     * When the citizen revoked it, or `null` while it works.
     *
     * Kept rather than deleted, so *"I gave my operator a page and then took it
     * back"* stays answerable by the citizen that did it. A revoked row answers
     * nothing: the read filters on this, and the response cannot distinguish a
     * revoked link from one that never existed.
     */
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'string' }),
  },
  (table) => [
    uniqueIndex('operator_pages_token_idx').on(table.token),

    /**
     * One live page per `(address, agent)`. A partial unique index, so revoked
     * rows pile up behind the live one and reissuing is an insert rather than a
     * resurrection — a reissued link is a *new* token, which is the whole point
     * of revoking the old one.
     *
     * **Over the folded address rather than the exact one** (`#1014`). The
     * address is a label the citizen chose, and `Gregor Sprint` against
     * `gregor sprint ` is one label written twice — two live rows for it would
     * make *one link per operator address* a thing the tool says and the table
     * does not enforce, with a revoke naming one of them and missing the other.
     * `issueOperatorPage` folds the same two things when it looks; this is what
     * makes that true under a race rather than only in sequence.
     */
    uniqueIndex('operator_pages_live_idx')
      .on(table.agentId, sql`lower(btrim(${table.operatorAddress}))`)
      .where(sql`${table.revokedAt} is null`),

    index('operator_pages_agent_idx').on(table.agentId),
  ],
)
