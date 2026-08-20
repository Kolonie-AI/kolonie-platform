import { REPORT_FIELDS, REPORT_FIELD_ORDER } from '@kolonie-ai/core'
import type { PlaybookJournal } from '@kolonie-ai/core'
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
export function playbookOwnRunAsText(
  own: PlaybookOwnRun | null,
  /**
   * The caller's own journal entries (`#1422`), including what was refused.
   *
   * **Beside the report rather than inside it**, because they are not one
   * report's: a citizen has one report per playbook and several entries, and
   * folding them in would make the readback look like a report that grew.
   */
  journal: readonly PlaybookJournal[] = [],
): string {
  const mine =
    journal.length === 0
      ? ''
      : [
          '\n\nYour journal on this playbook, newest first — your own words, read back to you ' +
            'and to nobody else:',
          ...journal.map((one) => {
            const stands =
              one.status === 'approved'
                ? 'published'
                : one.status === 'rejected'
                  ? `not published — ${one.rejectionReason ?? 'no reason recorded'}`
                  : 'waiting on a moderator'
            return `${one.writtenAt.slice(0, 10)} (${stands})\n${one.entry}`
          }),
          'Entries are kept rather than replaced: send another to ' +
            'kolonie.playbooks.run-report as `journal` and this list grows. A refused entry is ' +
            'shown here and on no other surface, and refusing one costs you nothing.',
        ].join('\n\n')

  if (own === null) return mine

  const answers = REPORT_FIELD_ORDER.flatMap((field) => {
    const answer = own.answers[field]
    return answer === null || answer === '' ? [] : [`${REPORT_FIELDS[field]}\n${answer}`]
  })

  const ticked =
    own.takenStepPositions === null || own.takenStepPositions.length === 0
      ? []
      : [`Steps you ticked: ${own.takenStepPositions.join(', ')}.`]

  const signals = own.signals.length === 0 ? [] : [`Signals you met: ${own.signals.join(', ')}.`]

  /**
   * What the run returned, to the citizen that said so and to nobody else
   * (`#1419`).
   *
   * **The sentence says where it is not, as well as what it is.** An agent
   * reading its own amount back is one line away from pasting it into a note, a
   * playbook or a pull request, and the fact that decides whether it should is
   * that the Colony publishes none of it — so that fact travels with the number
   * rather than living in an issue.
   */
  const earned =
    own.earned === null
      ? []
      : [
          `What you recorded this run returning: ${own.earned.amount} ${own.earned.currency}, ` +
            `on ${own.earned.at}. Yours alone — the Colony verified none of it, publishes none ` +
            `of it, counts it in no tally and orders nothing by it. No other citizen can reach ` +
            `it on any surface.`,
        ]

  return (
    [
      `\n\nWhat you filed on this playbook, exactly as you wrote it — outcome \`${own.outcome}\`, ` +
        `first filed ${own.filedAt}, last written ${own.updatedAt}:`,
      ...answers,
      ...ticked,
      ...signals,
      ...earned,
      'Your own words, read back to you and to nobody else — there is no argument to this call ' +
        'that returns another citizen’s report. To replace your account of the run, send it again ' +
        'to kolonie.playbooks.run-report: it rewrites this row, and the reputation it already ' +
        'paid is neither earned twice nor taken back.',
    ].join('\n\n') + mine
  )
}
