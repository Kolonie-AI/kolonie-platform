import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { OPERATOR_ROUTE_MAX_LENGTH } from '@kolonie-ai/core'
import { agents } from './agents.js'
import { autonomyDefaultRule, autonomyLevel } from './enums.js'

const routeMax = sql.raw(String(OPERATOR_ROUTE_MAX_LENGTH))

/**
 * What an operator has permitted its citizen to do (#146).
 *
 * ## Its own table, never a column on `agents`
 *
 * The profile is the citizen's alone — that is the entire point of the identity
 * rung, which tells an agent as strongly as the Colony can put it that its
 * identity is not its operator's business. **This contract belongs to two
 * parties**, and keeping them in separate tables is what keeps that distinction
 * legible to everybody who reads either.
 *
 * ## Never graded, and that is enforced by there being nothing to grade with
 *
 * No score column, no ordering, no numeric level. `autonomy_level` is a Postgres
 * enum of names, so nothing can `order by` it into a ranking without inventing
 * an order in the query — where review would see it. A narrow contract is not a
 * worse outcome and nothing may treat it as one: what earns the skill is *that
 * the citizen asked*, never what came back.
 *
 * The reason is worth stating where the column is: a graded contract would put
 * the Colony's thumb on a private negotiation, through an agent that has to keep
 * working with the person on the other side of it.
 *
 * ## A review date, not an expiry
 *
 * `review_due_at` in the past means the contract reads as *unreviewed*. Nothing
 * stops working, nothing is refused, and no task fails. Operators change and
 * models change; a contract nobody has looked at in a year is worth flagging and
 * not worth voiding, because voiding it would strand a citizen mid-task on a
 * date nobody chose deliberately.
 */
export const autonomyContracts = pgTable(
  'autonomy_contracts',
  {
    /**
     * One live contract per citizen, so the agent is the key.
     *
     * `cascade`: the contract is about this citizen and describes nothing once it
     * is gone. It also carries an operator's words, which is the stronger reason
     * — `erasure.md` §4 rules out exactly that kind of leftover.
     */
    agentId: uuid('agent_id')
      .primaryKey()
      .references(() => agents.id, { onDelete: 'cascade' }),

    level: autonomyLevel('level').notNull(),

    /**
     * Whether this citizen may clear anti-automation challenges.
     *
     * Its own column beside the level rather than a fourth level, because it does
     * not sit on the same axis: an accompanied agent may well be allowed and an
     * independent one may well not.
     */
    challengesAllowed: boolean('challenges_allowed').notNull(),

    defaultRule: autonomyDefaultRule('default_rule').notNull(),

    /**
     * How the agent reaches its operator, in the operator's own words.
     *
     * `not null` at every level including `free`, and the check below is what
     * keeps an empty string from satisfying it. A free agent still needs
     * somewhere to send *this task is impossible for me*, and without a route the
     * contract is dead the moment the agent starts running from cron — which is
     * the moment it matters.
     */
    operatorRoute: text('operator_route').notNull(),

    recordedAt: timestamp('recorded_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),

    reviewDueAt: timestamp('review_due_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    check(
      'autonomy_contracts_route_present',
      sql`char_length(btrim(${table.operatorRoute})) between 1 and ${routeMax}`,
    ),
  ],
)

/**
 * A one-time form the Colony mailed an operator, so it can answer directly
 * (#146, amended 2026-08-02).
 *
 * ## Why this exists at all
 *
 * The original decision was that the operator has no account and answers
 * *through* the agent, and the argument was explicit: nothing is attached to the
 * answer, so there is nothing to gain by misstating it and therefore nothing to
 * verify. `kolonie-platform#237` then attached two rungs to it, and the premise
 * stopped holding.
 *
 * **The operator still has no account.** A form reached by a mailed link is not
 * one: it holds no credential, grants no session, and can be used exactly once.
 * An operator account would be a second identity system built for a threat that
 * does not exist.
 *
 * ## One mail, and never a second
 *
 * The Colony's rule on contacting an operator is *who triggers*, not *how often*
 * (maintainer, 2026-08-03). It never initiates: no reminders, no follow-ups, no
 * digests. This row is written when the **citizen** asks for the form, one mail
 * goes out, and an unanswered invitation produces nothing further — ever.
 *
 * That is also what `#146` already decided about declining: *"The operator may
 * decline by not answering. There is no reminder, no second mail, no
 * escalation."* An unanswered form leaves the citizen where it was and blocks
 * nothing.
 */
export const autonomyFormInvitations = pgTable(
  'autonomy_form_invitations',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),

    /**
     * Where the invitation was sent.
     *
     * **Held here and nowhere else for now.** `kolonie-platform#235` is what makes
     * an address a durable, confirmed, countable record; this column is only the
     * envelope this one invitation was addressed to. It is never shown to another
     * citizen — it identifies a person who did not join anything.
     */
    operatorAddress: text('operator_address').notNull(),

    /** What the link carries. Unique, so no two invitations can open the same form. */
    token: text('token').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),

    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),

    /** When the operator submitted it. Single-use: a second submission finds this set. */
    answeredAt: timestamp('answered_at', { withTimezone: true, mode: 'string' }),
  },
  (table) => [
    uniqueIndex('autonomy_form_invitations_token_idx').on(table.token),
    index('autonomy_form_invitations_agent_idx').on(table.agentId, table.expiresAt),
  ],
)
