/**
 * One account, and everything either side has ever said about it (`#932`).
 *
 * ## The account is the page
 *
 * The list `#928` built answers *how are my agent's accounts doing* in four
 * columns, and stops exactly where an operator's next question starts: *what
 * happened to this one*. That question had no surface at all. The conversation
 * existed in storage from `#930`, the secrets in it reached the dashboard in
 * `#931`, and the account they were about was a string in a table cell.
 *
 * So: head, a status line, then the whole thread as one column, oldest at the
 * top, and one box at the bottom. Not a tab strip, not a filter, not a list of
 * conversations to open one at a time — an account has a handful of these in its
 * lifetime, and a reader who has to click to find out whether anything happened
 * is a reader who stops looking.
 *
 * ## The word *episode* is not on it
 *
 * It is the storage's word and it is a good one there. On a page read by the
 * person who bought the mailbox it is jargon for *a thing that happened*, so the
 * types here are named for what the reader sees. The button that starts one says
 * *Something is wrong* or *I need you*, which is what the reader came to say.
 *
 * ## The status line is derived and never stored
 *
 * *Nobody is waiting*, or *waiting on you*, or *3 open: 1 on you, 2 on ariadne*.
 * A stored summary of open conversations is a second record of a fact the
 * conversations already hold, and it goes stale without anybody editing it,
 * which is D-002.
 *
 * ## Constraints
 *
 * No JavaScript, D-062, like every console page. There is no clipboard here and
 * cannot be one: a *copy button* is either the value on the page to select, or —
 * for a secret, which must not be on the page at all — the button that spends a
 * read and shows it on the handover page. Both are forms.
 */

import type {
  AtlasState,
  EpisodeOutcome,
  EpisodeTurn,
  SlotFiller,
  ThreadParty,
} from '@kolonie-ai/core'
import { heldRecheckCell, heldStateCell, type HeldAccountRow } from './agent-accounts.js'
import { escape, page } from './html.js'
import type { ConsoleNav } from './navigation.js'
import { absolute, relative } from './time.js'

/** One note, by whoever wrote it. There is no edit and no delete, either side. */
export interface ConversationEntry {
  readonly author: ThreadParty
  readonly body: string
  readonly createdAt: string
}

/**
 * A place a value goes, as this page renders it.
 *
 * **`value` is null for every secret and the type cannot say otherwise here.**
 * The storage read nulls it before the port sees it, and this page asserts the
 * same thing a second time by never printing `value` on a row that is `secret`.
 * Two guards for one rule, because the cost of the rule failing is a credential
 * in a page a browser has cached.
 */
export interface ConversationSlot {
  readonly id: string
  readonly label: string
  readonly secret: boolean
  readonly awaits: SlotFiller
  readonly filled: boolean
  /** Non-secret only. A secret arrives here null and is rendered as a button. */
  readonly value: string | null
  readonly readsLeft: number
  /** Taken, destroyed or lapsed. The row survives all three, and says so. */
  readonly gone: boolean
}

/** One thing that happened about this account, with everything said inside it. */
export interface Conversation {
  readonly id: string
  readonly title: string
  readonly openedBy: ThreadParty
  readonly turn: EpisodeTurn
  readonly outcome: EpisodeOutcome | null
  /** Why it failed, when it did. The one outcome that obliges a sentence. */
  readonly wall: string | null
  readonly openedAt: string
  readonly closedAt: string | null
  readonly entries: readonly ConversationEntry[]
  readonly slots: readonly ConversationSlot[]
}

/**
 * One inbox thread about this account, as the page needs it (`#1600`).
 *
 * **A projection and not the storage shape.** The page needs six facts and the
 * `Conversation` it comes from carries participants, bodies and subjects it has
 * no business rendering here — a renderer given the whole thing would be one
 * edit away from putting a message body on a page that is not the thread.
 */
export interface InboxThread {
  readonly id: string
  /** When anything last happened in it, or when it was opened if nothing has. */
  readonly lastActivityAt: string
  /** How many messages the person has not read. */
  readonly unread: number
  /** Whether this thread is one the person has put away. */
  readonly archived: boolean
  /**
   * The credential asks hanging on it — never a value, and never a key the
   * thread did not already name in its own words.
   */
  readonly shares: readonly {
    readonly vaultKey: string
    readonly purpose: string
    /** Whether the person has opened it at all. */
    readonly opened: boolean
    /** Whether they wrote something back into it. */
    readonly operatorWrote: boolean
    /** `null` while it is live. */
    readonly ended: 'taken-back' | 'expired' | null
  }[]
}

export interface AccountThreadInput {
  readonly nav: ConsoleNav
  readonly agentId: string
  /** The agent's name, so the page can say whose turn it is in words. */
  readonly name: string
  readonly zone: string
  readonly account: HeldAccountRow
  /**
   * Every conversation about this account, **oldest first**.
   *
   * The storage read is newest-first, because the reads it was written for are
   * *what is the latest*. A history reads the other way, and the reversal is the
   * caller's: a renderer that sorted its own input would be deciding something
   * the route is better placed to decide, and would hide the storage's order
   * from anyone reading either half alone.
   */
  readonly conversations: readonly Conversation[]
  /**
   * The inbox threads that are *about* this account (`#1600`), newest first.
   *
   * **A second list beside the episodes, labelled, and not merged into them.**
   * `#1600` freezes the distinction: an episode is the repair/handoff
   * conversation the account page has always owned, an inbox thread is
   * `kolonie.messages.*`, and the page lists both under one head rather than
   * pretending they are one sequence. They have different authors, different
   * lifecycles and different renderers, and a merged list would have to invent
   * an ordering across two clocks.
   *
   * **Empty means the section is not rendered at all** — an empty shell would be
   * a promise that this account has an inbox, which for most accounts is not a
   * thing anybody wants to be told.
   */
  readonly inboxThreads?: readonly InboxThread[] | undefined
  /**
   * What the Atlas has on this account's provider (`#936`).
   *
   * **Absent where there is no provider to look one up by**, which an account
   * the agent declared without naming one is. Absent renders nothing at all
   * rather than *unwalked*: the Colony has not failed to find an entry, it was
   * never asked.
   */
  readonly atlas?: AtlasState | undefined
  /** Set after a form on this page, so the reader knows it landed. */
  readonly notice?: string | undefined
}

/** Whose turn, in the second person for the reader and by name for the agent. */
function turnWords(turn: EpisodeTurn, name: string): string {
  return turn === 'operator' ? 'you' : turn === 'agent' ? name : 'nobody'
}

/**
 * What the head says before anything else (`#932`).
 *
 * **Derived from the conversations, every time.** *Nobody is waiting* is the
 * common answer and the page has to be able to say it plainly — an operator who
 * cannot tell *nothing is owed* from *I have not been told* checks the page
 * every day and learns nothing from it.
 */
export function statusLine(conversations: readonly Conversation[], name: string): string {
  const open = conversations.filter((conversation) => conversation.outcome === null)
  if (open.length === 0) return 'Nobody is waiting.'

  if (open.length === 1) {
    const [only] = open
    if (only === undefined) return 'Nobody is waiting.'
    const since = ` <small>open since ${escape(relative(only.openedAt))}</small>`
    if (only.turn === 'nobody')
      return `Something is open, and neither of you owes the other a move.${since}`
    return `Waiting on ${escape(turnWords(only.turn, name))}.${since}`
  }

  /**
   * Counts, and `nobody` is one of the three rather than the remainder. An open
   * conversation nobody owes a move on is a real state — `EpisodeTurn` says so —
   * and folding it into the total would make the parts not add up.
   */
  const counted = (['operator', 'agent', 'nobody'] as const)
    .map((turn) => ({
      turn,
      count: open.filter((conversation) => conversation.turn === turn).length,
    }))
    .filter((part) => part.count > 0)
    .map((part) => `${String(part.count)} on ${escape(turnWords(part.turn, name))}`)

  return `${String(open.length)} open: ${counted.join(', ')}.`
}

/**
 * What a slot renders as, which is a button or a value and never both (`#932`).
 *
 * **A secret is not on this page and no argument makes it one.** The read that
 * shows it is `POST /account-slots/:slotId`, which spends one of three reads and
 * renders the value on a page of its own — a button rather than a link, on
 * `#931`'s reasoning: a link is prefetched, crawled and re-run by a back button,
 * and each of those would burn a read of a live credential.
 *
 * **A slot waiting on the operator points at the dashboard rather than carrying
 * a second box.** The paste form is there already, and a form is a place a
 * decision is taken: two of them for one slot is two places to keep right.
 */
function slotLine(slot: ConversationSlot, name: string): string {
  const label = `<strong>${escape(slot.label)}</strong>`

  if (slot.gone) {
    return (
      `${label}<br><small>there was a value here and it is gone — taken, or destroyed when its ` +
      'few days ran out</small>'
    )
  }

  if (!slot.filled) {
    return slot.awaits === 'operator'
      ? `${label}<br><small>waiting on you. It is on <a href="/">your dashboard</a>, where the ` +
          'box for it is</small>'
      : `${label}<br><small>waiting on ${escape(name)}</small>`
  }

  if (slot.secret) {
    return [
      label,
      `<form method="post" action="/account-slots/${escape(slot.id)}">`,
      `<button type="submit">Read it (${String(slot.readsLeft)} left)</button>`,
      '</form>',
      '<small>Reading spends one of them, and there is no way to get one back.</small>',
    ].join('')
  }

  // Not a secret, so it is on the page and there is nothing to spend. Selecting
  // it is the copy, which is what a console with `default-src 'none'` can offer.
  return `${label}<br><code>${escape(slot.value ?? '')}</code>`
}

/** Who wrote a note, in words rather than in the storage's three tokens. */
function authorWords(author: ThreadParty, name: string): string {
  return author === 'operator' ? 'You' : author === 'agent' ? name : 'The Colony'
}

/** How a conversation ended, for the line that closes its block. */
function outcomeWords(outcome: EpisodeOutcome): string {
  return outcome === 'taken-over'
    ? 'handed over'
    : outcome === 'created'
      ? 'the account was created'
      : outcome === 'repaired'
        ? 'the account was repaired'
        : outcome === 'failed'
          ? 'it failed'
          : 'abandoned'
}

/**
 * One conversation, head to foot: what it is, what was said, what is in it, and
 * — while it is still open — the two acts either side can take on it.
 *
 * **The note and the turn are separate forms, deliberately.** Writing something
 * down is not taking the ball, and a page that made it one would leave an
 * operator unable to say *I have asked our provider and I am waiting* without
 * also claiming the next move. `EpisodeTurnSchema` says the same thing in its
 * own words: the turn is not permission to speak.
 */
function conversationBlock(
  conversation: Conversation,
  input: AccountThreadInput,
  index: number,
): string {
  const open = conversation.outcome === null
  const action = `/agents/${escape(input.agentId)}/accounts/${escape(input.account.id)}`
  const notes = conversation.entries.map((entry) =>
    [
      '<li class="operator-ask">',
      `<p><strong>${escape(authorWords(entry.author, input.name))}</strong> ` +
        `<small>${escape(relative(entry.createdAt))}, at ` +
        `${escape(absolute(entry.createdAt, input.zone))}</small></p>`,
      // Line breaks are kept and nothing is markdown, which is what the body's
      // own contract in `core` says. `<pre>` is how a page keeps them without a
      // renderer that could be given something to interpret.
      `<pre>${escape(entry.body)}</pre>`,
      '</li>',
    ].join(''),
  )

  return [
    `<h2>${escape(conversation.title)}</h2>`,
    `<p><small>opened by ${escape(authorWords(conversation.openedBy, input.name))} ` +
      `${escape(relative(conversation.openedAt))}, at ` +
      `${escape(absolute(conversation.openedAt, input.zone))}` +
      (open
        ? `; waiting on ${escape(turnWords(conversation.turn, input.name))}`
        : conversation.closedAt === null
          ? ''
          : `; closed ${escape(relative(conversation.closedAt))}`) +
      '</small></p>',
    ...(notes.length === 0
      ? ['<p><small>Nothing has been written here yet.</small></p>']
      : [`<ol class="operator-asks">${notes.join('')}</ol>`]),
    ...(conversation.slots.length === 0
      ? []
      : [
          `<ul class="operator-asks">${conversation.slots
            .map((slot) => `<li class="operator-ask">${slotLine(slot, input.name)}</li>`)
            .join('')}</ul>`,
        ]),
    ...(conversation.outcome === null
      ? [
          '<form method="post" action="' + `${action}/note` + '">',
          `<input type="hidden" name="conversation" value="${escape(conversation.id)}">`,
          `<label for="note-${String(index)}">Write something here</label>`,
          `<textarea id="note-${String(index)}" name="body" rows="4" required ` +
            'maxlength="2000"></textarea>',
          '<button type="submit">Send</button>',
          '</form>',
          '<p class="note">Writing does not take the next move. Whose it is, is the thing ' +
            'below.</p>',
          `<form method="post" action="${action}/turn">`,
          `<input type="hidden" name="conversation" value="${escape(conversation.id)}">`,
          // D-013: no button whose only answer is a refusal, so the side that
          // already holds the turn is not offered a form to take it again.
          ...(conversation.turn === 'operator'
            ? []
            : [
                '<button type="submit" name="to" value="operator">I will take it from here</button>',
              ]),
          ...(conversation.turn === 'agent'
            ? []
            : [
                '<button type="submit" name="to" value="agent">Over to ' +
                  `${escape(input.name)}</button>`,
              ]),
          '</form>',
        ]
      : [
          `<p><small>Ended: ${escape(outcomeWords(conversation.outcome))}` +
            (conversation.wall === null ? '' : ` — ${escape(conversation.wall)}`) +
            '</small></p>',
        ]),
  ].join('')
}

/**
 * What the Atlas has on this provider, on the page where somebody is about to
 * act on it (`#936`).
 *
 * **Three states, three shapes, and the shapes are the point.** A reader
 * skimming does not read the words before deciding whether this block matters —
 * so a warning is a paragraph they cannot miss, a crib sheet is folded away
 * until they want it, and *nobody has been here* is one quiet line. Rendering
 * all three as the same box would put the refusal and the reassurance at the
 * same weight.
 *
 * **The crib sheet is a hint and says so.** These are steps somebody else
 * walked, at a provider that has had a year to change its signup since. The
 * acceptance criteria for `#936` turn on that being visible rather than implied:
 * an operator who follows a stale step and finds a different page should have
 * been told what they were reading.
 */
function atlasBlock(atlas: AtlasState): readonly string[] {
  if (atlas.state === 'unwalked') {
    return [
      `<p class="note">The Atlas has no written path for ${escape(atlas.provider)}. Nobody ` +
        'has been through here, and what you two find on the way is how an entry gets ' +
        'written.</p>',
    ]
  }

  if (atlas.state === 'closed') {
    return [
      '<p class="notice"><strong>The Atlas records this one as ' +
        `${atlas.withdrawn ? 'withdrawn' : 'not joinable'}.</strong> ` +
        (atlas.reason === null ? 'No reason was recorded.' : escape(atlas.reason)) +
        '</p>',
      /**
       * D-013's neighbour: the warning must not read as a closed door. A
       * refusal in the Atlas is a finding from one walk, and the provider is
       * free to have changed its mind since — which is exactly why nothing here
       * stops the conversation.
       */
      '<p class="note">Nothing is stopped by this. It is one recorded finding and it may be ' +
        'out of date — if it turns out to be, that is worth more to the Colony than the ' +
        'account is.</p>',
    ]
  }

  return [
    '<details>',
    `<summary>What somebody who walked ${escape(atlas.provider)} wrote down ` +
      `(${String(atlas.steps.length)} step${atlas.steps.length === 1 ? '' : 's'})</summary>`,
    /**
     * **The caveat about who wrote this went with the status it described**
     * (`#1032`). It read *and no steward has reviewed it yet* wherever a walk
     * had put its own steps on the entry; walks no longer write steps, so every
     * list that reaches here is the Colony's own route. What has not changed is
     * the warning that matters more: the provider has had a year to move its
     * signup, and the page in front of the reader wins.
     */
    `<p class="note"><strong>A hint, not an instruction.</strong> This is ${escape(
      atlas.title,
    )} as the Colony has it written down. The signup may have changed since. Where the page ` +
      'in front of you disagrees with the list, the page is right.</p>',
    `<ol>${atlas.steps.map((step) => `<li>${escape(step)}</li>`).join('')}</ol>`,
    ...(atlas.operatorSteps === 0
      ? []
      : [
          `<p class="note">${String(atlas.operatorSteps)} of these needed a person when it ` +
            'was walked.</p>',
        ]),
    '</details>',
  ]
}

/**
 * The inbox threads about this account (`#1600`).
 *
 * **Each row says whether the ask reached anybody.** That is the whole reason
 * this section exists rather than a bare list of links: the case it was written
 * for is a live share with zero reads, which from the citizen's side and from
 * the operator's looked exactly like a thread nobody had opened. *Not opened*,
 * *opened*, and *answered* are three different next moves.
 *
 * **A link out rather than the thread inlined.** The inbox already renders a
 * thread and does it in one place; a second renderer here would be a second copy
 * of the one surface `#1547` unified.
 */
function inboxThreadsBlock(threads: readonly InboxThread[], zone: string): string[] {
  return [
    '<h2>Messages about this account</h2>',
    '<p class="note">These are inbox threads, not the account history above. Opening one takes ' +
      'you to your inbox.</p>',
    '<table>',
    '<thead><tr><th>Thread</th><th>Last activity</th><th>Waiting on you</th>' +
      '<th>Credentials attached</th></tr></thead>',
    '<tbody>',
    ...threads.map((thread) => {
      const shares =
        thread.shares.length === 0
          ? '<small>none</small>'
          : thread.shares
              .map((share) => {
                /**
                 * The four states a share can be in, said as what the person
                 * would do next rather than as a status word. An ended one still
                 * renders — `#1574`'s rule that a credential box does not vanish
                 * without saying it was there.
                 */
                const state =
                  share.ended === 'taken-back'
                    ? 'taken back'
                    : share.ended === 'expired'
                      ? 'expired'
                      : share.operatorWrote
                        ? 'you answered it'
                        : share.opened
                          ? 'you opened it'
                          : '<strong>you have not opened it</strong>'
                return `<div>${escape(share.vaultKey)} — ${state}<br><small>${escape(
                  share.purpose,
                )}</small></div>`
              })
              .join('')

      return (
        '<tr>' +
        `<td><a href="/inbox/${escape(thread.id)}">Open thread</a>${
          thread.archived ? ' <small>(put away)</small>' : ''
        }</td>` +
        `<td>${absolute(thread.lastActivityAt, zone)}</td>` +
        `<td>${thread.unread === 0 ? '<small>nothing new</small>' : `<strong>${String(thread.unread)}</strong>`}</td>` +
        `<td>${shares}</td>` +
        '</tr>'
      )
    }),
    '</tbody>',
    '</table>',
  ]
}

export function accountThreadPage(input: AccountThreadInput): string {
  const action = `/agents/${escape(input.agentId)}/accounts/${escape(input.account.id)}`
  const nothingOpen = input.conversations.every((conversation) => conversation.outcome !== null)

  const body = [
    ...(input.notice === undefined ? [] : [`<p><strong>${escape(input.notice)}</strong></p>`]),
    `<h1>${escape(input.account.identifier)}</h1>`,
    `<p>${escape(input.account.kind)} at ${
      input.account.provider === null
        ? '<small>a provider your agent did not name</small>'
        : escape(input.account.provider)
    }</p>`,
    `<p>${statusLine(input.conversations, input.name)}</p>`,
    '<table>',
    '<thead><tr><th>Your agent says</th><th>The Colony last checked</th></tr></thead>',
    `<tbody><tr><td>${heldStateCell(input.account)}</td>` +
      `<td>${heldRecheckCell(input.account, input.zone)}</td></tr></tbody>`,
    '</table>',
    ...(input.atlas === undefined ? [] : atlasBlock(input.atlas)),
    /**
     * **Omitted entirely when there is none** (`#1600`), rather than an empty
     * shell: a heading over nothing tells an operator this account has an inbox
     * and that it is empty, and the first half of that is the part most accounts
     * would rather not claim.
     */
    ...(input.inboxThreads === undefined || input.inboxThreads.length === 0
      ? []
      : inboxThreadsBlock(input.inboxThreads, input.zone)),
    ...(input.conversations.length === 0
      ? [
          '<p>Nothing has ever happened to this account. That is the ordinary state of an ' +
            'account that works.</p>',
        ]
      : input.conversations.map((conversation, index) =>
          conversationBlock(conversation, input, index),
        )),
    /**
     * The openers, and only where there is nothing to write into.
     *
     * Two, because they are two different things to say and an operator knows
     * which they mean before they know what the Colony would call it. Both open
     * the same kind of conversation and hand the next move to the agent — the
     * point of saying either is that the agent does something.
     */
    ...(nothingOpen
      ? [
          '<h2>Start something</h2>',
          `<form method="post" action="${action}/open">`,
          '<button type="submit" name="reason" value="wrong">Something is wrong</button>',
          '<button type="submit" name="reason" value="help">I need you</button>',
          '</form>',
          `<p class="note">Either one wakes ${escape(input.name)} and hands it the next move. ` +
            'Nothing here starts, stops or instructs an agent; you are telling it something.</p>',
        ]
      : []),
  ]

  return page({
    title: input.account.identifier,
    body: body.join(''),
    signedIn: true,
    nav: input.nav,
  })
}
