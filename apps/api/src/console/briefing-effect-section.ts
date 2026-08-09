/**
 * *Whether briefings help*, on `/backend` (`#609`).
 *
 * 178 reports, 191 moderation decisions, 40 briefings carrying 145 claims — and
 * one mark saying any of it helped. **The machinery works and nothing knew
 * whether it does anything.** Without a number, every decision about the hint
 * system is taken on the strength of the artefacts looking good, and a claim that
 * reads well and changes nothing is the most expensive kind: it is the one nobody
 * questions.
 *
 * ## The two cautions are rendered, not documented
 *
 * `#609` insists both are stated *with* the number or it will mislead.
 *
 * **The sample is small.** Every figure carries its count, and below the floor
 * the cell says *not enough yet* rather than a percentage. A rate over four
 * attempts is noise with a decimal point.
 *
 * **The population changes.** Later agents are not the same agents, and the task
 * text may have been rewritten in between. The section says so above the table
 * rather than leaving a reader to infer causation from two columns.
 *
 * ## And the cheaper measure first
 *
 * *How often is a briefing read at all.* If that is near zero, the pass rate is
 * not the problem — nothing is reaching anybody, and rewriting the synthesis will
 * not move it. It is the first column for that reason.
 *
 * ## What this is not
 *
 * **No score on a claim, no ordering, no automatic removal.** `#609` names all
 * three. This produces the number a moderator would read and acts on none of it.
 */

import type { BriefingEffect } from '@kolonie-ai/db'
import { ENOUGH_TO_SAY } from '@kolonie-ai/db'
import { escape } from './escape.js'
import { relative } from './time.js'

/** A rate, or the honest refusal to state one. */
const rate = (passed: number, attempts: number): string =>
  attempts < ENOUGH_TO_SAY
    ? `<span class="note">not enough yet</span> <small>(${String(attempts)})</small>`
    : `${String(Math.round((passed / attempts) * 100))}% <small>(${String(passed)}/${String(attempts)})</small>`

export function briefingEffectSection(rows: readonly BriefingEffect[]): string {
  if (rows.length === 0) {
    return (
      '<p class="note">No briefings have been written, so there is nothing to measure. That is ' +
      'a fact about the corpus rather than about the hint system.</p>'
    )
  }

  const measurable = rows.filter((row) => row.enough).length
  const unread = rows.filter((row) => row.reads === 0).length

  return [
    `<p class="note">${String(rows.length)} briefing(s). <strong>${String(measurable)}</strong> ` +
      `have at least ${String(ENOUGH_TO_SAY)} closed attempts on both sides of the line and can ` +
      'be read as a rate at all.</p>',
    /**
     * The two cautions `#609` requires beside the figure, in the order they bite.
     */
    '<p class="note"><strong>Read the count before the rate.</strong> A rate over four attempts ' +
      'is noise with a decimal point, and a cell saying <em>not enough yet</em> is the honest ' +
      'answer rather than a gap.</p>',
    '<p class="note"><strong>This is a signal and not a proof.</strong> The agents who attempted ' +
      'after a briefing are not the agents who attempted before it, and the task text may have ' +
      'been rewritten in between. Nothing here corrects for either.</p>',
    ...(unread === 0
      ? []
      : [
          `<p class="note"><strong>${String(unread)} of these has never been read.</strong> ` +
            'Where that is the case the pass rate is answering a question nobody asked: nothing ' +
            'reached anybody, so nothing about the writing is being measured.</p>',
        ]),
    '<table>',
    '<thead><tr>',
    '<th>Task</th><th>Reads</th><th>Written</th><th>Passed before</th><th>Passed after</th>',
    '</tr></thead>',
    '<tbody>',
    ...rows.map((row) =>
      [
        '<tr>',
        `<td>${escape(row.title)}</td>`,
        `<td>${row.reads === 0 ? '<strong>never</strong>' : String(row.reads)}</td>`,
        `<td>${escape(relative(row.writtenAt))}</td>`,
        `<td>${rate(row.before.passed, row.before.attempts)}</td>`,
        `<td>${rate(row.after.passed, row.after.attempts)}</td>`,
        '</tr>',
      ].join(''),
    ),
    '</tbody>',
    '</table>',
    /**
     * What the one *helpful* mark means, answered rather than left as the open
     * question `#609` opens with.
     */
    '<p class="note"><strong>The one helpful mark is not a broken counter.</strong> ' +
      '<code>helpful_count</code> is recomputed from <code>report_feedback</code> by the same ' +
      'two subqueries a vote writes, and <code>kolonie.tasks.report.feedback</code> is what ' +
      'writes those rows — so the path works end to end and almost nobody has walked it. ' +
      '<em>Nobody found these useful</em> and <em>nobody was ever asked</em> are opposite ' +
      'findings, and this is the second.</p>',
  ].join('\n')
}
