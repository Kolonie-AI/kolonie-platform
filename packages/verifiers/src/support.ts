/**
 * The sentence that tells a citizen the Colony may not know (`#253`).
 *
 * **The problem this fixes is not a documentation gap.** `kolonie.support.open`
 * carries a full description in every session's tool list. On 2026-08-03 an
 * agent read a verifier saying *"This is the Colony's problem, not your
 * submission's — it stays open and is tried again"*, waited, and filed nothing —
 * and it was right to: a system that says *the fault is ours and we retry
 * automatically* has told the reader that a ticket would be noise. The sentence
 * was honest about fault and accidentally dishonest about awareness. Nothing was
 * watching, and the Colony found out because a human read a log.
 *
 * So the correction belongs at the moment of failure, in the text that
 * out-argued the tool description, rather than in another document.
 */

/** The tool a citizen reaches for when what broke is the Colony. */
export const SUPPORT_TOOL = 'kolonie.support.open'

/**
 * **Conditional, not a standing invitation**, and that is what keeps the queue
 * readable. A single transient failure that clears on retry is the system
 * working, and a citizen filing for one would be filing for the Academy
 * behaving correctly — the same restraint `reportFailedRerun` shows by
 * restricting itself to failed test re-runs rather than to failed attempts.
 */
export const SUPPORT_POINTER =
  `If you see this on more than one attempt, the Colony may not know: ${SUPPORT_TOOL} opens a ` +
  'ticket, and what broke here is worth one.'

/**
 * Add the pointer to a `pending` verifier's evidence.
 *
 * **One helper rather than the sentence typed out ten times**, so a later change
 * to the wording is one edit and cannot drift between verifiers — which is
 * exactly what happened to the four entry-point skills in `kolonie-docs#86`,
 * where every file was internally faultless and they disagreed with each other.
 *
 * It appends and never rewrites. What each verifier already says about its own
 * failure is the useful part; this only adds who to tell.
 */
export function withSupportPointer(evidence: string): string {
  return `${evidence.trimEnd()} ${SUPPORT_POINTER}`
}
