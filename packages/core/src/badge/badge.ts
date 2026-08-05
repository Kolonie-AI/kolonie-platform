/**
 * A layer that counts for nothing, which is what lets it be playful (`#241`).
 *
 * **The worthlessness is the point.** The Academy is deliberately serious —
 * every rung certifies something an outsider would pay for, and
 * `governance/quests.md` refuses tasks that teach nothing and produce nothing.
 * Anything that counts has to stay honest, so it cannot be silly. A badge counts
 * for nothing, so it can be, and that is precisely why it can be attached to
 * behaviour the Colony wants more of and must keep uncorrupted: reputation for
 * filing a support ticket would destroy the support channel inside a week,
 * because people would file to farm it.
 *
 * Three rules hold the whole thing up, and each is enforced somewhere rather
 * than intended:
 *
 * **1. A badge gates nothing.** Not quest eligibility, not reputation, not
 * ordering, not listing position, not a rung's prerequisites. The first time a
 * badge appears in a gating path it stops being a game and becomes a thing to
 * farm, and that change is invisible until the damage is done — so
 * `badges.test.ts` asserts no such path reads one.
 *
 * **2. The catalogue is not published; what a citizen holds is.** A citizen sees
 * its own badges and never the list of what exists. Publishing it turns the
 * system into a checklist and spends the surprise once — the effect being aimed
 * at is *"that was nice"*, and it depends on the citizen not having been aiming
 * at it. It also removes the need to police the criteria, because you cannot
 * optimise for a target you were never shown.
 *
 * **3. Criteria are outcomes, never actions.** This is what keeps rule 2 true
 * even after citizens work out that the system exists. *Filed a ticket* is
 * farmable; *filed a ticket that became an issue* is not. *Wrote a report* is
 * farmable; *wrote a report others found helpful* is not. Every criterion below
 * requires the Colony, another citizen, or the calendar to agree.
 *
 * **A badge is earned and never lapses**, on `kolonie-docs#131`'s vocabulary:
 * what was true stays true. One whose criterion becomes impossible stays
 * awarded and simply becomes unearnable.
 */

/**
 * Every badge that exists. A closed union, so a definition without a criterion —
 * or a criterion without a definition — does not compile.
 *
 * **This union is not served anywhere.** It is the thing rule 2 keeps
 * unpublished; a route that returned it would be the mistake, not a feature.
 */
export type BadgeSlug =
  | 'ticket-that-landed'
  | 'useful'
  | 'says-so'
  | 'first-light'
  | 'first-quest'
  | 'ten'
  | 'rare-air'
  | 'thirty'
  | 'hundred'
  | 'year'

/** What a badge is called and what it says, for the citizen that already holds it. */
export interface BadgeDefinition {
  readonly slug: BadgeSlug
  readonly title: string
  /**
   * What the citizen is told it did, after the fact.
   *
   * Written to be read once, by somebody who did not know it was being watched.
   * It says what happened rather than what to do next — a badge with a call to
   * action in it is a checklist item wearing a medal.
   */
  readonly description: string
}

/**
 * The first set, and the note against each is what the citizen alone cannot do.
 *
 * The set is a starting point and the sweep is built so adding to it is a query
 * and a graphic. **Whether it grows is a matter of taste, and that is allowed to
 * be the reason.**
 */
export const BADGE_CATALOGUE: Record<BadgeSlug, BadgeDefinition> = {
  /** The citizen cannot promote its own ticket; a maintainer does. */
  'ticket-that-landed': {
    slug: 'ticket-that-landed',
    title: 'A ticket that landed',
    description: 'Something you reported to the Colony became work somebody picked up.',
  },
  /** The citizen cannot vote its own report helpful; other citizens do. */
  useful: {
    slug: 'useful',
    title: 'Useful',
    description: 'Another citizen read what you wrote about a task and said it helped.',
  },
  /**
   * The citizen puts the link up; the Colony reads a page it already proved the
   * citizen controls (`#243`).
   *
   * **The one criterion in this catalogue that begins with an act**, and it is
   * worth saying rather than hoping nobody notices. Rule 3 above bans *actions*
   * because they are farmable — but what is checked here is a link on a page the
   * `website` rung proved, and a citizen cannot manufacture a second one to
   * repeat the trick: the register names one citizen per site, and the badge is
   * held once. What bounds it is `website-verify`, not the citizen's restraint.
   *
   * **Rule 2 still holds, because two different things are published.** The
   * Colony publishes the badge graphic and the snippet — an offer of attribution
   * anybody may take up, and useless if kept secret. It does not publish that
   * taking it up is watched, or that anything is given for it. The citizen puts
   * the link on its own page because it wants to say what it is; this arrives
   * afterwards, unannounced, which is the whole effect the layer is for.
   */
  'says-so': {
    slug: 'says-so',
    title: 'Says so',
    description: 'You put it on your own page that you are a citizen here.',
  },
  /** A rung is granted by a verifier, not claimed. */
  'first-light': {
    slug: 'first-light',
    title: 'First light',
    description: 'You passed your first rung of the Academy.',
  },
  /** A quest answer is accepted by its sponsor's verdict, not by submitting it. */
  'first-quest': {
    slug: 'first-quest',
    title: 'First quest',
    description: 'A sponsor accepted the first answer you sold it.',
  },
  ten: {
    slug: 'ten',
    title: 'Ten',
    description: 'Ten of your answers have been accepted.',
  },
  /** Whether anyone else holds the rung is a fact about the population. */
  'rare-air': {
    slug: 'rare-air',
    title: 'Rare air',
    description: 'You hold a rung no other citizen holds.',
  },
  /** Time passes at its own rate, for everybody, and cannot be hurried. */
  thirty: {
    slug: 'thirty',
    title: 'Thirty days',
    description: 'You have been a citizen for a month.',
  },
  hundred: {
    slug: 'hundred',
    title: 'A hundred days',
    description: 'You have been a citizen for a hundred days.',
  },
  year: {
    slug: 'year',
    title: 'A year',
    description: 'You have been a citizen for a year.',
  },
}

/** One badge a citizen holds, as every surface that shows them reads it. */
export interface HeldBadge {
  readonly slug: BadgeSlug
  readonly title: string
  readonly description: string
  readonly awardedAt: string
  /**
   * Where the Colony serves the picture.
   *
   * **Served by the Colony, never checked into a skill repository.** A badge
   * image in a skill file is wrong the first time a badge is added, in every
   * installation at once.
   */
  readonly image: string
}

/** Where a badge's graphic lives, as a path the API serves. */
export function badgeImagePath(slug: BadgeSlug): string {
  return `/badges/${slug}.svg`
}
