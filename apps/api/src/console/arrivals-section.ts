/**
 * *Who arrived*, with enough on the row to tell one arrival from forty (`#607`).
 *
 * ## What this section is for
 *
 * The row used to carry a name, a time and one of two words, and nothing on it
 * could distinguish a citizen that is going to do something from forty accounts
 * opened by one script in an afternoon. It also listed agents only, while the
 * number of ways to open an account went from one to four on 2026-08-08.
 *
 * ## The line it must not cross
 *
 * **A domain, never an address. A count, never a list of who.** Every reduction
 * that matters happens in SQL — see `arrivals.ts` — so this file cannot print an
 * address even by mistake. What it adds is the second half of the same rule:
 *
 * **The grouping keys never reach the page.** The origin fingerprint and the
 * operator's id are what makes *these six arrived together* answerable, and both
 * are exactly the values that should not be printed. So they are turned into
 * letters here, per render: a reader sees *origin A* and *operator B*, which is
 * everything the question needs and nothing a page should carry.
 *
 * **No score, no flag, no ranking.** `#607` names all three. The rows are facts
 * and a person draws the conclusion; a computed *likely fake* would be acted on
 * without anybody having looked, and the cost of being wrong is banning a real
 * citizen. The one thing this section does beyond listing is **repeat** a letter,
 * which is a fact about two rows rather than a judgement about either.
 *
 * **Nothing here is published.** `kolonie-docs#216` decides what may be shown
 * outside, and this is behind the `maintainer` role on `/backend` and reaches no
 * figure that leaves it.
 */

import type { Arrivals, ArrivedAgent } from '@kolonie-ai/db'
import { escape } from './escape.js'
import { relative } from './time.js'

/**
 * A letter per distinct key, in the order the keys are met.
 *
 * **A to Z and then AA**, which is enough for twenty rows several times over and
 * degrades legibly rather than wrapping to `A` again.
 */
function labeller(): (key: string | null) => string | null {
  const seen = new Map<string, string>()

  return (key) => {
    if (key === null) return null
    const held = seen.get(key)
    if (held !== undefined) return held

    const index = seen.size
    const letter =
      index < 26
        ? String.fromCharCode(65 + index)
        : `${String.fromCharCode(65 + Math.floor(index / 26) - 1)}${String.fromCharCode(65 + (index % 26))}`
    seen.set(key, letter)
    return letter
  }
}

/** How many of the listed rows share each key — the *repeat* worth seeing. */
function tally(
  rows: readonly ArrivedAgent[],
  of: (row: ArrivedAgent) => string | null,
): Map<string, number> {
  const counts = new Map<string, number>()
  for (const row of rows) {
    const key = of(row)
    if (key !== null) counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return counts
}

/**
 * A cell that says the letter and, when it is shared, how many share it.
 *
 * *A ×6* is the whole feature: it is one glance rather than reading twenty rows
 * against each other.
 */
const shared = (letter: string | null, count: number): string =>
  letter === null
    ? '—'
    : count > 1
      ? `${escape(letter)} <strong>×${String(count)}</strong>`
      : escape(letter)

/** Whether this agent has done anything at all since it registered. */
const doneSince = (row: ArrivedAgent): string => {
  if (row.calls === 0 && row.attempts === 0 && row.skills === 0) return '<strong>nothing</strong>'

  return escape(
    [
      `${String(row.calls)} call${row.calls === 1 ? '' : 's'}`,
      `${String(row.attempts)} attempt${row.attempts === 1 ? '' : 's'}`,
      `${String(row.skills)} skill${row.skills === 1 ? '' : 's'}`,
    ].join(' · '),
  )
}

/**
 * *Who arrived and never came back* (`#876`).
 *
 * **A count with an age beside each row, and no verdict.** The same rule the rest
 * of this section obeys: an account that registered four minutes ago and has not
 * authenticated is an agent mid-arrival, one that registered four weeks ago is a
 * citizen nobody holds, and which of the two a given row is stays the reader's
 * call. There is no threshold here that turns into a flag.
 *
 * **Empty is the good answer and has to read like one.** A silent table would be
 * indistinguishable from a table that failed to load, which is the failure mode
 * `#607` avoids everywhere else on this page by writing the empty case out.
 */
function unconfirmedRows(unconfirmed: Arrivals['unconfirmed']): string {
  /**
   * What the question could not be asked about, said in the same breath as the
   * answer (`#876`).
   *
   * **A silent exclusion would be the defect this section is about, one level
   * up.** Ten of production's accounts are older than the origins record, so
   * nothing can be concluded about them either way; a page that quietly left
   * them out would read as *we checked all 26*, which is the same shape of wrong
   * as the count that included them.
   */
  const excluded =
    unconfirmed.unmeasurable === 0
      ? ''
      : `<p class="note">${String(unconfirmed.unmeasurable)} account${unconfirmed.unmeasurable === 1 ? ' is' : 's are'} older than the origins record itself and ` +
        'cannot be asked this question. They are not counted below, in either direction.</p>'

  if (unconfirmed.total === 0) {
    return (
      excluded +
      '<p class="note">Every account that could be asked has authenticated at least once. That is the good answer, and it is read rather than assumed.</p>'
    )
  }

  return excluded + unconfirmedTable(unconfirmed)
}

/** The rows themselves, once there is something to show. */
function unconfirmedTable(unconfirmed: Arrivals['unconfirmed']): string {
  const age = (hours: number): string =>
    hours < 1
      ? 'under an hour'
      : hours < 48
        ? `${String(hours)} hour${hours === 1 ? '' : 's'}`
        : `${String(Math.floor(hours / 24))} days`

  return [
    `<p class="note"><strong>${String(unconfirmed.total)}</strong> account${unconfirmed.total === 1 ? ' has' : 's have'} registered ` +
      `and never made an authenticated call. The ${String(Math.min(unconfirmed.oldest.length, unconfirmed.total))} oldest:</p>`,
    '<table>',
    '<thead><tr><th>Agent</th><th>Registered</th><th>Silent for</th></tr></thead>',
    '<tbody>',
    ...unconfirmed.oldest.map((row) =>
      [
        '<tr>',
        `<td>${escape(row.name)}</td>`,
        `<td>${escape(relative(row.registeredAt))}</td>`,
        `<td>${escape(age(row.hoursSince))}</td>`,
        '</tr>',
      ].join(''),
    ),
    '</tbody>',
    '</table>',
  ].join('')
}

export function arrivalsSection(arrivals: Arrivals): string {
  const originLetter = labeller()
  const operatorLetter = labeller()
  const domainLetter = labeller()

  const byOrigin = tally(arrivals.agents, (row) => row.originKey)
  const byOperator = tally(arrivals.agents, (row) => row.operatorKey)
  const byDomain = tally(arrivals.agents, (row) => row.mailboxDomain)

  const agentRows =
    arrivals.agents.length === 0
      ? '<p class="note">No agents have registered at all, which means something is wrong rather than quiet.</p>'
      : [
          '<table>',
          '<thead><tr>',
          '<th>Agent</th><th>Arrived</th><th>How</th><th>Runtime</th><th>From</th>',
          '<th>Origins</th><th>Operator</th><th>Mailbox</th><th>Since</th>',
          '</tr></thead>',
          '<tbody>',
          ...arrivals.agents.map((row) =>
            [
              '<tr>',
              `<td>${escape(row.name)}</td>`,
              `<td>${escape(relative(row.registeredAt))}</td>`,
              `<td>${escape(row.path)}</td>`,
              `<td>${escape(row.runtime)}${row.model === null ? '' : ` <small>${escape(row.model)}</small>`}</td>`,
              `<td>${row.country === null ? '—' : escape(row.country)}</td>`,
              // The letter groups; the count beside it says how many distinct
              // places this one agent has been seen from, which is a different
              // question and a useful one on its own.
              `<td>${shared(originLetter(row.originKey), byOrigin.get(row.originKey ?? '') ?? 0)}` +
                `${row.origins > 1 ? ` <small>(${String(row.origins)} seen)</small>` : ''}</td>`,
              `<td>${
                row.operated
                  ? `${shared(operatorLetter(row.operatorKey), byOperator.get(row.operatorKey ?? '') ?? 0)}` +
                    `${row.operatorAgents > 1 ? ` <small>(holds ${String(row.operatorAgents)})</small>` : ''}`
                  : 'none'
              }</td>`,
              `<td>${shared(domainLetter(row.mailboxDomain), byDomain.get(row.mailboxDomain ?? '') ?? 0)}</td>`,
              `<td>${doneSince(row)}</td>`,
              '</tr>',
            ].join(''),
          ),
          '</tbody>',
          '</table>',
        ].join('')

  const peopleRows =
    arrivals.people.length === 0
      ? '<p class="note">Nobody has signed in yet. Three of the four doors opened on 2026-08-08, so this being empty is recent rather than settled.</p>'
      : [
          '<table>',
          '<thead><tr>',
          '<th>Arrived</th><th>Door</th><th>Address</th><th>Domain</th><th>Agents</th><th>Last seen</th>',
          '</tr></thead>',
          '<tbody>',
          ...arrivals.people.map((row) =>
            [
              '<tr>',
              `<td>${escape(relative(row.registeredAt))}</td>`,
              `<td>${escape(row.provider)}</td>`,
              // `readProfile` refuses an unverified address, so *none* here means
              // the identity carries no reachable one — which is itself the
              // finding, not a gap in the table.
              `<td>${row.addressKnown ? 'verified' : 'none'}</td>`,
              `<td>${row.emailDomain === null ? '—' : escape(row.emailDomain)}</td>`,
              `<td>${String(row.agentsOperated)}</td>`,
              `<td>${row.lastSeenAt === null ? 'never' : escape(relative(row.lastSeenAt))}</td>`,
              '</tr>',
            ].join(''),
          ),
          '</tbody>',
          '</table>',
        ].join('')

  return [
    `<p class="note">The ${String(arrivals.agents.length)} most recent agents and ` +
      `${String(arrivals.people.length)} most recent people, newest first. Read at ` +
      `${escape(arrivals.computedAt)}.</p>`,
    /**
     * The two sentences this section cannot be read correctly without.
     *
     * The first is what the letters are for. The second is the rule `#607`
     * insists on and the reason there is no *suspicion* column: what is on the
     * page is what the Colony recorded, and the conclusion is the reader's.
     */
    '<p class="note"><strong>A letter is a group, not an identity.</strong> Two rows sharing ' +
      'one letter were seen from the same origin, or belong to the same operator, or declared a ' +
      'mailbox on the same domain. The letters are assigned per reading of this page and mean ' +
      'nothing between one reading and the next — no address, no fingerprint and no operator’s ' +
      'name is on this page or reachable from it.</p>',
    '<p class="note">Nothing here is scored, flagged or ranked. Six arrivals sharing an origin ' +
      'is a fact; whether it is a swarm or a shared office is a judgement, and it is yours.</p>',
    '<h3>Agents</h3>',
    agentRows,
    '<h3>Registered, never authenticated</h3>',
    /**
     * The one sentence this table cannot be read correctly without: what it
     * measures, and the one way it can be wrong. An origin is written on every
     * successful authentication and the write never throws, so a failed write
     * leaves a citizen here that did in fact authenticate — rare, and worth
     * knowing before somebody acts on a row.
     */
    '<p class="note">Measured from observed origins, which are written on every successful ' +
      'authentication. A row here has never made one — which is what a lost key looks like from ' +
      'this side, and equally what an abandoned arrival looks like. The two are not ' +
      'distinguishable from here and nothing below guesses between them. An origin write that ' +
      'failed would also land a citizen here, because observation never stands between an agent ' +
      'and its request.</p>',
    unconfirmedRows(arrivals.unconfirmed),
    '<h3>People</h3>',
    peopleRows,
  ].join('\n')
}
