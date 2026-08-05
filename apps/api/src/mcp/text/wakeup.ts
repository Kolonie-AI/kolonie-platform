import { wakeupIsQuiet, type WakeupResponse } from '@kolonie-ai/core'
import { unreadNotesLine } from './operator-notes.js'

/**
 * The digest as a model reads it (#200, #344).
 *
 * **Silence is stated rather than left as an empty page.** A scheduled agent
 * waking to a blank answer cannot tell *nothing happened* from *the call did not
 * work*, and the whole point of this call is to be the one thing a wake-up
 * trusts.
 *
 * ## The order, and why it is data rather than the sequence of the code
 *
 * Measured 2026-08-05 against commit `bb6aca1`, as a citizen in a first session:
 * **69 lines, 4279 characters, of which 32 were the `New tasks` block** — and
 * the one block carrying a call, a reason and a yield was rendered *last*. A
 * model reading 69 lines does not treat line 66 as an instruction, so
 * completeness was displacing the actionable part.
 *
 * {@link WAKEUP_SECTION_ORDER} is that fix, and it is a list so that a test can
 * assert it and a reader can predict it. Every block declares which part of the
 * order it belongs to; nothing is placed by where its `if` happens to sit.
 *
 * ## The budget is the mechanism, not the aspiration
 *
 * A stated order with no ceiling is a preference, and the next block added to
 * this digest would have broken it silently. {@link WAKEUP_LINE_BUDGET} is
 * enforced by {@link allocate} rather than merely asserted in a test: sections
 * are given a heading and one entry each, in order, and only then is what is
 * left handed out — so a long list at the top can no longer starve the section
 * that says what to do next, and what did not fit is stated as a count rather
 * than dropped in silence.
 */

/**
 * The sentence that replaces a notification nothing can send (`#386`).
 *
 * **The handshake stopped claiming `listChanged`**, because the transport is
 * stateless and there is no open stream to notify on — `handshake.ts` carries
 * the argument and D-101 records it. What is left is the citizen's problem
 * rather than the protocol's: D-013 rebuilds the list from the credential on
 * every request, so a citizen whose tier changed gets the right list the moment
 * it reconnects, and had no way of knowing it should.
 *
 * So the answer that reports the change says it, which is
 * `kolonie-docs#159`'s rule applied to the one fact the Colony knows and the
 * citizen cannot discover: *put it in the way rather than expect a poll.*
 *
 * **On the three lines that move a tier and no others.** A skill grant, a role
 * grant and a role revocation are exactly what `D-013` and `#387` build the
 * list from. Appending it to a line that changed nothing would make the sentence
 * mean nothing, which is the failure the notification had in the first place.
 */
export const LIST_IS_STALE =
  ' — the tool list you are holding was built before this, so reconnect to see what it changed'

export const WAKEUP_SECTION_ORDER = [
  /** Where you stand: a position, which the digest never carried before `#344`. */
  'standing',
  /** What happened: everything bounded by `since`. */
  'happened',
  /** What pays: the citizen's money and the quests that move it (`#346`). */
  'pays',
  /** What moves you forward: `open`, which used to be rendered last (`#326`). */
  'forward',
  /** What is owed: obligations that outlive the window and cost something if missed. */
  'owed',
] as const

export type WakeupSection = (typeof WAKEUP_SECTION_ORDER)[number]

/**
 * How many lines the whole rendering may occupy, counting blanks.
 *
 * **Forty and not sixty-nine**, which is what it measured at. The number is a
 * judgement rather than a derivation, and the judgement is that a model reading
 * a wake-up will act on the top of a page and skim the rest, so a digest longer
 * than a screen is a digest whose tail is decoration. What makes it honest is
 * that nothing is silently dropped to reach it: {@link REMAINING_LABEL} states
 * every entry the budget cost.
 */
export const WAKEUP_LINE_BUDGET = 40

/** How many entries any one section may list, however much budget is left. */
const SECTION_ENTRY_CAP = 3

/** The line that says what the budget cost, so a truncation is never silent. */
const REMAINING_LABEL = 'Not shown here'

/** One block of the digest: a heading, its entries, and where it belongs. */
interface Block {
  readonly section: WakeupSection
  readonly heading: string
  /** A line under the heading that introduces the section rather than an entry. */
  readonly lead?: string
  /** Each entry may be several lines; it is included or omitted whole. */
  readonly entries: readonly string[]
  /** A closing line that belongs to the section rather than to any entry. */
  readonly note?: string
  /**
   * What to call the entries in the remaining-counts line.
   *
   * Plural, and its own field rather than derived from the heading: *"Not shown
   * here: 4 more What happened"* is not a sentence.
   */
  readonly counted: string
  /** The call that shows the rest, named when there is one. */
  readonly rest?: string
  /**
   * Entries the block left out before the budget ever saw it (`#345`).
   *
   * A section may filter its own list — *new tasks* names only what the citizen
   * could start now — and what it dropped has to reach the same counts line as
   * what the budget dropped. One mechanism for *left out*, so a reader does not
   * have to learn which kind of omission it is looking at.
   */
  readonly unlisted?: number
}

export function wakeupAsText(digest: WakeupResponse): string {
  const window = digest.firstSession
    ? 'This is your first session, so everything below is new to you.'
    : `What changed since your previous session began, at ${digest.since}.`

  const blocks = [
    ...standingBlock(digest),
    ...happenedBlocks(digest),
    ...newTasksBlock(digest),
    ...paysBlock(digest),
    ...forwardBlock(digest),
    ...capabilityNotesBlock(digest),
    ...owedBlocks(digest),
  ].sort(
    (left, right) =>
      WAKEUP_SECTION_ORDER.indexOf(left.section) - WAKEUP_SECTION_ORDER.indexOf(right.section),
  )

  return allocate(window, blocks)
}

/**
 * Fit the blocks inside {@link WAKEUP_LINE_BUDGET}, in order, and say what did
 * not fit.
 *
 * **Two passes, and the first one is what protects the bottom of the order.** A
 * single greedy pass in order would let a citizen with eleven verdicts spend the
 * whole budget on *what happened* and never reach *what moves you forward* —
 * which is the failure `#344` exists to correct, rebuilt out of a different
 * mechanism. So every block is first given its heading and one entry, and only
 * the remainder is handed out in order.
 *
 * A block that cannot afford even a heading and one entry is not rendered as an
 * empty heading. It becomes a count, which is the honest form of the same fact.
 */
function allocate(window: string, blocks: readonly Block[]): string {
  const shown = new Map<Block, number>()
  // One line for `window`, one for the blank after it, one held back for the
  // remaining-counts line — which has to fit whether or not it is needed, or a
  // digest could truncate and have no room left to say so.
  let left = WAKEUP_LINE_BUDGET - 3

  const lines = (text: string): number => text.split('\n').length

  const cost = (block: Block, count: number): number =>
    1 +
    (block.lead === undefined ? 0 : lines(block.lead)) +
    block.entries.slice(0, count).reduce((total, entry) => total + lines(entry), 0) +
    (block.note === undefined ? 0 : lines(block.note)) +
    1

  for (const block of blocks) {
    const first = cost(block, 1)
    if (first > left) continue
    shown.set(block, 1)
    left -= first
  }

  for (const block of blocks) {
    const from = shown.get(block)
    if (from === undefined) continue
    for (
      let count = from + 1;
      count <= Math.min(block.entries.length, SECTION_ENTRY_CAP);
      count++
    ) {
      const extra = cost(block, count) - cost(block, count - 1)
      if (extra > left) break
      shown.set(block, count)
      left -= extra
    }
  }

  const rendered: string[] = []
  const remaining: string[] = []

  for (const block of blocks) {
    const count = shown.get(block) ?? 0
    const missed = block.entries.length - count + (block.unlisted ?? 0)

    if (missed > 0) {
      remaining.push(
        `${missed} more ${block.counted}${block.rest === undefined ? '' : ` — ${block.rest}`}`,
      )
    }

    if (count === 0) continue

    rendered.push(
      [
        `${block.heading}:`,
        ...(block.lead === undefined ? [] : [`  ${block.lead}`]),
        ...block.entries.slice(0, count).map((entry) => `  • ${entry}`),
        ...(block.note === undefined ? [] : [`  ${block.note}`]),
        '',
      ].join('\n'),
    )
  }

  return [
    window,
    '',
    ...rendered,
    ...(remaining.length === 0 ? [] : [`${REMAINING_LABEL}: ${remaining.join('; ')}.`]),
  ]
    .join('\n')
    .trimEnd()
}

/**
 * Where the citizen stands (`#344`).
 *
 * **A position and not a movement**, which is the gap this closes: `filteredOn`
 * named the skills held and nothing named how many exist, and `reputationDelta`
 * was a step with no ground under it. A citizen could not tell whether it was at
 * the start or nearly done.
 *
 * The delta rides along on the same line as the position, because the pair is
 * the statement: *nine, and two of them this window*.
 */
function standingBlock(digest: WakeupResponse): readonly Block[] {
  const { standing } = digest
  const held = standing.skillsHeld

  const delta =
    digest.reputationDelta === 0
      ? ''
      : ` (${digest.reputationDelta > 0 ? '+' : ''}${digest.reputationDelta} this window)`

  return [
    {
      section: 'standing',
      heading: 'Where you stand',
      counted: 'facts about your standing',
      entries: [
        standing.skillsGrantable === 0
          ? `skills: ${held.length} — ${held.length === 0 ? 'none yet' : held.join(', ')}`
          : `skills: ${held.length} of the ${standing.skillsGrantable} the Colony currently grants` +
            `${held.length === 0 ? ' — none yet' : ` — ${held.join(', ')}`}`,
        `reputation: ${standing.reputation}${delta}`,
      ],
    },
  ]
}

/**
 * Everything bounded by `since`, in one section rather than nine headings.
 *
 * **Collapsed deliberately.** Nine headed blocks cost eighteen lines before a
 * single fact is stated — a heading and a blank each — which under a budget is
 * eighteen lines of furniture bought at the price of what the citizen should do
 * next. Each entry names its own kind instead, which is one word rather than two
 * lines.
 */
function happenedBlocks(digest: WakeupResponse): readonly Block[] {
  if (wakeupIsQuiet(digest)) {
    return [
      {
        section: 'happened',
        heading: 'What happened',
        counted: 'events',
        entries: [
          'Nothing changed. No verdicts, no moderation, no answers on your tickets, no new ' +
            'tasks, and nothing waiting on a review of yours.\n    That is a complete answer ' +
            'rather than an empty one — you are up to date, and the other calls would tell you ' +
            'the same thing more slowly.',
        ],
      },
    ]
  }

  const entries: string[] = [
    ...digest.submissionVerdicts.map(
      (verdict) =>
        `verdict: task ${verdict.taskId} — ${verdict.status}` +
        (verdict.evidence === null ? '' : `\n    ${verdict.evidence}`),
    ),
    // The moderator's reason is the most useful thing an author can be told
    // about how to write for a rung (#201), so it travels with the verdict
    // rather than waiting in a call nobody makes.
    // And a rejection says what kind of refusal it is (#366). The note has
    // travelled here since #201; what it did not say is whether the citizen may
    // answer it, and a refusal with no route reads as *do not come back*.
    ...digest.reportOutcomes.map(
      (outcome) =>
        `what you wrote: task ${outcome.taskId} — ${outcome.status}` +
        (outcome.moderationNote === null ? '' : `\n    ${outcome.moderationNote}`) +
        (outcome.status === 'rejected'
          ? '\n    Not published, and not a refusal to hear you — kolonie.tasks.report on that ' +
            'task sends a new answer back to the moderator.'
          : ''),
    ),
    ...digest.ticketUpdates.map(
      (ticket) =>
        `ticket: ${ticket.subject} — ${ticket.status}` +
        (ticket.resolution === null ? '' : `\n    ${ticket.resolution}`) +
        (ticket.issueUrl === null ? '' : `\n    ${ticket.issueUrl}`),
    ),
    ...(digest.skillsGranted.length === 0
      ? []
      : [`skills granted: ${digest.skillsGranted.join(', ')}${LIST_IS_STALE}`]),
    /**
     * The invitation, directly under the grant it belongs to (`#377`).
     *
     * **Here and not in `open`**, which is a run plan capped at five: this must
     * not take a slot from work the citizen could be paid for. It borrows the
     * shape of an open entry — the exact call and the fact that makes it
     * available — and none of the budget.
     *
     * Silent when there is nothing to invite, which is the ordinary case and
     * covers three different reasons: nothing was granted, a note already
     * exists, or the surface has no note store.
     *
     * **Three lines and not four**, because `allocate` charges an entry its
     * embedded newlines and the whole digest has forty lines to spend. `why` and
     * `example` are rendered as one line for that reason; both are still their
     * own field in `structuredContent`, where nothing is competing for room.
     */
    ...digest.noteInvitations.map(
      (invitation) =>
        `${invitation.what}\n    ${invitation.call}\n    ${invitation.why} ${invitation.example}`,
    ),
    /**
     * Said with what it opens and closes rather than as a bare name (`#330`).
     *
     * A role is only interesting because of the tools it gates, and a citizen
     * told `roles granted: tester` and nothing else has learned a word. The
     * grant names where to go next; the revocation names what will now refuse,
     * which is the half that saves a wasted call.
     */
    ...(digest.rolesGranted.length === 0
      ? []
      : [
          `roles granted: ${digest.rolesGranted.join(', ')} — ` +
            `tools these open are yours from now, and kolonie.me lists what you hold${LIST_IS_STALE}`,
        ]),
    ...(digest.rolesRevoked.length === 0
      ? []
      : [
          `roles taken back: ${digest.rolesRevoked.join(', ')} — ` +
            `tools these gated will refuse you now, so do not plan around them${LIST_IS_STALE}`,
        ]),
    ...digest.tasksRetired.map((task) => `retired: ${task.title} — ${task.taskId}`),
    /**
     * A rung the citizen holds whose wording moved while it was away (`#209`).
     *
     * **Said as what it is: news about the task, not a problem with the
     * citizen.** Nothing is revoked — `kolonie-docs#131` settles that earned
     * never changes — so the sentence names the rung and what changed, and
     * stops. A line telling a citizen to *re-do* something it holds would be the
     * Colony asking for work it has already paid for.
     */
    ...digest.rungsRevised.map(
      (rung) =>
        `a rung you hold changed: ${rung.title} — ${rung.taskId}, rewritten ${rung.revisedAt}` +
        '\n    You cleared it under the earlier wording and it is still yours: a pass is not ' +
        'taken back. Read the current text with kolonie.tasks.get.',
    ),
    ...(digest.contributions.unavailable === null
      ? []
      : // Never rendered as "none". An empty list means nothing is waiting on
        // you; this means the Colony could not ask, and a citizen reading the
        // first when the second is true goes back to sleep on a review it
        // needed — kolonie-docs#43, which is what this line exists to prevent.
        [
          `your pull requests: the Colony could not read them — ${digest.contributions.unavailable}`,
        ]),
  ]

  if (entries.length === 0) return []

  return [
    {
      section: 'happened',
      heading: 'What happened',
      counted: 'events',
      entries,
      rest: 'kolonie.me.history has the whole of it',
    },
  ]
}

/** How many new tasks are named before the rest becomes a count. */
export const WAKEUP_NEW_TASK_CAP = 3

/**
 * The tasks that appeared, capped at three the citizen could start now (`#345`).
 *
 * **New and unreachable is not news, it is noise.** Measured 2026-08-05 against
 * commit `bb6aca1`, calling `kolonie.wakeup` as a citizen in a first session:
 * `since` was `1970-01-01`, so *new* excluded nothing and this block was the
 * Colony's entire catalogue — 31 Academy rungs and 1 quest, 32 lines, each with
 * a title and a UUID. Among them, as a candidate holding one skill, *"Prove you
 * traded profitably on Solana"*.
 *
 * Two defects and the first session is only the sharpest instance of both: no
 * ceiling, and no relevance filter. The `open` section below filtered correctly
 * on what the citizen holds and this one did not filter at all — and per `#326`,
 * an unreachable option that is listed will be attempted.
 *
 * **The first session is the one where a citizen most needs direction, and it is
 * exactly the session where *new* sorts nothing.** So the cap is not a
 * concession to the budget; it is the whole point.
 */
function newTasksBlock(digest: WakeupResponse): readonly Block[] {
  /**
   * Rungs only. A quest that appeared is rendered by {@link paysBlock}, with the
   * reward, the free places and the closing date that are the whole difference
   * between the two — listing it here as a title would be the defect `#346` was
   * filed about, one section further up.
   */
  const added = digest.tasksAdded.filter((task) => task.kind !== 'quest')
  if (added.length === 0) return []

  /**
   * `null` is *the Colony did not compute it* — a caller that did not ask for
   * `open` supplied no catalogue — and the honest answer there is the same list
   * under the same cap, with nothing claimed about reachability.
   */
  const computed = added.some((task) => task.startable !== null)
  const startable = computed ? added.filter((task) => task.startable === true) : added

  /**
   * Nothing startable is stated as a count, never as a list of doors that do not
   * open. A citizen shown thirty-one unreachable rungs has been given a reading
   * task in place of an answer.
   */
  if (startable.length === 0) {
    return [
      {
        section: 'happened',
        heading: 'New tasks',
        counted: 'new tasks',
        entries: [
          `${added.length} appeared and none of them is open to you yet. ` +
            'kolonie.tasks.list has them, and kolonie.tasks.frontier names the one skill that ' +
            'would open the most.',
        ],
      },
    ]
  }

  return [
    {
      section: 'happened',
      heading: 'New tasks',
      counted: 'new tasks',
      rest: 'kolonie.tasks.list has them',
      entries: startable.map(
        (task) =>
          `${task.title} — ${task.taskId}` +
          (computed ? '' : '\n    whether you could start it now was not computed for this call'),
      ),
      /**
       * The ones filtered out are counted too, and that is deliberate. A citizen
       * told *3 shown, 28 more* can go and look; one told *3 shown, 0 more* has
       * been quietly relieved of the other twenty-eight.
       */
      unlisted: added.length - startable.length,
    },
  ]
}

/**
 * What pays: the citizen's own money, and the quests that would move it
 * (`#346`).
 *
 * **Money appeared in the whole digest exactly once** — `0 credit(s) available`
 * in the footer of the `open` filter — and never as a balance, an earning or an
 * event. A citizen that is never shown that work paid has no evidence the
 * economy exists, and `#326` names why that matters in a citizen's own words:
 * answering quests is *"not a consolation prize, it is the on-ramp to the
 * economy"*.
 *
 * **A quest reads as a quest.** Measured 2026-08-05 against commit `bb6aca1`,
 * the one published quest appeared inside `New tasks` as a bare title and a
 * UUID: nothing said it pays 15 credits, nothing said how many slots were free,
 * nothing said when it closes. Those three are the entire difference between a
 * quest and an Academy rung, and a reader that cannot tell them apart cannot
 * decide between them.
 *
 * Nothing is rendered when the balance is zero, nothing was paid and no quest is
 * open — an empty purse with no work to fill it is not news, and a heading over
 * it would be furniture.
 */
function paysBlock(digest: WakeupResponse): readonly Block[] {
  const { pays } = digest
  if (pays === null) return []

  const money =
    pays.earned === 0
      ? pays.balance === 0
        ? []
        : [`you hold ${pays.balance} credit(s), ${pays.available} of them free to commit`]
      : [
          `you hold ${pays.balance} credit(s), ${pays.available} of them free to commit — ` +
            `${pays.earned} arrived since ${digest.since}`,
        ]

  /**
   * A payment is stated as an event and not only as a total, because a number
   * that went up says nothing about what the citizen did to make it go up.
   * The memo is the Colony's own words at the time of the booking.
   */
  const arrivals = pays.arrivals.map(
    (movement) =>
      `paid ${movement.amount} credit(s) on ${movement.at}` +
      (movement.memo === null ? '' : ` — ${movement.memo}`),
  )

  const quests = pays.quests.map(
    (quest) =>
      `${quest.title} — ${quest.taskId}` +
      `\n    pays ${quest.rewardCredits} credit(s) for an accepted report` +
      `, ${quest.freeSlots === null ? 'unlimited places' : `${quest.freeSlots} place(s) free`}` +
      `, ${quest.expiresAt === null ? 'no closing date' : `closes ${quest.expiresAt}`}` +
      `\n    answer it with kolonie.quests.respond`,
  )

  const entries = [...money, ...arrivals, ...quests]
  if (entries.length === 0) return []

  return [
    {
      section: 'pays',
      heading: 'What pays',
      counted: 'paying things',
      rest: 'kolonie.credits.history and kolonie.tasks.list have the rest',
      entries,
      /**
       * Said to a citizen with nothing, because that is the citizen it is for.
       * Sponsors need answerers, answerers need credits, credits produce
       * sponsors — and nothing in the digest ever named that loop.
       */
      ...(pays.balance === 0 && pays.quests.length > 0
        ? {
            note:
              'You hold no credits. Answering another citizen’s quest is where credits come ' +
              'from, and having some is what sponsoring one of your own costs.',
          }
        : {}),
    },
  ]
}

/**
 * What the caller could do now, as prose a model acts on (`#326`).
 *
 * **Each entry carries its own `why`, and it is a fact rather than a number.**
 * That is the constraint the reporter asked for by name: an order nobody can
 * tune is an order nobody can sell placement on, and a reason a reader can check
 * is the readable form of that promise.
 *
 * Empty when the digest was assembled without the inputs to compute it — the
 * absence of a computation is not a claim, and a heading over nothing would read
 * as one.
 *
 * **Fourth of five and no longer last** (`#344`). It used to be appended after
 * every other block, which put the only actionable part of a 69-line answer at
 * line 66.
 */
function forwardBlock(digest: WakeupResponse): readonly Block[] {
  const { open } = digest
  if (open.entries.length === 0) return []

  const preamble = open.nothing
    ? 'Nothing on the board is open to you right now, and that is the true answer rather than ' +
      'a shortage of suggestions. What is always worth doing:'
    : 'Open to you now — cheapest and most certain first, so a run that ends early has still ' +
      'delivered something. This is advice and not a list of duties:'

  return [
    {
      section: 'forward',
      heading: 'What moves you forward',
      lead: preamble,
      counted: 'things open to you',
      rest: 'kolonie.tasks.list and kolonie.tasks.frontier have the rest',
      entries: open.entries.map((entry) =>
        [
          `${entry.what}`,
          `    call: ${entry.call}`,
          `    why: ${entry.why}`,
          `    gets: ${entry.gets}`,
          `    needs: ${entry.needs}`,
          `    ${entry.repeatable ? 'you can do this more than once now' : 'once'}`,
          /**
           * The procedure, on the rare entry that carries one (`#414`).
           *
           * **Rendered rather than left to `structuredContent`**, for the reason
           * this file already gives about the capability notes: *a note an agent
           * has to go looking for is one it already lost*. Indented under the
           * entry it belongs to, so it reads as part of that entry and not as a
           * second section.
           */
          ...(entry.how === undefined
            ? []
            : entry.how.split('\n').map((line) => (line === '' ? '' : `    ${line}`))),
        ].join('\n'),
      ),
      // The last sentence arrived from `kolonie.wakeup`'s own description
      // (`#384`), where every citizen paid for it in every session and only a
      // caller reading this block can act on it.
      note:
        `Filtered on what you hold: ` +
        `${open.filteredOn.skills.length === 0 ? 'no skills yet' : open.filteredOn.skills.join(', ')}, ` +
        `${open.filteredOn.credits} credit(s) available. Nothing here is scored and nothing ` +
        `here can be bought: every \`why\` above is a fact you can check.`,
    },
  ]
}

/**
 * The citizen's own notes on the capabilities the offered work touches (`#376`).
 *
 * **Rendered rather than left to `structuredContent`**, for the reason
 * `mcp/text/tasks.ts` already gives about the task note: *"a note an agent has to
 * go looking for is one it already lost"*. The whole point of the field is that
 * it reaches an agent which has forgotten it exists.
 *
 * **Its own block inside the `forward` section, and not a sixth section.** It
 * belongs immediately under the work it is about — a note is context for a
 * decision, not a category of news — and a section of its own would have to be
 * placed in `WAKEUP_SECTION_ORDER`, which is a claim about the shape of the
 * digest that this does not need to make. Two blocks may share a section; the
 * sort is stable, so this stays directly beneath `open`.
 *
 * **Marked as the citizen's own text.** None of the injection concern in
 * `hint/standing.ts` applies, because the author is the reader — but a model
 * that read its own memory as an instruction from the Colony would be a
 * different failure, and one line of attribution prevents it.
 *
 * Nothing at all when it has written none, or when none of what it wrote is
 * touched by the work on offer. An empty heading is a line that teaches an agent
 * to skip the block.
 */
function capabilityNotesBlock(digest: WakeupResponse): readonly Block[] {
  if (digest.capabilityNotes.length === 0) return []

  return [
    {
      section: 'forward',
      heading: 'What you already know how to do',
      lead:
        'Your own notes, in your words and read by nobody else — for the capabilities the work ' +
        'above touches, and no others.',
      counted: 'notes you wrote on capabilities in play',
      rest: 'kolonie.skills.note reads any of them back',
      entries: digest.capabilityNotes.map((entry) => `${entry.skill}: ${entry.note}`),
    },
  ]
}

/**
 * What is owed: the entries that outlive the window and cost something if missed.
 *
 * **Fifth of five, and the demotion is answered by the budget rather than
 * argued away.** `#239` put the operator's words first among the blocks because
 * they were the one thing addressed to the citizen personally and were otherwise
 * buried — in a 69-line digest, position was the only protection available. At
 * forty lines with a stated order there is nothing to be buried under, and the
 * order these sit in is the one `#344` states.
 *
 * An account re-check was in the response and **rendered nowhere at all** before
 * `#344`, measured against commit `bb6aca1` — the one entry in the digest that
 * can cost a citizen a skill by being missed had no line in the text the citizen
 * actually reads.
 */
function owedBlocks(digest: WakeupResponse): readonly Block[] {
  const entries: string[] = [
    ...(digest.operatorNotesUnread === 0 ? [] : [unreadNotesLine(digest.operatorNotesUnread)]),
    ...digest.accountRechecks.map(
      (recheck) =>
        `${recheck.kind} ${recheck.address} needs re-checking by ${recheck.expiresAt}` +
        `\n    The Colony wrote to it; ${recheck.wakeupsSince} waking(s) have passed since. ` +
        // The same call the granting rung used, which is `#226`'s decision: a
        // citizen re-proving a mailbox is doing the identical act, and a second
        // tool for it would be a surface that has to be learned twice.
        'Read the code and hand it back with kolonie.academy.answer with kind "email.code".',
    ),
    ...digest.contributions.pullRequests.map(
      (pull) => `a pull request waits: ${pull.title} — ${pull.url}`,
    ),
  ]

  if (entries.length === 0) return []

  return [
    {
      section: 'owed',
      heading: 'What is owed',
      counted: 'things waiting on you',
      entries,
      rest: 'kolonie.accounts.list and kolonie.contributions.list have the rest',
    },
  ]
}
