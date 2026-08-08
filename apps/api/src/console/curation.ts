import { isStale, type AtlasEntry, type EntryProposal } from '@kolonie-ai/core'
import type { FallingRate } from '@kolonie-ai/db'
import { escape } from './html.js'
import { relative } from './time.js'

/**
 * Curating the Atlas (`#549`).
 *
 * **A section, not a new tool.** `/backend` exists (`#486`) and is the
 * maintainer's page; the steward's `/review` exists and is the steward's. This
 * renders once and is placed on both, which is the arrangement
 * `colonyNumbersSections` already uses for the figures — two copies of a label
 * stay identical exactly as long as nobody edits one of them.
 *
 * ## Who may curate
 *
 * The maintainer **and stewards**. `#549` is explicit, and the reason is
 * operational rather than generous: a catalogue only one person can maintain is
 * a catalogue that stops when that person is busy. Curation is review work of
 * exactly the kind `#522` gives stewards a written basis for.
 *
 * ## Three queues and one signal
 *
 * The queues are work somebody filed. **The signal is the Colony noticing
 * something nobody reported** — a provider that quietly changed its signup form
 * announces itself as a success rate that was fine last month and is not now.
 * `#549` says that last one is the section that will actually be used, and it is
 * rendered first for that reason.
 *
 * ## What this screen cannot do
 *
 * **Nothing here can change an entry's position**, because there is no position:
 * ordering is derived from the measurements (`#545`) and `#548` requires that no
 * settable field exists. A curation screen with drag handles is where that rule
 * would quietly die, so there is deliberately no control on this page that
 * reorders anything, and a test asserts it.
 */

/** The falling-rate signal, first because it is the one that will be used. */
export function fallingRatesSection(rows: readonly FallingRate[]): string {
  if (rows.length === 0) {
    return (
      '<p class="note">No entry’s success rate has fallen sharply. This is the section that ' +
      'catches a provider changing its signup form without telling anybody, so an empty one is ' +
      'the good answer rather than a quiet one.</p>'
    )
  }

  const body = rows
    .map(
      (row) =>
        `<tr><td>${escape(row.provider)}</td><td>${escape(row.kind)}</td>` +
        `<td>${Math.round(row.earlierRate * 100)}%</td>` +
        `<td>${Math.round(row.recentRate * 100)}%</td>` +
        `<td>${String(row.recentAttempts)}</td></tr>`,
    )
    .join('')

  return [
    '<table>',
    '<thead><tr><th>Provider</th><th>Kind</th><th>Was</th><th>Now</th><th>Recent attempts</th></tr></thead>',
    `<tbody>${body}</tbody>`,
    '</table>',
  ].join('\n')
}

/**
 * The queue of contributed entries and proposed corrections, **with what
 * changed**.
 *
 * The fields are printed rather than summarised as *a change*: a reviewer
 * deciding on a correction needs to see which field it touches, and a queue that
 * makes them open the entry to find out is a queue nobody works through.
 */
export function proposalsSection(proposals: readonly EntryProposal[]): string {
  if (proposals.length === 0) {
    return '<p class="note">Nothing is waiting to be reviewed.</p>'
  }

  const rows = proposals
    .map(
      (proposal) =>
        '<tr>' +
        `<td>${escape(proposal.provider)}</td>` +
        `<td>${escape(proposal.kind)}</td>` +
        `<td>${escape(proposal.author)}</td>` +
        `<td>${escape(Object.keys(proposal.proposed).sort().join(', '))}</td>` +
        `<td>${escape(proposal.note ?? '')}</td>` +
        `<td>${escape(relative(proposal.proposedAt))}</td>` +
        '<td>' +
        // One action, and it is one press: `#549` asks that approving a
        // contribution be a single action recorded against its author.
        `<form method="post" action="/curation/${escape(proposal.id)}/accept">` +
        '<button type="submit">Accept</button></form>' +
        `<form method="post" action="/curation/${escape(proposal.id)}/refuse">` +
        '<button type="submit">Refuse</button></form>' +
        '</td>' +
        '</tr>',
    )
    .join('')

  return [
    '<table>',
    '<thead><tr><th>Provider</th><th>Kind</th><th>From</th><th>Changes</th><th>Why</th>' +
      '<th>Waiting</th><th></th></tr></thead>',
    `<tbody>${rows}</tbody>`,
    '</table>',
  ].join('\n')
}

/** Entries nobody has walked lately, which are guesses with a date on them. */
export function staleEntriesSection(entries: readonly AtlasEntry[]): string {
  const stale = entries.flatMap((entry) =>
    entry.recipes
      .filter((recipe) => recipe.status === 'joinable' && isStale(recipe.lastConfirmedAt))
      .map((recipe) => ({
        provider: entry.provider,
        kind: recipe.kind,
        at: recipe.lastConfirmedAt,
      })),
  )

  if (stale.length === 0)
    return '<p class="note">Every joinable entry has been confirmed recently.</p>'

  const rows = stale
    .map(
      (row) =>
        `<tr><td>${escape(row.provider)}</td><td>${escape(row.kind)}</td>` +
        `<td>${row.at === null ? 'never' : escape(relative(row.at))}</td></tr>`,
    )
    .join('')

  return [
    '<table>',
    '<thead><tr><th>Provider</th><th>Kind</th><th>Last confirmed</th></tr></thead>',
    `<tbody>${rows}</tbody>`,
    '</table>',
  ].join('\n')
}

/** The whole section, headings and all, for whichever page is placing it. */
export function curationSections(input: {
  readonly proposals: readonly EntryProposal[]
  readonly falling: readonly FallingRate[]
  readonly entries: readonly AtlasEntry[]
}): string {
  return [
    '<h2>Entries whose success rate has fallen</h2>',
    '<p class="note">Measured over the last 30 days against the 30 before it, both sides above ' +
      'the aggregate floor. This is the section that catches a provider changing its signup ' +
      'form without telling anybody — the queues below are work somebody filed, and this is not.</p>',
    fallingRatesSection(input.falling),
    '<h2>Waiting to be reviewed</h2>',
    '<p class="note">Contributed entries and proposed corrections, from citizens and from ' +
      'providers that have claimed their own entry. A provider proposes and cannot apply, and a ' +
      'finding about a provider is not that provider’s to remove — that is refused before it ' +
      'reaches this queue, so nothing here needs checking for it.</p>',
    proposalsSection(input.proposals),
    '<h2>Entries nobody has walked lately</h2>',
    '<p class="note">A recipe nobody has confirmed is a guess with a date on it, and the ' +
      'catalogue says so on the entry itself. Walking one and reporting the outcome is what ' +
      'brings it back, whether it worked or not.</p>',
    staleEntriesSection(input.entries),
  ].join('\n')
}
