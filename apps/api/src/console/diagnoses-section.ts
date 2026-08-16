import { DIAGNOSIS_RETENTION_DAYS, type Diagnosis } from '@kolonie-ai/core'
import type { RuleHealthRow } from '@kolonie-ai/db'
import { escape } from './escape.js'
import { relative } from './time.js'

/**
 * *What has the Colony found, and what did it do about it* — answered to the
 * person running it (`#841`).
 *
 * ## Why this exists at all
 *
 * **A diagnostic system nobody can look at is one nobody can correct.** The
 * Doctor's whole operational half is in being read: a rule that fires on the
 * wrong shape, a threshold set from one episode, a signature that returns every
 * Tuesday — none of those is visible from inside the arithmetic, and all three
 * are obvious in a list.
 *
 * `Kolonie-AI/kolonie-docs#324` point 8 makes that a policy requirement rather
 * than a convenience: *a diagnosis nobody can reconstruct is one nobody can
 * overturn.* And the Colony has made this mistake once already and filed it
 * against itself — `kolonie-platform#814` is the complaint that
 * `quest_moderations` records decisions with no way to read them back. `#838`
 * wrote the table with that issue in view; this is the surface that makes the
 * intention true.
 *
 * ## Read-only, and it is not caution
 *
 * **There is no close button, no override and no throttle control**, and the
 * test asserts it against the router rather than against this file. The reason
 * is structural: a diagnosis resolves when its evidence stops matching, decided
 * by the rules that opened it (`#838`). A person closing one would put an
 * opinion into a state machine that is defined by evidence, and the two would
 * drift within a month — at which point the list stops describing the Colony and
 * starts describing what somebody last clicked.
 *
 * Anything a person *should* decide belongs in the support queue, which already
 * exists and already has an owner.
 *
 * ## Colony first, and the citizens behind a deliberate step
 *
 * They are read for different reasons. A Colony-scoped finding is an operational
 * fact — a route returning 500 — and there will be a handful. An agent-scoped one
 * is somebody's inefficient loop, and there may be hundreds. Mixing them buries
 * the first under the second, which is the failure that makes an operations page
 * stop being opened.
 *
 * ## What it may show
 *
 * Numbers, route keys, a citizen identifier and the sentence a model wrote.
 * **No address and no plaintext of anything** — the envelope
 * `packages/db/src/schema/origins.ts` draws, unchanged: nothing about this
 * surface widens what the Colony holds, because it reads a table that was
 * already written not to hold it.
 */

/** How the states read to a person. The vocabulary is the machine's; this is the gloss. */
const STATE_WORDS: Readonly<Record<Diagnosis['state'], string>> = {
  open: 'open',
  resolved: 'resolved itself',
  superseded: 'superseded by newer rules',
}

/**
 * One row.
 *
 * **Recurrence is on the row rather than behind the link**, which is the whole of
 * what `#838` gives that a live computation could not: *seen 40 times over three
 * days* reads differently from *seen twice*, and a reader scanning a list is
 * deciding which one to open from exactly that.
 */
function row(diagnosis: Diagnosis): string {
  const span = relative(diagnosis.firstSeenAt)

  return [
    '<tr>',
    `<td>${escape(diagnosis.severity)}</td>`,
    `<td><a href="/backend/diagnoses/${escape(diagnosis.id)}">${escape(diagnosis.kind)}</a></td>`,
    `<td>${escape(diagnosis.subject)}</td>`,
    `<td>${diagnosis.observations}× since ${escape(span)}</td>`,
    `<td>${escape(relative(diagnosis.lastSeenAt))}</td>`,
    // *Has a sentence* rather than the sentence: a list is scanned, and a
    // paragraph in a cell makes forty rows unreadable to save one click.
    `<td>${diagnosis.prose === null ? '—' : 'yes'}</td>`,
    '</tr>',
  ].join('')
}

/** A list, or the sentence that says there is nothing in it. */
export function diagnosesTable(rows: readonly Diagnosis[], nothing: string): readonly string[] {
  if (rows.length === 0) {
    /**
     * **Said rather than left blank**, which is the `available` lesson from
     * `apps/support-triage-runner/src/logs.ts` applied to a page: a store that
     * answers nothing looks exactly like a Colony with no errors, and a blank
     * panel looks exactly like a broken query.
     */
    return [`<p>${escape(nothing)}</p>`]
  }

  return [
    '<table>',
    '<thead><tr><th>Severity</th><th>Kind</th><th>Subject</th><th>Seen</th><th>Last</th><th>Sentence</th></tr></thead>',
    '<tbody>',
    ...rows.map(row),
    '</tbody>',
    '</table>',
  ]
}

/**
 * The two sentences that stand between the numbers and a reader misreading them
 * (`#1083`).
 *
 * **The retention line is computed from {@link DIAGNOSIS_RETENTION_DAYS} and not
 * written out**, because the whole thing it says is *these two columns count
 * different amounts of history* — a hard-coded ninety would go on saying so
 * after somebody changed the constant, and a page that lies confidently about
 * its own window is worse than a page that says nothing.
 *
 * **The second line is there because `Resolved after` reads as a success rate
 * and is not one.** A diagnosis resolves when its evidence stops matching, which
 * may be the citizen acting on what it was told and may be the citizen stopping
 * for reasons of its own. There is deliberately no percentage anywhere on this
 * page: a ratio would be read as *the rule worked this often*, and nothing here
 * measures that.
 */
export function ruleHealthNotes(): readonly string[] {
  return [
    `<p class="note">Diagnoses are kept ${DIAGNOSIS_RETENTION_DAYS} days; verdicts are kept ` +
      `indefinitely, so a rule may show more verdicts than findings.</p>`,
  ]
}

/** One rule at one policy version. */
function ruleRow(rule: RuleHealthRow): string {
  return [
    '<tr>',
    `<td>${escape(rule.kind)}<br><small>${escape(rule.policyVersion ?? 'no rules on file')}</small></td>`,
    `<td>${rule.opened}</td>`,
    `<td>${rule.announced}</td>`,
    `<td>${rule.consulted}</td>`,
    `<td>${rule.resolvedAfterAnnouncement}</td>`,
    // Nobody consulted is a dash and never a nought: a zero here would read as
    // *they all came back instantly*, which is the opposite of what happened.
    `<td>${rule.medianHoursToConsult === null ? '—' : escape(String(Math.max(1, Math.round(rule.medianHoursToConsult))))}</td>`,
    `<td>${rule.helpful}</td>`,
    `<td>${rule.notApplicable}</td>`,
    `<td>${rule.wrong}</td>`,
    '</tr>',
  ].join('')
}

/**
 * Which rules are any good (`#1083`).
 *
 * One row per rule per policy version, and **the two halves of it come from
 * sources that do not agree about time**: the left is what the rule did, swept
 * with the findings, and the right is what the citizens made of it, kept. A row
 * of zeros with verdicts beside it is therefore a real row and the most
 * interesting one on the page — the rule that was disputed and then stopped
 * firing — rather than something to filter out.
 */
export function ruleHealthTable(rules: readonly RuleHealthRow[]): readonly string[] {
  if (rules.length === 0) {
    return [
      '<p>No rule has produced a finding and no citizen has said anything about one. ' +
        'That is an answer rather than an empty panel.</p>',
    ]
  }

  return [
    '<table>',
    '<thead><tr><th>Rule</th><th>Opened</th><th>Announced</th><th>Consulted</th>' +
      '<th>Resolved after</th><th>Median hours to consult</th>' +
      '<th>Helpful</th><th>N/A</th><th>Wrong</th></tr></thead>',
    '<tbody>',
    ...rules.map(ruleRow),
    '</tbody>',
    '</table>',
    `<p class="note">A diagnosis resolves when its evidence stops matching. That a citizen was ` +
      `told first does not establish that being told is why.</p>`,
  ]
}

/** The two links that move through a list too long to show at once. */
export function pager(path: string, page: number, more: boolean): readonly string[] {
  const links = [
    ...(page > 0 ? [`<a href="${escape(path)}?page=${page - 1}">Previous</a>`] : []),
    ...(more ? [`<a href="${escape(path)}?page=${page + 1}">Next</a>`] : []),
  ]

  return links.length === 0 ? [] : [`<p>${links.join(' · ')}</p>`]
}

/**
 * One diagnosis, read to the end (`#841`).
 *
 * **This is the audit trail, and it is one page and one read.** What was found,
 * on what evidence, under which rules, when it was first and last seen, how many
 * times, what a model said about it and which model, and what it caused. A reader
 * who cannot reconstruct a verdict cannot overturn it, and everything needed to
 * reconstruct this one is on this page.
 */
export function diagnosisDetail(diagnosis: Diagnosis): readonly string[] {
  const evidence = [
    ...(diagnosis.evidence.routeKeys.length === 0
      ? []
      : [`<tr><th>Routes</th><td>${escape(diagnosis.evidence.routeKeys.join(', '))}</td></tr>`]),
    ...Object.entries(diagnosis.evidence.figures).map(
      ([name, value]) => `<tr><th>${escape(name)}</th><td>${escape(String(value))}</td></tr>`,
    ),
  ]

  return [
    `<h2>${escape(diagnosis.kind)} — ${escape(diagnosis.severity)}</h2>`,
    `<p>${escape(diagnosis.scope === 'colony' ? 'About a route' : 'About a citizen')}: ` +
      `<code>${escape(diagnosis.subject)}</code></p>`,
    '<table>',
    `<tr><th>State</th><td>${escape(STATE_WORDS[diagnosis.state])}</td></tr>`,
    `<tr><th>Confidence</th><td>${escape(diagnosis.confidence.toFixed(2))}</td></tr>`,
    /**
     * **The rule set that produced it, printed as itself.** A verdict made under
     * different arithmetic is a different judgement (`#838`), and a reader
     * comparing two diagnoses of the same kind needs to know whether they were
     * decided by the same rules before comparing anything else.
     */
    `<tr><th>Rules</th><td>${escape(diagnosis.policyVersion)}</td></tr>`,
    `<tr><th>First seen</th><td>${escape(relative(diagnosis.firstSeenAt))}</td></tr>`,
    `<tr><th>Last seen</th><td>${escape(relative(diagnosis.lastSeenAt))}</td></tr>`,
    `<tr><th>Observations</th><td>${diagnosis.observations}</td></tr>`,
    ...(diagnosis.resolvedAt === null
      ? []
      : [`<tr><th>Resolved</th><td>${escape(relative(diagnosis.resolvedAt))}</td></tr>`]),
    ...(diagnosis.announcedAt === null
      ? []
      : [
          `<tr><th>Told the citizen</th><td>${escape(relative(diagnosis.announcedAt))}` +
            `${diagnosis.announcedSeverity === null ? '' : ` (as ${escape(diagnosis.announcedSeverity)})`}</td></tr>`,
        ]),
    '</table>',
    '<h3>Evidence</h3>',
    ...(evidence.length === 0
      ? ['<p>No figures were recorded.</p>']
      : ['<table>', ...evidence, '</table>']),
    '<h3>What was said about it</h3>',
    /**
     * **Absent is the ordinary case and is said in words** (`#840`). A missing
     * sentence means the gateway was not configured or was not answering, and
     * neither makes the diagnosis less complete — a blank space here would read
     * as a page that failed to render half of itself.
     */
    ...(diagnosis.prose === null
      ? ['<p>Nothing. The finding is complete without a sentence.</p>']
      : [
          `<p>${escape(diagnosis.prose)}</p>`,
          `<p><small>Written by ${escape(diagnosis.proseModel ?? 'an unrecorded model')}.</small></p>`,
        ]),
    '<h3>What it caused</h3>',
    /**
     * **Audit means reconstructable, not merely recorded**, so *what did this
     * actually do* is on the same page as *what it found*. Today the only
     * consequence a diagnosis can have is a support ticket, and nothing opens one
     * yet — `#869` is where that decision sits. A throttle (`#843`) would be the
     * second, and gets its line when it exists.
     */
    ...(diagnosis.supportTicketId === null
      ? ['<p>Nothing. No consequence has been recorded against it.</p>']
      : [`<p>Support ticket <code>${escape(diagnosis.supportTicketId)}</code></p>`]),
  ]
}
