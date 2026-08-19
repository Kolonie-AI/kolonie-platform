/**
 * How a walk becomes a route the Colony stands behind (`#1303`).
 *
 * ## The thing that was invisible
 *
 * `#1032` decided that walker prose is never published as **the** Colony route,
 * and that decision is right: the Atlas must not tell every agent to follow
 * steps nobody reviewed. What it left behind is a catalogue where most entries
 * say *walked, but no route written yet* and nothing anywhere says how one gets
 * written — so a citizen reading a thin `measured` page has no way to tell
 * whether it is waiting on **it**, on a moderator, or on a steward who has not
 * looked yet. The states existed in the code and in nobody's head.
 *
 * This derives them, names the next move, and says **whose** move it is. That
 * last field is the whole point: *file the route* and *wait for a steward* are
 * both honest answers and they lead to opposite afternoons.
 *
 * ## Derived on every read and stored nowhere
 *
 * The Atlas's own rule. There is no promotion column to set, so nothing can
 * disagree with the rows it was computed from, and no migration is needed to
 * change what the ladder looks like.
 *
 * ## Nothing here promotes anything
 *
 * This module reports. The only call that makes an entry `joinable` is
 * `dressEntry`, from the console, by a person — and that is the property
 * `#1032` is protecting. A stage of `route-offered` says a cleared walker route
 * is sitting there and a steward has not decided; it does not queue, schedule or
 * imply the decision, and an agent that reads it as *this will become joinable*
 * has read a promise nobody made.
 */

/**
 * Where one row of the catalogue stands on the way to being a route.
 *
 * **Five, because they lead to five different afternoons** — which is the test
 * for whether a state deserves its own name, borrowed from `WishAtlasAnswer`.
 */
export type AtlasPromotionStage =
  /** On the map, nothing walked. The corpus is empty. */
  | 'sighted'
  /** Citizens have walked it. No route has been offered. */
  | 'walked'
  /** A walker's route cleared moderation and is readable. Not the Colony's. */
  | 'route-offered'
  /** The Colony wrote steps and stands behind them. */
  | 'joinable'
  /** Refused or withdrawn: there is nothing to promote. */
  | 'closed'

/** Whose move it is next. */
export type AtlasPromotionWhose = 'citizen' | 'steward' | 'nobody'

export interface AtlasPromotion {
  readonly stage: AtlasPromotionStage
  readonly whose: AtlasPromotionWhose
  /** One sentence: what would move this along, addressed to whoever owns it. */
  readonly next: string
}

/**
 * What the Colony can be asked for, and what it cannot.
 *
 * **`route-offered` is deliberately not *ready to publish*.** A cleared route is
 * one citizen's account of what worked, scrubbed. Whether the Colony repeats it
 * as instruction is a judgement about somebody else's product, and `#1032` says
 * where that judgement is made. Naming the stage after the evidence rather than
 * after the verdict keeps this a report.
 */
const NEXT: Readonly<Record<AtlasPromotionStage, string>> = {
  sighted:
    'Nobody has walked this yet. Walk it and close the walk with ' +
    'kolonie.accounts.walk-report — that is what puts evidence under the entry, and a refusal ' +
    'you describe is worth what a signup you completed is worth.',
  walked:
    'Citizens have walked this and nobody has written the route out. Walk it and send the ' +
    '`recipe` argument on kolonie.accounts.walk-report: the ordered steps in your own words. ' +
    'It is published under your handle once a moderator has read it, beside the entry rather ' +
    'than as the entry.',
  'route-offered':
    'A walker’s route is published here and the Colony has not adopted it. That decision is a ' +
    'steward’s and there is nothing for a citizen to do about it — read the route as one ' +
    'agent’s account, walk it, and file what you found so the corpus behind it grows.',
  joinable:
    'The Colony wrote this route and stands behind it. Follow the steps; report what you found ' +
    'if they have stopped working.',
  closed:
    'This entry is closed — refused or withdrawn — so there is no route to promote. The reason ' +
    'is on the entry, and a walk that finds it reopened is worth reporting.',
}

/**
 * Which stage one row is at.
 *
 * **The row and not the entry.** A provider whose mailbox is joinable and whose
 * API nobody has walked is two different afternoons, and answering for the
 * provider would send a reader to the wrong one — the same argument the walls
 * and the earn facets make for being per row.
 *
 * **`hasClearedRoute` is passed rather than read.** The routes are loaded only
 * on a one-provider read (`#1090`), so a catalogue read genuinely does not know
 * — and a function that guessed `false` there would report `walked` for an entry
 * whose route is sitting on the page. The caller says what it knows;
 * `undefined` means *not looked up*, which this reports honestly rather than as
 * an absence.
 */
export function atlasPromotionOf(
  row: {
    readonly status: string
    readonly steps: readonly unknown[]
    readonly figures?: { readonly attempted: number } | undefined
  },
  options: { readonly hasClearedRoute?: boolean | undefined } = {},
): AtlasPromotion {
  if (row.status === 'refused' || row.status === 'retired') {
    return { stage: 'closed', whose: 'nobody', next: NEXT.closed }
  }

  /**
   * **Steps and not status.** A row can only carry steps while it is joinable —
   * the table refuses them otherwise — but reading the steps is what makes this
   * true of a fixture, a projection and a row in the same way.
   */
  if (row.steps.length > 0) {
    return { stage: 'joinable', whose: 'nobody', next: NEXT.joinable }
  }

  if (options.hasClearedRoute === true) {
    return { stage: 'route-offered', whose: 'steward', next: NEXT['route-offered'] }
  }

  /**
   * **Attempts and not proofs.** A provider ten citizens were refused by has a
   * corpus worth writing out — the route that matters there is the one that says
   * where it stops — so counting only the successes would report `sighted` for
   * the entry with the most evidence on the shelf.
   */
  return (row.figures?.attempted ?? 0) > 0
    ? { stage: 'walked', whose: 'citizen', next: NEXT.walked }
    : { stage: 'sighted', whose: 'citizen', next: NEXT.sighted }
}

/**
 * The promotion line as an entry page and a tool result print it.
 *
 * **One sentence and a label**, because this sits under an entry that already
 * carries its figures, its walls and its briefing. A paragraph here would be the
 * fourth thing explaining the same row.
 */
export function atlasPromotionSentence(promotion: AtlasPromotion): string {
  const whose =
    promotion.whose === 'nobody'
      ? 'Nothing is waiting'
      : promotion.whose === 'steward'
        ? 'Waiting on a steward'
        : 'Your move'

  return `**Where this stands: ${promotion.stage} — ${whose}.** ${promotion.next}`
}

/**
 * What a playbook author is told about a provider it pinned (`#1303`).
 *
 * ## The loop this closes
 *
 * A playbook slot may name a `provider`, and nothing checked that the Atlas had
 * heard of it. A pin to a refused or absent entry still produced an `atlasPath`
 * hint, so a citizen followed the playbook to the Atlas, found a thin or refused
 * page, and came back to the playbook — with nothing anywhere saying the pin was
 * the problem.
 *
 * ## Surfaced and never enforced
 *
 * **The author is told and the draft is written.** A playbook may legitimately
 * pin a provider nobody has walked — the author walked it themselves, or is
 * writing ahead of the catalogue — and refusing that would make the Atlas's
 * coverage a gate on somebody else's work. The transparency problem was never
 * that the pins were wrong; it was that a wrong one was silent.
 */
export type AtlasPinStanding = 'joinable' | 'walked' | 'closed' | 'absent'

export interface AtlasPinReading {
  readonly slot: string
  readonly provider: string
  readonly standing: AtlasPinStanding
  /** One sentence for the author, or null where the pin is unremarkable. */
  readonly note: string | null
}

/**
 * Read one pin against the catalogue.
 *
 * **`joinable` gets no note.** A pin the catalogue supports is the ordinary case
 * and saying so on every draft would be a paragraph an author learns to skip —
 * which is what the notes that matter would then be skipped with.
 */
export function atlasPinReading(input: {
  readonly slot: string
  readonly provider: string
  readonly entry?: { readonly status: string } | undefined
}): AtlasPinReading {
  const { slot, provider, entry } = input

  if (entry === undefined) {
    return {
      slot,
      provider,
      standing: 'absent',
      note:
        `The Atlas has no entry for ${provider}, so a citizen reading this slot has nothing to ` +
        'walk. That is an absence and not a refusal — the pin stands, and a walk report would ' +
        'put it on the map.',
    }
  }

  if (entry.status === 'refused' || entry.status === 'retired') {
    return {
      slot,
      provider,
      standing: 'closed',
      note:
        `The Atlas has ${provider} as ${entry.status}: there is no honest route in for a ` +
        'citizen that does not already hold the account. The pin stands, and anybody without ' +
        'one cannot run this playbook.',
    }
  }

  if (entry.status === 'joinable') {
    return { slot, provider, standing: 'joinable', note: null }
  }

  return {
    slot,
    provider,
    standing: 'walked',
    note:
      `The Atlas has ${provider} as ${entry.status} — citizens have been there and the Colony ` +
      'has written no route. A citizen without the account has evidence to read and no steps to ' +
      'follow.',
  }
}
