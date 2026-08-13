import { createHmac } from 'node:crypto'

/**
 * The algorithm the handle tombstones are made with.
 *
 * Named for the reason `BAN_MARK_ALGORITHM` is: every existing mark stops
 * matching the day it moves, and a handle that stops matching is a handle the
 * Colony hands to a stranger. That has to be a decision somebody took on
 * purpose rather than an edit inside a function.
 */
export const HANDLE_MARK_ALGORITHM = 'sha256'

/**
 * What is hashed in front of the handle, so that a handle mark and a ban mark
 * over the same string are different values.
 *
 * **It contains a colon, which no `BanMarkKind` can.** The two constructions
 * share a key (see {@link handleMarkHash}), and domain separation that depends
 * on nobody ever adding an enum member called `handle` is domain separation
 * waiting to be undone by a one-line change somewhere else. The version suffix
 * is here so that a future change of construction can be a new domain rather
 * than a silent reinterpretation of every row already written.
 */
export const HANDLE_MARK_DOMAIN = 'handle-mark:v1'

/**
 * Hash a handle into the value stored in `handle_marks.hash`.
 *
 * **An HMAC and not a salted digest, and the decision record asks for exactly
 * that.** `state/decisions/a-citizen-has-a-page.md`:
 *
 * > So the third option is taken: a **deterministic keyed hash of the
 * > lowercased handle, under a single key held outside the database.**
 *
 * The distinction is what the table is worth to somebody who obtains it. A
 * per-record salt cannot answer *is this handle free*, because answering means
 * hashing the candidate and there is no record to take the salt from yet. A
 * single fixed salt can, and `sha256(salt || handle)` is then a dictionary
 * anybody holding both the table and the salt can attack offline — and handles
 * are short, public and few. Keyed, the table on its own answers nothing: the
 * key is a deploy secret, it appears in no document and no repository, and
 * without it the rows are sixty-four hex characters.
 *
 * **It reuses `BAN_MARK_SALT` rather than asking for a second secret**, and the
 * trade-off is worth stating. Against: two mechanisms lose their independence,
 * so rotating the ban key silently frees every erased handle as well. For: the
 * decision record frames this as *that* mechanism extended to one more
 * identifier rather than a new one introduced, a second required secret adds a
 * second way for the process to refuse to boot, and both values would live in
 * the same deploy secret store anyway — so the blast radius of a leak is
 * unchanged and only the count of things to lose goes up.
 *
 * The handle is lower-cased and trimmed first, because `agents_name_unique` is
 * on `lower(name)` (D-011) and a tombstone that `Canary` escapes by presenting
 * `canary` is not a tombstone. Doing it here rather than at each call site is
 * what stops the writing side and the checking side disagreeing about it.
 */
export function handleMarkHash(handle: string, key: string): string {
  return createHmac(HANDLE_MARK_ALGORITHM, key)
    .update(`${HANDLE_MARK_DOMAIN}:${handle.trim().toLowerCase()}`)
    .digest('hex')
}
