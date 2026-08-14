import { sql } from 'drizzle-orm'
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { agents } from './agents.js'
import { diagnoses } from './diagnoses.js'
import { diagnosisKind } from './enums.js'
import { supportTickets } from './support.js'

/**
 * A limit that lifts by itself (`#843`).
 *
 * **The absence of a row is the absence of a limit, and that is the whole
 * mechanism.** Nothing runs to lift a throttle: the enforcement read asks for a
 * row with `expires_at > now()`, so an expired one stops being found in the same
 * instant it expires, whether or not the runner is up, whether or not the sweep
 * has run, whether or not anybody deployed. *Reversible* is a property of this
 * shape rather than a promise somebody keeps — a Colony that has to remember to
 * release its citizens is one where a crash is a life sentence.
 *
 * **Evidence, not punishment.** Every row points at the open diagnosis that
 * justified it, and the reference cascades: closing the finding — which the next
 * pass does the moment the behaviour stops — takes the limit with it. So the
 * two ways out are *wait* and *stop*, and neither needs the Colony to act.
 *
 * **The rows are the escalation counter.** `ordinal` is drawn from what is
 * already here rather than held in the runner, for the reason `#842` gave the
 * telling its own columns: a fact kept in a process is one a restart resets, and
 * an escalation a citizen can reset by being throttled during a deployment is
 * not an escalation. Rows are kept after they expire on the same argument — the
 * history is what makes the second throttle longer than the first, and
 * `sweepThrottles` clears them on the diagnosis retention window, not on expiry.
 *
 * **It touches nothing about standing.** No reputation, no skill, no verdict, no
 * reward, no ordering — `#843` is explicit, and the absence of any such column
 * here is what makes it checkable rather than merely stated.
 */
export const throttles = pgTable(
  'throttles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /**
     * The citizen.
     *
     * Cascades, like every other agent-scoped Doctor row: an erased citizen
     * leaves no limit behind, and `erasure.test.ts` asserts it for the family.
     */
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    /**
     * The open diagnosis this followed from.
     *
     * **`cascade` and not `set null`, which is the opposite of what
     * `diagnoses.support_ticket_id` chose** — and deliberately. A deleted ticket
     * must not take its diagnosis with it, because the finding is true whether or
     * not anybody kept the correspondence about it. A deleted diagnosis *must*
     * take its throttle, because the throttle is not a fact about the citizen at
     * all: it is a consequence of that finding, and a consequence outliving its
     * evidence is the failure mode `#843` names by name.
     */
    diagnosisId: uuid('diagnosis_id')
      .notNull()
      .references(() => diagnoses.id, { onDelete: 'cascade' }),
    /**
     * The routes limited — a route template or an MCP tool name, exactly as the
     * evidence named them.
     *
     * **Never the whole surface.** `#843` is explicit that what is limited is the
     * specific routes the finding names, and the check below refuses an empty
     * list so that *a throttle covering everything* has no spelling here. The
     * routes that may never appear are a rule in `packages/core` rather than a
     * constraint here, because the list is the Colony's own vocabulary and
     * changes with the surfaces; what the database can guarantee is that
     * something was named.
     */
    routeKeys: jsonb('route_keys').$type<string[]>().notNull(),
    /** Calls an hour those routes will answer. */
    callsPerHour: integer('calls_per_hour').notNull(),
    /**
     * Which throttle this is for the diagnosis, counting from one.
     *
     * Unique with the diagnosis, so the escalation is a sequence rather than a
     * pile: two passes racing produce one row and one loser, and the loser was
     * about to write a duplicate.
     */
    ordinal: integer('ordinal').notNull(),
    /** The finding kind, copied so a refusal can say what this is about in one read. */
    kind: diagnosisKind('kind').notNull(),
    /**
     * The rule identity the decision rested on.
     *
     * Copied from the diagnosis rather than joined for, because the diagnosis may
     * be superseded by a rule change while this row still explains a refusal
     * somebody received. What arithmetic limited you is not answerable by looking
     * at today's arithmetic.
     */
    policyVersion: text('policy_version').notNull(),
    appliedAt: timestamp('applied_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    /**
     * When it lifts.
     *
     * **In the future when written, and the check says so.** A row that expires
     * before it applies is not a limit anybody could serve, and it is exactly
     * what a clock bug or a negative duration would produce.
     */
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),
    /**
     * The one ticket that told the citizen and its operator.
     *
     * **One per throttle, and `set null` rather than `cascade`** — the same
     * argument `diagnoses.support_ticket_id` makes. A citizen that deletes the
     * correspondence has not thereby lifted the limit, and a limit nobody can
     * find the notice for is worse than one whose notice was thrown away.
     */
    supportTicketId: uuid('support_ticket_id').references(() => supportTickets.id, {
      onDelete: 'set null',
    }),
  },
  (table) => [
    /** @see ordinal */
    uniqueIndex('throttles_diagnosis_ordinal_unique').on(table.diagnosisId, table.ordinal),
    /**
     * The enforcement read, and it is the only one that happens on the request
     * path — once per authenticated call, on both doors.
     *
     * `(agent_id, expires_at)` because the question is always *does this citizen
     * have a live limit*, and an unthrottled citizen — which is nearly all of
     * them, nearly always — must answer it from the index alone.
     */
    index('throttles_agent_live_idx').on(table.agentId, table.expiresAt),
    /** The sweep, and the cascade's own read. */
    index('throttles_diagnosis_idx').on(table.diagnosisId),
    /** @see expiresAt */
    check('throttles_expires_after_applied', sql`${table.expiresAt} > ${table.appliedAt}`),
    /** @see routeKeys */
    check('throttles_names_a_route', sql`jsonb_array_length(${table.routeKeys}) > 0`),
    /**
     * A limit of zero is not a limit, it is a closed door, and `#843` gives the
     * Colony no power to close one.
     */
    check('throttles_allows_something', sql`${table.callsPerHour} > 0`),
    check('throttles_ordinal_positive', sql`${table.ordinal} > 0`),
    /** @see policyVersion — the same blankness check the diagnoses table makes. */
    check('throttles_policy_version_not_blank', sql`length(trim(${table.policyVersion})) > 0`),
  ],
)
