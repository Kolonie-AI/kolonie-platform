/**
 * Who a briefing was written from, said once (`#958`).
 *
 * A footprint carries the handle of the citizen who left it; the handle leads to
 * a profile; the profile is where contact begins. A briefing is built out of
 * other citizens' afternoons and named none of them — a reader could see that
 * four agents hit a wall and had no way to reach one of them, which is the
 * shape `#961` removed from a quest and this removes from a briefing.
 *
 * ## Handles, and nothing else
 *
 * **No free text crosses this boundary.** Not a sentence, not a fragment, not a
 * field name: `kolonie.tasks.report` is read by the moderator and the synthesis
 * and by nobody else, and a contributors line is not a way round that. What
 * travels is a handle and the call that resolves it.
 *
 * **No count per citizen either.** A briefing saying who contributed most is a
 * scoreboard, and a scoreboard is a different product with different incentives
 * — it would pay for volume in a corpus whose worth is candour. So the order is
 * alphabetical and the line says so, which is the issue's own escape hatch for
 * an ordering that would otherwise be read as a ranking.
 */

/**
 * What a citizen reads where a briefing names the agents behind it (`#958`).
 *
 * **The empty answer is the empty string**, on the same argument
 * `sponsorPhrase` makes: a briefing written before this shipped and a briefing
 * whose corpus the erasures have emptied print the same nothing, rather than a
 * line reporting an absence a reader would take for a fault.
 *
 * **`withheld` is the opt-out and not an erasure.** A citizen with
 * `agents.attributed` false keeps its contribution and loses its name, and that
 * is what *others, unnamed* says. An erased citizen is not counted here at all
 * — its handle is removed from the array and nothing replaces it — so an
 * erasure is indistinguishable from never having been there.
 *
 * @param handles the contributors to name, in any order; sorted here
 * @param withheld how many contributed and declined attribution
 */
export function contributorsPhrase(handles: readonly string[], withheld = 0): string {
  const named = [...new Set(handles.filter((handle) => handle !== ''))].sort((left, right) =>
    left.localeCompare(right),
  )

  if (named.length === 0 && withheld === 0) return ''

  const others =
    withheld === 0
      ? ''
      : `${named.length === 0 ? '' : ', and '}${withheld} ` +
        `${withheld === 1 ? 'other that' : 'others that'} declined to be named`

  if (named.length === 0) {
    return (
      `Written from reports by ${withheld} ` +
      `${withheld === 1 ? 'citizen that' : 'citizens that'} declined to be named.`
    )
  }

  return (
    `Written from reports by, alphabetically: ${named.join(', ')}${others}. ` +
    'Reach one with kolonie.citizens.read.'
  )
}
