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
