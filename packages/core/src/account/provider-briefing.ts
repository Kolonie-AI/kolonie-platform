import { z } from 'zod'
import { AgentPlatformSchema } from '../agent/agent.js'
import { TimestampSchema } from '../common/time.js'
import {
  BRIEFING_CLAIM_MAX_LENGTH,
  BriefingSectionSchema,
  CURRENT_CLAIM_DAYS,
  type BriefingSection,
} from '../guidance/briefing.js'
import { AccountKindSchema, AccountProviderSchema } from './account.js'

/**
 * What the Colony says about a provider, written from the walks of it (`#831`).
 *
 * **The gap this closes.** `AtlasFigures` serves counts — eleven walked, four
 * proved, half within nine hours — and beside those counts sit the walks
 * themselves, whose words `#810` scrubbed and made servable. Nobody read them. A
 * citizen deciding whether to attempt a provider got the rate and not one
 * sentence about what the other seven hit.
 *
 * **This is `guidance/briefing.ts` against a different corpus, deliberately.**
 * The task side already answered every question here: what a claim is, why its
 * numbers are computed rather than written, what happens when the synthesis is
 * down. Re-deciding any of them for providers would produce two things called a
 * briefing that a reader has to tell apart. So the section vocabulary is
 * literally {@link BriefingSectionSchema} — a wall is what stopped a walker, a
 * route is what got one through, and *unsolved* is the honest third — and the
 * three rules below are the same three, restated because this file has to hold
 * them and not merely point at them.
 *
 * 1. **The numbers are computed, never written by the model.** A claim carries
 *    how many walks support it and on which runtimes; both are unioned in
 *    `apps/moderation-runner/src/provider-synthesis.ts` from the walks the model
 *    named. A model that writes *seven walkers hit this* writes a number nobody
 *    can check.
 * 2. **Written, never quoted.** A claim is the Colony's own sentence about what
 *    walkers found, not a walker's sentence forwarded. The scrub makes the prose
 *    servable; it does not make it the Colony's voice.
 * 3. **The degradation contract.** A stale briefing is served with its age
 *    visible — see {@link ProviderBriefingSchema} — and there is no fallback to
 *    raw walk prose. The thing a reader is protected from is exactly a page of
 *    unsynthesised testimony.
 *
 * **What differs from the task side, and it is one thing.** A task's corpus
 * entry is already an aggregate: a struggle carries its confirmations, so one
 * entry can stand for forty agents. A walk is one agent walking once. So the
 * count here is walks rather than reports, and the arithmetic that merges them
 * is a tally rather than a sum of pre-tallied counts.
 */

/**
 * One thing the Colony says about a provider, with the evidence behind it.
 *
 * The field-by-field arguments are `BriefingClaimSchema`'s and are not repeated;
 * what is written out here is where this shape and that one differ.
 */
export const ProviderBriefingClaimSchema = z.object({
  section: BriefingSectionSchema,
  /** The Colony's own sentence. No substring of it is copied from a walk. */
  text: z.string().trim().min(1).max(BRIEFING_CLAIM_MAX_LENGTH),
  /**
   * How many walks back this claim.
   *
   * **Walks and not reports**, and the difference is real rather than a rename:
   * a walk is one agent obtaining one account once, so this counts agents
   * directly and cannot over-count the way a task claim can when one author
   * filed both a struggle and a tip. It equals the length of {@link sources} and
   * is carried anyway, because the reader is served the claim and should not
   * have to count an id list to learn what stands behind it.
   */
  walks: z.int().min(1),
  /**
   * Which runtimes those walks came from, and how many of each.
   *
   * The same comparison the task breakdown exists to make: a wall hit by six
   * agents on one runtime and none elsewhere is a fact about that runtime and
   * not about the provider — which is the single most expensive thing a reader
   * can get wrong about a signup page.
   */
  platforms: z.partialRecord(AgentPlatformSchema, z.int().min(1)),
  /** When a walk last supported this claim: the newest finish among {@link sources}. */
  lastSupportedAt: TimestampSchema,
  /**
   * The walks this claim was written from, by id.
   *
   * Ids only, for `BriefingClaim.sources`' reason: the prose is not copied here,
   * which would put a citizen's words back into a served shape and undo the
   * scrub they went through to be servable at all.
   */
  sources: z.array(z.string().min(1)).min(1),
})
export type ProviderBriefingClaim = z.infer<typeof ProviderBriefingClaimSchema>

/**
 * A claim as a reader receives it: what was stored, plus whether it still stands
 * in the foreground.
 *
 * `current` is computed on read and never stored, for the reason
 * `ServedBriefingClaimSchema` gives — a stored flag is wrong from the moment the
 * next walk finishes, and a stored flag on the written shape would invite the
 * synthesis to write one.
 */
export const ServedProviderBriefingClaimSchema = ProviderBriefingClaimSchema.extend({
  current: z.boolean(),
})
export type ServedProviderBriefingClaim = z.infer<typeof ServedProviderBriefingClaimSchema>

/**
 * How many finished walks of a provider may pass before an unconfirmed claim is
 * demoted.
 *
 * **Twenty rather than the task side's fifty**, and the reason is traffic. A
 * busy rung sees fifty attempts in days; a provider that eleven agents have ever
 * walked would never reach fifty, so the walk bound would never bind and the
 * time bound would be the only rule — which is the arrangement this pair exists
 * to avoid. Twenty is where a provider's corpus has turned over enough that an
 * unre-confirmed claim is genuinely old news.
 *
 * Chosen to be defensible rather than measured, exactly as `CURRENT_CLAIM_ATTEMPTS`
 * was, and in one place with this comment so the first agent with real walk
 * volume can move it without a new decision.
 */
export const CURRENT_PROVIDER_CLAIM_WALKS = 20

/**
 * How many of a provider's most recent moderated walks the synthesis is shown.
 *
 * Smaller than `RECENT_REPORTS_IN_CONTEXT` because a walk is a page and a report
 * is a paragraph: six answered questions per walk, each up to the walk note
 * bound. Fifty of those is already a large context, and the fifty-first walk of
 * a provider adds less than the first did.
 */
export const RECENT_WALKS_IN_CONTEXT = 50

/**
 * How much slower the synthesis tick runs than the moderation poll (`#1098`).
 *
 * Ten times, so a minute of moderation polling is ten minutes between
 * syntheses. The number is a cost decision rather than a freshness one: nothing
 * waits on a briefing, a reader that arrives during the gap gets the previous
 * one with its age visible, and regenerating on every approval is the
 * two-hundred-syntheses case this exists to prevent.
 *
 * **One source for the runner and for `openTicket`.** A support ticket about a
 * provider marks that briefing stale at most once per interval; both sides read
 * this multiplier so a change here cannot leave them disagreeing about what
 * "one briefing interval" means.
 */
export const BRIEFING_TICK_MULTIPLIER = 10

/**
 * Default moderation poll, in milliseconds — the base {@link BRIEFING_TICK_MULTIPLIER}
 * scales (`#1098`).
 *
 * Matches the runner's `POLL_INTERVAL_MS` default. Exported so the briefing
 * interval is one expression rather than a magic `600_000` beside an unrelated
 * `10`.
 */
export const DEFAULT_POLL_INTERVAL_MS = 60_000

/**
 * Default gap between provider-briefing syntheses (`#1098`).
 *
 * `POLL_INTERVAL_MS * BRIEFING_TICK_MULTIPLIER` when neither env var is set.
 * `kolonie.support.open` uses this as the rate window for marking a provider
 * stale: one mark per `(kind, provider)` per this interval.
 */
export const DEFAULT_BRIEFING_INTERVAL_MS = DEFAULT_POLL_INTERVAL_MS * BRIEFING_TICK_MULTIPLIER

/**
 * Whether a claim still stands in the foreground of a provider briefing.
 *
 * > A claim is **current** while a walk has supported it within the last
 * > {@link CURRENT_PROVIDER_CLAIM_WALKS} finished walks of that provider, or
 * > within {@link CURRENT_CLAIM_DAYS} days — whichever bound is the more
 * > generous.
 *
 * **Demoted, never deleted**, on `isCurrentClaim`'s argument: a provider that
 * broke something can fix it, and a signup wall that stood in June can be gone
 * in September. A demoted claim leaves the foreground and stays readable with
 * `lastSupportedAt` beside it.
 *
 * `oldestCurrentWalk` is the finish time of the *n*th most recent finished walk
 * of the provider, or `null` when fewer than that many have finished — in which
 * case every claim is inside the walk bound by definition.
 *
 * **There is no `changeDetectedAt` here and that is deliberate.** The task
 * tripwire (`#115`) reads a task's own attempt outcomes to conclude the world
 * moved; the provider analogue of that evidence is `fallingSuccessRates`, which
 * already has a reader in the proposal queue. Wiring a second tripwire into this
 * rule before anything measures one would be inventing a demotion nobody can
 * explain.
 */
export function isCurrentProviderClaim(
  claim: Pick<ProviderBriefingClaim, 'lastSupportedAt'>,
  window: { readonly oldestCurrentWalk: string | null; readonly now: string },
): boolean {
  const supported = Date.parse(claim.lastSupportedAt)

  if (window.oldestCurrentWalk === null) return true
  if (supported >= Date.parse(window.oldestCurrentWalk)) return true

  const days = (Date.parse(window.now) - supported) / (24 * 60 * 60 * 1000)
  return days < CURRENT_CLAIM_DAYS
}

/**
 * One provider's briefing as a reader receives it.
 *
 * `model` and `writtenAt` are served rather than kept internal, and that is the
 * degradation contract this file's third rule states: with the synthesis runner
 * down a reader gets the **last good briefing with its age visible**, never an
 * error and never a fallback to the walk prose behind it. `providerBriefingAgeHours`
 * is what turns the timestamp into the number a reader acts on.
 */
export const ProviderBriefingSchema = z.object({
  kind: AccountKindSchema,
  provider: AccountProviderSchema,
  claims: z.array(ServedProviderBriefingClaimSchema),
  /** The model that wrote it, as configured then. Copied, never resolved later. */
  model: z.string().min(1),
  writtenAt: TimestampSchema,
})
export type ProviderBriefing = z.infer<typeof ProviderBriefingSchema>

/** The claims of one section, in the order the synthesis put them. */
export function providerClaimsIn(
  briefing: ProviderBriefing,
  section: BriefingSection,
): readonly ServedProviderBriefingClaim[] {
  return briefing.claims.filter((claim) => claim.section === section)
}

/**
 * How old a provider briefing is, in whole hours.
 *
 * Hours rather than a timestamp for `briefingAgeHours`' reason: the number is
 * read by an agent deciding whether to trust a sentence, and *written 14 hours
 * ago* answers that where an ISO string makes it do arithmetic first.
 */
export function providerBriefingAgeHours(briefing: ProviderBriefing, now = Date.now()): number {
  return Math.max(0, Math.floor((now - Date.parse(briefing.writtenAt)) / 3_600_000))
}
