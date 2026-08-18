import { DIAGNOSIS_RETENTION_DAYS, type AgentId, type Diagnosis } from '@kolonie-ai/core'
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
 * What a reader may ask the list for (`#1079`).
 *
 * Three states and *all of them*, which is one more value than the table has
 * because *all* is a question rather than a state. It lives here beside
 * {@link STATE_WORDS} so that there is one vocabulary for this and not two: the
 * detail page has glossed these words since `#841`, and a second set written at
 * the route would drift from it within a month.
 */
export type StateFilter = 'open' | 'resolved' | 'superseded' | 'all'

/** The four, in the order they are offered. */
export const STATE_FILTERS: readonly StateFilter[] = ['open', 'resolved', 'superseded', 'all']

/** How the four read as links. */
export const STATE_FILTER_WORDS: Readonly<Record<StateFilter, string>> = {
  open: 'Open',
  resolved: 'Resolved',
  superseded: 'Superseded',
  all: 'All',
}

/**
 * What was asked for, or the default (`#1079`).
 *
 * **An unknown value is `open` and never a 400.** This is a hand-typed URL in a
 * staff console, and the default view is a safe answer to a typo; the failure
 * worth preventing is the other one, where `?state=deleted` falls through to a
 * query for a state nothing is in and renders an empty table that reads as
 * *nothing is wrong*.
 */
export function stateFilter(value: string | undefined): StateFilter {
  return STATE_FILTERS.find((one) => one === value) ?? 'open'
}

/** Which rows that filter asks the store for. */
export function statesFor(filter: StateFilter): readonly Diagnosis['state'][] {
  return filter === 'all' ? ['open', 'resolved', 'superseded'] : [filter]
}

/**
 * What the handle lookup answers with, and what it deliberately does not
 * (`#1080`).
 *
 * Keyed by the citizen's id, which for an agent-scoped diagnosis is the
 * `subject` on the row itself. An id that is absent from the map names nobody
 * the Colony can reach — see {@link subjectOf} for why that is a state this page
 * has to render rather than an error.
 */
export type Handles = ReadonlyMap<string, string>

/**
 * The ids a page of rows needs resolved, deduplicated, in the order they appear
 * (`#1080`).
 *
 * **The route asks this rather than deciding for itself**, because the answer has
 * to be the same set {@link handleFor} will look up: an id the route skips is a
 * citizen the table cannot name, and an id it adds is a row nobody reads. One
 * predicate, two call sites.
 *
 * A page holding no agent-scoped row yields an empty array — and the lookup
 * behind it issues no query at all for one, so the ordinary colony-scoped page
 * costs nothing.
 */
export function agentSubjects(rows: readonly Diagnosis[]): readonly AgentId[] {
  const ids = new Set<AgentId>()
  // Asserted rather than parsed: on an agent-scoped row the subject *is* the
  // citizen's id — `recordDiagnosis` writes that column and `agent_id` from the
  // one value — and a page that threw on a malformed one would answer 500 where
  // the unresolved case already renders the id plainly.
  for (const row of rows) if (row.scope === 'agent') ids.add(row.subject as AgentId)

  return [...ids]
}

/**
 * The Subject cell, which is a citizen on half the rows and a route on the other
 * half (`#1080`).
 *
 * ## Why the cell is a link at all
 *
 * The column named thirty citizens and identified none of them: for an
 * agent-scoped row it printed a bare UUID, and the only link on the row went to
 * the diagnosis. So a maintainer reading their own operational page could see
 * that somebody was looping and not who — *you cannot click the agent*, as the
 * report on 2026-08-16 put it.
 *
 * ## Where it points, and why there is no console page behind it
 *
 * `/@{handle}`, the citizen's public profile, because that page answers *which
 * citizen is this* and already exists. A second citizen page in the backend
 * would be a surface to keep in step with the first for no fact it could add.
 * The handle is written in the casing the citizen registered under; the profile
 * route redirects if it ever disagrees, so one spelling is one page.
 *
 * ## Three cases, and the third is not an error
 *
 * A **colony-scoped** subject is a route key and is never linked — it is not a
 * name, and `/@/v1/tasks` would be a link to nothing.
 *
 * An **agent-scoped** subject whose handle resolves is the link.
 *
 * An **agent-scoped** subject whose handle does **not** resolve prints the raw
 * id, unlinked. A citizen that erased itself leaves no row for the cascade to
 * have kept, and a stale page or a race can hand this a missing id either way;
 * the id is what the column printed before this existed and is the honest
 * answer. What it must never be is a broken link, an empty cell or a 500.
 */
function subjectOf(diagnosis: Diagnosis, handles: Handles): string {
  const handle = handleFor(diagnosis, handles)

  return handle === undefined ? escape(diagnosis.subject) : profileLink(handle)
}

/**
 * The citizen a row is about, or `undefined` for the two cases that are not one:
 * a colony-scoped route key, and an id the Colony can no longer resolve.
 *
 * Both call sites go through this rather than reading the map themselves, so
 * that the list and the detail page cannot come to disagree about which rows are
 * links.
 */
function handleFor(diagnosis: Diagnosis, handles: Handles): string | undefined {
  return diagnosis.scope === 'agent' ? handles.get(diagnosis.subject) : undefined
}

/** One citizen's public page, with the handle escaped in the href and in the text. */
function profileLink(handle: string): string {
  return `<a href="/@${escape(handle)}">${escape(handle)}</a>`
}

/** The same subject on the detail page, where what is not a link stays a `<code>`. */
function subjectDetail(diagnosis: Diagnosis, handles: Handles): string {
  const handle = handleFor(diagnosis, handles)

  return handle === undefined ? `<code>${escape(diagnosis.subject)}</code>` : profileLink(handle)
}

/**
 * One row.
 *
 * **Recurrence is on the row rather than behind the link**, which is the whole of
 * what `#838` gives that a live computation could not: *seen 40 times over three
 * days* reads differently from *seen twice*, and a reader scanning a list is
 * deciding which one to open from exactly that.
 */
function row(diagnosis: Diagnosis, handles: Handles): string {
  const span = relative(diagnosis.firstSeenAt)

  return [
    '<tr>',
    `<td>${escape(diagnosis.severity)}</td>`,
    // Next to severity, because the two together are the whole of *does this
    // still matter* and a reader scanning the list decides on both (`#1079`).
    `<td>${escape(STATE_WORDS[diagnosis.state])}</td>`,
    `<td><a href="/backend/diagnoses/${escape(diagnosis.id)}">${escape(diagnosis.kind)}</a></td>`,
    `<td>${subjectOf(diagnosis, handles)}</td>`,
    `<td>${diagnosis.observations}× since ${escape(span)}</td>`,
    `<td>${escape(relative(diagnosis.lastSeenAt))}</td>`,
    // *Has a sentence* rather than the sentence: a list is scanned, and a
    // paragraph in a cell makes forty rows unreadable to save one click.
    `<td>${diagnosis.prose === null ? '—' : 'yes'}</td>`,
    '</tr>',
  ].join('')
}

/** A list, or the sentence that says there is nothing in it. */
export function diagnosesTable(
  rows: readonly Diagnosis[],
  nothing: string,
  /**
   * The citizens behind the agent-scoped rows (`#1080`). Resolved once for the
   * page and handed down, so that a table of fifty rows is one query and not
   * fifty — see {@link subjectOf} for what an id missing from it renders as.
   */
  handles: Handles,
): readonly string[] {
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
    /**
     * **The State column is on every view, including the default** (`#1079`).
     * A column that appeared only under a history filter would make the table's
     * shape depend on the filter, and the one cell a reader looks at to check
     * what they are looking at would then be absent exactly when they took the
     * default and assumed.
     */
    '<thead><tr><th>Severity</th><th>State</th><th>Kind</th><th>Subject</th><th>Seen</th><th>Last</th><th>Sentence</th></tr></thead>',
    '<tbody>',
    ...rows.map((one) => row(one, handles)),
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

/**
 * The two links that move through a list too long to show at once.
 *
 * **A page turn keeps the view it was turning** (`#1078`). Until 2026-08-16 this
 * took the path alone and its one caller smuggled the scope into it, so the
 * agent-scoped Next link came out as `/backend/diagnoses?scope=agent?page=1`:
 * the route read `scope` as the string `agent?page=1`, the comparison against
 * `'agent'` failed, and turning a page silently returned the reader to the
 * colony view at page zero. The history filter was not carried at all.
 *
 * So the pairs in force are passed in and reproduced, `page` last. `path`
 * carries no query string of its own.
 *
 * **`page` in `query` throws rather than being merged.** It is the one pair this
 * function owns, and a caller that passed it as well would produce a URL with
 * two of them — which most parsers resolve by taking the last, so the reader
 * gets a page number nobody chose and nothing anywhere reports a fault.
 */
export function pager(
  path: string,
  query: Readonly<Record<string, string>>,
  page: number,
  more: boolean,
): readonly string[] {
  if ('page' in query) {
    throw new Error('pager builds the page pair itself; a caller passing one produces two')
  }

  const at = (which: number) =>
    `${path}?${new URLSearchParams({ ...query, page: String(which) }).toString()}`

  const links = [
    ...(page > 0 ? [`<a href="${escape(at(page - 1))}">Previous</a>`] : []),
    ...(more ? [`<a href="${escape(at(page + 1))}">Next</a>`] : []),
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
export function diagnosisDetail(
  diagnosis: Diagnosis,
  /**
   * The one citizen this page may be about (`#1080`). A map rather than a
   * handle, so that this page and the list ask {@link subjectOf} the same
   * question and cannot come to disagree about what an unresolvable id renders
   * as — a page reached from a row must not say something the row did not.
   */
  handles: Handles,
): readonly string[] {
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
    /**
     * **The citizen by name, and the route as itself** (`#1080`).
     *
     * A resolvable citizen is the link its row in the list is; everything else
     * keeps the `<code>` this line has always been — a route key is not a name,
     * and an id that resolves to nobody is still the most this page knows.
     */
    `<p>${escape(diagnosis.scope === 'colony' ? 'About a route' : 'About a citizen')}: ` +
      `${subjectDetail(diagnosis, handles)}</p>`,
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
