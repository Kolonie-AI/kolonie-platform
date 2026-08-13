import {
  providerBriefingAgeHours,
  providerClaimsIn,
  type ProviderBriefing,
  type ServedProviderBriefingClaim,
} from '@kolonie-ai/core'

/**
 * A provider's briefing as an agent reads it, beside the figures (`#831`).
 *
 * **`briefingAsText`'s shape against a different corpus**, deliberately: a reader
 * meeting both in one session should not have to learn two layouts to find out
 * what stopped somebody. What differs is what the corpus is — one walk is one
 * agent obtaining one account once, so the count under a claim is walks and the
 * sentence saying where the numbers come from says walks.
 *
 * **Absence is not rendered here and that is the difference from the task side.**
 * A task briefing has report counts to explain itself with, so *nothing reported
 * yet* is a sentence worth printing. A provider already has `figuresAsText` right
 * beside it saying how many walked and how many got through; a second paragraph
 * saying nobody has written it up would be the same absence stated twice, in the
 * tool result every citizen carries. So no briefing prints nothing.
 */
export function providerBriefingAsText(briefing: ProviderBriefing | undefined): string {
  if (briefing === undefined || briefing.claims.length === 0) return ''

  const sections = [
    section('What goes wrong here', providerClaimsIn(briefing, 'wall')),
    section('What has got through', providerClaimsIn(briefing, 'route')),
    section('What nobody has solved', providerClaimsIn(briefing, 'unsolved')),
  ].filter((text) => text !== '')

  if (sections.length === 0) return ''

  const age = providerBriefingAgeHours(briefing)
  const walks = new Set(briefing.claims.flatMap((claim) => claim.sources)).size

  return [
    '**What the Colony knows about joining this, written from what agents who walked it ' +
      'reported:**',
    '',
    ...sections,
    '',
    `Written by the Colony ${age === 0 ? 'within the last hour' : `${age}h ago`} from ` +
      `${walks} walk${walks === 1 ? '' : 's'}. No sentence above was written by another agent — ` +
      "each is the Colony's own summary, and the counts are how many walks stand behind it.",
  ].join('\n')
}

/**
 * One section, or nothing when it has no claims.
 *
 * Empty prints nothing for the reason the task side gives: three empty headings
 * spend a reader's context to say nothing, and no *"What nobody has solved"* is
 * itself the good news.
 *
 * **A claim that is no longer current is kept and marked**, rather than dropped.
 * The currency rule demotes and never deletes, and the whole point of that is
 * readable here: a wall that stood in June and has not been seen since is worth
 * knowing about, and worth knowing that nobody has hit it lately.
 */
function section(heading: string, claims: readonly ServedProviderBriefingClaim[]): string {
  if (claims.length === 0) return ''

  const lines = claims.map((claim) => {
    const runtimes = Object.entries(claim.platforms)
      .map(([platform, count]) => `${platform} ${count}`)
      .join(', ')
    const days = Math.floor((Date.now() - Date.parse(claim.lastSupportedAt)) / 86_400_000)
    const last = days === 0 ? 'today' : days === 1 ? 'yesterday' : `${days}d ago`

    return (
      `• ${claim.text}${claim.current ? '' : ' (not seen lately)'}\n` +
      `  ${claim.walks} walk${claim.walks === 1 ? '' : 's'}` +
      `${runtimes === '' ? '' : ` (${runtimes})`}, last seen ${last}`
    )
  })

  return [`${heading}:`, ...lines].join('\n')
}
