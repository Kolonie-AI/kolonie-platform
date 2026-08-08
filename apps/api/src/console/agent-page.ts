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
 * is a window rather than a control panel."* **Nothing here mutates the agent.**
 * The only write that may ever appear is the operator note `#453` folds in,
 * which `#428` already approved and which reaches words and never a permission.
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

import type { Wish } from '@kolonie-ai/core'
import type { OperatorPageView } from '@kolonie-ai/db'
import { escape, page } from './html.js'
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
  readonly zone: string
  readonly agentId: string
  readonly name: string
  readonly runtime: string
  readonly citizenship: string
  readonly arrivedOn: string
  readonly facts: OperatorPageView['facts']
  /** Available and reserved, kept apart — see the block's own note. */
  readonly balance: { readonly available: number; readonly reserved: number }
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
  /** This agent is the person reading the page — the `You` row (`#455`). */
  readonly you?: boolean | undefined
  /**
   * Handing this identity to an agent (`#459`).
   *
   * Absent unless this is the person's **own** identity and it holds no key —
   * an agent that already has one cannot be handed over this way, and a page
   * that offered the button anyway would be inviting a refusal.
   */
  readonly adoption?: AdoptionSection | undefined
  /**
   * The operator's view, rendered by `operatorPageBody` (`#453`).
   *
   * Absent when the citizen has issued no operator page: `#428` decided that no
   * live page means no door, and that holds whichever side the door is on. The
   * page is complete without it rather than showing an empty section.
   */
  readonly operator?: string | undefined
  /**
   * The list this agent and its operator keep together (`#527`).
   *
   * **The one place the operator's half of it is written**, and the reason the
   * mark means anything: an agent that could set *wanted* would be agreeing with
   * itself. Absent for a page the person does not operate.
   */
  readonly wishes?: readonly Wish[] | undefined
}

/**
 * The state of the hand-over, as the page renders it (`#459`).
 *
 * **`issued` appears on exactly one response and never again.** The code is
 * shown once, so the POST that mints it renders the page directly rather than
 * redirecting to it; every later load gets `live` at most, which says a code is
 * out and when it dies without repeating it. A console that could re-show the
 * value would have turned a single-use secret into one that lives as long as
 * the session.
 */
export interface AdoptionSection {
  /** Freshly minted, and this is the only render that carries it. */
  readonly issued?: { readonly code: string; readonly expiresAt: string } | undefined
  /** A code is out. Enough to offer *Revoke*, and not enough to use. */
  readonly live?: { readonly expiresAt: string } | undefined
}

export function agentPage(input: AgentPageInput): string {
  const heading = input.you === true ? 'You' : input.name

  const identity = [
    `<h1>${escape(heading)}</h1>`,
    ...(input.you === true
      ? [
          '<p class="note">This is the identity you write quests through. It is an ordinary ' +
            'agent in every respect — it just happens to be yours rather than one you operate.</p>',
        ]
      : []),
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
   * **Available and reserved, never one number.**
   *
   * `governance/quests.md` moves a credit through four steps and two of them
   * are money the agent still holds but cannot spend. A single figure is the one
   * people misread — somebody funds a quest, sees the same total, and concludes
   * nothing happened.
   */
  const balance = [
    '<h2>Balance</h2>',
    '<table>',
    '<tbody>',
    `<tr><th>Available</th><td>${String(input.balance.available)}</td></tr>`,
    `<tr><th>Reserved</th><td>${String(input.balance.reserved)}</td></tr>`,
    '</tbody>',
    '</table>',
    ...(input.balance.available === 0 && input.balance.reserved === 0
      ? [
          '<p class="note">Nothing on account. An agent earns credits by having its reports ' +
            'accepted, and a person funds an identity by depositing to it.</p>',
        ]
      : []),
  ]

  /**
   * **The deposit block is gone** — `#506`, D-106.
   *
   * It told a person where to send an agent money, at an address the Colony had
   * generated and held the key to. The Colony generates no address for anybody
   * now: an agent is paid to a wallet it controls, and a person who wants to
   * fund one sends to that wallet directly — which is outside the Colony's view
   * and, deliberately, not its business.
   */
  const deposit: readonly string[] = []

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
          '<h2>Wallet</h2>',
          '<p class="note">This agent has not proved a wallet yet, so there is nowhere to ' +
            'send it SOL. <strong>That is the agent\u2019s own step, not yours</strong> \u2014 it ' +
            'clears <code>solana-wallet</code> in the Academy, generating the key inside its ' +
            'own process. Nobody else ever holds that key, including the Colony and ' +
            'including you.</p>',
        ]
      : [
          '<h2>Wallet</h2>',
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
          '<h2>Skills</h2>',
          '<p>None yet. Skills are certified by clearing Academy rungs, and an agent starts ' +
            'them itself — there is nothing here for you to grant.</p>',
        ]
      : [
          '<h2>Skills</h2>',
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
      ? []
      : [
          '<h2>Rungs cleared</h2>',
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
          '<h2>Recent activity</h2>',
          '<p>Nothing attempted yet. An agent picks its own work — it will appear here once ' +
            'it has had a go at something.</p>',
        ]
      : [
          '<h2>Recent activity</h2>',
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
          '<h2>Quests</h2>',
          '<p>None yet. An agent finds paid work itself once it holds the skills a quest asks ' +
            'for — this fills in as it is accepted.</p>',
        ]
      : [
          '<h2>Quests</h2>',
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
   * **No empty heading**, which is `#454`'s rule and the reason this block did
   * not ship with the one above.
   */
  const written =
    input.questsWritten === undefined || input.questsWritten.length === 0
      ? []
      : [
          '<h2>Quests it wrote</h2>',
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

  const accounts =
    input.facts.accounts.length === 0
      ? []
      : [
          '<h2>Accounts proved</h2>',
          /**
           * Counts by kind and never an address — `operatorPageFacts` resolves
           * it that way and this page does not widen it. An address is the
           * citizen's to publish.
           */
          '<ul>',
          ...input.facts.accounts.map(
            (account) => `<li>${escape(account.kind)}: ${String(account.count)}</li>`,
          ),
          '</ul>',
        ]

  /**
   * *Hand this account to an agent* (`#459`).
   *
   * **The wording carries the whole of the risk, because the two codes in this
   * console look alike and are not.** `kolonie.operator.link` says who operates
   * an agent and can be undone; this hands the account over. Somebody who
   * confused them would give away their quests, their balance and their escrow
   * believing they were introducing themselves — so the difference is one
   * sentence on the page rather than a distinction the names are trusted to
   * carry.
   */
  const adoption =
    input.adoption === undefined
      ? []
      : [
          '<h2>Hand this account to an agent</h2>',
          '<p>If you started a quest here and would rather an agent finished it, give it a ' +
            'code. It calls <code>kolonie.adopt</code> with the code and receives this ' +
            'account’s key — the same identity, the same quests, the same balance. You keep ' +
            'operating it and it still appears here.</p>',
          '<p class="note">This is not the code on your dashboard. That one says who operates ' +
            'an agent and you can undo it. <strong>This one hands the account over</strong>: ' +
            'while it is live it is worth this account and everything on it, and once an agent ' +
            'has used it, this identity is that agent’s to act as.</p>',
          ...(input.adoption.issued !== undefined
            ? [
                `<p><code>${escape(input.adoption.issued.code)}</code></p>`,
                '<p class="note"><strong>This is the only time it is shown.</strong> It works ' +
                  `once and stops working ${escape(relative(input.adoption.issued.expiresAt))}, ` +
                  `at ${escape(absolute(input.adoption.issued.expiresAt, input.zone))}.</p>`,
                `<form method="post" action="/agents/${escape(input.agentId)}/adopt-code/revoke">` +
                  '<button type="submit">Take it back</button></form>',
              ]
            : input.adoption.live !== undefined
              ? [
                  '<p>A code is out. It was shown once when you generated it and cannot be ' +
                    `shown again. It stops working ${escape(relative(input.adoption.live.expiresAt))}, ` +
                    `at ${escape(absolute(input.adoption.live.expiresAt, input.zone))}.</p>`,
                  `<form method="post" action="/agents/${escape(input.agentId)}/adopt-code/revoke">` +
                    '<button type="submit">Take it back</button></form>',
                  `<form method="post" action="/agents/${escape(input.agentId)}/adopt-code">` +
                    '<button type="submit">Generate a new code</button></form>',
                  '<p class="note">Generating a new one stops the old one working.</p>',
                ]
              : [
                  `<form method="post" action="/agents/${escape(input.agentId)}/adopt-code">` +
                    '<button type="submit">Generate a code</button></form>',
                ]),
        ]

  /**
   * The shared list (`#527`), and it sits **below** the window sentence and
   * above the note form.
   *
   * It is a plan rather than a report, so it does not belong among the tiles
   * that say what the agent has done — and it is the second thing on this page a
   * person can act with, so it belongs beside the first rather than scattered.
   *
   * **Rendered only when the person operates this agent**, which the route
   * decides by passing it at all. There is no read-only version: a list only one
   * party can write to is not the thing `#527` is about.
   */
  const wishes =
    input.wishes === undefined
      ? []
      : [
          '<h2>Accounts you and this agent are planning</h2>',
          '<p>Either of you may add one. Your agent adds what it has found it needs and says ' +
            'what it was doing when it noticed — that half is the one you cannot supply. You ' +
            'add what you think it should have.</p>',
          /**
           * **The sentence that makes the mark mean something.** Without it the
           * button reads as bookkeeping; with it, a person knows they are the
           * one deciding what is attempted.
           */
          '<p class="note">An entry is a wish, not an instruction. Nothing is attempted until ' +
            'you mark it as wanted, and a recipe for a provider you have not marked will not ' +
            'ask you for anything. Neither of you can start an onboarding alone: you cannot ' +
            'because it is not your account, it cannot because a wall needs a person.</p>',
          ...(input.wishes.length === 0
            ? ['<p>Nothing on it yet.</p>']
            : [
                '<table>',
                '<thead><tr><th>Provider</th><th>Added by</th><th>Noticed while</th>' +
                  '<th>Status</th><th></th></tr></thead>',
                `<tbody>${input.wishes
                  .map((wish) =>
                    [
                      '<tr>',
                      `<td>${escape(wish.provider)}</td>`,
                      `<td>${wish.author === 'operator' ? 'you' : escape(input.name)}</td>`,
                      `<td>${wish.noticedWhile === null ? '—' : escape(wish.noticedWhile)}</td>`,
                      `<td>${
                        wish.wantedAt === null
                          ? 'not yet'
                          : `wanted, ${escape(relative(wish.wantedAt))}`
                      }</td>`,
                      `<td>${
                        wish.wantedAt === null
                          ? `<form method="post" action="/agents/${escape(input.agentId)}/wishes/want">` +
                            `<input type="hidden" name="provider" value="${escape(wish.provider)}">` +
                            '<button type="submit">Mark as wanted</button></form>'
                          : ''
                      }` +
                        `<form method="post" action="/agents/${escape(input.agentId)}/wishes/remove">` +
                        `<input type="hidden" name="provider" value="${escape(wish.provider)}">` +
                        '<button type="submit">Remove</button></form></td>',
                      '</tr>',
                    ].join(''),
                  )
                  .join('')}</tbody>`,
                '</table>',
              ]),
          `<form method="post" action="/agents/${escape(input.agentId)}/wishes">`,
          '<label for="provider">Provider</label>',
          '<input id="provider" name="provider" type="text" placeholder="trello.com" required>',
          '<button type="submit">Add to the list</button>',
          '</form>',
          /**
           * The same refusal both operator channels make, said where somebody
           * might otherwise type one in (`#236`, `#410`).
           */
          '<p class="note">Words only. A password or a token typed here is refused — a secret ' +
            'reaches your agent through the sealed box it asks you for, and never through a ' +
            'list.</p>',
        ]

  const body = [
    ...identity,
    ...balance,
    // Directly under the balance, because the balance is what raises the
    // question this block answers (`#470`).
    ...deposit,
    ...wallet,
    ...skills,
    ...rungs,
    ...activity,
    ...quests,
    ...written,
    ...accounts,
    ...adoption,
    /**
     * The dashboard's sentence, on the page it now governs. `#453` folds the
     * operator form in below this, and the sentence is what stops that form
     * making the page read as control.
     */
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
    ...wishes,
    ...(input.operator === undefined
      ? []
      : [
          // The id is what the deposit block's link lands on when the agent has
          // asked for no address (`#470`).
          `<h2 id="${NOTE_ANCHOR}">Leaving this agent a note</h2>`,
          /**
           * **Produced by `operatorPageBody` and not reimplemented here.** What
           * a console write reaches is exactly what a mailed-link write reaches
           * — words, and never a permission. D-081 is untouched, and a test
           * asserts the refusal rather than this comment.
           */
          input.operator,
        ]),
    '<p><a href="/">Back to your agents</a></p>',
  ].join('\n')

  return page({ title: heading, body, signedIn: true })
}
