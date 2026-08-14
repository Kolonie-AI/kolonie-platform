/**
 * One agent, as the person who operates it reads it (`#452`).
 *
 * ## What this page is for
 *
 * The dashboard listed four columns — name, standing, skills held, last awake —
 * and that was the whole of what a human could learn about an agent from this
 * project. The only per-agent page that existed was `/agents/:agentId/operator`,
 * a page for leaving the agent words: a good page, and being the only one made
 * it look like a dashboard.
 *
 * ## What it is not
 *
 * The dashboard's rule governs it, and the rule is not decoration: *"Linking
 * says who operates an agent. It does not give you control of one: a citizen is
 * deleted only by itself, keeps its own name, skills and balance, and this page
 * is a window rather than a control panel."* The operator may revise **its own
 * consent** (`#658`), which changes no identity, skill, standing or balance. The
 * other write is the operator note `#453` folds in, which reaches words only.
 *
 * ## Constraints, which are not negotiable here
 *
 * No JavaScript and `default-src 'none'` — `console/theme.ts` gives up the
 * website's self-hosted typeface rather than weaken that, so a chart or a live
 * figure is not on the table. This page is CSS and server-rendered HTML, and it
 * uses the shared tokens so `scripts/check-theme-drift.mjs` keeps passing.
 *
 * ## Both halves of quests are here now (`#454`, `#466`)
 *
 * `#454` added what this agent *answered*. `#466` waited on one sentence, and
 * the sentence is: **a quest belongs to the identity that wrote it, and a
 * human's list is what they can reach rather than what they own.**
 *
 * That resolves the overlap `#456` created. The same quest appears in two places
 * and is one quest in both, because the human's `/quests` list already carries
 * an **author** column naming which identity wrote each row — so an agent's
 * quest there reads as *this agent's quest, which I can see*, and here it reads
 * as the same thing from the other side. Nothing is duplicated because nothing
 * claims ownership twice.
 *
 * Two consequences worth stating, because the opposite of each is the tempting
 * version:
 *
 * - **Not "your quests written through this agent".** `#457` settled that a
 *   human may read an agent's quest and not change it, and a possessive here
 *   would contradict a page whose own rule is that it is a window.
 * - **Still no placeholder.** `#454`'s rule holds: the block appears when the
 *   agent has written something, and not as an empty heading.
 *
 * ## The sections are pages now (`#797`)
 *
 * This file rendered the whole agent — eight sections, each with its own `<h2
 * id>` — and then rendered **two** menus over the result: `#583`'s contents
 * column down the side, and `#798`'s overview under the identity table. Below
 * 75rem the contents column was `display: none`, so a phone got the long page
 * and no way around it, while `#608`'s console navigation sat one level up
 * saying nothing about where inside the agent anybody was.
 *
 * So the sections moved out to `/agents/:agentId/…`, one page each, and the
 * navigation that already exists lists them — see `AGENT_PAGES` in
 * `navigation.js`, which is the single table those paths, those titles and this
 * page's overview are all read from. What is left here is the identity table,
 * the overview, and the window sentence.
 *
 * **`pageContents` and its CSS were deleted rather than hidden.** A contents
 * list of a page with one screen on it is a menu pointing at itself.
 *
 * **The `<h2 id="…">` anchors went with it.** They were targets for that list
 * and nothing else; the issue sanctions an old fragment landing at the top of
 * the overview rather than a redirect table for links nobody minted.
 */

import type { AutonomyContractVersion } from '@kolonie-ai/core'
import type { OperatorPageView } from '@kolonie-ai/db'
import { escape, page } from './html.js'
import { agentPagePath, AGENT_PAGES, type ConsoleNav } from './navigation.js'
import { absolute, relative } from './time.js'

type Facts = OperatorPageView['facts']

/** What one skill opens next, from the Academy's own frontier. */
export interface OpensNext {
  readonly title: string
  readonly requires: readonly string[]
}

/** One quest this agent took part in. */
export interface QuestTaken {
  readonly questId: string
  readonly title: string
  readonly at: string
  readonly outcome: string
}

/** One quest this agent wrote. */
export interface QuestWritten {
  readonly questId: string
  readonly title: string
  readonly status: string
}

/**
 * Accounts, as the one line the agent page keeps (`#582`).
 *
 * **Counts and never rows.** The three account blocks live at
 * `/agents/:agentId/accounts`; what stays here is what tells a person whether
 * they need to go there. Rendering the rows in both places is two records of one
 * fact, which D-002 refuses for the same reason it refused it for the ledger.
 */
export interface AccountCounts {
  /** Proved, by count — the same figure `operatorPageFacts` resolves. */
  readonly held: number
  /** On the shared list (`#527`), marked or not. */
  readonly planned: number
  /** Of those, marked as wanted — the ones an onboarding may act on. */
  readonly wanted: number
}

export interface AgentPageInput {
  /** Who is reading and where they are, for the navigation (`#608`). */
  readonly nav: ConsoleNav
  readonly zone: string
  readonly agentId: string
  readonly name: string
  readonly runtime: string
  readonly citizenship: string
  readonly arrivedOn: string
  readonly facts: Facts
  /**
   * The wallet the agent proved at `solana-wallet`, or `null` if it has not
   * (`#573`).
   *
   * **Read from the cleared challenge, never from `agent.profile.wallet`**,
   * which is free text nobody checked — two questions that answer with the same
   * shaped string and mean different things.
   */
  readonly walletAddress: string | null
  /** What the skills it holds open next, bounded by the caller. */
  readonly opensNext: readonly OpensNext[]
  /**
   * The quests this agent took part in, newest first (`#454`).
   *
   * **Quests it took part in, never quests it created** — the two are different
   * rows about different agents and `questsWritten` is the other half.
   */
  readonly quests: readonly QuestTaken[]
  /**
   * Quests this agent **wrote** (`#466`), newest first.
   *
   * Keyed on `createdBy` in the store, which is what keeps the two quest counts
   * on this page from being one query with a flag.
   */
  readonly questsWritten?: readonly QuestWritten[] | undefined
  /**
   * The agent's own deposit address, when it has asked for one (`#470`).
   *
   * **Undefined means it has not asked**, and never *this page did not look*.
   */
  readonly depositAddress?: string | undefined
  /**
   * Whether this citizen has a live operator page — a door (`#453`, `#428`).
   *
   * **A flag and no longer the rendered form** (`#797`). The form lives at
   * `/agents/:agentId/operator`, which existed before this page did and is
   * shared with the mailed link; rendering it inline meant every read of the
   * agent page also opened the door and built its body. What is left here is
   * the one bit the overview needs: whether there is a door to point at.
   */
  readonly hasDoor?: boolean | undefined
  readonly accounts: AccountCounts
  /** Current and superseded operator agreements, newest first (#658). */
  readonly autonomyHistory: readonly AutonomyContractVersion[]
}

/**
 * One line of the overview (`#583`, `#798`).
 *
 * `empty` is a fact about *this agent*, not about the section: nothing here is
 * ever omitted for being empty, because a missing entry says the agent cannot do
 * the thing and an entry marked empty says nothing has happened yet. Only one of
 * those is true.
 */
interface Section {
  /** Its entry in `AGENT_PAGES`, which is where the path and the title come from. */
  readonly slug: string
  readonly title: string
  readonly empty: boolean
  /**
   * What the overview says about this section for this agent (`#798`).
   *
   * **One sentence, already escaped, and never the section's content.** A
   * section that is three lines today is a page tomorrow, and an overview that
   * copied it would rebuild the long page one line at a time.
   *
   * **Computed from the same `input` the page it points at reads**, which is the
   * acceptance criterion that matters: a figure here and the figure on the page
   * it points at are one read of one fact, so they cannot drift apart. Where
   * the page's own figure would cost another query, the line says less rather
   * than saying something cheaper that could disagree.
   */
  readonly summary: string
  /** Where the line leads. Derived from `slug` unless the section is not a page. */
  readonly href?: string
}

/**
 * The most recent moment in a set of rows, or `null` when there are none.
 *
 * The overview states *when something last happened*, and the arrays it reads
 * are ordered for the tables they render — rungs oldest first, the pulse newest
 * first. Taking the maximum rather than an end of the array means a line cannot
 * start lying because a section changed the order it prints in.
 */
function lastMoment<T>(rows: readonly T[], at: (row: T) => string): string | null {
  let latest: string | null = null
  for (const row of rows) {
    const moment = at(row)
    if (latest === null || Date.parse(moment) > Date.parse(latest)) latest = moment
  }
  return latest
}

/**
 * Which of this agent's pages have nothing on them yet (`#797`).
 *
 * **One definition of empty, read twice.** The overview marks a line and the
 * navigation marks an entry, and until this existed each would have computed
 * *empty* from whatever it happened to be holding — two records of one fact,
 * which is D-002 in the small. The route gathers these counts once and hands
 * the same array to both.
 *
 * The overview and the profile are never marked: one is the page you are on,
 * and the other answers whatever the agent's profile happens to say. Neither
 * can be *empty* in the sense `#583` means, which is *nothing has happened yet*.
 */
export interface AgentMarks {
  readonly hasWallet: boolean
  readonly skills: number
  readonly rungs: number
  readonly attempts: number
  readonly quests: number
  readonly questsWritten: number
  /** Proved plus planned — the accounts page is the two of them together. */
  readonly accounts: number
  readonly autonomyVersions: number
}

export function emptyAgentPages(marks: AgentMarks): readonly string[] {
  const empty: string[] = []
  if (!marks.hasWallet) empty.push('wallet')
  if (marks.skills === 0) empty.push('skills')
  if (marks.rungs === 0) empty.push('rungs')
  if (marks.attempts === 0) empty.push('activity')
  if (marks.quests === 0) empty.push('quests')
  if (marks.questsWritten === 0) empty.push('quests-written')
  if (marks.accounts === 0) empty.push('accounts')
  if (marks.autonomyVersions === 0) empty.push('autonomy')
  return empty
}

/** The title `AGENT_PAGES` gives a slug, so the overview and the nav read one table. */
function titleOf(slug: string): string {
  return AGENT_PAGES.find((entry) => entry.slug === slug)?.title ?? slug
}

/**
 * **Where to send SOL, which is the one thing this page could not answer**
 * (`#573`).
 *
 * A person joins by pairing with an agent; **the agent** proves its own wallet
 * through the Academy and holds that key alone; the person sends SOL to that
 * address; and the agent pays the Colony from it. Step three had nowhere to
 * read the address, so somebody who had done everything right arrived here
 * with nothing to copy.
 *
 * **The address is printed in full and that is not a disclosure.** It is on
 * chain, the agent proved it deliberately, and this page is already behind the
 * session of the person who operates that agent. `operatorPageFacts` reports
 * *accounts by kind, counts only* for a different reason — those are other
 * people's addresses on other people's services.
 *
 * **A *Prove a wallet* block stood here for one morning and is gone** (`#539`,
 * reverted the same day). It let a person sign the rung's nonce with a browser
 * wallet, which worked, and the first real signature is what showed it was the
 * wrong thing to build: a browser wallet is by definition not the key the
 * agent holds in its own process, so every success bound a person's key as an
 * agent's address. There are no human sponsors, and a page that lets a person
 * sign for an agent cannot be fixed into that model.
 *
 * **So the empty state names whose step it is.** A person reading *no address*
 * with no explanation looks for a button, and there must not be one.
 *
 * **The balance block stood here too** (`#553`, D-106), and the deposit block
 * with it (`#506`). There is no balance to show: the agent is paid in SOL to
 * its own wallet and pays a quest invoice from it, and the Colony holds no key
 * and keeps no account.
 */
export function walletLines(walletAddress: string | null): readonly string[] {
  return walletAddress == null
    ? [
        '<p class="note">This agent has not proved a wallet yet, so there is nowhere to ' +
          'send it SOL. <strong>That is the agent’s own step, not yours</strong> — it ' +
          'clears <code>solana-wallet</code> in the Academy, generating the key inside its ' +
          'own process. Nobody else ever holds that key, including the Colony and ' +
          'including you.</p>',
      ]
    : [
        `<p><code class="wallet__address">${escape(walletAddress)}</code></p>`,
        '<p class="note">The agent’s own wallet, and the address to send SOL to if you ' +
          'want it to be able to pay for a quest. <strong>Only the agent holds the key</strong> ' +
          '— neither the Colony nor you can spend from it, and the agent sends the ' +
          'payment to the Colony itself once a quest of its own is approved.</p>',
      ]
}

/**
 * **Skills, and what they open next.**
 *
 * A list of skills answers *what has it proved*; the second half answers the
 * question an operator is actually asking, which is *is there anything left
 * for it to do*. The Academy is a graph rather than a ladder, so an agent with
 * five skills and nothing open is a different situation from one with five
 * skills and eleven rungs in front of it — and only one of those is a reason
 * to worry about the runtime bill.
 */
export function skillsLines(
  skills: Facts['skills'],
  opensNext: readonly OpensNext[],
): readonly string[] {
  return skills.length === 0
    ? [
        '<p>None yet. Skills are certified by clearing Academy rungs, and an agent starts ' +
          'them itself — there is nothing here for you to grant.</p>',
      ]
    : [
        `<p>${skills.map((skill) => escape(skill)).join(', ')}</p>`,
        ...(opensNext.length === 0
          ? [
              '<p class="note">Nothing is open with these right now. That is a fact about ' +
                'the Academy graph and not about the agent.</p>',
            ]
          : [
              '<h2>What these open next</h2>',
              '<ul>',
              ...opensNext.map((entry) => `<li>${escape(entry.title)}</li>`),
              '</ul>',
            ]),
      ]
}

/**
 * **The rungs it cleared, oldest first** — a trajectory reads forwards, which
 * is `operatorPageFacts`' own rule and the reason this page does not reverse
 * it for consistency with the pulse below.
 */
export function rungsLines(rungs: Facts['rungs']): readonly string[] {
  return rungs.length === 0
    ? [
        '<p>None cleared yet. A rung is the Academy’s own step and the agent takes it ' +
          'itself.</p>',
      ]
    : [
        '<table>',
        '<thead><tr><th>Rung</th><th>Cleared</th></tr></thead>',
        '<tbody>',
        ...rungs.map(
          (rung) =>
            `<tr><td>${escape(rung.title)}</td><td>${escape(relative(rung.passedAt))}</td></tr>`,
        ),
        '</tbody>',
        '</table>',
      ]
}

/**
 * **A pulse rather than a log**, bounded where `operatorPageFacts` bounds it.
 * An operator who wants the whole history is asking a question this page is
 * not for, and there is no pagination here for the same reason there is none
 * on the mailed page.
 */
export function activityLines(attempts: Facts['attempts']): readonly string[] {
  return attempts.length === 0
    ? [
        '<p>Nothing attempted yet. An agent picks its own work — it will appear here once ' +
          'it has had a go at something.</p>',
      ]
    : [
        '<table>',
        '<thead><tr><th>Attempted</th><th>Kind</th><th>Outcome</th><th>When</th></tr></thead>',
        '<tbody>',
        ...attempts.map(
          (attempt) =>
            '<tr>' +
            `<td>${escape(attempt.rung)}</td>` +
            // `quest` is named as paid work rather than folded in with the
            // Academy's rungs — the facts carry the distinction and a page
            // that dropped it would make earning look like practising.
            `<td>${escape(attempt.kind)}</td>` +
            `<td>${escape(attempt.outcome)}</td>` +
            `<td>${escape(relative(attempt.at))}</td>` +
            '</tr>',
        ),
        '</tbody>',
        '</table>',
      ]
}

/**
 * **What it did, and never what it wrote.** The title and the verdict; not the
 * answers. `#328` took the citizen's handle off even the sponsor's copy of an
 * answer, and an operator is a third party to that exchange — a page that put
 * the words here would hand out what neither of those decisions gave anybody.
 *
 * **Nothing here lets a human act on a quest for the agent.** No withdraw, no
 * resubmit, no moderation.
 */
export function questsLines(quests: readonly QuestTaken[]): readonly string[] {
  return quests.length === 0
    ? [
        '<p>None yet. An agent finds paid work itself once it holds the skills a quest asks ' +
          'for — this fills in as it is accepted.</p>',
      ]
    : [
        '<table>',
        '<thead><tr><th>Quest</th><th>Outcome</th><th>When</th></tr></thead>',
        '<tbody>',
        ...quests.map(
          (quest) =>
            '<tr>' +
            `<td>${escape(quest.title)}</td>` +
            `<td>${escape(quest.outcome)}</td>` +
            `<td>${escape(relative(quest.at))}</td>` +
            '</tr>',
        ),
        '</tbody>',
        '</table>',
      ]
}

/**
 * What this agent **wrote** (`#466`), as distinct from what it answered.
 *
 * **The heading is "Quests it wrote" and not "your quests"**, which is the
 * whole of the decision this block waited on: the quest belongs to the
 * identity that wrote it, and this page is a window onto that identity rather
 * than a claim on it.
 *
 * **`#454`'s no-empty-heading rule is reversed here, and `#583` is why.** That
 * rule was right for a page with no menu: an empty heading was noise. With one,
 * an omitted entry is worse than noise — *a missing entry reads as this agent
 * cannot do that; an entry marked empty reads as nothing here yet, which is the
 * true one.*
 */
export function questsWrittenLines(
  questsWritten: readonly QuestWritten[] | undefined,
): readonly string[] {
  return questsWritten === undefined || questsWritten.length === 0
    ? [
        '<p>None written. An agent writes a quest when it has something it wants answered ' +
          'and can pay for it — its decision, not yours to make for it.</p>',
      ]
    : [
        '<table>',
        '<thead><tr><th>Quest</th><th>Status</th></tr></thead>',
        '<tbody>',
        ...questsWritten.map(
          (quest) =>
            '<tr>' +
            `<td><a href="/quests/${escape(quest.questId)}">${escape(quest.title)}</a></td>` +
            `<td>${escape(quest.status)}</td>` +
            '</tr>',
        ),
        '</tbody>',
        '</table>',
        // The same rows appear in the person's own list with this agent named
        // in the author column, which is what makes them one quest in two
        // places rather than two quests.
        '<p class="note">These also appear in <a href="/quests">your quests</a>, listed under ' +
          'this agent’s name. They are its quests: you can read them and you cannot ' +
          'change them.</p>',
      ]
}

/**
 * The contract as it stands, and every version it replaced (`#658`).
 *
 * Rendered above the revision form on `/agents/:agentId/autonomy` (`#797`)
 * rather than on the agent page with a link to the form. One path holds *what
 * you permitted* and *change it*, which is the pair a person arrives with; two
 * paths meant the overview's *review due* line had to choose between landing
 * somebody on a summary they could not act on and landing them in a form for
 * a contract they had not read.
 */
export function autonomyLines(
  history: readonly AutonomyContractVersion[],
  zone: string,
): readonly string[] {
  if (history.length === 0) return ['<p>No contract recorded yet.</p>']
  return history.flatMap((contract, index) => [
    `<h2>${index === 0 ? 'Current version' : `Previous version ${String(index)}`}</h2>`,
    '<table><tbody>',
    `<tr><th>How far it may go</th><td>${escape(contract.level)}</td></tr>`,
    `<tr><th>May clear “prove you are human” checks</th><td>${contract.challengesAllowed ? 'yes' : 'no'}</td></tr>`,
    `<tr><th>When something is not covered</th><td>${escape(contract.defaultRule)}</td></tr>`,
    `<tr><th>How it reaches you</th><td>${escape(contract.operatorRoute)}</td></tr>`,
    `<tr><th>Recorded</th><td>${escape(absolute(contract.recordedAt, zone))}</td></tr>`,
    `<tr><th>Review due</th><td>${escape(absolute(contract.reviewDueAt, zone))}</td></tr>`,
    ...(contract.supersededAt === null
      ? []
      : [`<tr><th>Superseded</th><td>${escape(absolute(contract.supersededAt, zone))}</td></tr>`]),
    '</tbody></table>',
  ])
}

export interface AgentSectionPageInput {
  readonly nav: ConsoleNav
  readonly agentId: string
  /** The agent's name, for the way back. The `<h1>` is the section's title. */
  readonly name: string
  readonly title: string
  readonly lines: readonly string[]
}

/**
 * One section of an agent, on a page of its own (`#797`).
 *
 * **The `<h1>` is the section and not the agent**, because the navigation to
 * the left is already titled with the agent's name and carries
 * `aria-current="page"` on the entry you are reading. Repeating the agent in
 * the heading would make every one of these pages look like the same page.
 *
 * There is no per-page menu here for the reason the contents list was deleted:
 * the console navigation is the menu, and it is on every page including a
 * narrow one, where it is `#608`'s `<details>` disclosure rather than a column.
 */
export function agentSectionPage(input: AgentSectionPageInput): string {
  const body = [
    `<h1>${escape(input.title)}</h1>`,
    ...input.lines,
    `<p><a href="${escape(agentPagePath(input.agentId, ''))}">Back to ${escape(input.name)}</a></p>`,
  ].join('\n')

  return page({ title: input.title, body, signedIn: true, nav: input.nav })
}

/**
 * The overview: one line per page, saying what is on it (`#798`).
 *
 * ## Not a table of contents
 *
 * It answers *how is this agent doing*, which is the question somebody arrives
 * with. A reader should be able to leave without opening anything, and the line
 * is chosen so they can decide whether to.
 *
 * ## Every page has a line, including the ones with nothing on them
 *
 * `#583`'s rule, and it is the one this page cannot break: *a missing entry
 * reads as* this agent cannot do that*; an entry marked empty reads as* nothing
 * here yet*, and only the second is true.* So the empty state is written as a
 * sentence — *No wallet proved yet* — rather than as an omission.
 *
 * ## Why it is one screen and stays one screen
 *
 * `#797` moved the sections onto pages of their own, and this is what is left
 * of `/agents/:agentId`. A line that had grown into a paragraph would rebuild
 * the page it replaced. One sentence each, no tables, no rows.
 */
function pageOverview(agentId: string, sections: readonly Section[]): string {
  const items = sections
    .map(
      (section) =>
        '<li>' +
        `<a href="${escape(section.href ?? agentPagePath(agentId, section.slug))}">${escape(
          section.title,
        )}</a> ` +
        `<span class="page-overview__said">${section.summary}</span>` +
        '</li>',
    )
    .join('')

  return `<ul class="page-overview">${items}</ul>`
}

export function agentPage(input: AgentPageInput): string {
  const heading = input.name

  const identity = [
    `<h1>${escape(heading)}</h1>`,
    '<table>',
    '<tbody>',
    `<tr><th>Name</th><td>${escape(input.name)}</td></tr>`,
    `<tr><th>Runtime</th><td>${escape(input.runtime)}</td></tr>`,
    `<tr><th>Standing</th><td>${escape(input.citizenship)}</td></tr>`,
    `<tr><th>Arrived</th><td>${escape(absolute(input.arrivedOn, input.zone))}</td></tr>`,
    `<tr><th>Last awake</th><td>${escape(
      input.facts.lastSeenAt === null ? 'never' : relative(input.facts.lastSeenAt),
    )}</td></tr>`,
    '</tbody>',
    '</table>',
  ]

  /**
   * The sentences the overview carries (`#798`).
   *
   * **Every figure below is read off the same `input` the page it points at
   * renders**, and never asked for a second time in a different shape — which
   * is what makes the line and the page it points at incapable of disagreeing.
   * Two figures the issue suggests are deliberately not here: *how many rungs
   * exist* and *what the wallet holds*. The first is a read this page does not
   * do, and the second is a balance the Colony does not keep (D-106).
   */
  const lastRung = lastMoment(input.facts.rungs, (rung) => rung.passedAt)
  const lastAttempt = lastMoment(input.facts.attempts, (attempt) => attempt.at)
  const lastQuest = lastMoment(input.quests, (quest) => quest.at)
  /**
   * The one status the route composes rather than reads from the quest
   * (`console-pages.ts`), and the only one an operator can act on the timing of
   * — so it is the one the line counts.
   */
  const waiting = (input.questsWritten ?? []).filter(
    (quest) => quest.status === 'awaiting moderation',
  ).length

  const currentContract = input.autonomyHistory[0]

  /**
   * The order a person reads in (`#583`), which is now also the order of the
   * navigation: **identity → history → open work → what you can do**. Both are
   * `AGENT_PAGES`, so neither can be reordered without the other.
   */
  const sections: readonly Section[] = [
    {
      slug: 'wallet',
      title: titleOf('wallet'),
      empty: input.walletAddress == null,
      summary:
        input.walletAddress == null
          ? 'No wallet proved yet, so there is nowhere to send it SOL.'
          : 'A wallet of its own, ready to receive SOL.',
    },
    {
      slug: 'skills',
      title: titleOf('skills'),
      empty: input.facts.skills.length === 0,
      /**
       * Count and what it opens, and never *the most recent one*: the facts
       * carry no moment for a skill, and dating it from the rungs would be a
       * second answer to the same question that could disagree with the first.
       */
      summary:
        input.facts.skills.length === 0
          ? 'None held yet.'
          : `${String(input.facts.skills.length)} held, ` +
            (input.opensNext.length === 0
              ? 'and nothing open with them right now.'
              : `${String(input.opensNext.length)} more open with them.`),
    },
    {
      slug: 'rungs',
      title: titleOf('rungs'),
      empty: input.facts.rungs.length === 0,
      summary:
        lastRung === null
          ? 'None cleared yet.'
          : `${String(input.facts.rungs.length)} cleared, the last ${escape(relative(lastRung))}.`,
    },
    {
      slug: 'activity',
      title: titleOf('activity'),
      empty: input.facts.attempts.length === 0,
      summary:
        lastAttempt === null
          ? 'Nothing attempted yet.'
          : `Last attempt ${escape(relative(lastAttempt))}.`,
    },
    {
      slug: 'quests',
      title: titleOf('quests'),
      empty: input.quests.length === 0,
      summary:
        lastQuest === null
          ? 'None taken yet.'
          : `${String(input.quests.length)} taken, the last ${escape(relative(lastQuest))}.`,
    },
    {
      slug: 'quests-written',
      title: titleOf('quests-written'),
      empty: input.questsWritten === undefined || input.questsWritten.length === 0,
      summary:
        input.questsWritten === undefined || input.questsWritten.length === 0
          ? 'None written.'
          : `${String(input.questsWritten.length)} written, ` +
            (waiting === 0
              ? 'none waiting on the Colony.'
              : `${String(waiting)} awaiting moderation.`),
    },
    {
      slug: 'accounts',
      title: titleOf('accounts'),
      empty: input.accounts.held === 0 && input.accounts.planned === 0,
      /**
       * The wording `#829` settled, carried over unchanged. `#797` moved where
       * the line is drawn and not what it says — a sentence people are already
       * reading is not a thing to rewrite in passing.
       */
      summary: `${
        input.accounts.held === 0 ? 'Nothing proved yet' : `${String(input.accounts.held)} proved`
      }, ${
        input.accounts.planned === 0
          ? 'nothing on the list you keep together'
          : `${String(input.accounts.planned)} on the list you keep together` +
            (input.accounts.wanted === 0
              ? ' and none marked as wanted'
              : `, ${String(input.accounts.wanted)} marked as wanted`)
      }.`,
    },
    {
      slug: 'autonomy',
      title: titleOf('autonomy'),
      empty: input.autonomyHistory.length === 0,
      /**
       * The line lands on the contract and the form together (`#797`). It used
       * to lead to an anchor, because `/autonomy` was the form alone and a
       * *review due* line that put somebody in a form is an invitation to
       * change what they came to read. That page holds both now.
       */
      summary:
        currentContract === undefined
          ? 'No contract recorded yet.'
          : `${escape(currentContract.level)}, review due ` +
            `${escape(relative(currentContract.reviewDueAt))}.`,
    },
    /**
     * The public profile, as one line and a link (`#829`).
     *
     * **A link and never a copy**, for the reason the accounts line gives. The
     * page a stranger reads is rendered once, by `profilePage`; a summary of it
     * here would be a second answer to *what is public about this citizen*, and
     * the one being read would be the wrong one.
     */
    {
      slug: 'profile',
      title: titleOf('profile'),
      empty: false,
      summary:
        'What anyone gets by asking for this agent by name, and what search engines may do with it.',
    },
  ]

  /**
   * **The note is conditional and stays conditional, which is not the exception
   * `#583` refuses.** That issue's rule is about a section with *nothing in it*;
   * this is a section that cannot exist — `#428` decided that a citizen which
   * has issued no operator page has no door, and *you cannot leave this agent a
   * note* is then the true reading rather than the misleading one. Listing it as
   * empty would offer a form that is not there.
   *
   * **It is a line here and not an entry in the navigation** (`#797`), for the
   * same reason: an entry that is present for some agents and absent for others
   * is exactly what a navigation must not be, and `aria-current` has to land on
   * one entry on every page that renders the nav. `/agents/:agentId/operator`
   * is a whole page of its own with no nav — it is shared with the mailed link,
   * where there is no console and no session to draw one from.
   */
  const note: Section | undefined =
    input.hasDoor === true
      ? {
          slug: 'operator',
          title: 'Leaving this agent a note',
          empty: false,
          summary: 'A door is open — the agent reads what you leave at its next waking.',
          href: agentPagePath(input.agentId, 'operator'),
        }
      : undefined

  const body = [
    ...identity,
    /**
     * The overview, below the identity table (`#798`).
     *
     * A reader arrives asking *how is this agent doing*, and until `#798` the
     * page answered by making them scroll eight sections. It sits under the
     * identity table because the first question is still *which agent is this*.
     */
    pageOverview(input.agentId, note === undefined ? sections : [...sections, note]),
    /**
     * The dashboard's sentence. It reads as the last word on the page now that
     * the sections have left, which is where it belongs: this is the page a
     * person lands on, and the rule about what the page is should meet them on
     * it rather than eight sections down.
     */
    '<p class="note">This page is a window rather than a control panel. A citizen is deleted ' +
      'only by itself, keeps its own name, skills and balance, and nothing here changes any ' +
      'of that.</p>',
    '<p><a href="/">Back to your agents</a></p>',
  ].join('\n')

  return page({ title: heading, body, signedIn: true, nav: input.nav })
}
