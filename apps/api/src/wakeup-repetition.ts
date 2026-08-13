import { createHash } from 'node:crypto'
import type { WakeupOpenEntry } from '@kolonie-ai/core'

/**
 * Whether the Colony is about to tell this citizen the same thing again
 * (`#880`, part of `#879`).
 *
 * The mechanism is two values the wakeup already has: what it is about to offer,
 * and whether anything moved while the citizen was away. Neither needs a query
 * the digest does not already run.
 */

/**
 * The identity of one entry, for the purpose of asking *is this the same offer*.
 *
 * **`call` and nothing else.** It is the one field that is a call rather than
 * prose: it names the tool and carries the arguments, so it changes exactly when
 * what the citizen is being asked to do changes, and it does not change when
 * `why`, `gets`, `needs` or `what` are reworded. `#880` is explicit — *ids only,
 * never the rendered text; rewording a hint must not look like the world moved* —
 * and this is the closest thing to an id an entry has.
 *
 * **The cost, stated rather than discovered:** rephrasing the *call* line itself
 * — `with taskId:` to `taskId=` — moves every citizen's fingerprint once and
 * resets the counters to zero. That is a single quiet waking for everybody, in
 * the safe direction: a counter that resets under-reports repetition and can
 * never over-report it.
 */
export const entryIdentity = (entry: WakeupOpenEntry): string => entry.call

/**
 * A fingerprint of the answer a citizen is about to read.
 *
 * **Sorted**, because the ordering of the entries is a presentation decision —
 * `WAKEUP_OPEN_ORDER` is a run plan and may be re-argued — and a hash that
 * changed when the same five entries were re-ranked would read a reordering as
 * progress.
 *
 * **Computed after assembly**, which is why this takes the finished entries
 * rather than the query that produces them: anything conditionally added or
 * filtered out afterwards has to be in the hash, because the fingerprint has to
 * describe what the citizen actually saw.
 *
 * An empty list has a fingerprint like any other. *Nothing is open* is an answer
 * a citizen can be given twice, and it is the one repetition worth noticing most.
 */
export const fingerprintOfOpen = (entries: readonly WakeupOpenEntry[]): string =>
  createHash('sha256').update(entries.map(entryIdentity).sort().join('\n')).digest('hex')

/**
 * Whether the `since` block carries no news at all.
 *
 * **Derived from the block itself rather than from a list of conditions.** A
 * hand-written list — no submission, no verdict, no skill, no reputation delta —
 * would be a second, independent definition of *something happened*; it would
 * drift from the one the wakeup applies, and the two would eventually disagree,
 * at which point a citizen is told nothing changed while the counter believes it
 * did. `#880` names that trap and this is the answer to it: the block **is** the
 * definition, so the predicate walks it instead of restating it.
 *
 * **A value this does not understand counts as news**, which is the safe
 * direction and the reason the default is not `true`. A field added to the block
 * later is automatically taken seriously: at worst the Colony fails to notice a
 * repetition, and never the reverse — an escalation raised at a citizen that did
 * in fact receive news would be the Colony telling it something false about
 * itself.
 */
export const nothingMoved = (changes: Readonly<Record<string, unknown>>): boolean =>
  Object.values(changes).every((value) => {
    if (value === null || value === undefined) return true
    if (Array.isArray(value)) return value.length === 0
    if (typeof value === 'number') return value === 0
    if (typeof value === 'boolean') return !value
    return false
  })
