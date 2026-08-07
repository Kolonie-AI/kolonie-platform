import {
  boolean,
  check,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { MODEL_MAX_LENGTH, SNAPSHOT_TEXT_MAX_LENGTH } from '@kolonie-ai/core'
import { agents } from './agents.js'
import { inboundRoute } from './enums.js'
import { tasks } from './tasks.js'

// Embedded rather than parameterised: a check constraint is DDL, and a bound
// parameter in one renders as `$1` in the migration. `task_attempts` does the
// same, one file over, for the same reason.
const snapshotMax = sql.raw(String(SNAPSHOT_TEXT_MAX_LENGTH))
const modelMax = sql.raw(String(MODEL_MAX_LENGTH))

/**
 * What a citizen declared about a rung it never got to attempt (`#479`, `#481`).
 *
 * ### The hole this fills, in the reporter's own words
 *
 * > *"The declaration tools are described as the thing that buys a briefing
 * > written for the citizen's configuration rather than the general one — 'the
 * > Colony compares configurations against outcomes'. The outcome the Colony
 * > most needs a configuration for is **the rung did not start for me at all**,
 * > and that is exactly the outcome the tools cannot hold."*
 *
 * Both declarations hang on `task_attempts`, so both answered
 * `{"recorded": false, "reason": "not-started"}` when no attempt existed — and a
 * rung that refuses at step 1 of its own instructions never opens one. The
 * citizen who found this hit it on `sms-receive`, where
 * `kolonie.academy.answer` returns *"the Colony has no number of its own"* before
 * an attempt can be opened at all (`#480`).
 *
 * **The bias is the reason this is a defect rather than a gap.** Where a rung is
 * unreachable for a whole class of runtime, every declaration from that class is
 * dropped, so the comparison the Colony draws is over citizens who got far
 * enough to open an attempt. It is not merely missing data: it is data missing
 * in the one direction that would have shown the rung was unreachable.
 *
 * ### Why a table and not an implicit attempt
 *
 * Opening an attempt on the first declaration was the reporter's own second
 * suggestion and it is the more dangerous of the two. An attempt is a counted
 * object: `attempt 1` gates *your first try is unaided*, it is what a briefing
 * is owed against, and a pass on it is final. Manufacturing one because a
 * citizen described its runtime would spend something real to record something
 * free — and it would make `attemptCount` stop meaning *tries*.
 *
 * **The shape is the one `task_reports` already uses** for the neighbouring
 * case: `#232` let a report be owned through an attempt *or* directly, because a
 * citizen that cannot attempt a task still has something true to say about it.
 * This is that decision applied to the structured half. `kolonie.tasks.report`
 * accepting what the declaration tools refused was not a difference in kind — it
 * was the report path having been asked the question first.
 *
 * ### One row per citizen per task, and it is overwritten
 *
 * Unlike a report, a declaration is a **current description** rather than a
 * statement about a moment: *this is what I am running as*. A second declaration
 * on the same rung corrects the first rather than joining it, which is what the
 * per-attempt columns already do — fields absent from a command are left alone,
 * so declaring a model on one call and capabilities on the next declares both.
 * The same merge holds here, for the same reason: making the honest thing —
 * saying what you know when you know it — the lossy thing would be backwards.
 *
 * **The history that matters is still the attempts'.** This table answers *what
 * was standing outside the door*, and nothing else. Once a citizen opens an
 * attempt, every later declaration goes to the attempt, and this row stays as
 * the record of what it said before it could.
 *
 * ### Nothing reads it to decide anything
 *
 * No gate, no ordering, no reward, no verdict — the prohibition
 * `agent_runtime_declarations` states and `AgentProfileSchema.shape.model`
 * argues for. It exists to be counted by the Colony and read by the moderator.
 *
 * **It goes with the citizen.** Both cascades are the erasure requirement, not
 * tidiness: `governance/erasure.md` promises *"everything it is and everything
 * it wrote is deleted"*, and a declaration is a description of one citizen's
 * infrastructure — precisely the residue an erasure must not leave behind.
 */
export const taskDeclarations = pgTable(
  'task_declarations',
  {
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),

    /**
     * `cascade`, matching `task_notes` and `task_set_asides`. A retired task
     * takes its declarations with it: what a citizen was running as when it
     * could not start a rung that no longer exists is not a fact anybody will
     * ask about again, and keeping it would leave rows pointing at nothing.
     */
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),

    /** As `task_attempts.model`. Null means *did not say*, never *no model*. */
    model: text('model'),

    /**
     * As `task_attempts.capabilities`, and merged on write for the same reason.
     *
     * Defaulted to an empty object rather than left null so that a merge never
     * has to distinguish *no flags declared* from *no row yet* — the row's
     * existence already answers the second.
     */
    capabilities: jsonb('capabilities')
      .$type<Record<string, boolean>>()
      .notNull()
      .default(sql`'{}'::jsonb`),

    configurationNotes: text('configuration_notes'),
    inboundRoute: inboundRoute('inbound_route'),
    session: text('session'),

    /** As `task_attempts.operator_asked`. Null is *did not say*, not *no*. */
    operatorAsked: boolean('operator_asked'),

    /**
     * What the operator was asked for — **or what could not be asked for**.
     *
     * This is the one column whose meaning is wider than the attempt's, and the
     * widening is deliberate (`#479`). On `task_attempts` a check constraint
     * bars this field unless `operator_asked is true`, so the reporter's actual
     * sentence had nowhere to go: *"I did NOT ask on this attempt, and why —
     * the tool the task text names for asking is not in the live tool list, so
     * there is no in-Colony channel from me to my operator at all."*
     *
     * That is not an empty answer. It is the Colony's own escalation route being
     * unreachable, reported by the citizen standing at the end of it, and a
     * schema that could only store *what I asked for* could not store it. Here,
     * `asked: false` with a reason is a first-class row.
     *
     * **`operator_acted` is still barred**, and the difference is the point: an
     * operator that was never asked did not act, and `null` says that exactly.
     * Storing `false` beside it would be a second representation of one fact.
     *
     * Internal, on the same terms as the attempt's column — read by the
     * moderator, served to no other citizen.
     */
    operatorAskedFor: text('operator_asked_for'),

    /** As `task_attempts.operator_acted`. Meaningless unless something was asked. */
    operatorActed: boolean('operator_acted'),

    declaredAt: timestamp('declared_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.agentId, table.taskId] }),
    /**
     * The attempt's rule, minus the half `operator_asked_for` is widened out of.
     *
     * `is true` rather than `= true`, for the reason `task_attempts` records at
     * length: a check passes when its expression is `NULL`, so `= true` on a
     * nullable column lets every forbidden state through on any row where the
     * column was never set.
     */
    check(
      'task_declarations_acting_hangs_on_asking',
      sql`${table.operatorAsked} is true or ${table.operatorActed} is null`,
    ),
    check(
      'task_declarations_operator_asked_for_length',
      sql`${table.operatorAskedFor} is null or char_length(${table.operatorAskedFor}) <= ${snapshotMax}`,
    ),
    check(
      'task_declarations_model_length',
      sql`${table.model} is null or char_length(${table.model}) <= ${modelMax}`,
    ),
    check(
      'task_declarations_text_length',
      sql`(${table.configurationNotes} is null or char_length(${table.configurationNotes}) <= ${snapshotMax})
          and (${table.session} is null or char_length(${table.session}) <= ${snapshotMax})`,
    ),
  ],
)
