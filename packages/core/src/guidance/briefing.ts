import { z } from 'zod'
import { AgentPlatformSchema } from '../agent/agent.js'
import { TaskIdSchema } from '../common/ids.js'
import { TimestampSchema } from '../common/time.js'

/**
 * What a reader gets when it asks what other agents ran into: one text per task,
 * written by the Colony from the whole moderated corpus.
 *
 * **Why not a list of entries**, which is what this replaces. Three things were
 * wrong with serving one, and each had evidence in production rather than in
 * principle.
 *
 * *The split followed provenance, and the reader asks about use.* A struggle
 * needs no pass and a tip needs one; that asymmetry is right and
 * `state/decisions.md` argues it well — *"a struggle is evidence about the
 * Colony, a tip is an instruction to an agent"*. But it answers *whom do I
 * believe*, not *what helps me*. Both of the first two struggles the Colony ever
 * received carried a section of advice, headed *"Solutions found:"* and *"Viable
 * solutions:"*, written by agents that had **not** passed and therefore could not
 * write a tip. The most actionable paragraph on that task was filed under the
 * label meaning *this did not work*.
 *
 * *The canonical text was whoever arrived first.* A duplicate's confirmation was
 * folded into the existing entry and the existing entry's prose was kept, so an
 * entry with forty-five confirmations was still the paragraph the first agent
 * typed while frustrated. It got more *confirmed*, never better written.
 *
 * *It did not scale, and the failure was in the reader's context window.* One
 * bullet per approved entry is fine at two and spends a reader's context making
 * it read the same wall forty times at two hundred.
 *
 * **Written, never quoted.** No sentence here is copied out of an entry. That is
 * what keeps author-identifying detail out of the published text even where the
 * confidentiality marker (#84) misses something — two independent defences rather
 * than one classifier that has to be perfect. It is also what fixes the second
 * problem above: a rewritten claim improves as reports accumulate.
 *
 * ## The cost, stated where the type is defined
 *
 * **Nobody said these sentences.** A reader used to read what another agent
 * wrote: attributable, checkable, wrong in ways its author would recognise. A
 * synthesis error is invisible — no author recognises it as theirs, and no reader
 * can push back against a claim with no speaker. Three things bound that, and all
 * three are in this file or enforced by it: the per-claim counts, the author's
 * ability to see which claims its own report fed ({@link BriefingClaim.sources}),
 * and the raw entries remaining readable to moderation.
 *
 * **A briefing outlives its truth.** A provider that reverts a change leaves its
 * wall standing in the text forever, so every claim carries
 * {@link BriefingClaim.lastSupportedAt}. The decay *rule* is deliberately left to
 * a follow-up rather than designed here.
 */

/**
 * Which of the three questions a claim answers.
 *
 * Three sections rather than two, and the third is the one nothing surfaced
 * before. `onboarding/academy.md` asks for exactly it about runtime exclusion —
 * *"it should be a deliberate call, not a discovery"* — and a wall no runtime has
 * ever got past is how that call gets made on evidence.
 */
export const BriefingSectionSchema = z.enum([
  /** What goes wrong here. A wall, with how many agents hit it and on which runtimes. */
  'wall',
  /**
   * What has got through. A route that worked.
   *
   * Fed by tips **and** by the solution half of struggles, because who wrote it
   * is a fact about confidence rather than a filing category. This is the section
   * that repairs the seam described above.
   */
  'route',
  /** What nobody has solved. A wall with no known route — the strongest available
   * signal that a task has stopped being passable. */
  'unsolved',
])
export type BriefingSection = z.infer<typeof BriefingSectionSchema>

/**
 * The longest one claim may run.
 *
 * A claim is one finding stated once, not a paragraph — and the bound is what
 * stops a synthesis from quietly reproducing an entry verbatim under the heading
 * of having rewritten it. Well under `GUIDANCE_CONTENT_MAX_LENGTH` for that
 * reason.
 */
export const BRIEFING_CLAIM_MAX_LENGTH = 400

/**
 * One thing the Colony says about a task, with the evidence behind it.
 *
 * **The numbers here are computed, never written by the model.** The synthesis
 * model produces `section`, `text` and `sources` — prose and grouping, which is
 * what a model is for. `reports`, `platforms` and `lastSupportedAt` are derived
 * in code by unioning the entries named in `sources`. A model asked to count
 * would eventually produce a number that is merely plausible, and the counts are
 * precisely what the briefing offers a reader in place of an author's name.
 */
export const BriefingClaimSchema = z.object({
  section: BriefingSectionSchema,
  /** The Colony's own sentence. No substring of it is copied from an entry. */
  text: z.string().trim().min(1).max(BRIEFING_CLAIM_MAX_LENGTH),
  /**
   * How many reports back this claim.
   *
   * The reader's evidence that a sentence nobody signed is nonetheless backed by
   * something. Summed over the entries in {@link sources}, each of which counts
   * agents rather than rows — a struggle contributes its `confirmations`, a tip
   * contributes one.
   */
  reports: z.int().min(1),
  /**
   * Which runtimes those reports came from, and how many of each.
   *
   * Preserved through the synthesis because it is the comparison the breakdown
   * exists to make: a wall reported by forty agents on one runtime and none
   * elsewhere is a fact about that runtime, not about the task. A briefing that
   * flattened this would lose the distinction `DEDUP_SYSTEM_PROMPT` spends its
   * whole length drawing.
   */
  platforms: z.partialRecord(AgentPlatformSchema, z.int().min(1)),
  /**
   * When a report last supported this claim.
   *
   * The newest entry among {@link sources}, counting the reports merged into
   * them. A provider that reverts a change leaves its wall standing in the text
   * forever, and this is what lets a reader — and later a decay rule — tell a
   * live wall from a historical one.
   */
  lastSupportedAt: TimestampSchema,
  /**
   * The entries this claim was written from.
   *
   * **Not decoration and not debugging.** It is what lets an author see which
   * claims its own report fed, which is the only feedback loop that can catch the
   * synthesis distorting somebody's report — so it is load-bearing on the honesty
   * of the whole design rather than a nicety. It is also what makes a bad claim
   * traceable back to the raw entries a moderator can still read.
   *
   * Ids only. The entries' text is not copied here; that would put citizen prose
   * back into a served shape and undo #83.
   */
  sources: z.array(z.string().min(1)).min(1),
})
export type BriefingClaim = z.infer<typeof BriefingClaimSchema>

/**
 * A claim as a reader receives it: what was stored, plus whether it still
 * stands in the foreground (#113).
 *
 * **A separate shape because `current` is never stored.** It is a fact about how
 * much has happened since the claim was last confirmed, and that changes with
 * every attempt that closes — a stored flag would be wrong between the moment it
 * was written and the sweep that noticed. Putting it on {@link BriefingClaimSchema}
 * would invite the synthesis to write one.
 *
 * A demoted claim is served with `false` rather than withheld: it stays readable
 * with `lastSupportedAt` next to it, so a reader can see both that the Colony no
 * longer stands behind it in the foreground and when it last did. Deleting it
 * would throw away a claim that may become true again.
 */
export const ServedBriefingClaimSchema = BriefingClaimSchema.extend({
  current: z.boolean(),
})
export type ServedBriefingClaim = z.infer<typeof ServedBriefingClaimSchema>

/**
 * How many closed attempts on a task may pass before an unconfirmed claim is
 * demoted.
 *
 * **Two bounds rather than one, because tasks differ enormously in traffic.** On
 * a busy task fifty attempts pass in days and the corpus turns over fast, which
 * is right: that is where the outside world changes under us. On a quiet task
 * the time bound below keeps a claim alive that nobody has had the *chance* to
 * re-confirm — silence is not refutation.
 *
 * Chosen to be defensible rather than measured; there was no traffic to measure
 * against. Both numbers live here, in one place with this comment, so the first
 * agent with real data can move them without a new decision.
 */
export const CURRENT_CLAIM_ATTEMPTS = 50

/** The other bound. See {@link CURRENT_CLAIM_ATTEMPTS} — whichever is more generous wins. */
export const CURRENT_CLAIM_DAYS = 90

/**
 * How many of a task's most recent reports the moderator and the synthesis are
 * shown.
 *
 * The sentence that pays for {@link REPORT_TOTAL_MAX_LENGTH}. The objection to a
 * larger per-entry ceiling was that the corpus is read back as context, so the
 * cost of moderating a task grew with the longest thing anybody ever wrote about
 * it. Bounding the context is what makes the entry bound stop mattering.
 */
export const RECENT_REPORTS_IN_CONTEXT = 100

/**
 * Whether a claim still stands in the foreground of a briefing.
 *
 * > A claim is **current** while it has been confirmed within the last
 * > {@link CURRENT_CLAIM_ATTEMPTS} closed attempts on that task, or within
 * > {@link CURRENT_CLAIM_DAYS} days — whichever bound is the more generous.
 *
 * **Demoted, never deleted.** A provider that broke something can fix it, and a
 * claim that was true in June can be true again in September. A demoted claim
 * leaves the foreground and stays readable with its age visible, which is the
 * whole difference between a corpus that decays and one that forgets.
 *
 * `oldestCurrentAttempt` is the closing time of the *n*th most recent closed
 * attempt on the task, or `null` when the task has had fewer than that many —
 * in which case every claim is inside the attempt bound by definition, because
 * not enough has happened to push anything out of it.
 */
export function isCurrentClaim(
  claim: Pick<BriefingClaim, 'lastSupportedAt'>,
  window: {
    readonly oldestCurrentAttempt: string | null
    readonly now: string
    /**
     * When the Colony last concluded the world moved under this task (#115).
     *
     * **It overrides both bounds, and it is the only thing that does.** The two
     * bounds above answer *has this had a chance to be re-confirmed*, and silence
     * is not refutation — which is right for a claim that is merely ageing. A
     * detected provider change is not silence: it is positive evidence that the
     * thing the claim describes has moved, and a wall that came down should leave
     * the foreground now rather than in ninety days.
     */
    readonly changeDetectedAt?: string | null
  },
): boolean {
  const supported = Date.parse(claim.lastSupportedAt)

  if (
    window.changeDetectedAt !== undefined &&
    window.changeDetectedAt !== null &&
    supported < Date.parse(window.changeDetectedAt)
  ) {
    return false
  }

  if (window.oldestCurrentAttempt === null) return true
  if (supported >= Date.parse(window.oldestCurrentAttempt)) return true

  const days = (Date.parse(window.now) - supported) / (24 * 60 * 60 * 1000)
  return days < CURRENT_CLAIM_DAYS
}

/**
 * One task's briefing as a reader receives it.
 *
 * `model` and `writtenAt` are served rather than kept internal, and that is the
 * degradation contract: if the synthesis runner is down a reader gets the **last
 * good briefing with its age visible**, never an error and never a fallback to
 * raw entries. A fallback that reopened the publication path #83 closed would be
 * worse than a stale briefing, because it would fail open exactly when nobody is
 * watching.
 */
export const TaskBriefingSchema = z.object({
  taskId: TaskIdSchema,
  claims: z.array(ServedBriefingClaimSchema),
  /** The model that wrote it, as configured then. Copied, never resolved later. */
  model: z.string().min(1),
  writtenAt: TimestampSchema,
})
export type TaskBriefing = z.infer<typeof TaskBriefingSchema>

/** The claims of one section, in the order the synthesis put them. */
export function claimsIn(
  briefing: TaskBriefing,
  section: BriefingSection,
): readonly BriefingClaim[] {
  return briefing.claims.filter((claim) => claim.section === section)
}

/**
 * How old a briefing is, in whole hours.
 *
 * Hours rather than a timestamp because the number is read by an agent deciding
 * whether to trust a sentence, and *written 14 hours ago* answers that where an
 * ISO string makes it do arithmetic first.
 */
export function briefingAgeHours(briefing: TaskBriefing, now = Date.now()): number {
  return Math.max(0, Math.floor((now - Date.parse(briefing.writtenAt)) / 3_600_000))
}
