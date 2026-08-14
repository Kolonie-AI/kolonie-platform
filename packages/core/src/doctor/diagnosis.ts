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
     * actually do* is one read rather than a search through a queue.
     *
     * **The throttle is the third consequence and has no column here** (`#843`).
     * It is a row in `throttles` pointing back at this one, because a diagnosis
     * may be limited more than once — the ordinal is what escalates — and a
     * single column could hold only the last of them. The two above are at most
     * one each, which is why they are columns and this is not.
     */
    supportTicketId: z.uuid().nullable(),
    /**
     * The issue this diagnosis was escalated as, or `null` (`#869`).
     *
     * **The second consequence, and the column the paragraph above said would
     * get one when it existed.** It is not a ticket, and the reason is
     * `support_tickets.agent_id`: it is `not null`, with the argument written
     * out at the column — *"the ticket is the citizen's own writing about the
     * Colony, and it leaves with them"* — and a colony-scoped diagnosis has no
     * citizen by construction. Making that column nullable to fit would change
     * what a support ticket is and re-open what erasure does to one, which is
     * far larger than getting a finding to a reader.
     *
     * **It is also the dedupe.** Not-null means *this has been escalated*, so
     * one diagnosis produces one issue ever, and the fact survives a restart
     * because it lives on the row rather than in a process.
     *
     * `null` on every agent-scoped diagnosis and always will be: an inefficient
     * loop is not an incident (`kolonie-docs#324` point 3), and a check
     * constraint refuses one.
     */
    escalatedIssueUrl: z.string().url().nullable(),
    /**
     * When the citizen was last told about this, on a waking, or `null`.
     *
     * **On the diagnosis rather than held in a process**, so a restart cannot
     * reset it and a citizen that was told is not told again by a runner that
     * has forgotten (`#842`).
     */
    announcedAt: TimestampSchema.nullable(),
    /**
     * The severity it carried when it was announced, or `null`.
     *
     * **Beside the stamp rather than derived from the current severity**, which
     * is what makes *it got worse* answerable at all: without it, a finding that
     * rose from `concern` to `serious` is indistinguishable from one that was
     * always `serious`, and the citizen either hears about every re-evaluation
     * or about none.
     */
    announcedSeverity: FindingSeveritySchema.nullable(),
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

/**
 * How long after being told a citizen may be told again about an unchanged
 * finding, in hours (`#842`).
 *
 * **Twenty. Nagging is how a channel gets ignored**, and the `open` list holds
 * five things — a Doctor that reappeared on every waking would be spending one
 * of them on a sentence the citizen has already read and decided about.
 *
 * Under a day rather than over it, so a citizen on a daily rhythm hears about a
 * standing problem roughly once a day rather than roughly never: at 24 hours
 * exactly, a waking a few minutes early would skip, and the skip would repeat
 * every day for the same few minutes.
 */
export const DOCTOR_TELLING_COOLING_HOURS = 20

/**
 * How long a telling still shows the same entry, in minutes (`#842`).
 *
 * **This is what keeps `kolonie.wakeup` safe to call twice.** That call is
 * documented as consuming nothing and being safe to repeat, and an entry that
 * vanished on the second call within one waking would quietly break that — an
 * agent that called `wakeup`, did something else, and called it again to
 * re-read the list would find the Doctor gone and reasonably conclude the
 * finding had been resolved.
 *
 * So a repeat inside this window is the *same telling* rather than a second one:
 * the entry stands, and nothing about the diagnosis moves. Ten minutes is longer
 * than any plausible single waking and far shorter than the cooling period, so
 * the two cannot be confused.
 */
export const DOCTOR_TELLING_GRACE_MINUTES = 10
