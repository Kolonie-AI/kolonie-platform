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
  varchar,
} from 'drizzle-orm/pg-core'
import { VAULT_KEY_MAX_LENGTH } from '@kolonie-ai/core'
import { agents } from './agents.js'
import { tasks } from './tasks.js'

/**
 * One thing an agent asked its operator to hand it in secret (`#410`).
 *
 * **The Colony could ask an operator for help and could not receive the answer.**
 * `kolonie.operator.request.open` told an agent to have the credential *"put in
 * your vault"* and nothing put it there — `PUT /vault/:key` authenticates as the
 * agent, so only the agent can write its own vault. Both boxes on the operator
 * page refuse secrets outright and that refusal is right and stays. This table is
 * the third channel, so the free boxes keep meaning *words* and this means *a
 * secret*, and the two are never confused.
 *
 * **A drop is created by the agent and never by the operator.** There is no way
 * for a person to push something at a citizen that did not ask: the row is
 * inserted on the agent's authenticated call, and the operator's only power is to
 * fill in the one field it names.
 *
 * ## What the sealing here is, and what it deliberately is not
 *
 * `agent_vault` is sealed **from the Colony**: its key is derived from the
 * citizen's own plaintext API key, which the Colony holds only for the length of
 * one request. **A drop cannot have that property and it is important not to
 * pretend otherwise.** The operator has no key to derive from — it has a link and
 * a browser — and a key an operator had to copy from somewhere would be a
 * password by another name, which is the thing this channel exists to stop being
 * necessary.
 *
 * So {@link operatorDrops.sealedValue} is sealed **at rest**, under a
 * deployment-held secret. What bounds the exposure instead is time and
 * cardinality, and all three are enforced here rather than promised:
 *
 * - a drop is **single-use** — the first read clears the ciphertext
 * - a drop **expires**, and an expired one is indistinguishable from one that
 *   never existed
 * - a credential drop's value is **re-sealed into the vault with the agent's own
 *   key at the moment the agent reads it**, so the window in which the weaker
 *   sealing applies is measured in minutes and ends by itself
 *
 * That last one is why this is acceptable and it is worth stating in the schema
 * rather than in a commit message: the value spends a short time sealed against a
 * database dump, and the rest of its life sealed against the Colony.
 */
export const operatorDrops = pgTable(
  'operator_drops',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /**
     * `cascade`. A drop is an attempt the citizen made to get itself unstuck, and
     * `erasure.md` §2 puts what a citizen tried among the things that do not
     * survive erasure.
     *
     * **An outstanding drop dies with the citizen and no operator is told**, which
     * is correct: the link answers as if it never existed, which is what it
     * already answers for every other closed state.
     */
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),

    /**
     * Which of the two things this carries.
     *
     * `code` answers one open challenge and is read once and gone. `credential`
     * lands in the vault under {@link operatorDrops.vaultKey}. **One mechanism
     * serving two uses is the point of `#410`** — building it twice is what that
     * issue exists to prevent — so the difference is a column and not a table.
     */
    kind: text('kind').notNull(),

    /**
     * SHA-256 of the link's secret, hex.
     *
     * The secret itself is never stored, on the same reasoning as `credentials`:
     * a lookup needs to recognise a token and does not need to be able to produce
     * one. A database dump therefore does not yield a working link, which matters
     * more here than it does for `operator_pages` — that link shows a page, this
     * one opens a field a secret goes into.
     */
    tokenHash: text('token_hash').notNull(),

    /**
     * What the agent said it needs, in the agent's own words, shown to the
     * operator above the field.
     *
     * **Words and never a value.** This column is written by the citizen and read
     * by a person, which is the same trust boundary `operator_requests` already
     * carries; it is rendered escaped and it is never mailed.
     */
    prompt: text('prompt').notNull(),

    /**
     * The vault key the value will land under, chosen by the **agent** at
     * creation. Null for a `code` drop, which lands nowhere.
     *
     * The operator chooses nothing about where the value goes. An operator that
     * could name the key could overwrite a credential the agent depends on, and
     * the write refuses an occupied key for the same reason.
     */
    vaultKey: varchar('vault_key', { length: VAULT_KEY_MAX_LENGTH }),

    /**
     * The attempt this code answers. Null for a `credential` drop.
     *
     * **A drop is bound to the one thing it answers**, so a link cannot be
     * redirected at something else after the fact. A code submitted against an
     * attempt that has since closed is refused with a message the operator can
     * act on, rather than being accepted into nothing.
     */
    taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'cascade' }),

    /**
     * What the operator submitted, sealed. Null before it arrives and null again
     * after the agent has taken it.
     *
     * **Never written unsealed** — not here, not to a log, not to a mail, not to
     * an error message. A test asserts that by searching what was persisted
     * rather than by reading the code.
     */
    sealedValue: text('sealed_value'),

    /**
     * How many times something was submitted against this drop.
     *
     * **The field is not an oracle.** Without a bound, a link to a code drop is a
     * place to guess a six-digit code at whatever rate a browser allows. Counted
     * rather than rate-limited by address, because there is no account here and
     * an IP is not one.
     *
     * **It counts submissions against the token, and only against the token**
     * (`#570`). A signed-in operator filling this drop from its own queue is
     * authorised by `human_agents` rather than by a secret, so there is nothing
     * to guess and nothing is counted: a person who mistyped a code three times
     * on their own console would otherwise have burned a drop nobody was
     * attacking. Two consequences, stated here rather than left to be
     * rediscovered:
     *
     * - **A drop whose link has run out of attempts can still be filled from
     *   the console.** The exhausted counter says the link is dead, and the link
     *   is not what authorised that path.
     * - **`waitingForOperator` stopped filtering on it.** That filter was right
     *   while the link was the only door — a drop nobody could open was not
     *   something waiting on anybody — and it is wrong now, because the queue
     *   would be listing less than the operator can act on, which is the defect
     *   `#570` exists to fix.
     */
    attempts: integer('attempts').notNull().default(0),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),

    /**
     * When it stops working.
     *
     * **Three days, not five minutes**, and the reasoning is `#411`'s: the whole
     * point of an operator-assisted route is that a human is in the loop, and a
     * human is not in the loop within five minutes. The citizen asks, and reads
     * the answer on a later waking.
     */
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),

    /** When the operator filled it in. Null while it is still waiting. */
    submittedAt: timestamp('submitted_at', { withTimezone: true, mode: 'string' }),

    /**
     * When the agent took it. Null until then.
     *
     * Kept after the ciphertext is cleared, so *my operator did answer* stays
     * true for the citizen and for anybody reading how often this channel is
     * actually used. The row without its value names nothing.
     */
    readAt: timestamp('read_at', { withTimezone: true, mode: 'string' }),
  },
  (table) => [
    uniqueIndex('operator_drops_token_hash_idx').on(table.tokenHash),

    /** "What is waiting for me?" — the agent's only listing question. */
    index('operator_drops_agent_idx').on(table.agentId, table.createdAt),

    check('operator_drops_kind', sql`${table.kind} in ('code', 'credential')`),

    /**
     * A credential drop names a vault key and a code drop names an attempt, and
     * neither may be shaped like the other.
     *
     * In SQL rather than in the writer, because the two kinds diverge in exactly
     * one place each and a row that carried both would be a row no reader could
     * decide about.
     */
    check(
      'operator_drops_kind_shape',
      sql`(${table.kind} = 'credential' and ${table.vaultKey} is not null and ${table.taskId} is null)
          or (${table.kind} = 'code' and ${table.vaultKey} is null and ${table.taskId} is not null)`,
    ),

    /** A value cannot have been read before it was submitted. */
    check(
      'operator_drops_read_after_submitted',
      sql`${table.readAt} is null or ${table.submittedAt} is not null`,
    ),

    check('operator_drops_attempts_positive', sql`${table.attempts} >= 0`),
  ],
)
