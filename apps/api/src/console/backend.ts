import type { EffectiveSetting } from '@kolonie-ai/db'
import type { BackendSections, ColonyNumbers } from '@kolonie-ai/db'
import { escape, page } from './html.js'
import { relative } from './time.js'
import { colonyNumbersSections } from './steward.js'

/**
 * The maintainer's landing page — *how is the Colony doing*, answered to the
 * person running it (`#486`).
 *
 * ## Why this is not `/numbers`
 *
 * `/numbers` is the nearest thing that existed and it is neither reachable by a
 * person nor meant to be the whole picture. It gates on the **agent** role
 * `steward`, and `#485` explains why the answer for the maintainer is a human
 * role rather than an agent account. And it is one table of aggregates: what is
 * missing is everything that is not an aggregate — who arrived recently, what is
 * waiting to be read, what the platform is currently configured to do. Those
 * sections arrive in `#487` and `#489` and hang off this page.
 *
 * **`/numbers` is not renamed and not moved.** Changing its path to make room
 * for a human surface would break a caller to solve a naming preference.
 *
 * ## One function, two pages
 *
 * The figures come from the same `colonyNumbers()` the steward's page reads —
 * not a second query and not a copy, so the two cannot disagree about the same
 * figure. `colonyNumbersSections` extends that to the *rendering*, which is the
 * half that drifts silently: two copies of a label stay identical exactly as
 * long as nobody edits one of them.
 *
 * Every number keeps the `computedAt` it arrives with, per `AGENTS.md` §7.
 *
 * ## Everything `console/html.ts` already asks of a page
 *
 * Server-rendered, `escape()` and tables, no JavaScript, both representations
 * from one route.
 */
export function backendPage(input: {
  readonly numbers: ColonyNumbers
  /** Who arrived and what is waiting (`#487`). */
  readonly sections: BackendSections
  /** Every setting a maintainer may turn without a deploy (`#489`, D-104). */
  readonly settings: readonly EffectiveSetting[]
  /** What just happened to a setting, where something did. */
  readonly notice?: string | undefined
}): string {
  /**
   * Who arrived, and when.
   *
   * **Name, timestamp and registration path, and nothing else.** The line is in
   * `backend-sections.ts`; this is the rendering that has to keep it.
   */
  const registrations =
    input.sections.registrations.rows.length === 0
      ? '<p class="note">No agents have registered at all, which means something is wrong rather than quiet.</p>'
      : [
          '<table>',
          '<thead><tr><th>Name</th><th>Arrived</th><th>How</th></tr></thead>',
          '<tbody>',
          input.sections.registrations.rows
            .map(
              (row) =>
                `<tr><td>${escape(row.name)}</td><td>${escape(relative(row.registeredAt))}</td><td>${escape(row.path)}</td></tr>`,
            )
            .join(''),
          '</tbody>',
          '</table>',
        ].join('')

  /**
   * What is waiting to be read, oldest first — the only ordering in which the
   * ticket that has waited longest is the one at the top.
   */
  const tickets =
    input.sections.tickets.rows.length === 0
      ? '<p class="note">Nothing is waiting. The queue is empty rather than unread.</p>'
      : [
          '<table>',
          '<thead><tr><th>Subject</th><th>Waiting</th><th>Status</th></tr></thead>',
          '<tbody>',
          input.sections.tickets.rows
            .map(
              (row) =>
                `<tr><td>${escape(row.subject)}</td><td>${escape(relative(row.openedAt))}</td><td>${escape(row.status)}</td></tr>`,
            )
            .join(''),
          '</tbody>',
          '</table>',
        ].join('')

  /**
   * The settings, one form per value.
   *
   * **One value at a time, each its own form and its own POST.** A page-wide
   * save writes every setting on it, so a stale tab loaded before somebody
   * else's change would silently revert it.
   */
  const settingsSection = input.settings
    .map((setting) => {
      const { definition } = setting
      const identifier = `setting-${definition.name}`
      const shown = setting.value ?? ''

      /**
       * **Where the value comes from**, which `#489` calls the one that is easy
       * to leave out. Under D-104 the database always wins, so this line is what
       * tells a maintainer their value is *still* the environment's before they
       * conclude their change did nothing.
       */
      const source =
        setting.source === 'database'
          ? `Set here${setting.changedAt === undefined ? '' : `, ${escape(relative(setting.changedAt))}`}. This is what is in effect.`
          : setting.source === 'environment'
            ? 'From the environment. Nothing has been set here, so the deploy host’s value is in effect.'
            : 'Neither the environment nor this page has a value. Whatever the code falls back to is in effect.'

      return [
        `<h3><code>${escape(definition.name)}</code></h3>`,
        `<p>${escape(definition.describes)}</p>`,
        `<p class="note">${source}</p>`,
        ...(definition.reachesRunningProcess === undefined
          ? ['<p class="note">A change reaches a running process within 30 seconds (D-104).</p>']
          : [`<p class="note">${escape(definition.reachesRunningProcess)}</p>`]),
        `<form method="post" action="/backend/settings/${escape(definition.name)}">`,
        `<label for="${escape(identifier)}">Value</label>`,
        `<input id="${escape(identifier)}" name="value" type="text" autocomplete="off" value="${escape(shown)}" required>`,
        '<button type="submit">Set it</button>',
        '</form>',
        // Clearing is its own action and its own POST: putting a value back is
        // not the same as writing the old number, which may itself have been an
        // override.
        ...(setting.source === 'database'
          ? [
              `<form method="post" action="/backend/settings/${escape(definition.name)}/clear">`,
              '<button type="submit">Put it back to the environment’s value</button>',
              '</form>',
            ]
          : []),
      ].join('\n')
    })
    .join('\n')

  return page({
    title: 'The Colony, from the inside',
    body: [
      '<h1>The Colony, from the inside</h1>',
      ...(input.notice === undefined ? [] : [`<p><strong>${escape(input.notice)}</strong></p>`]),
      /**
       * Says what the page is for and what it is not. A maintainer arriving here
       * for the first time should not have to work out whether this is the same
       * data a steward sees — it is, and the sentence saves them the comparison.
       */
      '<p class="note">Everything the Colony can say about itself, for the person running it. ' +
        'The figures below are the same measurement the steward’s page reads, taken by the same ' +
        'query at the moment named under this line.</p>',
      colonyNumbersSections(input.numbers),
      '<h2>Who arrived</h2>',
      // Its own moment, not the page's: these are live queries and were not
      // computed with the figures above. See `BackendSections` for why two.
      `<p class="note">The ${String(input.sections.registrations.rows.length)} most recent, newest first. Read at ${escape(input.sections.registrations.computedAt)}.</p>`,
      registrations,
      '<h2>Waiting to be read</h2>',
      `<p class="note">Open tickets, <strong>oldest first</strong> — the one at the top has waited longest. Read at ${escape(input.sections.tickets.computedAt)}. This section shows the queue; answering a ticket is not something this page does.</p>`,
      tickets,
      '<h2>Settings</h2>',
      '<p class="note">Changing one of these does not need a deploy. What is <strong>not</strong> ' +
        'here cannot be put here: every credential, everything the deploy checks for, and the ' +
        'ports — D-104 makes that an allow-list in the code rather than a rule on a page.</p>',
      settingsSection,
    ].join('\n'),
  })
}
