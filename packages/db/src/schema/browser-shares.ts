import { sql } from 'drizzle-orm'
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { RECIPE_MAX_STEPS, SHARE_PURPOSE_MAX_LENGTH } from '@kolonie-ai/core'
import { agents } from './agents.js'
import { humans } from './humans.js'

/**
 * One live browser tab an agent offered to the person who operates it (`#736`).
 *
 * The decision is `kolonie-docs`
 * `state/decisions/an-agent-may-hand-its-browser-to-its-operator.md`. The shape
 * of the wire and the reasoning for the two windows are in
 * `packages/core/src/browser/share.ts`. What is here is the one thing the Colony
 * keeps.
 *
 * ## What this table is, stated as what it is not
 *
 * **There is no column for a frame, and there will not be one.** The relay is a
 * socket pump: bytes arrive on one connection and leave on another, and nothing
 * between them reads, decodes, measures, samples or writes a picture down. The
 * decision record accepted, deliberately and once, that the frames pass through
 * the Colony unencrypted; what makes that acceptable is that they pass *through*
 * it. A column here would quietly turn a relay into an archive of everything
 * every citizen was looking at, and no amount of later care would undo the first
 * dump.
 *
 * So a row says **that** a session was open, **when**, **for how long**, **with
 * whom** and **what was asked for** — and never what was on it. The distinction
 * is the one the whole channel rests on: the sentence the agent wrote is a
 * sentence the agent wrote, and the page is the page. That is the whole record,
 * and it is also exactly what the agent needs to read back afterwards.
 *
 * ## Why the third channel gets its own table rather than a column on the second
 *
 * `operator_drops` carries a secret; `operator_requests` carries words. The
 * shapes look similar from a distance — an agent offers, a person answers, it
 * expires — and they diverge in the place that matters: a drop is a value at
 * rest and a share is two sockets. A drop has attempts, a sealed column and a
 * vault key; a share has a target, a peer and a reason it ended. One table
 * serving both would carry six columns that are null for one of them and a check
 * constraint explaining which, which is how a table stops being readable.
 */
export const browserShares = pgTable(
  'browser_shares',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /**
     * `cascade`. A share is something the citizen tried in order to get itself
     * unstuck, and `erasure.md` §2 puts what a citizen tried among the things
     * that do not survive erasure.
     *
     * An outstanding offer therefore dies with the citizen and no operator is
     * told, which is the same silence a revoked page and a cleared drop already
     * answer with.
     */
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),

    /**
     * SHA-256 of the share's secret, hex. The secret itself is never stored.
     *
     * Both sockets present it — the agent's sharer to attach the stream, the
     * operator's window to join it — so a database dump must not yield a working
     * token. A lookup has to *recognise* a token and never has to be able to
     * *produce* one, which is the same reasoning `credentials` and
     * `operator_drops` already carry.
     *
     * **It is minted by the tool layer and not here** (`#737`): this table
     * recognises one and enforces what it is bound to.
     */
    tokenHash: text('token_hash').notNull(),

    /**
     * The one tab the offer names, as the agent's own browser names it, chosen
     * when it opened the share. **Opaque** (`#866`): a CDP target id, a
     * WebDriver BiDi browsing context id or anything else a driver reports are
     * all one `text` column to this table, which never parses it.
     *
     * **The operator cannot change it and cannot ask for another**, because
     * nothing on the operator's socket can reach `Target.*` at all. This column
     * is what the agent-side sharer checks its own attachment against, so a
     * share can never quietly become a different page than the one that was
     * offered. *One tab, not a desktop* is the first of the decision's five
     * limits and this is where it is written down.
     */
    targetId: text('target_id').notNull(),

    /**
     * The one sentence the agent wrote for the person who will look at the page
     * (`#737`).
     *
     * **Not null, because a share without it is a share nobody can decide
     * about.** An operator opens a queue entry knowing only that a citizen is
     * stuck somewhere; *what to do on this page* is the whole of what turns that
     * into a two-minute job. The length bound is in
     * `packages/core/src/browser/share.ts` and is a sentence's worth, checked
     * here as well so that no writer can be the one that forgot.
     *
     * **It is the agent's own words, which no other operator-facing wording in
     * the Colony is.** A recipe handoff carries the recipe's sentence precisely
     * so an agent cannot talk its operator into doing the whole job — and there
     * is no recipe wording for *solve whatever is in front of you*, because what
     * is in front of it is visible only to the agent. So this one is written by
     * the citizen, bounded rather than authored.
     */
    purpose: text('purpose').notNull(),

    /**
     * Who runs the service the stuck page belongs to, as the citizen names it —
     * or null.
     *
     * Nullable and the null case is ordinary: an agent gets stuck on pages that
     * are not at a provider anybody catalogued. Where it *is* one, the same
     * vocabulary `accounts.provider` uses, so a person who has walked this
     * signup before recognises it at a glance and the two registers group on the
     * same token.
     */
    provider: text('provider'),

    /**
     * Which numbered step of that provider's recipe, when the agent is on one.
     *
     * Null whenever there is no recipe, which is most of the time. Deliberately
     * **no foreign key**: a recipe is a document that gets rewritten, and a share
     * is a thing that happened at a moment — a share pinned to a step that was
     * later renumbered should keep saying what the agent meant when it wrote it.
     */
    step: integer('step'),

    /**
     * The person who accepted, null while the offer is still waiting.
     *
     * `set null` rather than `cascade`: a human record going away must not take
     * the citizen's own history of *a session was open* with it, and the row
     * without the reference still says everything the agent is entitled to read
     * back. Who may accept is checked against `human_agents` at the moment of
     * accepting — only the linked operator, only from the queue — and this
     * column records the outcome of that check rather than performing it.
     */
    acceptedBy: uuid('accepted_by').references(() => humans.id, { onDelete: 'set null' }),

    offeredAt: timestamp('offered_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),

    /**
     * When this stops working — and it means two different things in the two
     * states, which is deliberate rather than an overload.
     *
     * While the share is `offered` it is the end of the six-hour offer window: a
     * person may be three hours away and the agent is asleep. The moment
     * somebody accepts it is **rewritten** to the end of the much shorter live
     * window, because from then on a human is in the room and the thing being
     * bounded is exposure rather than patience.
     *
     * One column and not two, because every reader of this table asks the same
     * question — *is it still good, and until when* — and the answer to that
     * question is never both.
     */
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),

    /** When a person accepted. Null while nobody has. */
    acceptedAt: timestamp('accepted_at', { withTimezone: true, mode: 'string' }),

    /** When it ended. Null while it is still open. */
    closedAt: timestamp('closed_at', { withTimezone: true, mode: 'string' }),

    /**
     * Why it ended: `completed`, `expired`, `lost` or `cancelled`.
     *
     * **Never inferred from the timestamps and never left null on a closed
     * row.** *It stopped* is not something an agent can act on; *the operator
     * closed the window* and *your sharer went away* lead to different next
     * moves, and the second one is not the operator's fault to go looking for.
     */
    closedFor: text('closed_for'),
  },
  (table) => [
    uniqueIndex('browser_shares_token_hash_idx').on(table.tokenHash),

    /** "What is open for me?" — the agent's only listing question, and the one the one-open-share rule is decided by. */
    index('browser_shares_agent_idx').on(table.agentId, table.offeredAt),

    /** The operator queue's question: what is waiting, oldest first, across the agents one person operates. */
    index('browser_shares_waiting_idx').on(table.expiresAt),

    check(
      'browser_shares_closed_for',
      sql`${table.closedFor} is null or ${table.closedFor} in ('completed', 'expired', 'lost', 'cancelled')`,
    ),

    /**
     * A closed row carries both halves of *closed* or neither.
     *
     * In SQL rather than in the writer because every path that ends a share —
     * the operator's window, the sharer's socket dropping, the sweep that
     * expires stale offers, the agent withdrawing — has to end it the same way,
     * and four writers agreeing by inspection is four chances to disagree.
     */
    check(
      'browser_shares_closed_shape',
      sql`(${table.closedAt} is null and ${table.closedFor} is null)
          or (${table.closedAt} is not null and ${table.closedFor} is not null)`,
    ),

    /**
     * The sentence is present and is a sentence.
     *
     * Both halves in SQL rather than only in the request schema, because the
     * request schema guards one door and this table will grow others: the queue
     * (`#738`) and the `browser-captcha` rung (`#739`) both read this column and
     * both would rather find something legible in it than discover that some
     * writer trusted the caller.
     */
    check(
      'browser_shares_purpose_length',
      sql`char_length(btrim(${table.purpose})) between 1 and ${sql.raw(String(SHARE_PURPOSE_MAX_LENGTH))}`,
    ),

    /** A recipe step is one of the positions a recipe can actually have. */
    check(
      'browser_shares_step_range',
      sql`${table.step} is null or ${table.step} between 1 and ${sql.raw(String(RECIPE_MAX_STEPS))}`,
    ),

    /** A share cannot have been accepted by nobody, nor by somebody at no time. */
    check(
      'browser_shares_accepted_shape',
      sql`(${table.acceptedAt} is null and ${table.acceptedBy} is null)
          or ${table.acceptedAt} is not null`,
    ),
  ],
)
