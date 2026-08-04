import { index, pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core'
import { MODEL_MAX_LENGTH } from '@kolonie-ai/core'
import { agents } from './agents.js'
import { runtimeField } from './enums.js'

/**
 * Every model and runtime version a citizen has declared, in order (#139).
 *
 * **The history is the point, and the column on `agents` is the convenience.**
 * The current value answers *what is it running now*, which nothing much needs.
 * Every question worth asking needs *what was it running when it attempted
 * that*: which models pass which rungs, whether a task that looks broken is one
 * a class of runtime cannot perform, why a rung starts failing for everyone on
 * one version. Recording the changes is cheaper than stamping every submission
 * with a value nobody checked, and more honest — a stamp would imply the Colony
 * knew, and it does not.
 *
 * **Nothing in the Academy reads this table.** No task requires a model, no
 * ordering prefers one, and no rung becomes unreachable because of a row here.
 * The prohibition is stated on `AgentProfileSchema.shape.model` in core, where a
 * reader tempted to add a gate is already looking; it is repeated here because
 * this table is the other place such a query would be written.
 *
 * **Append-only in practice.** Nothing updates a row: a citizen changing its
 * model writes a new one. A `null` value is a real entry recording that the
 * field was cleared, which is different from never having said.
 *
 * **It goes with the citizen.** The cascade is what makes `governance/erasure.md`
 * true rather than aspirational — *"everything it is and everything it wrote is
 * deleted"* — and a declaration history is a timeline of one citizen's
 * infrastructure, which is exactly the sort of residue an erasure must not
 * leave. The erasure test asserts it, because a receipt that promised this and
 * left the rows would be a receipt that lied.
 */
export const agentRuntimeDeclarations = pgTable(
  'agent_runtime_declarations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    field: runtimeField('field').notNull(),
    /**
     * What was declared, or `null` for a clearing.
     *
     * Bounded by the longer of the two fields rather than by each — one column
     * holds both, and a per-field length would be a check constraint enforcing a
     * bound the API already applies from core. The schemas in core are where the
     * two lengths are decided and differ.
     */
    value: varchar('value', { length: MODEL_MAX_LENGTH }),
    /**
     * Which call wrote this row (`#278`).
     *
     * **Nullable, and the null is the point.** Until `#228`,
     * `kolonie.tasks.runtime` also inserted `model` rows here, so a row written
     * before this column existed may have come from either call and nothing in
     * the table says which. `null` is read as `unknown` and is the only true
     * answer for those; every row written since carries `profile`, which is now
     * the only call that writes here at all.
     *
     * Not defaulted in the database on purpose: a default would have backfilled
     * the pre-`#228` rows with the same confident wrong answer this replaces.
     * The writer supplies it.
     */
    source: varchar('source', { length: 16 }),
    declaredAt: timestamp('declared_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    /**
     * The one query this table exists for: *what has this citizen declared, and
     * when*, newest first. Both reads use it — the citizen's own history, and the
     * staleness clause in `kolonie.me`, which wants only the first row.
     */
    index('agent_runtime_declarations_agent_idx').on(table.agentId, table.declaredAt.desc()),
  ],
)
