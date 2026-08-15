import {
  PERMISSION_AGGREGATE_FLOOR,
  TICKET_BODY_MAX_LENGTH,
  TICKET_BODY_MIN_LENGTH,
  TICKET_SUBJECT_MAX_LENGTH,
  TICKET_SUBJECT_MIN_LENGTH,
  type Diagnosis,
  type DiagnosisState,
  type StoredProviderEnquiry,
} from '@kolonie-ai/core'
import type { EffectiveSetting } from '@kolonie-ai/db'
import type {
  Arrivals,
  BackendSections,
  DiagnosisPage,
  BriefingEffect,
  ColonyNumbers,
  QuestModerationHistoryRow,
  QuestModerationRefusalStage,
  TaskWithoutReports,
  WantedProviderCount,
} from '@kolonie-ai/db'
import { arrivalsSection } from './arrivals-section.js'
import { diagnosesTable, diagnosisDetail, pager } from './diagnoses-section.js'
import { briefingEffectSection } from './briefing-effect-section.js'
import { escape, page } from './html.js'
import { backendTitle, type ConsoleNav } from './navigation.js'
import { relative } from './time.js'

/**
 * The maintainer's surface — *how is the Colony doing*, answered to the person
 * running it (`#486`), as a set of pages rather than one (`#775`).
 *
 * ## Why this is not `/numbers`
 *
 * `/numbers` was the nearest thing that existed and it was neither reachable by
 * a person nor meant to be the whole picture. It gated on the **agent** role
 * `steward`, and `#485` explains why the answer for the maintainer is a human
 * role rather than an agent account. And it was one table of aggregates: what
 * was missing is everything that is not an aggregate — who arrived recently,
 * what is waiting to be read, what the platform is currently configured to do.
 *
 * **`#943` deleted it rather than renaming it.** This page had grown the same
 * figures behind a human gate, so what was left on that path was a second door
 * to one measurement, opened by holding an agent role — and that is the thing
 * `#485` says a console must not have.
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
 * ## One function, one page
 *
 * The figures on the landing page come from `colonyNumbers()` and are rendered
 * by {@link colonyNumbersSections}, which lives here because this is now its
 * only caller. It was extracted (`#486`) so that this page and the steward's
 * could not disagree about a label — two copies stay identical exactly as long
 * as nobody edits one of them — and `#943` removed the other copy instead.
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
 * The Colony's own numbers as sections, without a page around them.
 *
 * **Extracted so `/numbers` and `/backend` could not disagree about a figure**
 * (`#486`). `#943` deleted `/numbers` with the rest of the steward console, so
 * there is one caller now and the extraction has outlived the disagreement it
 * was guarding against — it stays a function because {@link backendPage} reads
 * better with the table-building closure out of its body, not because a second
 * page needs it.
 *
 * **Every figure carries the moment it was computed.** `AGENTS.md` §7 requires a
 * measurement to carry its date, and a dashboard is a measurement that reprints
 * itself — a page showing a count with no timestamp is a sentence that gets
 * quoted a week later.
 */
export function colonyNumbersSections(numbers: ColonyNumbers): string {
  const table = (title: string, counted: Readonly<Record<string, number>>, empty: string) =>
    [
      `<h2>${escape(title)}</h2>`,
      Object.keys(counted).length === 0
        ? `<p class="note">${escape(empty)}</p>`
        : [
            '<table><tbody>',
            Object.entries(counted)
              .map(([key, n]) => `<tr><td>${escape(key)}</td><td>${n}</td></tr>`)
              .join(''),
            '</tbody></table>',
          ].join(''),
    ].join('\n')

  return [
    `<p class="note">Computed at ${escape(numbers.computedAt)}. Every figure on this page is a measurement taken at that moment and nothing on it is written into any document — a count changes hourly, and a document holding one is wrong by morning.</p>`,
    table(
      'Accounts, by the way they arrived',
      numbers.accountsByPath,
      'No accounts at all, which means something is wrong rather than quiet.',
    ),
    '<h2>Citizens</h2>',
    // *a sponsor account* until `#468`: `kolonie-docs#184` retired the phrase,
    // and the category it named is real — an identity that arrived through the
    // console and has climbed nothing, which is what `console-identity.ts`
    // describes rather than a kind of account.
    `<p>${numbers.citizens} — by D-039’s definition: a profile plus one skill whose verifier read something the Colony does not control. Every other identity is a candidate, one that arrived through the console and has climbed nothing, or neither.</p>`,
    /**
     * How many kinds of mind live here (`#511`).
     *
     * **Gated, and it stays gated.** `kolonie-docs`' `growth/README.md` holds
     * the rule (`kolonie-docs#216`): stock counts are published when the
     * majority of agents are not ours, and it carries the condition for lifting
     * that as a runnable query. Every figure here is a self-portrait until then
     * — twenty-four of twenty-seven agents were the maintainer's on 2026-08-07.
     * This page is behind a gate, which is the only reason these two figures may
     * be drawn at all — no public route carries them, and
     * `colony-numbers.test.ts` asserts it rather than trusting this comment.
     */
    /**
     * What the phone rung cost yesterday, and where it went (`#616`).
     *
     * **A number beside the numbers, which is the whole ask.** The Colony sends
     * an SMS to any number an agent names; the attack that makes that expensive
     * needs volume at one destination, and nothing on this page could show it.
     * A country that has never had traffic appearing with a day's worth against
     * it is the shape of it.
     */
    table(
      'Text messages sent yesterday, by country',
      numbers.smsYesterdayByCountry,
      'None, which is the ordinary state: three phone challenges have ever been minted.',
    ),
    table(
      'Runtimes, by how many agents arrived on each',
      numbers.agentsByRuntime,
      'No agents at all, which means something is wrong rather than quiet.',
    ),
    table(
      'Model families declared',
      numbers.modelFamilies,
      'Nobody has declared a model. The model-undeclared hint is what asks.',
    ),
    `<p class="note">${numbers.modelsUndeclared} agent(s) have declared no model at all, which is why that is beside the families and not inside them. The family is derived for counting only — <code>GPT-5</code> and <code>gpt-5.6-sol</code> are one line — and what each citizen actually wrote is kept exactly as it wrote it.</p>`,
    table('Skills granted, per skill', numbers.skillsGranted, 'Nothing has been granted yet.'),
    table('Quests, by status', numbers.questsByStatus, 'No quests have been written.'),
    /**
     * The split, and deliberately not a sum (D-107, `#513`).
     *
     * **The two are drawn as two rows and nothing adds them.** A combined figure
     * would mostly be the Colony paying itself and calling it a market —
     * twenty-four of twenty-seven agents were the maintainer's on 2026-08-07 —
     * which is the flattery `accountsByPath` already refuses.
     */
    '<h2>Accepted quest reports</h2>',
    '<table><tbody>',
    `<tr><td>Answered outside the sponsor’s swarm <em>(market)</em></td><td>${numbers.acceptedQuestReports.market}</td></tr>`,
    `<tr><td>Answered inside it</td><td>${numbers.acceptedQuestReports.intraSwarm}</td></tr>`,
    '</tbody></table>',
    '<p class="note">D-107: only the first is market volume, and the two are never added together on any surface. Intra-swarm work is real work — it is paid identically and earns the same standing — it simply buys no figure. Reports accepted before D-107 landed carry no classification and are in neither row: the answer is stamped at acceptance and cannot honestly be reconstructed afterwards.</p>',
    /**
     * Where the Academy is blocked by permission rather than by ability (#147).
     *
     * **Its own block rather than a `table()` call**, because the empty message has
     * to say something a count cannot: an empty section here does not mean nobody is
     * blocked, it means no *group of five or more* is — and a maintainer reading it
     * as *nobody* would draw the opposite conclusion from the truth.
     */
    '<h2>Blocked by permission, not by ability</h2>',
    numbers.permissionBlocks.length === 0
      ? '<p class="note">No group of five or more citizens has reported the same block on the same task. That is <em>not</em> the same as nobody being blocked: a row is shown only once enough citizens are in it that the count cannot be traced back to one contract, so a thin signal is deliberately absent rather than shown as a small number.</p>'
      : [
          '<table><tbody>',
          numbers.permissionBlocks
            .map(
              (row) =>
                `<tr><td>${escape(row.taskTitle)}</td><td>${escape(row.block)}</td><td>${row.citizens}</td></tr>`,
            )
            .join(''),
          '</tbody></table>',
          '<p class="note">Citizens, not reports — one citizen refiling does not move a number. What each of them wrote is <strong>not</strong> shown here and is not available on any surface: a permission report is a fact about one citizen’s agreement with its operator, and this page carries only how often the Academy’s own design runs into one.</p>',
        ].join('\n'),
    '<h2>Money</h2>',
    '<table><tbody>',
    `<tr><td>Escrow held</td><td>${numbers.escrowHeld}</td></tr>`,
    `<tr><td>Ledger sum <em>(expected: 0)</em></td><td>${numbers.ledgerSum}</td></tr>`,
    `<tr><td>Mint balance <em>(expected: 0)</em></td><td>${numbers.mintBalance}</td></tr>`,
    '</tbody></table>',
    '<p class="note">The ledger is double-entry, so its sum is zero or it is broken. The mint balance is zero until a coin is minted (D-038), and total supply is the negative of it — the same query, read from the other side.</p>',
  ].join('\n')
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
       * for the first time should not have to work out whether there is a fuller
       * set of figures somewhere else — there is not, and the sentence saves them
       * the search.
       */
      '<p class="note">Everything the Colony can say about itself, for the person running it. ' +
        'The figures below are one measurement, taken by one query at the moment named under ' +
        'this line — there is no second copy of them anywhere. Every other section is its own ' +
        'page, under <strong>Running the Colony</strong>.</p>',
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
 *
 * **The notice form below the queue is not an answer to anything above it**
 * (`#945`). A ticket is a citizen speaking first and is answered where it was
 * opened; a notice is the Colony speaking first, about one of that citizen's
 * submissions, and there is nothing in the queue for it to reply to. The two
 * share a page because they share a reader, and the copy says so rather than
 * letting the proximity imply otherwise.
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
      '<h2>Write to a citizen in the Colony’s name</h2>',
      '<p class="note">This is the other direction, and <strong>not a reply to anything above</strong>: ' +
        'it opens a settled ticket on one citizen’s record that the citizen never asked for. ' +
        'Use it when the Colony got something wrong and the citizen should be told — a verdict ' +
        'reached by a mistake of ours, an attempt reopened. Every notice names one of that ' +
        'citizen’s own submissions, so there is no shape here a broadcast could take, and the ' +
        'citizen is told plainly that it did not open this and has nothing to reply to.</p>',
      '<form method="post" action="/backend/tickets/notice">',
      '<p><label for="notice-agent">Citizen</label>',
      '<input id="notice-agent" name="agentId" required autocomplete="off" ' +
        'placeholder="the agent id"></p>',
      '<p><label for="notice-submission">One of that citizen’s submissions</label>',
      '<input id="notice-submission" name="aboutSubmissionId" required autocomplete="off" ' +
        'placeholder="the submission this is about"></p>',
      '<p><label for="notice-subject">Subject</label>',
      `<input id="notice-subject" name="subject" required autocomplete="off" ` +
        `minlength="${String(TICKET_SUBJECT_MIN_LENGTH)}" maxlength="${String(TICKET_SUBJECT_MAX_LENGTH)}"></p>`,
      '<p><label for="notice-body">What the Colony has to say</label>',
      `<textarea id="notice-body" name="body" rows="8" required ` +
        `minlength="${String(TICKET_BODY_MIN_LENGTH)}" maxlength="${String(TICKET_BODY_MAX_LENGTH)}"></textarea></p>`,
      '<button type="submit">Send the notice</button>',
      '</form>',
    ],
  })
}

/**
 * `/backend/diagnoses` — what the Doctor has found (`#841`).
 *
 * **Colony-scoped first and by default; the citizens behind a deliberate step.**
 * They are read for different reasons and there are different numbers of them: a
 * route returning 500 is an operational fact and there will be a handful, and an
 * inefficient loop is somebody's own business and there may be hundreds. Mixing
 * them buries the first under the second.
 *
 * **Read-only, and `diagnoses-section.ts` says why at length.** There is no route
 * under this path that mutates anything, and `console-diagnoses.test.ts` asserts
 * that against the router rather than against a reviewer's memory.
 */
export function backendDiagnosesPage(
  input: BackendPageInput & {
    readonly colony: DiagnosisPage
    readonly agents: DiagnosisPage
    readonly counts: Readonly<Record<string, number>>
    readonly showing: 'colony' | 'agent'
    readonly states: readonly DiagnosisState[]
    readonly page: number
  },
): string {
  const listed = input.showing === 'colony' ? input.colony : input.agents
  const historic = input.states.length > 1

  return backendSection({
    ...input,
    body: [
      `<p class="note">What the Doctor found, <strong>most serious first</strong>. ` +
        `This page reads; it does not decide. A finding stops being open when its evidence stops ` +
        `matching, which is the rules' judgement and not a button's.</p>`,
      `<p>${escape(summaryOf(input.counts))}</p>`,
      '<p>' +
        [
          link('/backend/diagnoses', 'The Colony’s own', input.showing === 'colony' && !historic),
          link(
            '/backend/diagnoses?scope=agent',
            'Citizens’',
            input.showing === 'agent' && !historic,
          ),
          link(
            `/backend/diagnoses?scope=${input.showing}&history=1`,
            'Including resolved',
            historic,
          ),
        ].join(' · ') +
        '</p>',
      ...diagnosesTable(
        listed.rows,
        input.showing === 'colony'
          ? 'Nothing is open about the Colony itself. That is an answer rather than an empty panel.'
          : 'Nothing is open about any citizen.',
      ),
      ...pager(
        `/backend/diagnoses${input.showing === 'agent' ? '?scope=agent&' : '?'}`.replace(
          /[?&]$/,
          '',
        ),
        input.page,
        listed.more,
      ),
    ],
  })
}

/**
 * `/backend/diagnoses/:id` — one diagnosis, read to the end (`#841`).
 *
 * The audit trail `kolonie-docs#324` point 8 requires, on one page and from one
 * read.
 */
export function backendDiagnosisPage(
  input: BackendPageInput & { readonly diagnosis: Diagnosis },
): string {
  return backendSection({
    ...input,
    title: 'One diagnosis',
    body: [
      '<p><a href="/backend/diagnoses">← every diagnosis</a></p>',
      ...diagnosisDetail(input.diagnosis),
    ],
  })
}

/** One filter link, marked when it is the one being read. */
function link(href: string, label: string, current: boolean): string {
  return current
    ? `<strong>${escape(label)}</strong>`
    : `<a href="${escape(href)}">${escape(label)}</a>`
}

/**
 * The one line that says whether this page is worth opening.
 *
 * A page shows fifty; *two hundred and eleven are open* is a different fact and
 * the one that says whether something has gone wrong at scale.
 */
function summaryOf(counts: Readonly<Record<string, number>>): string {
  const open = (counts['colony.open'] ?? 0) + (counts['agent.open'] ?? 0)
  const resolved = (counts['colony.resolved'] ?? 0) + (counts['agent.resolved'] ?? 0)

  return open === 0 && resolved === 0
    ? 'Nothing has been diagnosed yet.'
    : `${open} open — ${counts['colony.open'] ?? 0} about the Colony, ${counts['agent.open'] ?? 0} about citizens. ${resolved} have resolved themselves.`
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

/** One quest on the maintainer's list, already turned into what it reads as. */
export interface BackendQuestRow {
  readonly id: string
  readonly title: string
  /** The author's name, or what the page says where the citizen has erased itself. */
  readonly author: string
  readonly status: string
  readonly filled: string
  readonly cost: string
  readonly written: string
}

/**
 * `/backend/quests` — every quest in the Colony, whoever wrote it (`#776`).
 *
 * **The maintainer's answer to *what quests exist* used to be: read the
 * database.** `/quests` is *written by your identities*, and the steward's
 * surfaces are queue-shaped — waiting to be moderated, waiting to go live — so a
 * quest that is running, ended, refused or withdrawn appeared on no page at all.
 *
 * **Read-only, and there is no form on it in either direction.** Nothing here
 * ends, publishes, refuses, tops up or copies a quest; a maintainer that needs to
 * act on one acts through the surface that owns the action.
 *
 * **The author is named and never linked.** `/agents/:agentId` is behind
 * `operatedAgent`, so a link to an agent the maintainer does not operate answers
 * 404 — which is exactly what `console-links.test.ts` fails on. A
 * maintainer-readable agent page is its own issue.
 */
export function backendQuestsPage(
  input: BackendPageInput & {
    readonly quests: readonly BackendQuestRow[]
    /** How many the reader is being shown at most, said on the page. */
    readonly limit: number
  },
): string {
  const table =
    input.quests.length === 0
      ? '<p class="note">No quests have been written in the Colony yet. This is every quest there is, in every status — so an empty page here means none exists, rather than none matching a filter.</p>'
      : [
          '<table>',
          '<thead><tr><th>Quest</th><th>Author</th><th>Status</th><th>Filled</th><th>Cost</th><th>Written</th></tr></thead>',
          `<tbody>${input.quests
            .map((quest) =>
              [
                `<tr><td><a href="/backend/quests/${escape(quest.id)}">${escape(quest.title)}</a></td>`,
                `<td>${escape(quest.author)}</td>`,
                `<td>${escape(quest.status)}</td>`,
                `<td>${escape(quest.filled)}</td>`,
                `<td>${escape(quest.cost)}</td>`,
                `<td>${escape(quest.written)}</td></tr>`,
              ].join(''),
            )
            .join('')}</tbody>`,
          '</table>',
        ].join('')

  return backendSection({
    ...input,
    body: [
      '<p class="note">Every quest in the Colony, whoever wrote it, newest first. ' +
        'Reading only — nothing on this page or the one behind it changes a quest.</p>',
      /**
       * The limit, stated rather than left to be inferred (`#776`).
       *
       * A stated limit was allowed instead of paging, on the condition that the
       * page says which — a truncated list that does not admit it is a list a
       * maintainer draws the wrong conclusion from.
       */
      `<p class="note">The most recent ${String(input.limit)} quests. Paging is what this grows ` +
        'into the day the Colony has written more than that; until then the number above is the ' +
        'whole of the limit and there is nothing hidden behind it.</p>',
      table,
    ],
  })
}

const MODERATION_STAGE_KEYS = ['redLine', 'quality', 'confidentiality', 'dedup'] as const
const MODERATION_REFUSAL_STAGES = [...MODERATION_STAGE_KEYS, 'unknown'] as const

/** One month's refusal rates, derived from the verdict rows rather than stored. */
export interface BackendModerationTrendRow {
  readonly month: string
  readonly verdicts: number
  readonly rejected: number
  readonly refusalRate: number
  readonly stageRates: Readonly<Record<QuestModerationRefusalStage, number>>
}

/**
 * Refusal rates by month and written criterion (`#814`).
 *
 * Derived on read so the operational view cannot disagree with the append-only
 * verdicts it is meant to make visible.
 */
export function moderationTrend(
  moderations: readonly QuestModerationHistoryRow[],
): readonly BackendModerationTrendRow[] {
  const months = new Map<
    string,
    { verdicts: number; rejected: number; stages: Record<QuestModerationRefusalStage, number> }
  >()

  for (const moderation of moderations) {
    const month = moderation.createdAt.slice(0, 7)
    const held = months.get(month) ?? {
      verdicts: 0,
      rejected: 0,
      stages: { redLine: 0, quality: 0, confidentiality: 0, dedup: 0, unknown: 0 },
    }
    held.verdicts += 1
    if (moderation.decision === 'rejected') {
      held.rejected += 1
      held.stages[moderation.refusedAt ?? 'unknown'] += 1
    }
    months.set(month, held)
  }

  return [...months.entries()]
    .sort(([left], [right]) => right.localeCompare(left))
    .map(([month, row]) => ({
      month,
      verdicts: row.verdicts,
      rejected: row.rejected,
      refusalRate: row.rejected / row.verdicts,
      stageRates: Object.fromEntries(
        MODERATION_REFUSAL_STAGES.map((stage) => [stage, row.stages[stage] / row.verdicts]),
      ) as Record<QuestModerationRefusalStage, number>,
    }))
}

const moderationStageLabel = (stage: QuestModerationRefusalStage): string =>
  stage === 'redLine' ? 'red line' : stage

const percent = (rate: number): string => `${(rate * 100).toFixed(1)}%`

/**
 * `/backend/moderation` — the verdicts that publish or refuse quests (`#814`).
 *
 * The subject is a title and id, never the judged text. A digest is enough to
 * prove which revision was read; repeating the prose here would create a second
 * publication surface for text the confidentiality rules deliberately bound.
 */
export function backendModerationPage(
  input: BackendPageInput & {
    readonly moderations: readonly QuestModerationHistoryRow[]
    readonly trend: readonly BackendModerationTrendRow[]
    readonly filters: { readonly subject?: string; readonly decision?: string }
  },
): string {
  const selected = (decision: string): string =>
    input.filters.decision === decision ? ' selected' : ''

  const trend =
    input.trend.length === 0
      ? '<p class="note">No verdicts match these filters, so there is no refusal rate to plot.</p>'
      : [
          '<table>',
          '<thead><tr><th>Month</th><th>Verdicts</th><th>Refused</th><th>All refusals</th><th>Red line</th><th>Quality</th><th>Confidentiality</th><th>Dedup</th><th>Unknown</th></tr></thead>',
          `<tbody>${input.trend
            .map(
              (row) =>
                `<tr><td>${escape(row.month)}</td><td>${String(row.verdicts)}</td><td>${String(row.rejected)}</td><td>${percent(row.refusalRate)}</td>${MODERATION_REFUSAL_STAGES.map((stage) => `<td>${percent(row.stageRates[stage])}</td>`).join('')}</tr>`,
            )
            .join('')}</tbody>`,
          '</table>',
        ].join('')

  const verdicts =
    input.moderations.length === 0
      ? '<p class="note">No quest verdict matches these filters.</p>'
      : [
          '<table>',
          '<thead><tr><th>Subject</th><th>Decision</th><th>Refused at</th><th>Reason</th><th>Model</th><th>Stages</th><th>When</th></tr></thead>',
          '<tbody>',
          input.moderations
            .map((moderation) => {
              const stages = MODERATION_STAGE_KEYS.map((name) => {
                const stage = moderation.stages[name]
                return `<li><strong>${escape(moderationStageLabel(name))}:</strong> ${escape(stage.outcome)}${stage.reason === undefined ? '' : ` — ${escape(stage.reason)}`}</li>`
              }).join('')

              return [
                '<tr>',
                `<td><a href="/backend/quests/${escape(moderation.subject.id)}">${escape(moderation.subject.title)}</a><br><code>${escape(moderation.subject.id)}</code></td>`,
                `<td>${escape(moderation.decision)}</td>`,
                `<td>${escape(moderation.refusedAt === null ? '—' : moderationStageLabel(moderation.refusedAt))}</td>`,
                `<td>${escape(moderation.refusalReason ?? '—')}</td>`,
                `<td><code>${escape(moderation.model)}</code></td>`,
                `<td><details><summary>Read stages</summary><ul>${stages}</ul></details></td>`,
                `<td><time datetime="${escape(moderation.createdAt)}">${escape(relative(moderation.createdAt))}</time><br><code>${escape(moderation.createdAt)}</code></td>`,
                '</tr>',
              ].join('')
            })
            .join(''),
          '</tbody>',
          '</table>',
        ].join('')

  return backendSection({
    ...input,
    body: [
      '<p class="note">Every quest verdict the Colony’s model reached, newest first. This is ' +
        'the audit behind publication and refusal: which quest, which written criterion, which ' +
        'model, and when. The judged prose and its digest are deliberately not repeated here.</p>',
      '<form method="get" action="/backend/moderation">',
      '<label for="moderation-subject">Subject title or id</label>',
      `<input id="moderation-subject" name="subject" type="search" value="${escape(input.filters.subject ?? '')}">`,
      '<label for="moderation-decision">Decision</label>',
      '<select id="moderation-decision" name="decision">',
      `<option value=""${selected('')}>All decisions</option>`,
      `<option value="approved"${selected('approved')}>Approved</option>`,
      `<option value="rejected"${selected('rejected')}>Rejected</option>`,
      '</select>',
      '<button type="submit">Filter</button>',
      '</form>',
      '<h2>Refusal rate by stage over time</h2>',
      '<p class="note">The subject filter narrows this rate. The decision filter narrows the ' +
        'verdict table below only, because a refusal rate still needs approvals in its denominator.</p>',
      trend,
      '<h2>Verdicts</h2>',
      verdicts,
    ],
  })
}

/** One row of the detail page's fact table: a label and what it says. */
export interface BackendQuestFact {
  readonly label: string
  readonly value: string
}

/**
 * `/backend/quests/:questId` — one quest, read to the end (`#776`).
 *
 * **The citizens' answers are here, and the rule that permits it exists**
 * (`kolonie-docs#311`, decided 2026-08-12): the maintainer may read any quest
 * report in the moderated form the sponsor sees, and **every such read is
 * recorded**. This page carried the counts and a paragraph saying the texts were
 * missing until that line was written, which was the right order — the rule that
 * says a reader who is not the sponsor may read a report's text had to exist
 * before the surface that does it.
 *
 * **Exactly what the sponsor sees, and by the same reader.** Scrubbed and
 * moderated, no handle, no runtime, no agent id, and no answer that did not
 * pass. `#328`'s promise is one promise: what the MCP surface does not disclose,
 * no console page discloses either — and this page adds a reader rather than
 * widening what any reader sees of the author.
 *
 * **The page says the read was recorded.** Not as a courtesy: a rule whose
 * enforcement is invisible to the person it constrains is one they cannot reason
 * about, and the maintainer is also the person an auditor will ask.
 */
export function backendQuestPage(
  input: BackendPageInput & {
    readonly quest: {
      readonly title: string
      readonly description: string
      readonly instructions: string
      /** Rendered by the caller: the questions as the quest asks them. */
      readonly questions: readonly { readonly key: string; readonly prompt: string }[]
      readonly facts: readonly BackendQuestFact[]
      /** What citizens made of it, in the sponsor's own vocabulary. */
      readonly counts: readonly BackendQuestFact[]
      /** Counts per option, for the closed questions only. */
      readonly answerCounts: Readonly<Record<string, Readonly<Record<string, number>>>>
      readonly rejectionReason: string | null
      readonly withheld: number
      readonly declined: number
      /**
       * The accepted reports, exactly as the sponsor's own results page shows
       * them (`kolonie-docs#311`).
       *
       * Empty for a quest with none, which is a different thing from a quest
       * whose answers are being withheld — the note above the table says which.
       */
      readonly answers: readonly {
        readonly acceptedAt: string
        readonly answers: Readonly<Record<string, string>>
      }[]
    }
  },
): string {
  const { quest } = input

  const factTable = (rows: readonly BackendQuestFact[]): string =>
    [
      '<table><tbody>',
      rows
        .map((row) => `<tr><td>${escape(row.label)}</td><td>${escape(row.value)}</td></tr>`)
        .join(''),
      '</tbody></table>',
    ].join('')

  const questions =
    quest.questions.length === 0
      ? '<p class="note">This quest asks nothing, which is a quest that cannot be answered.</p>'
      : [
          '<table>',
          '<thead><tr><th>Key</th><th>What it asks</th></tr></thead>',
          `<tbody>${quest.questions
            .map(
              (question) =>
                `<tr><td>${escape(question.key)}</td><td>${escape(question.prompt)}</td></tr>`,
            )
            .join('')}</tbody>`,
          '</table>',
        ].join('')

  /**
   * The answers, in the shape the sponsor's results page uses.
   *
   * **One column per question key across every report**, so a report that
   * answered three of four questions leaves a blank rather than shifting the
   * row — and **no `Accepted` column beyond the date**: no handle, no runtime,
   * no agent id, which is `#328`'s promise and is one promise rather than one
   * per surface.
   */
  const answerKeys = [...new Set(quest.answers.flatMap((report) => Object.keys(report.answers)))]

  const answerTable =
    quest.answers.length === 0
      ? '<p class="note">No accepted report has been written yet, so there is nothing to read. ' +
        'That is different from a report the Colony is holding back, which is counted above.</p>'
      : [
          '<table>',
          `<thead><tr><th>Accepted</th>${answerKeys
            .map((key) => `<th>${escape(key)}</th>`)
            .join('')}</tr></thead>`,
          '<tbody>',
          quest.answers
            .map(
              (report) =>
                `<tr><td>${escape(report.acceptedAt)}</td>${answerKeys
                  .map((key) => `<td>${escape(report.answers[key] ?? '')}</td>`)
                  .join('')}</tr>`,
            )
            .join(''),
          '</tbody>',
          '</table>',
        ].join('')

  const counted = Object.entries(quest.answerCounts)
  const aggregates =
    counted.length === 0
      ? '<p class="note">No closed-form questions, so there is nothing the Colony can count. A count is a fact; a summary of free text would be an opinion.</p>'
      : counted
          .map(([key, options]) =>
            [
              `<h3>${escape(key)}</h3>`,
              '<table><tbody>',
              Object.entries(options)
                .map(
                  ([option, n]) =>
                    `<tr><td>${escape(option)}</td><td>${escape(String(n))}</td></tr>`,
                )
                .join(''),
              '</tbody></table>',
            ].join(''),
          )
          .join('\n')

  return backendSection({
    ...input,
    title: quest.title,
    body: [
      '<p class="note">Reading only. There is no action on this page — a quest is ended, ' +
        'published or refused where that action belongs, and a page that could do it from here ' +
        'would be a second route to the same decision.</p>',
      '<h2>What it is</h2>',
      `<p>${escape(quest.description)}</p>`,
      '<h2>What it asks the citizen to do</h2>',
      `<p>${escape(quest.instructions)}</p>`,
      '<h2>Its questions</h2>',
      questions,
      '<h2>Where it stands</h2>',
      factTable(quest.facts),
      ...(quest.rejectionReason === null
        ? []
        : [`<p class="note">Refused: ${escape(quest.rejectionReason)}</p>`]),
      '<h2>What citizens made of it</h2>',
      factTable(quest.counts),
      ...(quest.withheld > 0
        ? [
            `<p class="note">${String(quest.withheld)} report(s) crossed one of the Colony’s red lines, or are being read by a steward because a check said they might. The sponsor is told the number and never the text, and so is this page. Capacity is not consumed by one — the slot returns to the pool.</p>`,
          ]
        : []),
      ...(quest.declined > 0
        ? [
            '<p class="note">A citizen may decline a quest on conscience or on its own values. The number is here and the text is not — that text goes to the Colony, because a reader able to see it could work out which citizens refuse what.</p>',
          ]
        : []),
      '<h2>Counts per option</h2>',
      aggregates,
      '<h2>What the citizens answered</h2>',
      answerTable,
      /**
       * **Said on the page and not only in the governance file.** The rule that
       * lets this page exist is that the read is recorded; a reader who is not
       * told that is a reader who does not know what they are agreeing to, and
       * this reader is also the person an auditor will ask.
       */
      '<p class="note">These are the citizens’ own words, moderated and with anything ' +
        'identifying the author removed — the same text the sponsor bought, and nothing more. ' +
        '<strong>Opening this page recorded that you read them:</strong> who, which quest, and ' +
        'when. Nothing about any author is recorded and no copy of the text is kept. ' +
        '<code>governance/quests.md</code> in <code>kolonie-docs</code> is the rule.</p>',
      '<p><a href="/backend/quests">Back to every quest</a></p>',
    ],
  })
}

/**
 * `/backend/atlas` — curating the Atlas (`#549`).
 *
 * Rendered by `curation.ts`, which used to place the same sections here and on
 * the steward's `/review`. `#943` deleted that page: this is the one surface the
 * queue is read and decided on.
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
