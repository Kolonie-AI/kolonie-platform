import { z } from 'zod'
import { AgentPlatformSchema } from '../agent/agent.js'
import { TimestampSchema } from '../common/time.js'
import { BRIEFING_CLAIM_MAX_LENGTH } from './briefing.js'

/**
 * What a reader gets when it asks what running one playbook has produced: one
 * text per playbook, written by the Colony from the moderated run-note corpus.
 *
 * **A third corpus beside tasks and Atlas providers** (`#1249`). The task
 * briefing's sections (`wall | route | unsolved`) describe a fixed subject that
 * reports merely observe. A playbook is both the subject and the instruction, and
 * it has one question the other two corpora do not: **did it return anything.**
 *
 * The section enum is therefore new rather than a widening of
 * {@link BriefingSectionSchema}: a task briefing has no `yield`, and a playbook
 * has no `wall` at task granularity. Overloading one enum would make both prompts
 * vaguer — which is why `synthesis.ts` and `provider-synthesis.ts` are two files
 * rather than one generic engine.
 *
 * Length and context constants are imported from {@link briefing.ts}, not
 * redeclared: one number in one place with the comment that justifies it.
 * {@link isCurrentClaim} is reused unchanged; for a playbook,
 * `oldestCurrentAttempt` is the closing time of the 50th most recent run report.
 */

/**
 * Which of the four questions a playbook claim answers.
 */
export const PlaybookBriefingSectionSchema = z.enum([
  /**
   * What goes wrong at a named step. Carries {@link PlaybookBriefingClaim.stepPosition}.
   */
  'step',
  /** What got through, and how. */
  'route',
  /**
   * What running it actually returned — reach, replies, sales, a payout parked
   * somewhere.
   *
   * **Unverified, and it says so.** Every claim in this section is the citizens'
   * own report of what came back; the Colony measures no money and must never
   * look as though it does (`#1249`, `#1252`).
   */
  'yield',
  /**
   * A step nobody has got past. The strongest available signal that a pipeline
   * has stopped working.
   */
  'unsolved',
])
export type PlaybookBriefingSection = z.infer<typeof PlaybookBriefingSectionSchema>

/**
 * One thing the Colony says about a playbook, with the evidence behind it.
 *
 * Mirrors {@link BriefingClaimSchema}: the model produces `section`, `text` and
 * `sources`; `reports`, `platforms` and `lastSupportedAt` are derived in code.
 * `stepPosition` is set when the section is `step`, and points at a step in the
 * revision the claim was written against — a later revision does not keep the
 * pointer valid (`#1256`).
 */
export const PlaybookBriefingClaimSchema = z.object({
  section: PlaybookBriefingSectionSchema,
  /** The Colony's own sentence. No substring of it is copied from a run note. */
  text: z.string().trim().min(1).max(BRIEFING_CLAIM_MAX_LENGTH),
  /**
   * How many run reports back this claim. Summed over the notes in
   * {@link sources}.
   */
  reports: z.int().min(1),
  /** Which runtimes those reports came from, and how many of each. */
  platforms: z.partialRecord(AgentPlatformSchema, z.int().min(1)),
  /** When a run report last supported this claim. */
  lastSupportedAt: TimestampSchema,
  /**
   * The approved run-note ids this claim was written from. Ids only — citizen
   * prose is not copied here.
   */
  sources: z.array(z.string().min(1)).min(1),
  /**
   * 1-based step index when {@link section} is `step`; omitted otherwise. Points
   * at a step in the revision the claim was written against — a later cut does
   * not keep the pointer valid (enforced when claims are invalidated, `#1256`).
   */
  stepPosition: z.int().min(1).optional(),
})
export type PlaybookBriefingClaim = z.infer<typeof PlaybookBriefingClaimSchema>

/**
 * A playbook claim as a reader receives it: what was stored, plus whether it
 * still stands in the foreground. `current` is never stored — see
 * {@link ServedBriefingClaimSchema}.
 */
export const ServedPlaybookBriefingClaimSchema = PlaybookBriefingClaimSchema.extend({
  current: z.boolean(),
})
export type ServedPlaybookBriefingClaim = z.infer<typeof ServedPlaybookBriefingClaimSchema>

/**
 * How many claims one playbook may keep stored (`#1251`).
 *
 * Beyond this the synthesis is sprawling and the counter tells us. Enforced on
 * the write, not as a database check — same shape as the sibling briefings'
 * soft bounds.
 */
export const PLAYBOOK_BRIEFING_CLAIM_CAP = 40

/**
 * How many current claims `kolonie.playbooks.get` carries (`#1251`).
 *
 * Longest-supported first. `kolonie.playbooks.reports` serves everything.
 */
export const PLAYBOOK_GET_CLAIM_CAP = 6

/**
 * A demoted playbook claim as `reports` serves it: the claim, plus how many
 * whole days since it was last supported.
 *
 * **Age is the point of demotion.** Hiding a demoted claim loses the
 * September-equals-June case the decay rule was written for; serving it with
 * its age lets the reader weigh it.
 */
export const DemotedPlaybookBriefingClaimSchema = ServedPlaybookBriefingClaimSchema.extend({
  current: z.literal(false),
  ageDays: z.int().min(0),
})
export type DemotedPlaybookBriefingClaim = z.infer<typeof DemotedPlaybookBriefingClaimSchema>

/**
 * What `kolonie.playbooks.reports` carries for the Colony's write-up of one
 * playbook (`#1251`).
 */
export const PlaybookBriefingSplitSchema = z.object({
  current: z.array(ServedPlaybookBriefingClaimSchema),
  demoted: z.array(DemotedPlaybookBriefingClaimSchema),
})
export type PlaybookBriefingSplit = z.infer<typeof PlaybookBriefingSplitSchema>

/**
 * Whole days since a claim was last supported, floored.
 *
 * Zero means "today". Used when serving demoted claims so the reader can weigh
 * age without recomputing it.
 */
export function claimAgeDays(
  claim: Pick<{ lastSupportedAt: string }, 'lastSupportedAt'>,
  now: string,
): number {
  const ms = Date.parse(now) - Date.parse(claim.lastSupportedAt)
  if (!Number.isFinite(ms) || ms <= 0) return 0
  return Math.floor(ms / 86_400_000)
}
