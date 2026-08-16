import type { ProviderRecipe } from './recipe.js'
import type { AccountEpisode } from './thread.js'

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
 * structure rather than recollection, so the entry can fall out of closing it
 * with nobody asked to write anything up.
 *
 * The *decision* about what a finished path means for the catalogue is not
 * duplicated: `walkVerdict` still owns it, and this module answers the narrower
 * question of what an episode observed. The two meet at the storage layer, which
 * writes the entry the same way from either.
 *
 * ## What an episode is allowed to contribute, after `#1032`
 *
 * **That the pair exists and somebody got through it, and nothing else.** This
 * module used to derive a *route* — which values in what order, which step was
 * human — and that route became a `draft` entry waiting for a steward to dress
 * it in wording the episode never observed. Two entries were ever dressed, so
 * `#1032` deleted the gate and the status behind it. What a `writes` verdict
 * produces now is a `measured` row carrying no steps at all.
 *
 * **That is a deletion and not a loss.** The slots, their order and which side
 * filled each are still on `account_slots`, where they always were; what the
 * catalogue stops doing is republishing them as an instruction under the
 * Colony's name. A reader who wants the path reads the provider's computed
 * briefing, which is written from the walks at that pair, under their own
 * authors and with their own prose moderation.
 */

/** The little of an episode this derivation reads. */
export type ObservedEpisode = Pick<AccountEpisode, 'kind' | 'outcome' | 'wall'>

/**
 * What closing this episode proposes to the catalogue.
 *
 * A deliberately smaller vocabulary than `WalkVerdict`: an episode has no
 * tick-list against a published recipe, so it can neither confirm one nor raise
 * a divergence, and pretending otherwise would put an unchecked shape beside the
 * one the Colony stands behind.
 *
 * **`writes` carries nothing** (`#1032`), on `walkVerdict`'s rule and for its
 * reason: the entry it produces is `measured`, which is figures and no route.
 */
export type EpisodeVerdict =
  | { readonly kind: 'nothing'; readonly why: string }
  | { readonly kind: 'writes' }
  | { readonly kind: 'refusal'; readonly wall: string }

export function episodeVerdict(
  episode: ObservedEpisode,
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
  if (entry !== undefined && entry.status !== 'unwritten' && entry.status !== 'measured') {
    return {
      kind: 'nothing',
      why: 'the Colony already publishes an entry for this provider, and an episode carries no tick-list that could confirm or contradict it',
    }
  }

  return { kind: 'writes' }
}
