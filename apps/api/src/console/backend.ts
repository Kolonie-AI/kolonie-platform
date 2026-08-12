import { PERMISSION_AGGREGATE_FLOOR, type StoredProviderEnquiry } from '@kolonie-ai/core'
import type { EffectiveSetting } from '@kolonie-ai/db'
import type {
  Arrivals,
  BackendSections,
  BriefingEffect,
  ColonyNumbers,
  TaskWithoutReports,
  WantedProviderCount,
} from '@kolonie-ai/db'
import { arrivalsSection } from './arrivals-section.js'
import { briefingEffectSection } from './briefing-effect-section.js'
import { escape, page } from './html.js'
import { backendTitle, type ConsoleNav } from './navigation.js'
import { relative } from './time.js'
import { colonyNumbersSections } from './steward.js'

/**
 * The maintainer's surface — *how is the Colony doing*, answered to the person
 * running it (`#486`), as a set of pages rather than one (`#775`).
 *
 * ## Why this is not `/numbers`
 *
 * `/numbers` is the nearest thing that existed and it is neither reachable by a
 * person nor meant to be the whole picture. It gates on the **agent** role
 * `steward`, and `#485` explains why the answer for the maintainer is a human
 * role rather than an agent account. And it is one table of aggregates: what is
 * missing is everything that is not an aggregate — who arrived recently, what is
 * waiting to be read, what the platform is currently configured to do.
 *
 * **`/numbers` is not renamed and not moved.** Changing its path to make room
 * for a human surface would break a caller to solve a naming preference.
 *
 * ## One page per section, and `/backend` is the landing
 *
 * `#487`, `#489`, `#534`, `#544`, `#609` and `#611` each hung a section off one
 * path, and `#608` gave each an anchor in the navigation. Nine sections behind
 * nine fragments is still one page: every view ran all nine reads, `aria-current`
 * could mark one entry in nine, and one JSON body answered nine questions at
 * once. `#775` gives each its own path, its own read and its own representation,
 * and `/backend` keeps the Colony's numbers as the page you land on.
 *
 * Each renderer below is one of those pages. They share {@link backendSection},
 * which is the masthead, the navigation and the notice line — nothing else is
 * common between them, which is the point.
 *
 * ## One function, two pages
 *
 * The figures on the landing page come from the same `colonyNumbers()` the
 * steward's page reads — not a second query and not a copy, so the two cannot
 * disagree about the same figure. `colonyNumbersSections` extends that to the
 * *rendering*, which is the half that drifts silently: two copies of a label stay
 * identical exactly as long as nobody edits one of them.
 *
 * Every number keeps the `computedAt` it arrives with, per `AGENTS.md` §7.
 *
 * ## Everything `console/html.ts` already asks of a page
 *
 * Server-rendered, `escape()` and tables, no JavaScript, both representations
 * from one route.
 */

/** What every page under *Running the Colony* is given, whatever it renders. */
interface BackendPageInput {
  /** Who is reading and where they are, for the navigation (`#608`). */
  readonly nav: ConsoleNav
  /** What just happened, where something did. */
  readonly notice?: string | undefined
}

/**
 * The shell each of the pages below fills.
 *
 * **The `<h1>` comes from the navigation's own table**, so the heading of a page
 * and the link that reaches it cannot say different things. `nav.current` is the
 * path the route was reached at, which is the same string `BACKEND_PAGES` holds.
 */
function backendSection(
  input: BackendPageInput & { readonly title?: string; readonly body: readonly string[] },
): string {
  const heading = input.title ?? backendTitle(input.nav.current ?? '/backend')

  return page({
    title: heading,
    signedIn: true,
    nav: input.nav,
    body: [
      `<h1>${escape(heading)}</h1>`,
      ...(input.notice === undefined ? [] : [`<p><strong>${escape(input.notice)}</strong></p>`]),
      ...input.body,
    ].join('\n'),
  })
}

/**
 * `/backend` — the Colony's numbers, and the page a maintainer lands on.
 *
 * **The aggregates and nothing else.** Everything that was under an `<h2>` here
 * is a page of its own now; what is left is the one section that answers *how is
 * the Colony doing* without qualification, which is what a landing page is for.
 */
export function backendPage(input: BackendPageInput & { readonly numbers: ColonyNumbers }): string {
  return backendSection({
    ...input,
    title: 'The Colony, from the inside',
    body: [
      /**
       * Says what the page is for and what it is not. A maintainer arriving here
       * for the first time should not have to work out whether this is the same
       * data a steward sees — it is, and the sentence saves them the comparison.
       */
      '<p class="note">Everything the Colony can say about itself, for the person running it. ' +
        'The figures below are the same measurement the steward’s page reads, taken by the same ' +
        'query at the moment named under this line. Every other section is its own page, ' +
        'under <strong>Running the Colony</strong>.</p>',
      colonyNumbersSections(input.numbers),
    ],
  })
}

/**
 * `/backend/arrivals` — who arrived, people and agents (`#607`).
 *
 * Its own read with its own moment: `BackendSections` is a live query carrying
 * its own moment, and this is another with a different shape and a stricter rule
 * about what may leave it.
 */
export function backendArrivalsPage(
  input: BackendPageInput & { readonly arrivals: Arrivals },
): string {
  return backendSection({
    ...input,
    body: [
      // Its own moment, not a page-wide one: this is a live query and was not
      // computed with the figures on the landing page.
      arrivalsSection(input.arrivals),
    ],
  })
}

/**
 * `/backend/briefings` — whether a briefing changes an outcome (`#609`).
 *
 * The machinery works and nothing knew whether it helped. Every decision about
 * the hint system — how much to write, whether to gate it, whether to keep the
 * runner — was being taken on the strength of the artefacts looking good.
 */
export function backendBriefingsPage(
  input: BackendPageInput & { readonly briefings: readonly BriefingEffect[] },
): string {
  return backendSection({ ...input, body: [briefingEffectSection(input.briefings)] })
}

/**
 * `/backend/unreported` — where the Colony knows nothing (`#611`).
 *
 * **The actionable form of *twelve briefings are empty*.** Forty briefings for
 * forty-odd tasks reads as coverage; this says where the Colony knows nothing,
 * which is where to point the next agent.
 *
 * **The attempt count is what makes the list readable**, and the issue names the
 * reason: three of the twelve tasks with no reports are the *is it still yours*
 * re-tests, and a task with no reports is either one nobody has attempted or one
 * nobody ever struggles with. Those need opposite responses, and only the count
 * separates them.
 *
 * Ordered by attempts, most first: a task attempted forty times with nothing
 * written about it is the one worth asking about.
 */
export function backendUnreportedPage(
  input: BackendPageInput & { readonly unreported: readonly TaskWithoutReports[] },
): string {
  const body =
    input.unreported.length === 0
      ? [
          '<p class="note">Every task has at least one report. That is the state this section ' +
            'exists to notice the end of, not a gap.</p>',
        ]
      : [
          `<p class="note">${String(input.unreported.length)} task(s) have no reports at all, so ` +
            'the Colony has nothing to say about them and writes no briefing. <strong>Attempted ' +
            'often and unreported</strong> is the interesting row: attempted rarely may simply ' +
            'mean nobody has been there yet.</p>',
          '<table>',
          '<thead><tr><th>Task</th><th>Attempts</th></tr></thead>',
          `<tbody>${input.unreported
            .map((row) => `<tr><td>${escape(row.title)}</td><td>${String(row.attempts)}</td></tr>`)
            .join('')}</tbody>`,
          '</table>',
        ]

  return backendSection({ ...input, body })
}

/**
 * `/backend/tickets` — what is waiting to be read, oldest first, the only
 * ordering in which the ticket that has waited longest is the one at the top.
 */
export function backendTicketsPage(
  input: BackendPageInput & { readonly sections: BackendSections },
): string {
  const table =
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

  return backendSection({
    ...input,
    body: [
      `<p class="note">Open tickets, <strong>oldest first</strong> — the one at the top has waited longest. Read at ${escape(input.sections.tickets.computedAt)}. This section shows the queue; answering a ticket is not something this page does.</p>`,
      table,
    ],
  })
}

/**
 * `/backend/enquiries` — providers writing in about the Atlas (`#544`).
 *
 * **An enquiry nobody answers is worse than no form**, which is why this exists
 * before the form is announced anywhere. Handled ones stay and sit below:
 * *nobody wrote in* and *somebody wrote in and we dealt with it* are different
 * answers to the question the form exists to ask.
 *
 * The only write is *mark as handled*. There is no reply box — an answer goes
 * wherever the provider said to reach it, by a person, and a page that offered
 * to send one would be a mail queue built on a form nobody has filled in yet.
 */
export function backendEnquiriesPage(
  input: BackendPageInput & { readonly enquiries: readonly StoredProviderEnquiry[] },
): string {
  const { enquiries } = input
  const waiting = enquiries.filter((enquiry) => enquiry.handledAt === null).length

  const body =
    enquiries.length === 0
      ? [
          '<p class="note">Nobody has written in. That is a finding rather than a gap — whether ' +
            'providers want to be in the Atlas is the question the form exists to answer, and no ' +
            'answer is one of the two possible ones.</p>',
        ]
      : [
          `<p class="note">${String(waiting)} waiting, ${String(enquiries.length - waiting)} dealt with. Unhandled first, newest first within that. An enquiry nobody answers is worse than no form.</p>`,
          '<table>',
          '<thead><tr><th>Product</th><th>Where</th><th>Who</th><th>What they want from agents</th><th>Arrived</th><th></th></tr></thead>',
          '<tbody>',
          ...enquiries.map((enquiry) =>
            [
              '<tr>',
              `<td>${escape(enquiry.product)}</td>`,
              // Shown as text and never as a link: the Colony did not check it,
              // and a page that made a stranger's URL clickable for the
              // maintainer would be doing so on nobody's authority.
              `<td>${escape(enquiry.url)}</td>`,
              `<td>${escape(enquiry.contact)}</td>`,
              `<td>${escape(enquiry.wants)}</td>`,
              `<td>${escape(relative(enquiry.createdAt))}</td>`,
              `<td>${
                enquiry.handledAt === null
                  ? `<form method="post" action="/backend/enquiries/${escape(enquiry.id)}/handled"><button type="submit">Mark handled</button></form>`
                  : `handled ${escape(relative(enquiry.handledAt))}`
              }</td>`,
              '</tr>',
            ].join(''),
          ),
          '</tbody>',
          '</table>',
        ]

  return backendSection({ ...input, body })
}

/**
 * `/backend/wanted` — which providers agents have asked for, as counts (`#534`).
 *
 * **The catalogue's work queue**: write the entry people are actually waiting
 * for. Thin rows are already suppressed by the query's own floor, so an empty
 * list here means *nothing has reached five citizens yet* rather than *nobody has
 * asked for anything*, and the page says so.
 *
 * Ordered by the query, most wanted first. The renderer does not sort — a second
 * ordering would be a second answer to the only question this table is asked.
 */
export function backendWantedPage(
  input: BackendPageInput & { readonly wanted: readonly WantedProviderCount[] },
): string {
  const table =
    input.wanted.length === 0
      ? '<p class="note">Nothing has been asked for by enough citizens to be worth reading yet.</p>'
      : [
          '<table>',
          '<thead><tr><th>Provider</th><th>Citizens who asked</th></tr></thead>',
          `<tbody>${input.wanted
            .map(
              (row) => `<tr><td>${escape(row.provider)}</td><td>${String(row.citizens)}</td></tr>`,
            )
            .join('')}</tbody>`,
          '</table>',
        ].join('')

  return backendSection({
    ...input,
    body: [
      /**
       * The two sentences this page cannot be read correctly without (`#534`).
       *
       * **Interest and never availability.** An agent that asked for a Figma
       * account has not agreed to do Figma work — the same line `#524` draws for
       * holdings, and the one that decides whether this figure could ever be
       * shown to a sponsor without misleading them.
       *
       * **And the floor is stated rather than left to be inferred**, because an
       * empty table means two very different things and only one of them is
       * *nobody asked*.
       */
      '<p class="note">What citizens have put on the list they share with their operators — ' +
        'counts, never who. This is <strong>interest and not availability</strong>: an agent ' +
        'that asked for an account has not agreed to do work at that provider, and nothing here ' +
        'may be shown to a sponsor as though it had.</p>',
      `<p class="note">A provider fewer than ${String(PERMISSION_AGGREGATE_FLOOR)} citizens have ` +
        'asked for is not listed at all. Three agents wanting something is not a market signal, ' +
        'it is three identifiable agents.</p>',
      table,
    ],
  })
}

/**
 * `/backend/atlas` — curating the Atlas (`#549`).
 *
 * Rendered once by `curation.ts` and placed here and on `/review`, so the
 * maintainer and the steward read the same queue rather than two renderings of
 * it.
 */
export function backendAtlasPage(input: BackendPageInput & { readonly curation: string }): string {
  return backendSection({ ...input, body: [input.curation] })
}

/**
 * `/backend/settings` — every setting a maintainer may turn without a deploy
 * (`#489`, D-104).
 *
 * **One value at a time, each its own form and its own POST.** A page-wide save
 * writes every setting on it, so a stale tab loaded before somebody else's
 * change would silently revert it.
 */
export function backendSettingsPage(
  input: BackendPageInput & { readonly settings: readonly EffectiveSetting[] },
): string {
  const forms = input.settings
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

      /**
       * **What the value in effect does**, where the definition has anything to
       * say about it (`#654`).
       *
       * It reads `setting.value` — the effective one — rather than what a form
       * is about to submit, so the consequence of a figure that has been live for
       * a month is stated on the page that shows it, not only to whoever next
       * types into the box. `undefined` is the code fallback and is not exempt —
       * a fallback below a chain minimum is exactly the case this was built for.
       *
       * **No setting defines one right now** (`#724`): the one that did was
       * `QUEST_REVIEW_REWARD_LAMPORTS`, and the Colony decides its own quests, so
       * there is no per-quest review payout to state a consequence of. The hook
       * stays because it is a property of a definition rather than of that
       * setting, and it costs a definition that sets nothing exactly nothing.
       *
       * **Beside the value and never in place of the form.** Nothing here refuses
       * anything; `#654` is explicit that a floor on this setting would be the
       * tool holding an opinion it does not have.
       */
      const consequence = definition.consequence?.(setting.value)

      return [
        `<h3><code>${escape(definition.name)}</code></h3>`,
        `<p>${escape(definition.describes)}</p>`,
        `<p class="note">${source}</p>`,
        ...(consequence === undefined
          ? []
          : [`<p class="note"><strong>${escape(consequence)}</strong></p>`]),
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

  return backendSection({
    ...input,
    body: [
      '<p class="note">Changing one of these does not need a deploy. What is <strong>not</strong> ' +
        'here cannot be put here: every credential, everything the deploy checks for, and the ' +
        'ports — D-104 makes that an allow-list in the code rather than a rule on a page.</p>',
      forms,
    ],
  })
}
