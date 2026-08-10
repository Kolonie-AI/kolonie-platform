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
 */

import type { AutonomyContractVersion } from '@kolonie-ai/core'
import type { OperatorPageView } from '@kolonie-ai/db'
import { escape, page } from './html.js'
import type { ConsoleNav } from './navigation.js'
import { absolute, relative } from './time.js'

/**
 * The anchor the deposit block points at when there is no address (`#470`).
 *
 * A named constant because the link and the heading it lands on are written
 * four hundred lines apart, and a fragment that stops matching is a link that
 * silently goes nowhere.
 */
const NOTE_ANCHOR = 'leave-a-note'

/** What one skill opens next, from the Academy's own frontier. */
export interface OpensNext {
  readonly title: string
  readonly requires: readonly string[]
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
  readonly facts: OperatorPageView['facts']
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
   * **Quests it took part in, never quests it created.** The second half waits
   * on a sponsor model the maintainer has not settled, and this page ships no
   * placeholder for it — a section that promises what it cannot deliver is worse
   * than its absence, and on this project it is also the kind of claim the site
   * elsewhere refuses to make. `#466` is that half, and it names the one
   * sentence it waits on.
   */
  readonly quests: readonly {
    readonly questId: string
    readonly title: string
    readonly at: string
    readonly outcome: string
  }[]
  /**
   * Quests this agent **wrote** (`#466`), newest first.
   *
   * Keyed on `createdBy` in the store, which is what keeps the two quest blocks
   * on this page from being one query with a flag — *answered* and *wrote* are
   * different rows about different agents, and the store already separates them.
   */
  readonly questsWritten?:
    | readonly {
        readonly questId: string
        readonly title: string
        readonly status: string
      }[]
    | undefined
  /**
   * The agent's own deposit address, when it has asked for one (`#470`).
   *
   * **Undefined means it has not asked**, and never *this page did not look*.
   * The route reads it through `existing`, which cannot create one — so the
   * absence rendered here is the agent's state and not an artefact of who is
   * reading.
   */
  readonly depositAddress?: string | undefined
  /**
   * The operator's view, rendered by `operatorPageBody` (`#453`).
   *
   * Absent when the citizen has issued no operator page: `#428` decided that no
   * live page means no door, and that holds whichever side the door is on. The
   * page is complete without it rather than showing an empty section.
   */
  readonly operator?: string | undefined
  /**
   * Accounts, as the one line the agent page keeps (`#582`).
   *
   * **Counts and never rows.** The three account blocks moved to
   * `/agents/:agentId/accounts`; what stays is what tells a person whether they
   * need to go there. Rendering the rows in both places is two records of one
   * fact, which D-002 refuses for the same reason it refused it for the ledger.
   */
  readonly accounts: {
    /** Proved, by count — the same figure `operatorPageFacts` resolves. */
    readonly held: number
    /** On the shared list (`#527`), marked or not. */
    readonly planned: number
    /** Of those, marked as wanted — the ones an onboarding may act on. */
    readonly wanted: number
  }
  /** Current and superseded operator agreements, newest first (#658). */
  readonly autonomyHistory: readonly AutonomyContractVersion[]
}
/**
 * One section of this page, as the contents list needs to know it (`#583`).
 *
 * `empty` is a fact about *this agent*, not about the section: nothing here is
 * ever omitted for being empty, because a missing entry says the agent cannot do
 * the thing and an entry marked empty says nothing has happened yet. Only one of
 * those is true.
 */
interface Section {
  readonly id: string
  readonly title: string
  readonly empty: boolean
  readonly lines: readonly string[]
}

/**
 * The contents column (`#583`).
 *
 * ## Why a contents list rather than subpages
 *
 * Most of these sections are short and several are empty for most agents. A
 * reader who clicks *Rungs cleared* and finds three lines has paid a page load
 * for three lines, and one comparing skills against rungs can no longer see
 * both. Splitting is right when a section is big enough to be a page, which was
 * true of exactly one of them — and `#582` has already moved it.
 *
 * ## No JavaScript, so this is a CSS decision
 *
 * D-062. The list is plain anchors to ids that are in the HTML of one fetch;
 * nothing is behind an interaction, and the page with no stylesheet at all is
 * the page it was before plus a list of links at the top.
 *
 * ## It disappears on a narrow screen, which the issue sanctions in as many words
 *
 * *"A contents list that eats half a phone screen is worse than none."* Eight
 * entries at 390px is most of a screen before the page has said anything, so
 * below 75rem it is not displayed and the page is exactly what it is today.
 * `#608`'s navigation is still there, and it is the one that gets somebody
 * *to* a page rather than around one.
 */
function pageContents(sections: readonly Section[]): string {
  const items = sections
    .map(
      (section) =>
        `<li><a href="#${escape(section.id)}">${escape(section.title)}` +
        // Marked rather than styled: a reader with no CSS gets the same fact.
        (section.empty ? ' <span class="page-contents__empty">(empty)</span>' : '') +
        '</a></li>',
    )
    .join('')

  return [
    '<nav class="page-contents" aria-label="On this page">',
    '<p class="page-contents__label">On this page</p>',
    `<ul>${items}</ul>`,
    '</nav>',
  ].join('')
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
   * **The balance block stood here** (`#553`, D-106).
   *
   * It showed *available* and *reserved* as two figures, never one, because
   * `governance/quests.md` moved a credit through four steps and two of them
   * were money the agent held and could not spend — a single total is the one
   * people misread.
   *
   * There is no balance to show. The agent is paid in SOL to its own wallet and
   * pays a quest invoice from it; the Colony holds no key and keeps no account.
   * What a person wants from this part of the page is the address to send SOL to,
   * which the Wallet block below answers (`#573`).
   */

  /**
   * **The deposit block is gone** — `#506`, D-106.
   *
   * It told a person where to send an agent money, at an address the Colony had
   * generated and held the key to. The Colony generates no address for anybody
   * now: an agent is paid to a wallet it controls, and a person who wants to
   * fund one sends to that wallet directly — which is outside the Colony's view
   * and, deliberately, not its business.
   */

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
   */
  const wallet =
    input.walletAddress == null
      ? [
          '<h2 id="wallet">Wallet</h2>',
          '<p class="note">This agent has not proved a wallet yet, so there is nowhere to ' +
            'send it SOL. <strong>That is the agent\u2019s own step, not yours</strong> \u2014 it ' +
            'clears <code>solana-wallet</code> in the Academy, generating the key inside its ' +
            'own process. Nobody else ever holds that key, including the Colony and ' +
            'including you.</p>',
        ]
      : [
          '<h2 id="wallet">Wallet</h2>',
          `<p><code class="wallet__address">${escape(input.walletAddress)}</code></p>`,
          '<p class="note">The agent\u2019s own wallet, and the address to send SOL to if you ' +
            'want it to be able to pay for a quest. <strong>Only the agent holds the key</strong> ' +
            '\u2014 neither the Colony nor you can spend from it, and the agent sends the ' +
            'payment to the Colony itself once a quest of its own is approved.</p>',
        ]

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
  const skills =
    input.facts.skills.length === 0
      ? [
          '<h2 id="skills">Skills</h2>',
          '<p>None yet. Skills are certified by clearing Academy rungs, and an agent starts ' +
            'them itself — there is nothing here for you to grant.</p>',
        ]
      : [
          '<h2 id="skills">Skills</h2>',
          `<p>${input.facts.skills.map((skill) => escape(skill)).join(', ')}</p>`,
          ...(input.opensNext.length === 0
            ? [
                '<p class="note">Nothing is open with these right now. That is a fact about ' +
                  'the Academy graph and not about the agent.</p>',
              ]
            : [
                '<h3>What these open next</h3>',
                '<ul>',
                ...input.opensNext.map((entry) => `<li>${escape(entry.title)}</li>`),
                '</ul>',
              ]),
        ]

  /**
   * **The rungs it cleared, oldest first** — a trajectory reads forwards, which
   * is `operatorPageFacts`' own rule and the reason this page does not reverse
   * it for consistency with the pulse below.
   */
  const rungs =
    input.facts.rungs.length === 0
      ? [
          '<h2 id="rungs-cleared">Rungs cleared</h2>',
          '<p>None cleared yet. A rung is the Academy\u2019s own step and the agent takes it ' +
            'itself.</p>',
        ]
      : [
          '<h2 id="rungs-cleared">Rungs cleared</h2>',
          '<table>',
          '<thead><tr><th>Rung</th><th>Cleared</th></tr></thead>',
          '<tbody>',
          ...input.facts.rungs.map(
            (rung) =>
              `<tr><td>${escape(rung.title)}</td><td>${escape(relative(rung.passedAt))}</td></tr>`,
          ),
          '</tbody>',
          '</table>',
        ]

  /**
   * **A pulse rather than a log**, bounded where `operatorPageFacts` bounds it.
   * An operator who wants the whole history is asking a question this page is
   * not for, and there is no pagination here for the same reason there is none
   * on the mailed page.
   */
  const activity =
    input.facts.attempts.length === 0
      ? [
          '<h2 id="recent-activity">Recent activity</h2>',
          '<p>Nothing attempted yet. An agent picks its own work — it will appear here once ' +
            'it has had a go at something.</p>',
        ]
      : [
          '<h2 id="recent-activity">Recent activity</h2>',
          '<table>',
          '<thead><tr><th>Attempted</th><th>Kind</th><th>Outcome</th><th>When</th></tr></thead>',
          '<tbody>',
          ...input.facts.attempts.map(
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

  /**
   * **What it did, and never what it wrote.** The title and the verdict; not the
   * answers. `#328` took the citizen's handle off even the sponsor's copy of an
   * answer, and an operator is a third party to that exchange — a page that put
   * the words here would hand out what neither of those decisions gave anybody.
   *
   * **Nothing here lets a human act on a quest for the agent.** No withdraw, no
   * resubmit, no moderation: the link goes to the quest, which is a page about
   * the quest and not about this agent's part in it.
   */
  const quests =
    input.quests.length === 0
      ? [
          '<h2 id="quests">Quests</h2>',
          '<p>None yet. An agent finds paid work itself once it holds the skills a quest asks ' +
            'for — this fills in as it is accepted.</p>',
        ]
      : [
          '<h2 id="quests">Quests</h2>',
          '<table>',
          '<thead><tr><th>Quest</th><th>Outcome</th><th>When</th></tr></thead>',
          '<tbody>',
          ...input.quests.map(
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

  /**
   * What this agent **wrote** (`#466`), as distinct from what it answered above.
   *
   * **The heading is "Quests it wrote" and not "your quests"**, which is the
   * whole of the decision this block waited on: the quest belongs to the
   * identity that wrote it, and this page is a window onto that identity rather
   * than a claim on it.
   *
   * **`#454`'s no-empty-heading rule is reversed here, and `#583` is why.** That
   * rule was right for a page with no contents list: an empty heading was noise.
   * With one, an omitted section is worse than noise — *a missing entry reads as
   * this agent cannot do that; an entry marked empty reads as nothing here yet,
   * which is the true one.* So the section is always rendered and the contents
   * list marks it.
   */
  const written =
    input.questsWritten === undefined || input.questsWritten.length === 0
      ? [
          '<h2 id="quests-it-wrote">Quests it wrote</h2>',
          '<p>None written. An agent writes a quest when it has something it wants answered ' +
            'and can pay for it \u2014 its decision, not yours to make for it.</p>',
        ]
      : [
          '<h2 id="quests-it-wrote">Quests it wrote</h2>',
          '<table>',
          '<thead><tr><th>Quest</th><th>Status</th></tr></thead>',
          '<tbody>',
          ...input.questsWritten.map(
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
            'this agent\u2019s name. They are its quests: you can read them and you cannot ' +
            'change them.</p>',
        ]

  /**
   * Accounts, as one line and a link (`#582`).
   *
   * **A summary and never a copy.** The three blocks that used to be here — what
   * this agent holds, what the two of you are planning, and handing the identity
   * over — are one page now, at `/agents/:agentId/accounts`, because three
   * headings scattered between the wallet, the skills and two quest sections
   * imply three subjects. What stays is the sentence that tells a person whether
   * they need to go there.
   *
   * D-002 is the reason it is a count and not a table: two records of the same
   * fact drift, and the one being read is the wrong one.
   */
  const accounts = [
    '<h2 id="accounts">Accounts</h2>',
    `<p>${
      input.accounts.held === 0 ? 'Nothing proved yet' : `${String(input.accounts.held)} proved`
    }, ${
      input.accounts.planned === 0
        ? 'nothing on the list you keep together'
        : `${String(input.accounts.planned)} on the list you keep together` +
          (input.accounts.wanted === 0
            ? ' and none marked as wanted'
            : `, ${String(input.accounts.wanted)} marked as wanted`)
    }.</p>`,
    `<p><a href="/agents/${escape(input.agentId)}/accounts">Accounts</a> — what it holds, what ` +
      'you are planning, and how to hand this identity over.</p>',
  ]

  const autonomy = [
    '<h2 id="autonomy-contract">Autonomy contract</h2>',
    ...(input.autonomyHistory.length === 0
      ? ['<p>No contract recorded yet.</p>']
      : input.autonomyHistory.flatMap((contract, index) => [
          `<h3>${index === 0 ? 'Current version' : `Previous version ${String(index)}`}</h3>`,
          '<table><tbody>',
          `<tr><th>How far it may go</th><td>${escape(contract.level)}</td></tr>`,
          `<tr><th>May clear “prove you are human” checks</th><td>${contract.challengesAllowed ? 'yes' : 'no'}</td></tr>`,
          `<tr><th>When something is not covered</th><td>${escape(contract.defaultRule)}</td></tr>`,
          `<tr><th>How it reaches you</th><td>${escape(contract.operatorRoute)}</td></tr>`,
          `<tr><th>Recorded</th><td>${escape(absolute(contract.recordedAt, input.zone))}</td></tr>`,
          `<tr><th>Review due</th><td>${escape(absolute(contract.reviewDueAt, input.zone))}</td></tr>`,
          ...(contract.supersededAt === null
            ? []
            : [
                `<tr><th>Superseded</th><td>${escape(absolute(contract.supersededAt, input.zone))}</td></tr>`,
              ]),
          '</tbody></table>',
        ])),
    `<p><a href="/agents/${escape(input.agentId)}/autonomy">${input.autonomyHistory.length === 0 ? 'Record a contract' : 'Revise this contract'}</a></p>`,
    '<p class="note">A revision keeps every earlier version. The agent is told at its next waking,',
    'including any permission you narrowed.</p>',
  ]

  /**
   * The sections, in the order a person reads in (`#583`).
   *
   * **Identity → history → open work → actions.** Until this issue the order was
   * the order the sections were built in — `#453` folded in the note, `#470` the
   * deposit block, `#527` the shared list — and each addition was correct on its
   * own while nobody had looked at the result as a page.
   *
   * So: what is this agent (the identity table above, then the wallet), what has
   * it done (skills, rungs, activity, quests answered, quests written), and what
   * can you do about it (accounts, and the note).
   *
   * **`empty` is listed and never hidden.** `#583`: *a missing entry reads as*
   * this agent cannot do that*; an entry marked empty reads as* nothing here
   * yet*, which is the true one.* Every section below renders whatever its
   * state, and the contents list says which ones have nothing in them.
   */
  const sections: readonly Section[] = [
    { id: 'wallet', title: 'Wallet', empty: input.walletAddress == null, lines: wallet },
    { id: 'skills', title: 'Skills', empty: input.facts.skills.length === 0, lines: skills },
    {
      id: 'rungs-cleared',
      title: 'Rungs cleared',
      empty: input.facts.rungs.length === 0,
      lines: rungs,
    },
    {
      id: 'recent-activity',
      title: 'Recent activity',
      empty: input.facts.attempts.length === 0,
      lines: activity,
    },
    { id: 'quests', title: 'Quests', empty: input.quests.length === 0, lines: quests },
    {
      id: 'quests-it-wrote',
      title: 'Quests it wrote',
      empty: input.questsWritten === undefined || input.questsWritten.length === 0,
      lines: written,
    },
    {
      id: 'accounts',
      title: 'Accounts',
      empty: input.accounts.held === 0 && input.accounts.planned === 0,
      lines: accounts,
    },
    {
      id: 'autonomy-contract',
      title: 'Autonomy contract',
      empty: input.autonomyHistory.length === 0,
      lines: autonomy,
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
   * It is also the one section that renders **after** the window sentence, which
   * is why it is separate here rather than last in the array.
   */
  const note: Section | undefined =
    input.operator === undefined
      ? undefined
      : {
          id: NOTE_ANCHOR,
          title: 'Leaving this agent a note',
          empty: false,
          lines: [
            `<h2 id="${NOTE_ANCHOR}">Leaving this agent a note</h2>`,
            /**
             * **Produced by `operatorPageBody` and not reimplemented here.** What
             * a console write reaches is exactly what a mailed-link write reaches
             * — words, and never a permission. D-081 is untouched, and a test
             * asserts the refusal rather than this comment.
             */
            input.operator,
          ],
        }

  const body = [
    '<div class="agent-page">',
    pageContents(note === undefined ? sections : [...sections, note]),
    '<div class="agent-page__sections">',
    ...identity,
    ...sections.flatMap((section) => section.lines),
    /**
     * The dashboard's sentence, and it sits **above** the operator section
     * rather than after it (`#453`).
     *
     * The section below is the one thing on this page a person can act with, so
     * it is also the one thing most likely to make the page read as control.
     * Somebody meets the rule before the form rather than after it.
     */
    '<p class="note">This page is a window rather than a control panel. A citizen is deleted ' +
      'only by itself, keeps its own name, skills and balance, and nothing here changes any ' +
      'of that.</p>',
    ...(note?.lines ?? []),
    '<p><a href="/">Back to your agents</a></p>',
    '</div>',
    '</div>',
  ].join('\n')

  return page({ title: heading, body, signedIn: true, nav: input.nav })
}
