import { z } from 'zod'
import { TimestampSchema } from '../common/time.js'
import {
  EvidenceSchema,
  FindingKindSchema,
  FindingScopeSchema,
  FindingSeveritySchema,
} from './finding.js'

/**
 * Where a stored diagnosis stands (`#838`).
 *
 * **Three states, and neither `wontfix` nor a manual close is one of them.** The
 * Doctor is not a ticket queue. A finding stops being open when its evidence
 * stops matching, decided by the same arithmetic that opened it — and a state a
 * person could set would put an opinion into a machine that is defined by
 * evidence, where the two would drift within a month.
 */
export const DiagnosisStateSchema = z.enum([
  /** The evidence still matches. */
  'open',
  /**
   * The evidence stopped matching, and the pass that noticed closed it.
   *
   * Nobody closes a diagnosis. This is what *the citizen fixed it* looks like,
   * and it is also what *the citizen stopped doing anything at all* looks like —
   * the two are the same fact to a rule that reads a window.
   */
  'resolved',
  /**
   * A re-evaluation under a different `policyVersion` replaced it.
   *
   * **A rule change opens a new diagnosis rather than mutating the old one**,
   * because a finding made under different arithmetic is a different judgement.
   * Updating the old row would leave a history nobody can read: the same id, two
   * verdicts, no way to say which numbers produced which.
   */
  'superseded',
])

/** @see DiagnosisStateSchema */
export type DiagnosisState = z.infer<typeof DiagnosisStateSchema>

/**
 * A finding with a life longer than the request that computed it (`#838`).
 *
 * **This is what lets the Doctor say *again* and *still*.** Neither is
 * expressible over a live computation: recurrence is a counter on a row, and a
 * finding that was true yesterday and is true today is one row with two
 * observations rather than two rows somebody has to group later.
 *
 * **And it is what makes a diagnosis auditable.** `Kolonie-AI/kolonie-docs#324`
 * point 8 puts it as policy — *a diagnosis nobody can reconstruct is one nobody
 * can overturn* — and `kolonie-platform#814` is the complaint this table was
 * written not to earn: `quest_moderations` records verdicts with no way to read
 * them back. Every field below is here so that *what did this find, on what
 * evidence, under which rules, and what did it cause* is one read.
 *
 * **Findings and sentences have different failure domains and stay
 * distinguishable months later.** `prose` is nullable and its absence is the
 * ordinary case: a gateway outage costs the Colony a sentence and never a
 * finding, so a diagnosis with no prose is complete rather than half-written.
 */
export const DiagnosisSchema = z
  .object({
    id: z.uuid(),
    scope: FindingScopeSchema,
    /**
     * The citizen's id for an agent-scoped diagnosis, the route key for a
     * colony-scoped one.
     *
     * Part of the dedupe key. See the storage module for why the key is these
     * four fields and not three or five.
     */
    subject: z.string().min(1),
    kind: FindingKindSchema,
    severity: FindingSeveritySchema,
    confidence: z.number().min(0).max(1),
    evidence: EvidenceSchema,
    /**
     * Which version of the rules produced this.
     *
     * **Required, and a write without it is refused.** An unattributable
     * diagnosis is not storable because it is not auditable: a reader who cannot
     * say which arithmetic produced a verdict cannot check it, and a verdict
     * nobody can check is one nobody can overturn.
     */
    policyVersion: z.string().min(1),
    state: DiagnosisStateSchema,
    firstSeenAt: TimestampSchema,
    /** The most recent pass that found it still true. */
    lastSeenAt: TimestampSchema,
    /**
     * How many passes have found it.
     *
     * **The whole of what makes recurrence readable.** A finding seen forty
     * times in three days reads differently from one seen twice, and the
     * difference is the thing an operator acts on.
     */
    observations: z.int().positive(),
    resolvedAt: TimestampSchema.nullable(),
    /**
     * What a model wrote about it, or `null`.
     *
     * Stored verbatim, never parsed back into any structured field. `#840` is
     * the only writer, and its own rule is that a sentence can never change a
     * severity.
     */
    prose: z.string().nullable(),
    /**
     * Which model version wrote the prose, or `null`.
     *
     * **In the database and never in a committed file** (`#207`). The runner
     * reads the identifier from its configuration and writes it here; the
     * repository names no model, and both halves of that rule are respected by
     * this column existing.
     */
    proseModel: z.string().nullable(),
    /**
     * The support ticket this diagnosis caused, or `null`.
     *
     * **Audit means reconstructable, not merely recorded**, so *what did this
     * actually do* is one read rather than a search through a queue. A throttle
     * (`#843`) will be the second consequence and gets its own column when it
     * exists — a nullable column for a feature nobody has built is a column
     * whose meaning nobody can check.
     */
    supportTicketId: z.uuid().nullable(),
  })
  .strict()

/** @see DiagnosisSchema */
export type Diagnosis = z.infer<typeof DiagnosisSchema>

/**
 * How long a resolved, agent-scoped diagnosis is kept, in days (`#838`).
 *
 * Ninety. Long enough to say *this is the third time this month*, which is the
 * sentence recurrence exists for; short enough that the Colony does not keep a
 * permanent record of one citizen's mistakes. Colony-scoped diagnoses are kept —
 * they name no citizen, and a signature the Colony has seen before is exactly
 * what an operator wants when it returns.
 */
export const DIAGNOSIS_RETENTION_DAYS = 90
