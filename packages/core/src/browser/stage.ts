import { z } from 'zod'

/**
 * A stage of the browser branch: one page the Colony serves, grades, and can
 * switch off on its own.
 *
 * **Why this is a registry and not a pair of values.** `browser_challenges.kind`
 * was `'capability' | 'captcha'`, pinned by a check constraint, and that was the
 * right shape while the branch was one rung and one badge. It is the wrong shape
 * for a ladder: the vocabulary grows every time the Academy learns to measure
 * something new about a browser, and **a new stage must not be a migration**
 * (`#160`). That is the same argument `SkillSchema` and `TaskTypeSchema` make one
 * layer up, and it is quoted there rather than reasoned out again.
 *
 * The contract is therefore the shape, plus a named list this repository's own
 * tests check the seed against — never a database enum.
 */
export const BROWSER_STAGE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * How many steps the entry rung takes before it counts as cleared.
 *
 * Three rather than one, because a single measurement is a value and not an
 * interaction: the rung claims the agent *operated* the page, and operating it
 * means carrying state from one step into the next. Three rather than ten because
 * each extra step costs an honest agent time and proves nothing the second did
 * not.
 *
 * It lived in `packages/db/src/schema/challenges.ts` until `#160`. It is here now
 * because the registry entry below is what mint reads, and the route that bounds
 * an incoming step number reads it from the challenge's own stage rather than from
 * a global — so this name exists for the callers that still want the entry rung's
 * number by name, and there is exactly one of it.
 */
export const CAPABILITY_STEPS = 3

export const BrowserStageSchema = z
  .string()
  .min(3)
  .max(32)
  .regex(BROWSER_STAGE_PATTERN, 'must be a lowercase kebab-case slug')
  .brand<'BrowserStage'>()
export type BrowserStage = z.infer<typeof BrowserStageSchema>

/**
 * The entry rung's stage, named so that callers do not parse a literal each time.
 *
 * `skill()` in `common/skill.ts` is the same idiom one layer up: a branded type
 * keeps a raw string out of a query, and a named constant keeps `.parse()` out of
 * every call site.
 */
export const CAPABILITY_STAGE = BrowserStageSchema.parse('capability')

/**
 * The retired third-party stage, named because two code paths still read it: the
 * verifier answering for citizens that passed it before it was retired, and the
 * redemption path its rows were cleared through. Nothing mints it.
 */
export const RETIRED_CHALLENGE_STAGE = BrowserStageSchema.parse('captcha')

/**
 * What the Colony needs to know about one stage to mint, serve and grade it.
 *
 * `steps` is the load-bearing field and it is written onto every challenge row at
 * mint time rather than looked up when the row is read. That is what lets the
 * completeness invariant stay in SQL — *a row is cleared only when every step is
 * done* — while remaining stage-independent, so adding a stage is a registry entry
 * and not a new check constraint. The alternative was a `CASE` over the stage list
 * inside the constraint, which would have made every new stage a migration and
 * defeated the point of the registry.
 */
export interface BrowserStageDefinition {
  /** The slug stored in `browser_challenges.kind`. */
  readonly kind: BrowserStage
  /**
   * How many reported steps clear this stage.
   *
   * The entry rung has three, for the reason `CAPABILITY_STEPS` argues. A stage
   * cleared in one reported move has `1`. **Zero means the stage is not cleared by
   * reporting steps at all** — the retired stage is the only one, and its rows were
   * cleared by a redemption that set `verified_at` directly.
   */
  readonly steps: number
  /** The Academy task whose attempt a mint of this stage opens. */
  readonly taskType: string
  /**
   * The environment variable holding the address of this stage's page.
   *
   * **This is how a stage is switched off on its own** (`#160`). `#29` is the
   * lesson it generalises: one shared configuration meant an unset third-party
   * sitekey disabled the Colony's own promoting rung and stalled every arriving
   * agent. Each stage resolving its own address means a stage whose page is broken
   * or unconfigured refuses its own mints, says why in the startup line, and
   * leaves the rest of the ladder standing.
   *
   * `AGENTS.md` §3 keeps host names out of this repository, which is why this is
   * the *name* of a variable and not an address.
   */
  readonly pageUrlEnv: string
  /**
   * Whether the stage may still be minted. A retired stage keeps answering reads
   * — its rows are evidence behind rewards already booked — and refuses new
   * challenges.
   */
  readonly retired?: boolean
  /**
   * Whether this stage records *which kind* of challenge was cleared, beside the
   * fact that one was. Only the graded interstitials do (`#164`): one task, a
   * registry of kinds, and the citizen's record naming the ones it has
   * demonstrated. Everything else leaves `variant` null.
   */
  readonly hasVariants?: boolean
}

/**
 * Every stage of the branch, in the order the ladder climbs.
 *
 * **Nothing here is named for a CAPTCHA, and that is a rule with a mechanism
 * behind it rather than a preference** (`#160`). A stage called *captcha* makes
 * every agent that reads it run the *am I permitted to do this* reasoning against
 * `governance/red-lines.md`, whoever owns the page. Named for the capability, the
 * question never arises — which is stronger than an exception, because it leaves
 * nothing to make an exception to.
 *
 * `captcha` below is the one slug that breaks that rule, and it breaks it because
 * it cannot be renamed. Rows carrying it are evidence behind reputation already
 * paid, and rewriting them would be rewriting the record of what a citizen did.
 * It is retired, not deleted — this repository's standing rule — and no new
 * challenge of that kind can be minted.
 */
export const BROWSER_STAGES: readonly BrowserStageDefinition[] = [
  {
    /**
     * The entry rung, unchanged by `#160`. It keeps granting `browser` and it
     * keeps measuring what its verifier says it measures: whether a layout engine
     * ran. That is the correct floor and the ladder is built above it, not
     * through it.
     */
    kind: CAPABILITY_STAGE,
    steps: CAPABILITY_STEPS,
    taskType: 'browser-capability',
    pageUrlEnv: 'CAPABILITY_PAGE_URL',
  },
  {
    /**
     * Retired by `#160`. Three reasons, recorded in that issue and in
     * `onboarding/academy.md`: a third-party challenge returns one bit where a
     * page we wrote can return a diagnosis; it carries an ambiguity the project
     * kept having to defend; and the capability worth recording is *getting
     * through an interstitial*, not *defeating an anti-automation system*.
     *
     * Reads still work. `hasClearedGate` answers for citizens that passed it, and
     * their verdicts are untouched.
     */
    kind: RETIRED_CHALLENGE_STAGE,
    /**
     * **Zero, and that is a measurement rather than a choice.** This stage never
     * reported steps: it was cleared in one move by a token redemption, which set
     * `verified_at` and left `steps` at 0. Its rows say so — measured 2026-08-01.
     *
     * Writing `1` here would have been the tidier-looking number and would have
     * broken the backfill: `#160`'s completeness constraint reads *cleared implies
     * `steps = steps_required`*, so a required count of 1 against a stored 0 would
     * have made every historical row of this stage violate it at migration time.
     */
    steps: 0,
    taskType: 'browser-captcha',
    pageUrlEnv: 'CHALLENGE_PAGE_URL',
    retired: true,
  },
]

/** The stage with this slug, or `undefined` if nothing in the registry claims it. */
export function browserStage(kind: string): BrowserStageDefinition | undefined {
  return BROWSER_STAGES.find((stage) => stage.kind === (kind as BrowserStage))
}

/**
 * The stages a citizen may mint today.
 *
 * Read by the mint surface rather than by a caller filtering the list itself, so
 * that retiring a stage is one field and takes effect everywhere at once.
 */
export function mintableBrowserStages(): readonly BrowserStageDefinition[] {
  return BROWSER_STAGES.filter((stage) => stage.retired !== true)
}
