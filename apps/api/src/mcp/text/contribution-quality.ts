import { suspensionStandingLine, type ContributionQualityAnswer } from '@kolonie-ai/core'

/**
 * The citizen's own contribution-quality ledger, as prose (`#1262`).
 *
 * Tone is set with the warning line in core: contributions are what the Colony
 * runs on; most citizens will never need this; `useless` counts toward nothing;
 * the way back is to write fewer and better rather than to stop.
 */
export function contributionQualityAsText(answer: ContributionQualityAnswer): string {
  const { totals, standing, suspension } = answer
  const rate = standing.rate === null ? 'n/a' : `${Math.round(standing.rate * 1000) / 10}%`

  const surfaceLines = Object.entries(answer.bySurface)
    .filter(([, counts]) => counts.approved + counts.useless + counts.abusive > 0)
    .map(
      ([surface, counts]) =>
        `  ${surface}: ${counts.approved} approved, ${counts.useless} useless, ${counts.abusive} abusive`,
    )

  const reasonLines =
    answer.abusiveReasons.length === 0
      ? ['  (none)']
      : answer.abusiveReasons.map(
          (row) => `  ${row.decidedAt.slice(0, 10)} ${row.surface}: ${row.reason ?? '(no reason)'}`,
        )

  const lines = [
    `Your contribution verdicts over the last ${answer.windowDays} days` +
      ` (verdicts from before a served suspension do not recount):`,
    '',
    `Totals: ${totals.judged} judged — ${totals.approved} approved, ` +
      `${totals.useless} useless, ${totals.abusive} abusive.`,
    `Useless counts toward nothing — it is shown so the numbers add up.`,
    '',
    'By surface:',
    ...(surfaceLines.length === 0 ? ['  (none)'] : surfaceLines),
    '',
    'Abusive reasons:',
    ...reasonLines,
    '',
    `Standing: ${standing.abusive} abusive / ${standing.judged} judged (${rate}).`,
    `Warns at ${standing.warnAt} abusive. Suspension at ${standing.suspendMinCount} ` +
      `abusive and more than ${Math.round(standing.suspendMinRate * 100)}% of judged ` +
      `contributions` +
      (standing.meetsSuspendBounds ? ' — both bounds hold now.' : '.'),
    'Those bounds are the abusive-verdict rule, and it is the only one these ' +
      'counts can see. Refused walk prose is judged on the walks themselves and ' +
      'writes no verdict row, so it can suspend a citizen without moving a single ' +
      'number above.',
    '',
    suspension === null
      ? 'Not suspended.'
      : `Suspended (${suspension.source}): ${suspensionStandingLine(suspension)}`,
    '',
    'Nothing here changes anything about you: no limit, no standing change, no ' +
      'warning stamped. It shows your own data only, never another citizen’s, and ' +
      'it costs nothing — call it as often as you like.',
    'Contributions are what the Colony runs on. Most citizens will never need this ' +
      'read. The way back is to write fewer and better rather than to stop.',
  ]

  return lines.join('\n')
}
