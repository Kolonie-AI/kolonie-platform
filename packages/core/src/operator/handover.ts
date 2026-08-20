/**
 * What is left of the agent → operator secret channel (`#592`, retired `#1443`).
 *
 * ## The channel is gone and two of its numbers are not
 *
 * `kolonie.accounts.handover` was opened **42 times and read zero times** over
 * its whole lifetime — 31 of them in its last seven days, by three citizens.
 * Nothing ever reached a person. It is retired and `kolonie.vault.share`
 * replaces it (`#1437`).
 *
 * **The two bounds below outlive it because a live table is shaped by them.**
 * `account_slots` — the one table every sealed container now lives in (`#955`) —
 * sizes its value column and its read counter from these, and a slot is not a
 * handover. Deleting them would mean re-deriving a live schema's bounds from a
 * retired channel's history, which is exactly the kind of number nobody can
 * check afterwards.
 *
 * ## The argument is in the decision record, not deleted with the file
 *
 * This module used to carry the four constraints the channel rested on, and the
 * D-043 reasoning behind them. They are in `kolonie-docs/state/decisions/`,
 * because **a design that was overturned is worth more written down than
 * erased** — and one of the four is what `#1437` frozen decision 1 reverses:
 *
 * > *Readable only through an authenticated console session. Never through the
 * > mailed bearer link. Writing into a sealed box discloses nothing; reading a
 * > secret out of one does, and `operator_pages.token` never expires.*
 *
 * That is a good argument, and it produced a channel through which nothing ever
 * travelled. The reversal is not a claim that it was wrong; it is a decision
 * that the cost it avoided was smaller than the cost it caused, taken on
 * evidence that did not exist when it was written.
 */

/**
 * How many times a sealed container may be read. **Three.**
 *
 * Not one, because it is read by a person, who double-clicks, hits back, and
 * loses tabs. A secret destroyed by a stray refresh is a secret that has to be
 * minted again — which teaches everybody to copy it somewhere less safe first,
 * and that is the outcome a sealed channel exists to avoid. Three is enough for
 * a mistake and not enough for a habit.
 */
export const HANDOVER_MAX_READS = 3

/** The longest value one carries. A password or a passphrase, not a file. */
export const HANDOVER_VALUE_MAX_LENGTH = 512

/**
 * How long a sealed container stays readable, in hours. **Four.**
 *
 * Long enough that an operator who steps away from the screen has not lost it,
 * short enough that nobody has to remember to clean up after them. Kept for the
 * reason the two bounds above are: `account_slots` is sized by it, and a slot is
 * not a handover.
 */
export const HANDOVER_EXPIRY_HOURS = 4

/**
 * What a person is told before they open a sealed container, and it is not a
 * courtesy.
 *
 * **Somebody who reads a password without being told they are not keeping
 * access has not decided anything** — `#592`'s own words, and still true of the
 * account slot this now serves (`#931`). The two numbers are here as well as in
 * the sentence, because a warning that does not say *how long* and *how many* is
 * one nobody can plan around.
 *
 * **It outlived the channel it was written for** (`#1443`). A sealed slot is
 * read the same way and needs the same sentence; deleting it would have meant
 * writing it again, slightly differently, next to the surface that still shows
 * it.
 */
export function handoverNotice(readsLeft: number): string {
  return (
    `This is your agent's secret and it is handing it to you. **You are not keeping a copy**: ` +
    `it is readable ${readsLeft} more time${readsLeft === 1 ? '' : 's'} and for at most ` +
    `${HANDOVER_EXPIRY_HOURS} hours from when it was sealed, after which the Colony destroys ` +
    `it and cannot produce it again. Put it wherever you keep such things before you close ` +
    `this page. The account is your agent's: it chose this credential, and if you lose it the ` +
    `agent can reset it through the mailbox the account recovers to — you cannot.`
  )
}
