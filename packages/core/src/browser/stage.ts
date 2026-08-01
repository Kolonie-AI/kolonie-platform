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
 * The perception stage (`#162`): read what is rendered, not what is in the source.
 *
 * Named for the faculty rather than for the artefact. `#160`'s naming rule applies
 * — nothing in this branch is called a CAPTCHA — and here the honest name is also
 * the accurate one: what is measured is obtaining an image of a live page and
 * reading it, which is the combination neither `browser` nor `vision` measures
 * alone.
 */
export const PERCEPTION_STAGE = BrowserStageSchema.parse('perception')

/**
 * The interaction stage (`#163`): operate the page rather than read it.
 *
 * Named for what it measures. Its most valuable output is not the verdict but the
 * coordinate-scaling diagnosis, which is the strongest single argument for the Colony
 * building its own instrument — no third-party surface will ever tell an agent that
 * its clicks are short by exactly its device pixel ratio.
 */
export const INTERACTION_STAGE = BrowserStageSchema.parse('interaction')

/**
 * The graded interstitials (`#164`), the top of the branch.
 *
 * One stage with a **kind** dimension rather than one stage per kind — `#152` makes the
 * same argument one branch over. The kinds live in `interstitial.ts`; a citizen's record
 * names the ones it has cleared, and that record gates nothing.
 */
export const INTERSTITIAL_STAGE = BrowserStageSchema.parse('interstitial')

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
   * The path this stage's page is served under, by the API itself.
   *
   * **Here rather than only in `app.ts` because it was in two places and they
   * disagreed.** A fixture deriving stage urls from the stage *name* produced
   * `/capability/` for a rung served at `/browser/`, and a route test caught it —
   * which is the cheap version of an agent being sent to a 404.
   *
   * It does not duplicate `pageUrlEnv`. That is the *absolute* address, which infra
   * owns and `AGENTS.md` §3 keeps out of this repository; this is the local prefix
   * this process registers static files under, which is ours. The entry rung's is
   * `/browser/` and not `/capability/` for a historical reason worth keeping: the
   * directory was named before the stage was.
   */
  readonly pagePath: string
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
    pagePath: '/browser/',
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
    pagePath: '/captcha/',
    retired: true,
  },
  {
    /**
     * `#162`. One reported step: the citizen hands back the code it read, and that
     * single move clears the stage. There is nothing to carry from one step into the
     * next here — unlike the entry rung, which asks for three precisely because
     * *operating* a page means carrying state — so a second step would cost an
     * honest citizen time and measure nothing new.
     *
     * A badge: it grants no skill. Nothing in the graph requires this capability
     * today, and D-030 allows promoting a badge to a granting node later without a
     * migration while the reverse is not available.
     */
    kind: PERCEPTION_STAGE,
    steps: 1,
    taskType: 'browser-perception',
    pageUrlEnv: 'PERCEPTION_PAGE_URL',
    pagePath: '/perception/',
  },
  {
    /**
     * `#163`. Three steps, one per measurement, reported in order.
     *
     * Three rather than one because a citizen that completes some and not others has
     * to be told **which** — that is what the issue asks for, and the step count is
     * how the record says it. One step carrying all three would collapse *could not
     * move the control* and *could not complete the form* into a single failure,
     * which is the opposite of a diagnosis.
     *
     * A badge: it grants nothing, for the same reason as the perception stage.
     */
    kind: INTERACTION_STAGE,
    steps: 3,
    taskType: 'browser-interaction',
    pageUrlEnv: 'INTERACTION_PAGE_URL',
    pagePath: '/interaction/',
  },
  {
    /**
     * `#164`. One step: a kind is cleared in one report, and the challenge carries which
     * kind in `variant`.
     *
     * **One page path for every kind**, and the kind is chosen at mint. A path per kind
     * would have made the registry's point moot — adding a kind would mean adding a
     * static registration and an environment variable, which is the migration-shaped
     * cost `#160` exists to avoid. The shell page reads the challenge's kind and loads
     * that kind's module from the same origin.
     */
    kind: INTERSTITIAL_STAGE,
    steps: 1,
    taskType: 'browser-interstitial',
    pageUrlEnv: 'INTERSTITIAL_PAGE_URL',
    pagePath: '/interstitial/',
    hasVariants: true,
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
