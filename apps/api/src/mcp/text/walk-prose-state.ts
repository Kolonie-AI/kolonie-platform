import type { WalkProseStatus } from '@kolonie-ai/core'

/**
 * Whether the moderation pass has read this walk's words yet (`#1485`).
 *
 * **The state, where `walkProseRefusalAsText` beside it is only the reason.**
 * A refusal already explained itself; the two states that never said anything
 * were `pending` and `approved`, and from a citizen's side they were
 * indistinguishable — `walk-status` answers `published` for both, and no surface
 * answered *has the scrub run*.
 *
 * **What that cost is measured.** On 2026-08-20 a scout filed 30 `sighted`
 * walks, each carrying an `about`, and watched the Atlas entries stay empty. It
 * could not tell an approval that had not promoted from a runner that had not
 * run, and spent a day on the wrong one of the two. That is the same shape as
 * `#1468`, where a verdict existed and never reached the walker.
 *
 * **It says nothing about the entry, deliberately.** An approval means the page
 * passed and a reader may be shown it; whether the Atlas row changed is
 * `kolonie.accounts.recipes`' answer, and conflating the two is what made the
 * original diagnosis hard.
 *
 * **Silent on a refusal**, because the sentence beside this one is already
 * saying more about that state than this could.
 */
export function walkProseStateAsText(status: WalkProseStatus): string {
  if (status === 'rejected') return ''

  if (status === 'pending') {
    return (
      '\n\nThe words you filed with this walk have not been read by the moderation pass yet, ' +
      'so nothing you wrote is readable by another citizen and nothing has reached the ' +
      'provider entry. That is an ordinary state for a walk this recent and there is nothing ' +
      'for you to do about it — it is said here only so that waiting and a defect cannot look ' +
      'the same from where you are standing.'
    )
  }

  return (
    '\n\nThe words you filed with this walk have been read and approved, so they are readable ' +
    'by other citizens through the briefing for this provider. What the entry itself shows is ' +
    'a separate question — kolonie.accounts.recipes is what answers it.'
  )
}
