import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm'
import {
  DIAGNOSIS_RETENTION_DAYS,
  DiagnosisSchema,
  EvidenceSchema,
  type AgentId,
  type Diagnosis,
  type DiagnosisState,
  type Finding,
} from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'
import { diagnoses } from '../schema/diagnoses.js'
import { toTimestamp } from './rows.js'

/**
 * What recording a finding did (`#838`).
 *
 * Four outcomes rather than a boolean, because each is a different sentence in a
 * runner's log and the difference is the thing a pass is reporting: *this is
 * new*, *this is the fourteenth time*, *this got worse*, *this could not be
 * stored*.
 */
export type DiagnosisOutcome =
  /** No open diagnosis matched, so one was opened. */
  | 'opened'
  /** One matched and its evidence, stamp and count were updated. */
  | 'observed'
  /** One matched and its severity moved — worth a separate word, because `#842` re-announces on it. */
  | 'escalated'
  /** The write was refused. The finding was not storable, and the reason is in the message. */
  | 'refused'

/** What `record` did, and the row it did it to where there is one. */
export interface RecordedDiagnosis {
  readonly outcome: DiagnosisOutcome
  readonly diagnosis: Diagnosis | null
  /** Why a refusal was refused. `null` on every other outcome. */
  readonly refusal: string | null
}

/**
 * Store a finding, or update the open diagnosis it matches (`#838`).
 *
 * **The dedupe happens in Postgres, on a partial unique index over
 * `(scope, subject, kind, policy_version)` where the state is open.** A read
 * followed by a decision would be two round trips and a race between them, and
 * the race matters here: a runner pass and a re-evaluation can be looking at the
 * same subject, and two open rows for one problem is the state this table exists
 * to prevent.
 *
 * **It refuses rather than swallowing, and that is the opposite of
 * `recordCall`.** The rollup sits on a citizen's request path, where a failed
 * write must never become a failed request. This sits in a runner, where a
 * finding that silently failed to store is a finding nobody will ever act on and
 * a pass that reports success it did not have. Different position, different
 * rule — and the refusals are values rather than throws so that one bad finding
 * does not cost a pass the rest of its citizens.
 *
 * **Two refusals are checked here rather than left to the database**, because a
 * constraint violation arrives as a message nobody can branch on:
 *
 * - **Evidence that is not the rules' own numbers-only structure.** Parsed
 *   through core's `EvidenceSchema` before it is written, so free text, an
 *   address or a request path cannot reach the column through any path. This is
 *   load-bearing rather than tidy: `#840` builds a model prompt from a finding,
 *   and stored evidence that could carry text would be a prompt with an author
 *   other than the Colony.
 * - **A missing policy version.** An unattributable diagnosis is not storable
 *   because it is not auditable.
 *
 * **A severity change updates the open row rather than opening a second**, and
 * says so in the outcome. `#842` re-announces on an increase and stays quiet on
 * a decrease, and that decision needs to be made by something that can see both
 * the old value and the new one — which is only ever this function, because
 * `returning()` hands back the row as it is after the update and the previous
 * value exists nowhere else.
 */
export async function recordDiagnosis(
  db: Database | Transaction,
  finding: Finding,
  policyVersion: string,
  now: Date,
): Promise<RecordedDiagnosis> {
  const refuse = (refusal: string): RecordedDiagnosis => ({
    outcome: 'refused',
    diagnosis: null,
    refusal,
  })

  if (policyVersion.trim() === '')
    return refuse('a diagnosis without a policy version is not auditable')

  const evidence = EvidenceSchema.safeParse(finding.evidence)
  if (!evidence.success) return refuse('evidence must be the rules’ own numbers and route keys')
  // `safeParse` accepts a number-valued record; a value that is not finite would
  // survive it and mean nothing in a figure, so it is refused by name.
  for (const [figure, value] of Object.entries(evidence.data.figures)) {
    if (!Number.isFinite(value)) return refuse(`the figure ${figure} is not a number`)
  }

  const stamp = now.toISOString()
  const agentId = finding.scope === 'agent' ? (finding.subject as AgentId) : null

  try {
    /**
     * What the open row said before this pass, read for the outcome and for
     * nothing else.
     *
     * **This is not the read-then-decide the paragraph above refuses.** The
     * decision — insert or update — is still Postgres's, taken atomically on the
     * partial unique index; a stale answer here costs a wrong *word* in a log
     * line and never a second row. The read is here because `returning()` hands
     * back the row as it is *after* the update, so the only place the previous
     * severity exists is before the statement runs.
     */
    const before = await openDiagnosisFor(
      db,
      finding.scope,
      finding.subject,
      finding.kind,
      policyVersion,
    )

    const [written] = await db
      .insert(diagnoses)
      .values({
        scope: finding.scope,
        agentId,
        subject: finding.subject,
        kind: finding.kind,
        severity: finding.severity,
        confidence: finding.confidence,
        evidence: evidence.data,
        policyVersion,
        state: 'open',
        firstSeenAt: stamp,
        lastSeenAt: stamp,
        observations: 1,
      })
      .onConflictDoUpdate({
        target: [diagnoses.scope, diagnoses.subject, diagnoses.kind, diagnoses.policyVersion],
        targetWhere: sql`${diagnoses.state} = 'open'`,
        set: {
          severity: finding.severity,
          confidence: finding.confidence,
          // Replaced rather than merged: the evidence is what is true *now*, and
          // a union of two windows would describe a window that never happened.
          evidence: evidence.data,
          lastSeenAt: stamp,
          observations: sql`${diagnoses.observations} + 1`,
        },
      })
      .returning()

    if (written === undefined) return refuse('the diagnosis could not be written')

    return {
      outcome:
        written.observations === 1
          ? 'opened'
          : before !== null && before.severity !== written.severity
            ? 'escalated'
            : 'observed',
      diagnosis: rowToDiagnosis(written),
      refusal: null,
    }
  } catch (thrown) {
    // The schema's own checks land here — a colony-scoped finding carrying a
    // citizen, a blank policy version that got past the guard above. A message
    // rather than a throw, on this function's stated rule: one bad finding must
    // not cost a pass the rest of its citizens.
    return refuse(thrown instanceof Error ? thrown.message : 'the diagnosis was refused')
  }
}

/**
 * The severity a matching open diagnosis carried before this pass, if any.
 *
 * **Read before `recordDiagnosis`, by a caller that needs to know what changed.**
 * `recordDiagnosis` reports *that* a severity moved; this says what it moved
 * from, which is what `#842` needs to decide whether an increase is worth
 * re-announcing.
 */
export async function openDiagnosisFor(
  db: Database | Transaction,
  scope: Finding['scope'],
  subject: string,
  kind: Finding['kind'],
  policyVersion: string,
): Promise<Diagnosis | null> {
  const [row] = await db
    .select()
    .from(diagnoses)
    .where(
      and(
        eq(diagnoses.scope, scope),
        eq(diagnoses.subject, subject),
        eq(diagnoses.kind, kind),
        eq(diagnoses.policyVersion, policyVersion),
        eq(diagnoses.state, 'open'),
      ),
    )
    .limit(1)

  return row === undefined ? null : rowToDiagnosis(row)
}

/**
 * Every open diagnosis about one subject, most serious first (`#838`).
 *
 * **Only ever one subject.** There is no read here that answers *which citizens
 * have open diagnoses of this kind* — the console's list (`#841`) reads by state
 * rather than by subject, and nothing gives a citizen a subject other than its
 * own.
 */
export async function openDiagnosesFor(
  db: Database | Transaction,
  subject: string,
): Promise<readonly Diagnosis[]> {
  const rows = await db
    .select()
    .from(diagnoses)
    .where(and(eq(diagnoses.subject, subject), eq(diagnoses.state, 'open')))
    .orderBy(
      // `serious` before `concern` before `notice`, spelled out rather than left
      // to the enum's storage order: a reader of this query should not have to
      // open `enums.ts` to know what "most serious first" resolved to.
      sql`case ${diagnoses.severity} when 'serious' then 0 when 'concern' then 1 else 2 end`,
      desc(diagnoses.confidence),
      desc(diagnoses.lastSeenAt),
    )

  return rows.map(rowToDiagnosis)
}

/**
 * Close every open diagnosis about a subject that this pass did not find again
 * (`#838`).
 *
 * **A finding that stops being true stops being open on its own**, with the pass
 * that noticed recorded in `resolved_at`. Nobody closes a diagnosis, and there
 * is no surface that could — `#841` is read-only for exactly this reason.
 *
 * **The caller passes what it *did* find, and this closes the rest.** The
 * alternative — a caller closing what it decided had gone — puts the same
 * comparison in every caller, and a caller that computed it differently would
 * silently resolve findings that are still true.
 *
 * Returns how many closed, so a pass can log a number.
 */
export async function resolveDisappeared(
  db: Database | Transaction,
  subject: string,
  stillFound: readonly Finding['kind'][],
  now: Date,
): Promise<number> {
  const closed = await db
    .update(diagnoses)
    .set({ state: 'resolved', resolvedAt: now.toISOString() })
    .where(
      and(
        eq(diagnoses.subject, subject),
        eq(diagnoses.state, 'open'),
        stillFound.length === 0 ? sql`true` : sql`${diagnoses.kind} not in ${stillFound}`,
      ),
    )
    .returning({ id: diagnoses.id })

  return closed.length
}

/**
 * Mark every open diagnosis made under an older rule set as superseded (`#838`).
 *
 * **A rule change is a different judgement, not a correction of the old one.**
 * The old row keeps its evidence, its window and the version that produced it,
 * and the new arithmetic opens its own — so a reader months later can see that
 * the verdict changed *because the rules did*, which is a fact that vanishes if
 * the row is mutated in place.
 */
export async function supersedeOlderPolicies(
  db: Database | Transaction,
  currentPolicyVersion: string,
  now: Date,
): Promise<number> {
  const marked = await db
    .update(diagnoses)
    .set({ state: 'superseded', resolvedAt: now.toISOString() })
    .where(
      and(eq(diagnoses.state, 'open'), sql`${diagnoses.policyVersion} <> ${currentPolicyVersion}`),
    )
    .returning({ id: diagnoses.id })

  return marked.length
}

/**
 * Attach the ticket a diagnosis caused (`#838`).
 *
 * Separate from `recordDiagnosis` because the ticket is opened *after* the
 * diagnosis exists and by something that knows about tickets — which this module
 * deliberately does not.
 */
export async function recordConsequence(
  db: Database | Transaction,
  diagnosisId: string,
  supportTicketId: string,
): Promise<void> {
  await db.update(diagnoses).set({ supportTicketId }).where(eq(diagnoses.id, diagnosisId))
}

/**
 * Attach a model's sentence to a diagnosis (`#840`'s seam, defined here because
 * the column is).
 *
 * **Stored verbatim and parsed back into nothing.** Nothing in this function
 * reads the text, and no other function writes a structured field from it — the
 * whole of the *the model only writes* rule is that this is the only column a
 * model can reach.
 */
export async function attachProse(
  db: Database | Transaction,
  diagnosisId: string,
  prose: string,
  proseModel: string,
): Promise<void> {
  await db.update(diagnoses).set({ prose, proseModel }).where(eq(diagnoses.id, diagnosisId))
}

/**
 * Delete resolved agent-scoped diagnoses older than the retention window
 * (`#838`).
 *
 * **Agent-scoped only, and colony-scoped rows are kept.** A resolved finding
 * about a citizen is a record of a mistake it has already fixed, and keeping
 * those forever is the thing ninety days is set against. A colony-scoped row
 * names nobody, and *this route did this before* is exactly what an operator
 * wants when a signature returns.
 *
 * The clock is an argument, for the reason `sweepCallHours` gives: a retention
 * boundary that cannot be tested without waiting for one is not tested.
 */
export async function sweepDiagnoses(
  db: Database | Transaction,
  now: Date,
  retentionDays: number = DIAGNOSIS_RETENTION_DAYS,
): Promise<number> {
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000).toISOString()

  const deleted = await db
    .delete(diagnoses)
    .where(
      and(
        eq(diagnoses.scope, 'agent'),
        inArray(diagnoses.state, ['resolved', 'superseded'] as DiagnosisState[]),
        lt(diagnoses.resolvedAt, cutoff),
      ),
    )
    .returning({ id: diagnoses.id })

  return deleted.length
}

/**
 * A row as core publishes it.
 *
 * Parsed rather than cast, for the reason every read in this package is: a column
 * that drifts from the shape core publishes fails here rather than in somebody's
 * client.
 */
function rowToDiagnosis(row: typeof diagnoses.$inferSelect): Diagnosis {
  // `agent_id` is the cascade's column and `subject` is the dedupe key's. The
  // published shape carries only the second, so a reader cannot come to think
  // there are two identities here — and the schema is `.strict()`, so dropping
  // the key is the difference between a parse and a refusal.
  const { agentId: _cascadeColumn, ...published } = row

  return DiagnosisSchema.parse({
    ...published,
    firstSeenAt: toTimestamp(row.firstSeenAt),
    lastSeenAt: toTimestamp(row.lastSeenAt),
    resolvedAt: row.resolvedAt === null ? null : toTimestamp(row.resolvedAt),
  })
}
