import { z } from 'zod'

/**
 * Where an operator-need has got to (`#1601`).
 *
 * ## The need is the thread, and this is read off it
 *
 * `#1601` freezes it: **no `todos` table and no second board.** A citizen asks
 * its operator for something by opening a thread, and what was missing was a
 * lifecycle the Earn-Ops tick could branch on without parsing prose. So this is
 * four words derived from facts the thread already carries, stored nowhere, and
 * recomputed on every read — the same arrangement `conversationKind` is in, and
 * for the same reason: a status column would be a second answer to a question
 * the thread already answers, and the two would disagree the first time somebody
 * replied without updating it.
 *
 * ## Why the four
 *
 * They lead to four different next moves, which is the test for whether a state
 * deserves a name. `open` — ask again later, or ask better. `seen` — it
 * arrived; waiting is the right thing to do. `done` — stop reminting the ask.
 * `blocked` — the ask is dead and something has to change before it is worth
 * making again.
 *
 * ## What is deliberately not read
 *
 * **The person's message read cursor**, which `#1601` names first in its
 * preferred derivation. `kolonie.messages.mark_read` promises in as many words
 * that *nobody else is told (no read receipts)*, and `#1600` has just held the
 * neighbouring rule — that a citizen is told nothing about what a person did
 * with a thread, because it would read as *my operator has finished with me*.
 * Deriving `seen` from the cursor would break both.
 *
 * **A share's reads are a different fact and are already the sharer's.**
 * `kolonie.vault.unshare` tells the citizen *They opened it N times* today. A
 * citizen that put a credential in front of a person is entitled to know whether
 * the person opened it; that is the delivery of its own ask rather than a
 * receipt on somebody's reading habits.
 *
 * So `seen` rests on the share and never on the cursor, and a thread carrying no
 * share cannot reach `seen` — it goes `open` until the person replies. That is a
 * real limitation and the honest one: with no share and no reply there is
 * nothing the Colony knows.
 *
 * ## Why a reply is `done` and never `blocked`
 *
 * `#1601` lists *person said no* under `blocked`. Telling *no* from *done* means
 * reading the sentence, and clause 2 of that issue asks for a state the tick can
 * branch on **without parsing prose**. A reply is therefore `done` whatever it
 * says — the citizen reads the words itself and decides — and `blocked` is kept
 * for the one dead end that is structural rather than written: the credential
 * was offered, nobody ever opened it, and the offer has run out.
 */
export const OperatorNeedStateSchema = z.enum(['open', 'seen', 'done', 'blocked'])
export type OperatorNeedState = z.infer<typeof OperatorNeedStateSchema>

/** What the derivation reads. Every field is one the citizen may already see. */
export interface OperatorNeedFacts {
  /**
   * Whether the person has written anything into the thread.
   *
   * Not *what* — the citizen reads the message itself, and nothing here looks at
   * a body.
   */
  readonly personReplied: boolean
  /** The credential asks hanging on the thread, in any state. */
  readonly shares: readonly {
    /** How many times the person opened it. */
    readonly reads: number
    /** Whether they wrote something back into it. */
    readonly operatorWrote: boolean
    /** `null` while it is live. */
    readonly ended: 'taken-back' | 'expired' | null
  }[]
}

/**
 * Read the state off the thread (`#1601`).
 *
 * **The order of the branches is the whole of it**, so it is worth reading as a
 * sequence rather than as four independent rules:
 *
 * 1. **A person acted** — replied, or wrote into the credential box. `done`, and
 *    it outranks everything below because an answer settles the ask however the
 *    boxes ended up.
 * 2. **A person looked** — some share has been opened. `seen`, and *not* `done`:
 *    `#1601` asks for exactly this case to stay short of done, because a
 *    credential that was read and not acted on is a thing still waiting.
 * 3. **Every offer has run out unopened** — `blocked`. This is the *never
 *    silent-success* clause: an expired share nobody read must not read as
 *    though the ask had been answered, and it must not read as still waiting
 *    either, because nothing is going to happen now.
 * 4. Otherwise `open`.
 *
 * **A taken-back share counts as ended.** The citizen took it back itself, so
 * the offer is equally gone — and a thread whose only offer the citizen
 * withdrew, unread, is not one an Earn-Ops tick should keep waiting on.
 */
export function operatorNeedState(facts: OperatorNeedFacts): OperatorNeedState {
  if (facts.personReplied || facts.shares.some((share) => share.operatorWrote)) return 'done'
  if (facts.shares.some((share) => share.reads > 0)) return 'seen'
  if (facts.shares.length > 0 && facts.shares.every((share) => share.ended !== null)) {
    return 'blocked'
  }

  return 'open'
}
