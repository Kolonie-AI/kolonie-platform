import type { ProviderRecipe, RecipeStep } from './recipe.js'
import { RECIPE_MAX_STEPS } from './recipe.js'
import type { AccountEpisode, AccountSlot } from './thread.js'

/**
 * What a closed acquisition episode says about the provider (`#935`).
 *
 * ## Why this exists beside `walkVerdict` rather than inside it
 *
 * `kolonie.accounts.walk-report` asks an agent to reconstruct, in prose and days
 * later, what it already knew at the time — and measured on 2026-08-13 that
 * channel had produced **nothing** for the telephony shelf: three entries,
 * `unwritten`, `steps: []`, while seventeen providers were proved and sixteen
 * dead ends recorded through other calls. An episode holds the same material as
 * structure rather than recollection, so the draft can fall out of closing it
 * with nobody asked to write anything up.
 *
 * The *decision* about what a finished path means for the catalogue is not
 * duplicated: `walkVerdict` still owns it, and this module answers the narrower
 * question of what an episode observed. The two meet at the storage layer, which
 * writes a draft the same way from either.
 *
 * ## What an episode is allowed to contribute
 *
 * **Only which values, in what order, and which step was human.** `#935` is
 * explicit that a derived step carries no selector, no provider field name and
 * no screenshot — that is the part of a signup that ages in weeks, and the rest
 * ages in years. Nothing here reads an entry body, a note or a title: the
 * steward reads the episode itself, and a second copy of one fact in a
 * publishable field is the failure `D-002` names.
 *
 * **It is a draft and never the Colony's words.** It reaches no public surface
 * until a steward publishes it, exactly as a walk's draft does. Otherwise one
 * crooked episode becomes everybody's recipe.
 */

/** The little of a slot this derivation reads. Deliberately not the value. */
export type ObservedSlot = Pick<AccountSlot, 'label' | 'secret' | 'filledBy' | 'filledAt'>

/** The little of an episode this derivation reads. */
export type ObservedEpisode = Pick<AccountEpisode, 'kind' | 'outcome' | 'wall'>

/**
 * The slots that were actually filled, as recipe steps, in the order they were.
 *
 * **A slot nobody filled is a thing that did not happen.** `account_slots` has
 * no creation timestamp, so an unfilled slot could not be ordered against the
 * rest even if it were wanted — but the reason it is not wanted comes first: a
 * recipe step is an observation, and a container somebody opened and abandoned
 * observed nothing.
 *
 * **Ordered by `filled_at`, tie-broken by label.** Two slots filled inside the
 * same clock tick would otherwise come out in whatever order the database
 * happened to return, and a recipe whose step order changes between reads is one
 * a steward cannot review.
 */
export function episodeToSteps(slots: readonly ObservedSlot[]): readonly RecipeStep[] {
  const filled = slots.flatMap((slot) =>
    slot.filledBy === null || slot.filledAt === null
      ? []
      : [{ label: slot.label, secret: slot.secret, by: slot.filledBy, at: slot.filledAt }],
  )

  const ordered = [...filled].sort((one, two) => {
    const at = one.at.localeCompare(two.at)
    return at === 0 ? one.label.localeCompare(two.label) : at
  })

  return ordered.map((slot) => ({
    actor: slot.by,

    /**
     * **The label is the ask, and only where an operator filled it.**
     *
     * `RecipeStepSchema` requires an `ask` on every operator step and refuses one
     * on an agent step, so something has to be the sentence the human read — and
     * the label is exactly that. `apps/api/src/console/html.ts` renders it under
     * *What it is* and as the fill input's `aria-label`: it is text the operator
     * actually read, not text the Colony invented for them afterwards. That is
     * the same argument the walk's `ask` already makes, and it is the only one
     * that would justify carrying free text into a publishable field.
     *
     * `SLOT_LABEL_MAX_LENGTH` is 120 and `RECIPE_STEP_MAX_LENGTH` is 500, so no
     * label can overflow the field it lands in.
     */
    ...(slot.by === 'operator' ? { ask: slot.label } : {}),

    /**
     * **Only an operator step may be marked secret**, which `RecipeStepSchema`
     * refines and this respects rather than works around. An agent-filled secret
     * is the handover direction — the agent choosing a password and sealing it
     * for the console — and in *recipe* terms that is not a step where the
     * provider asks a human for something. Marking it would say the opposite of
     * what happened.
     */
    ...(slot.secret && slot.by === 'operator' ? { secret: true } : {}),

    /**
     * No `instruction`, which is what makes these steps a draft. A `draft` is the
     * one status permitted to carry a wordless step (`#601`), and inventing a
     * sentence here is precisely the *Colony's own words* `#935` refuses.
     */
  }))
}

/**
 * What closing this episode proposes to the catalogue.
 *
 * A deliberately smaller vocabulary than `WalkVerdict`: an episode has no
 * tick-list against a published recipe, so it can neither confirm one nor raise
 * a divergence, and pretending otherwise would put an unchecked shape beside a
 * shape a steward passed.
 */
export type EpisodeVerdict =
  | { readonly kind: 'nothing'; readonly why: string }
  | { readonly kind: 'draft'; readonly steps: readonly RecipeStep[] }
  | { readonly kind: 'refusal'; readonly wall: string }

export function episodeVerdict(
  episode: ObservedEpisode,
  slots: readonly ObservedSlot[],
  entry: Pick<ProviderRecipe, 'status'> | undefined,
): EpisodeVerdict {
  /**
   * **The rejection case `#935` names, and the first thing asked.** A maintenance
   * episode is not a recipe and must never become part of one: it is about an
   * account that already exists, and the steps in it are repairs rather than a
   * way in. Asked before anything else so that no later branch can reach a
   * maintenance episode by another route.
   */
  if (episode.kind !== 'acquisition') {
    return {
      kind: 'nothing',
      why: 'only an acquisition episode says how an account is obtained; a maintenance episode is a repair and is not part of a recipe',
    }
  }

  if (episode.outcome === null) {
    return { kind: 'nothing', why: 'the episode has not been closed' }
  }

  if (episode.outcome === 'failed') {
    /**
     * `account_episodes_failed_has_a_wall` makes the null impossible in storage;
     * this module is called with plain objects in tests and from a boundary that
     * could change, so it says what it does rather than asserting.
     */
    return episode.wall === null || episode.wall.length === 0
      ? { kind: 'nothing', why: 'a failure has to name the wall it ended at' }
      : { kind: 'refusal', wall: episode.wall }
  }

  /**
   * **`abandoned` proposes nothing**, for the reason `walkVerdict` gives about a
   * walk that stopped part-way: half a path published as a recipe is one that
   * fails at step three, and `unwritten` exists so the Colony can say it does not
   * know rather than guess.
   *
   * `repaired` lands here too. It is a maintenance outcome, and on an acquisition
   * it is a caller saying something this module has no reading of — which is a
   * reason to propose nothing rather than to pick one.
   */
  if (episode.outcome === 'abandoned' || episode.outcome === 'repaired') {
    return {
      kind: 'nothing',
      why:
        episode.outcome === 'abandoned'
          ? 'the episode stopped part-way, so what it holds is half a path — and half a path published as a recipe is one that fails at step three'
          : 'a repair is not how an account is obtained, so it proposes nothing about the way in',
    }
  }

  /**
   * **Against a published entry, propose nothing.** An episode carries no answer
   * to *which of the published steps did you take*, so its shape can be matched
   * against a published one only by mistaking one for the other. `#600`'s rule is
   * unchanged either way: what the Colony says about somebody else's product
   * passes a person, and this must not overwrite what one already passed.
   */
  if (entry !== undefined && entry.status !== 'unwritten' && entry.status !== 'draft') {
    return {
      kind: 'nothing',
      why: 'a steward has already published an entry for this provider, and an episode carries no tick-list that could confirm or contradict it',
    }
  }

  const steps = episodeToSteps(slots)

  if (steps.length === 0) {
    return { kind: 'nothing', why: 'nothing was observed, so there is nothing to propose' }
  }

  /**
   * **More steps than a recipe holds proposes nothing rather than the first
   * twenty.** A truncated path is the half path above wearing a full path's
   * clothes, and it is the one that fails silently: a reader has no way to tell
   * it stopped early.
   */
  if (steps.length > RECIPE_MAX_STEPS) {
    return {
      kind: 'nothing',
      why: `the episode filled ${String(steps.length)} slots and a recipe holds ${String(RECIPE_MAX_STEPS)}; a truncated path reads as a whole one, so nothing is proposed`,
    }
  }

  return { kind: 'draft', steps }
}
