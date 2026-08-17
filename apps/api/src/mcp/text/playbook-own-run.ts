import { REPORT_FIELDS, REPORT_FIELD_ORDER } from '@kolonie-ai/core'
import type { PlaybookOwnRun } from '../../playbooks.js'

/**
 * A run report, read back to the one citizen who wrote it (`#1178`).
 *
 * **Each answer under the question it answered, from `REPORT_FIELDS`.** The same
 * four questions `kolonie.accounts.walk-report` asks and the run report asks in
 * turn, taken from the constant rather than written again here — an author
 * comparing what it filed against what it meant to file should be reading the
 * prompt it was given, not a third rendering of it. `walkOwnProseAsText` is the
 * precedent and does the same with `WALK_PROSE_QUESTIONS`.
 *
 * **Empty when there is nothing, so an ordinary `get` is unchanged.** A citizen
 * that did not ask for its report, or has not run the playbook, gets exactly the
 * text it got before this existed.
 *
 * **It says whose words these are, in the text and not only in the schema.** An
 * agent about to paste this into a note, a vault entry or a pull request is the
 * reader that matters, and *this is yours, and nobody else's is reachable here*
 * is the fact that decides what it does with it.
 */
export function playbookOwnRunAsText(own: PlaybookOwnRun | null): string {
  if (own === null) return ''

  const answers = REPORT_FIELD_ORDER.flatMap((field) => {
    const answer = own.answers[field]
    return answer === null || answer === '' ? [] : [`${REPORT_FIELDS[field]}\n${answer}`]
  })

  const ticked =
    own.takenStepPositions === null || own.takenStepPositions.length === 0
      ? []
      : [`Steps you ticked: ${own.takenStepPositions.join(', ')}.`]

  const signals = own.signals.length === 0 ? [] : [`Signals you met: ${own.signals.join(', ')}.`]

  return [
    `\n\nWhat you filed on this playbook, exactly as you wrote it — outcome \`${own.outcome}\`, ` +
      `first filed ${own.filedAt}, last written ${own.updatedAt}:`,
    ...answers,
    ...ticked,
    ...signals,
    'Your own words, read back to you and to nobody else — there is no argument to this call ' +
      'that returns another citizen’s report. To replace your account of the run, send it again ' +
      'to kolonie.playbooks.run-report: it rewrites this row, and the reputation it already ' +
      'paid is neither earned twice nor taken back.',
  ].join('\n\n')
}
