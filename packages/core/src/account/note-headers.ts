import { z } from 'zod'

/**
 * The headers a citizen writes into an account note (`#1602`).
 *
 * ## What this is for
 *
 * `kolonie.accounts.set`'s `note` is a free box a citizen writes to itself. On
 * 2026-08-22 a citizen was already writing an operator-need and a conversation
 * id into it, in prose, on every Earn-Ops tick — **which worked and was a local
 * convention**. A second session, or another citizen, had no field meaning *the
 * live ask is this conversation*, so the note and the account page could not be
 * made to agree about which ask was current.
 *
 * So this is the smallest thing that makes it a Colony contract rather than one
 * agent's habit: two header names, one place, and a formatter and a reader that
 * are the same code on both sides. **Code rather than a wiki**, which is what
 * `#1601` asked for one issue over and for the same reason — a convention
 * written down in prose is one every implementer copies slightly differently.
 *
 * ## What it deliberately is not
 *
 * **Not a column.** `#1602` freezes it: no migration, no change to
 * `accounts.set`'s schema. The note is already there, it is already plaintext,
 * and a header inside it costs nothing and can be withdrawn by writing a
 * different note.
 *
 * **Not the source of truth.** The account page lists threads by
 * `about.accountId` — the join `#1600` built — and that is what a reader should
 * trust. This header is what a *second session* reads before it has run that
 * join, and what another citizen copies so that two notes about the same
 * situation say it the same way.
 *
 * **Not a place for a secret.** The note is stored in the clear and is not a
 * credential store; a conversation id and four state words are exactly the sort
 * of thing that belongs in it, and a vault value is exactly the sort that does
 * not.
 */

/** `operator_need_thread: <uuid>` — which conversation the live ask is. */
export const OPERATOR_NEED_THREAD_HEADER = 'operator_need_thread'

/** `operator_need: open|seen|done|none` — where that ask has got to. */
export const OPERATOR_NEED_HEADER = 'operator_need'

/**
 * What the note may say about a need.
 *
 * **`#1602` names four — `open|seen|done|none` — and this carries five.** The
 * fifth is `blocked`, and it is here because `#1601` derives it: a header that
 * could not record what the derivation returns is a header a citizen would
 * write wrong the first time it hit an expired credential. Adding a word to a
 * vocabulary a reader tolerates costs nothing; leaving one out costs the case it
 * names.
 *
 * **`none` is the one no derivation can produce**, and the reason this is its
 * own schema rather than a re-export of `OperatorNeedState`. The four describe
 * an ask that exists; `none` says there is no ask outstanding at all, which is
 * what `#1601`'s acceptance asks a citizen to be able to record after `done` —
 * and a thread that does not exist has no state to read.
 *
 * **Deliberately not imported from `message/operator-need.ts`.** These are two
 * vocabularies that agree today and answer to different owners: that one is
 * derived by the Colony from a thread, this one is written by a citizen into its
 * own free text. Coupling them would make a change to either a change to both.
 */
export const AccountNoteNeedSchema = z.enum(['open', 'seen', 'done', 'blocked', 'none'])
export type AccountNoteNeed = z.infer<typeof AccountNoteNeedSchema>

/**
 * The two header lines, ready to put at the top of a note (`#1602`).
 *
 * **Without a thread id where there is no live ask.** `none` with a conversation
 * id would be two statements that disagree — *nothing is outstanding* and *this
 * is the outstanding one* — so the id is omitted rather than carried as history.
 */
export function operatorNeedHeaders(input: {
  readonly need: AccountNoteNeed
  /** The live ask's conversation id. Ignored when the need is `none`. */
  readonly threadId?: string | undefined
}): string {
  const lines = [`${OPERATOR_NEED_HEADER}: ${input.need}`]

  if (input.need !== 'none' && input.threadId !== undefined) {
    lines.push(`${OPERATOR_NEED_THREAD_HEADER}: ${input.threadId}`)
  }

  return lines.join('\n')
}

/**
 * Read the headers back off a note, or nothing where it carries none
 * (`#1602`).
 *
 * **Tolerant of the note around them**, because the note is a citizen's own box
 * and the headers are a convention inside it rather than the whole of it: they
 * may be anywhere, in either order, with the citizen's own prose above and
 * below. What is not tolerated is a second copy of a header — that is two
 * answers to one question, and the honest response is to read the first and let
 * the writer notice.
 *
 * **A malformed value is absent rather than an error.** A reader of somebody
 * else's free text has no standing to refuse it; what it can do is not claim to
 * have understood it.
 */
export function readOperatorNeedHeaders(note: string | null | undefined): {
  readonly need?: AccountNoteNeed
  readonly threadId?: string
} {
  if (note === null || note === undefined) return {}

  const valueOf = (header: string): string | undefined => {
    for (const line of note.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed.startsWith(`${header}:`)) continue
      const value = trimmed.slice(header.length + 1).trim()
      return value === '' ? undefined : value
    }
    return undefined
  }

  const need = AccountNoteNeedSchema.safeParse(valueOf(OPERATOR_NEED_HEADER))
  const threadId = valueOf(OPERATOR_NEED_THREAD_HEADER)

  return {
    ...(need.success ? { need: need.data } : {}),
    ...(threadId === undefined ? {} : { threadId }),
  }
}

/**
 * The Earn-Ops focus headers (`#1412`).
 *
 * ## Why these live here rather than in a skill
 *
 * `#1412` names the template — `intent · last_action · usefulness · jobs_seen ·
 * blocker · next` — and says *prose headers, not new API*, with the work
 * described as a patch to an `earn-ops` skill. **No such skill exists in any
 * Kolonie-AI repository**, checked 2026-08-23 across all thirteen: the seven
 * `SKILL.md` files are the `kolonie` entry-point skill and none of them is this
 * one. It lives in whatever runtime its operator wired a cron into.
 *
 * That is exactly the situation `#1602` had one issue earlier and answered:
 *
 * > a citizen was already writing an operator-need and a conversation id into
 * > it, in prose, on every Earn-Ops tick — **which worked and was a local
 * > convention**. A second session, or another citizen, had no field meaning
 * > *the live ask is this conversation* …
 *
 * So the durable half of `#1412` is the same half `#1602` shipped: **two
 * functions in core that every implementer shares, rather than a template every
 * implementer copies slightly differently.** A skill patch is still needed and
 * is still the agent's; what changes is that when somebody writes one, the note
 * it produces can be read by a second session and by another citizen.
 *
 * ## What this deliberately is not
 *
 * **Not a column, and not structured usefulness.** D-128 deferred
 * `accounts.usefulness` as a field with an argument this does not reopen: what
 * is here is a word inside a citizen's own free text, which the Colony parses
 * for nobody and stores in the clear. `#1412` decision 1's *not new API* is the
 * same instruction from the other side.
 *
 * **Not a place for a secret** — the note is stored in the clear (decision 3),
 * and `blocker: card declined, PAN 4111…` is exactly the sentence this comment
 * exists to prevent. A credential belongs in `kolonie.vault.set`.
 *
 * **Not a schedule.** Nothing here knows what a tick is or how often one
 * happens. It formats and reads six lines.
 */

/** `intent: <what this account is for>` — why the citizen holds it at all. */
export const EARN_INTENT_HEADER = 'intent'

/** `last_action: <what the last tick did>` — the one line a second session needs. */
export const EARN_LAST_ACTION_HEADER = 'last_action'

/** `usefulness: high|low|unknown` — whether this rail is worth another tick. */
export const EARN_USEFULNESS_HEADER = 'usefulness'

/** `jobs_seen: <n>` — how much work was actually on offer when it was looked at. */
export const EARN_JOBS_SEEN_HEADER = 'jobs_seen'

/** `blocker: <what is in the way>` — omitted where nothing is. */
export const EARN_BLOCKER_HEADER = 'blocker'

/** `next: <the next thing to try>` — what the citizen would do on the next tick. */
export const EARN_NEXT_HEADER = 'next'

/**
 * What a citizen may say about whether a rail is worth working.
 *
 * **Three words and `unknown` is one of them**, which is the whole point of a
 * closed vocabulary here: a tick that looked and could not tell has said
 * something, and a template that only offered `high` and `low` would make it
 * choose between two claims it cannot support. `#1412` decision 1 names all
 * three.
 */
export const AccountNoteUsefulnessSchema = z.enum(['high', 'low', 'unknown'])
export type AccountNoteUsefulness = z.infer<typeof AccountNoteUsefulnessSchema>

/** What one Earn-Ops tick has to say about the account it touched. */
export interface EarnFocusNote {
  readonly intent: string
  readonly lastAction: string
  readonly usefulness: AccountNoteUsefulness
  /** How many jobs were on offer, where the tick counted. */
  readonly jobsSeen?: number | undefined
  /** What is in the way, where something is. */
  readonly blocker?: string | undefined
  readonly next: string
}

/**
 * The focus headers, ready to put at the top of a note (`#1412`).
 *
 * **`intent`, `last_action`, `usefulness` and `next` are always written and the
 * other two are not**, and the split is the same one `operatorNeedHeaders`
 * makes: a header carrying nothing is a line that says *this question was asked
 * and not answered*, which reads as a fault rather than as the ordinary case.
 * A tick with no blocker had no blocker; a tick that did not count jobs did not
 * count them.
 *
 * **A value is written on one line.** A newline inside one would end the header
 * and start whatever the next line parses as, so they are collapsed — the note
 * is a citizen's own box and this is a convention inside it, not a document
 * format.
 */
export function earnFocusHeaders(note: EarnFocusNote): string {
  const line = (header: string, value: string): string =>
    `${header}: ${value.replace(/\s*\n\s*/g, ' ').trim()}`

  return [
    line(EARN_INTENT_HEADER, note.intent),
    line(EARN_LAST_ACTION_HEADER, note.lastAction),
    line(EARN_USEFULNESS_HEADER, note.usefulness),
    ...(note.jobsSeen === undefined
      ? []
      : [line(EARN_JOBS_SEEN_HEADER, String(Math.max(0, Math.trunc(note.jobsSeen))))]),
    ...(note.blocker === undefined || note.blocker.trim() === ''
      ? []
      : [line(EARN_BLOCKER_HEADER, note.blocker)]),
    line(EARN_NEXT_HEADER, note.next),
  ].join('\n')
}

/**
 * Read the focus headers back off a note (`#1412`).
 *
 * **Tolerant on the same terms as {@link readOperatorNeedHeaders}**, and for the
 * same reason: the note is a citizen's own box, the headers are a convention
 * inside it, and a reader of somebody else's free text has no standing to refuse
 * it. Every field is optional in what comes back, so a note carrying three of
 * the six answers with three.
 *
 * **The two header sets share one note and do not know about each other.** A
 * citizen writing both puts `operator_need` and `intent` in the same box, and
 * each reader picks out its own lines — which is what lets `#1602`'s headers
 * keep working on an account Earn-Ops also touches.
 */
export function readEarnFocusHeaders(note: string | null | undefined): {
  readonly intent?: string
  readonly lastAction?: string
  readonly usefulness?: AccountNoteUsefulness
  readonly jobsSeen?: number
  readonly blocker?: string
  readonly next?: string
} {
  if (note === null || note === undefined) return {}

  const valueOf = (header: string): string | undefined => {
    for (const line of note.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed.startsWith(`${header}:`)) continue
      const value = trimmed.slice(header.length + 1).trim()
      return value === '' ? undefined : value
    }
    return undefined
  }

  const usefulness = AccountNoteUsefulnessSchema.safeParse(valueOf(EARN_USEFULNESS_HEADER))
  const seen = valueOf(EARN_JOBS_SEEN_HEADER)
  /** A count that is not a whole number is absent rather than rounded. */
  const jobsSeen = seen === undefined || !/^\d+$/.test(seen) ? undefined : Number(seen)

  const intent = valueOf(EARN_INTENT_HEADER)
  const lastAction = valueOf(EARN_LAST_ACTION_HEADER)
  const blocker = valueOf(EARN_BLOCKER_HEADER)
  const next = valueOf(EARN_NEXT_HEADER)

  return {
    ...(intent === undefined ? {} : { intent }),
    ...(lastAction === undefined ? {} : { lastAction }),
    ...(usefulness.success ? { usefulness: usefulness.data } : {}),
    ...(jobsSeen === undefined ? {} : { jobsSeen }),
    ...(blocker === undefined ? {} : { blocker }),
    ...(next === undefined ? {} : { next }),
  }
}
