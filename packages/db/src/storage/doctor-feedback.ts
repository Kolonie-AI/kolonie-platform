import { and, eq, sql } from 'drizzle-orm'
import type { AgentId, DoctorFeedbackVerdict, Finding } from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'
import { diagnoses } from '../schema/diagnoses.js'
import { doctorFeedback } from '../schema/doctor-feedback.js'

/** What a citizen said about a rule, on its way in (`#1082`). */
export interface DoctorFeedbackInput {
  readonly agentId: AgentId
  readonly kind: Finding['kind']
  readonly verdict: DoctorFeedbackVerdict
  /** What the verdict could not say, or `null`. */
  readonly note: string | null
}

/** What the citizen is told came of it (`#1082`). */
export interface RecordedDoctorFeedback {
  readonly kind: Finding['kind']
  readonly verdict: DoctorFeedbackVerdict
  /**
   * Whether this replaced a verdict the citizen had already given about this
   * rule.
   *
   * **Reported rather than refused.** One standing verdict per rule is the shape
   * the table enforces, and a citizen that changed its mind is telling the
   * Colony something — but a receipt that said *recorded* either way would let
   * it believe it had two.
   */
  readonly replaced: boolean
  /**
   * The diagnosis the verdict was attached to, or `null` when the citizen had no
   * open finding of that kind.
   *
   * On the receipt because it is the one part of the write the citizen did not
   * supply and could not predict.
   */
  readonly diagnosisId: string | null
}

/**
 * Record what a citizen made of a finding about it (`#1082`).
 *
 * **The diagnosis is resolved here rather than asked for.** The citizen names a
 * kind, because that is all the live answer gave it to name; this looks for its
 * own open agent-scoped diagnosis of that kind, which `diagnoses_open_unique`
 * guarantees is at most one. Doing it in the caller would put the lookup in
 * every door, and doing it in the citizen would require an id no surface serves.
 *
 * **A citizen with no open diagnosis of that kind is still recorded**, with both
 * the id and the policy version null. Refusing it would collect feedback only
 * from citizens currently in trouble, and a verdict given the day after a
 * finding resolved is precisely the one worth keeping.
 *
 * **Nothing here touches reputation, standing, the ledger or an attempt**, and
 * there is no call into any of them to remove: the promise the tool makes is
 * kept by this function having nothing else in it.
 */
export async function recordDoctorFeedback(
  db: Database | Transaction,
  input: DoctorFeedbackInput,
  now: Date,
): Promise<RecordedDoctorFeedback> {
  const [about] = await db
    .select({ id: diagnoses.id, policyVersion: diagnoses.policyVersion })
    .from(diagnoses)
    .where(
      and(
        eq(diagnoses.subject, input.agentId),
        eq(diagnoses.scope, 'agent'),
        eq(diagnoses.kind, input.kind),
        eq(diagnoses.state, 'open'),
      ),
    )
    .limit(1)

  const at = now.toISOString()
  const [row] = await db
    .insert(doctorFeedback)
    .values({
      agentId: input.agentId,
      kind: input.kind,
      verdict: input.verdict,
      note: input.note,
      diagnosisId: about?.id ?? null,
      policyVersion: about?.policyVersion ?? null,
      createdAt: at,
      updatedAt: at,
    })
    .onConflictDoUpdate({
      target: [doctorFeedback.agentId, doctorFeedback.kind],
      set: {
        verdict: input.verdict,
        note: input.note,
        diagnosisId: about?.id ?? null,
        policyVersion: about?.policyVersion ?? null,
        updatedAt: at,
      },
    })
    /**
     * Whether this was an insert, asked of the row rather than worked out.
     *
     * `xmax = 0` is true exactly when the tuple this statement returned is the
     * one it inserted, and false when the conflict clause updated somebody
     * else's. Taken from the write itself rather than from a `select` before it,
     * because a read-then-write would answer *did this replace something* with a
     * race in the middle of it — and comparing the stamps would answer it wrong
     * the moment two calls landed in the same millisecond.
     */
    .returning({ id: doctorFeedback.id, inserted: sql<boolean>`(xmax = 0)` })

  return {
    kind: input.kind,
    verdict: input.verdict,
    replaced: row !== undefined && !row.inserted,
    diagnosisId: about?.id ?? null,
  }
}

/** How many citizens gave each verdict about one rule (`#1082`). */
export interface DoctorFeedbackTally {
  readonly helpful: number
  readonly notApplicable: number
  readonly wrong: number
}

/**
 * What the citizens a rule fired on say about it, by kind (`#1082`).
 *
 * **Counts and never a citizen.** The notes are read by the Colony from the
 * table; what any surface may have is how many said each thing, which is the
 * same condition every published aggregate in this codebase carries.
 */
export async function doctorFeedbackTallies(
  db: Database | Transaction,
): Promise<Readonly<Record<string, DoctorFeedbackTally>>> {
  const rows = await db
    .select({
      kind: doctorFeedback.kind,
      helpful: sql<number>`count(*) filter (where ${doctorFeedback.verdict} = 'helpful')::int`,
      notApplicable: sql<number>`count(*) filter (where ${doctorFeedback.verdict} = 'not-applicable')::int`,
      wrong: sql<number>`count(*) filter (where ${doctorFeedback.verdict} = 'wrong')::int`,
    })
    .from(doctorFeedback)
    .groupBy(doctorFeedback.kind)

  return Object.fromEntries(
    rows.map((row) => [
      row.kind,
      { helpful: row.helpful, notApplicable: row.notApplicable, wrong: row.wrong },
    ]),
  )
}
