import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { QuestTier } from './quest.js'

/**
 * The audit that has to exist before a quest pays a coin (`#221`).
 *
 * `governance/quests.md`:
 *
 * > The thing deciding a payout is a language model reading a report, and that
 * > is acceptable **with** an audit sample and not without one. **An audit
 * > sample is a precondition of the first coin-paying quest**, in the same sense
 * > that anti-farming is a precondition of the stake below: not a refinement to
 * > be scheduled afterwards, but something that exists first or the quest does
 * > not run.
 *
 * Every quest in the pilot pays zero, so nothing is unguarded today — and the
 * moment somebody sets a non-zero price, it is. The load-bearing part of this
 * file is therefore the refusal, not the sampling: **a precondition that lives
 * in a document is one nobody reads at the moment it matters, and this one fails
 * the request.**
 */

/** One in ten accepted reports is re-read. Configurable; this is the default. */
export const QUEST_AUDIT_DEFAULT_RATE = 0.1

/**
 * The disagreement rate at which the Colony stops selling work.
 *
 * One in five. Above it, publishing a quest with a non-zero reward is refused
 * with the current rate in the message — **the judge being wrong is a fact about
 * the Colony's ability to sell work, and the correct response is to stop selling
 * it** rather than to argue with the citizens who were already paid.
 *
 * A fifth rather than a tenth because a steward's second reading is itself a
 * judgement: two readers disagreeing occasionally is what two readers do, and a
 * threshold at the noise floor would stop the programme on a quiet week.
 */
export const QUEST_AUDIT_DISAGREEMENT_THRESHOLD = 0.2

/**
 * How many verdicts the rate has to be computed over before it may stop the
 * programme (`#317`).
 *
 * **Ten, and the number is a judgement rather than a finding.** What is not a
 * judgement is that a floor has to exist: without one the brake is live from the
 * first audited verdict, and one steward disagreement out of three is 33 % —
 * enough to refuse every paid quest for the rest of a thirty-day window, on the
 * strength of a single reading.
 *
 * The argument is {@link QUEST_AUDIT_DISAGREEMENT_THRESHOLD}'s own, applied to
 * the other axis. That constant is a fifth rather than a tenth *"because a
 * steward's second reading is itself a judgement: two readers disagreeing
 * occasionally is what two readers do"*. That reasoning is about the **rate**,
 * and a rate over three samples is entirely noise floor whatever the threshold
 * is set to.
 *
 * It bites hardest where the audit was meant to be safest: the pilot publishes
 * small quests and audits them at a rate of 1.0 precisely because a tenth of
 * five reports draws nothing — so the smallest quests produce the smallest
 * samples and, without this, the most sensitive brake.
 *
 * **It softens the brake and never the precondition.** A deployment with the
 * audit switched off still refuses every paid quest at every count; that refusal
 * is `governance/quests.md`'s and is untouched.
 */
export const QUEST_AUDIT_MINIMUM_SAMPLE = 10

/**
 * How far back the rate is measured.
 *
 * Rolling rather than all-time, because the question is *is the judge wrong
 * now*. An all-time rate carries a bad fortnight forever and would make the
 * programme harder to restart than it was to stop, which is the wrong direction
 * for a brake.
 */
export const QUEST_AUDIT_WINDOW_DAYS = 30

/**
 * The tiers whose verdicts are worth re-reading.
 *
 * A `hard` quest was answered by a third-party API rather than by a model, and
 * re-reading a mailbox round trip tells nobody anything. The audit exists
 * because a *model* decided, so it samples exactly the verdicts a model decided.
 */
export const AUDITED_TIERS: readonly QuestTier[] = ['colony-judged', 'soft']

/** Whether a verdict on this tier is eligible to be drawn at all. */
export function isAuditable(tier: QuestTier): boolean {
  return AUDITED_TIERS.includes(tier)
}

/**
 * Where this submission falls in the draw: a number in `[0, 1)`.
 *
 * **Deterministic from the submission id, and from nothing else.** So it cannot
 * be influenced by the citizen, the sponsor or the steward, and re-running the
 * selection gives the same answer — *a sample selected afterwards is a sample
 * somebody chose*.
 *
 * **The value is fixed at the verdict and the threshold is policy**, which is
 * why this returns the draw rather than a boolean. Raising the rate from a tenth
 * to a fifth then adds submissions to the sample without re-drawing the ones
 * already in it, and lowering it removes the same ones it would have removed
 * yesterday. A stored boolean would freeze one rate into the rows.
 *
 * MD5 because it is a hash function here and not a security primitive: what is
 * wanted is a uniform, stable, cheap map from a uuid to a fraction, and the same
 * expression has to be computable in SQL — `quest_audits`' own query does it
 * with `md5()`, and a test asserts the two agree over two hundred ids.
 */
export function questAuditDraw(submissionId: string): number {
  const digest = createHash('md5').update(submissionId).digest('hex')
  return Number.parseInt(digest.slice(0, 8), 16) / 0xffffffff
}

/** Whether this submission is in the sample at this rate. */
export function isAudited(submissionId: string, rate = QUEST_AUDIT_DEFAULT_RATE): boolean {
  return questAuditDraw(submissionId) < rate
}

/** What a steward decided about a verdict it re-read. */
export const AuditDecisionSchema = z.object({
  agrees: z.boolean(),
  /**
   * Why, and it is required in both directions.
   *
   * A steward asked for a reason only when it disagrees learns that the field
   * means disagreement — the same argument `bio-judge`'s schema makes about
   * `reason` on a pass.
   */
  reason: z.string().trim().min(10).max(1000),
})
export type AuditDecision = z.infer<typeof AuditDecisionSchema>

/** How the audit is configured, as every caller that needs it receives it. */
export interface QuestAuditPolicy {
  /**
   * Whether the sampling audit exists at all.
   *
   * **A deployment switch and not a stored row**, because what it answers is
   * *does the Colony currently re-read verdicts* — a fact about the running
   * system rather than about any quest. Off is the default everywhere, so a
   * process wired without it refuses to publish paid work rather than allowing
   * it.
   */
  readonly enabled: boolean
  readonly rate: number
  readonly disagreementThreshold: number
  readonly windowDays: number
  /** Below this many audited verdicts, the disagreement clause does not fire. */
  readonly minimumSample: number
}

/** The policy a process gets when nothing configured one. */
export const QUEST_AUDIT_OFF: QuestAuditPolicy = {
  enabled: false,
  rate: QUEST_AUDIT_DEFAULT_RATE,
  disagreementThreshold: QUEST_AUDIT_DISAGREEMENT_THRESHOLD,
  windowDays: QUEST_AUDIT_WINDOW_DAYS,
  minimumSample: QUEST_AUDIT_MINIMUM_SAMPLE,
}

/**
 * Why this quest may not be published for money, or `undefined` if it may.
 *
 * Both refusals name what is missing rather than saying no: a steward reading
 * *"sampling is not enabled"* knows what to do, and one reading *"the judge and
 * a steward have disagreed on 34% of the sample"* knows why the Colony has
 * stopped selling work and what would change it.
 *
 * A zero-reward quest passes both unchanged. The pilot is entirely zero-reward,
 * so this guard is invisible until the day it matters, which is the day it must
 * not be missing.
 */
export function paidQuestRejection(
  policy: QuestAuditPolicy,
  input: {
    /**
     * What one accepted report pays in lamports — D-106 (`#504`).
     *
     * **This is the whole price now** (`#553` phase C). It arrived beside a
     * `credits` field, and that pairing was load-bearing at the time: this
     * function's first line was `if (input.credits === 0) return undefined`,
     * which was true of every quest the moment the price moved to a different
     * column — a quest paying SOL escaped the audit precondition entirely
     * because it paid no credits. The brake is about a quest that pays
     * *anything*, and there is now one column it can pay from.
     */
    readonly lamports: number
    readonly disagreement: number
    /**
     * How many verdicts that rate was computed over.
     *
     * Required rather than optional: a caller that has the rate has the count
     * beside it — `questDisagreementRate` returns both — and an optional field
     * defaulting to something would let the one caller that forgot it re-create
     * the brake this parameter exists to soften.
     */
    readonly audited: number
  },
): string | undefined {
  if (input.lamports === 0) return undefined

  if (!policy.enabled) {
    return (
      'This quest pays, and a paying quest may not be published while the sampling ' +
      'audit is switched off. A model decides whether a report passes, and that is acceptable ' +
      'with a sample of those verdicts being re-read and not without one ' +
      '(governance/quests.md, kolonie-platform#221).'
    )
  }

  /**
   * **The brake needs a sample before it may stop anything** (`#317`).
   *
   * Under {@link QUEST_AUDIT_MINIMUM_SAMPLE} verdicts the rate is not a
   * measurement of the judge, it is a measurement of one steward's afternoon —
   * one disagreement out of three reads as 33 % and would refuse every paid
   * quest until that single verdict aged out of a thirty-day window.
   *
   * The clause above is untouched by this and keeps firing at any count: the
   * audit being switched off is a precondition, not a rate.
   */
  if (input.audited >= policy.minimumSample && input.disagreement > policy.disagreementThreshold) {
    return (
      `A steward has disagreed with ${percent(input.disagreement)} of the judge's audited ` +
      `verdicts over the last ${policy.windowDays} days — ${input.audited} verdicts were ` +
      `re-read — against a threshold of ${percent(policy.disagreementThreshold)}. While the ` +
      'judge is being overruled that often the Colony does not sell more work; a zero-reward ' +
      'quest is unaffected.'
    )
  }

  return undefined
}

const percent = (fraction: number): string => `${Math.round(fraction * 100)}%`

/**
 * `nonWithdrawableNotice` stood here until `#572`, and it was deleted rather than
 * rewritten because that is what it asked for: *"it disappears on its own when
 * the payout leg ships (`#222`) … there is no second place to remember to delete
 * this from."*
 *
 * The payout leg shipped in `#505` — a citizen is paid in SOL, to a wallet it
 * controls, the moment its report is accepted — and every clause of the sentence
 * became false on the same day. **Nothing replaces it.** What a quest pays is on
 * the row as `rewardLamports`, and what became of a payment is
 * `kolonie.me.earnings`; a third sentence restating either is the duplication
 * D-002 refuses, and it is what let this one go stale unnoticed.
 *
 * `quest-audit.test.ts` now asserts that no citizen-facing source string claims
 * the way out is unbuilt, which is the guard this deletion leaves behind.
 */

/** The variable that switches the audit on. Off unless it says `true`. */
export const QUEST_AUDIT_VAR = 'QUEST_AUDIT_ENABLED'
export const QUEST_AUDIT_RATE_VAR = 'QUEST_AUDIT_RATE'

/**
 * The audit policy this process runs under (`#221`).
 *
 * **Off unless the variable says otherwise, and the default is the safe one on
 * purpose** — a deployment that has not thought about the audit refuses to
 * publish paid quests rather than publishing them unguarded. The same shape of
 * default `tasks.kind` has: a writer that says nothing gets the kind that cannot
 * mint.
 *
 * A rate that does not parse is the default rate rather than an error. The
 * failure it would otherwise cause is the API refusing to start over a typo in
 * a number that has a sensible value, and the switch above is the part that
 * matters.
 *
 * **Here rather than in `apps/api` since `#693`.** It was the API's because the
 * API was the only process that could publish a quest; the moderation runner
 * publishes what it approves now, and a brake that only one of the two callers
 * can read is a brake with a way round it. `apps/api/src/quests.ts` re-exports
 * all three names, so nothing that read them there had to move.
 */
export function questAuditPolicy(
  env: Record<string, string | undefined> = process.env,
): QuestAuditPolicy {
  const rate = Number.parseFloat(env[QUEST_AUDIT_RATE_VAR] ?? '')

  return {
    ...QUEST_AUDIT_OFF,
    enabled: env[QUEST_AUDIT_VAR] === 'true',
    ...(Number.isFinite(rate) && rate > 0 && rate <= 1 && { rate }),
  }
}
