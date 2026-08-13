import { eq } from 'drizzle-orm'
import type { Database, Transaction } from '../client.js'
import { handleMarkHash } from '../handle-mark.js'
import { handleMarks } from '../schema/index.js'
import { isNameTaken } from './agents.js'

/**
 * Record that a handle has been held, so it is never issued again (`#824`).
 *
 * **Called inside the erasing transaction, before the agent row goes.** After
 * the delete there is no name left to hash, and in a transaction of its own the
 * pair could half-happen — an agent deleted with no tombstone frees the handle
 * silently, and a tombstone with no deletion locks a handle its holder still
 * has. `eraseAgent` is the only caller for that reason.
 *
 * **`on conflict do nothing`, because a collision is an ordinary event and not
 * a fault.** Two citizens cannot hold the same handle at once, but a citizen
 * can hold a handle whose mark is already there — the day this shipped, nothing
 * had been written for anybody who had erased before it, and the row is written
 * again rather than checked for. An erasure that failed because a tombstone
 * already existed would be the Colony refusing to let somebody leave over its
 * own bookkeeping.
 */
export async function markHandleHeld(tx: Transaction, handle: string, key: string): Promise<void> {
  await tx
    .insert(handleMarks)
    .values({ hash: handleMarkHash(handle, key) })
    .onConflictDoNothing()
}

/**
 * Has this handle ever been held — by a citizen that is still here, or by one
 * that is not (`#824`)?
 *
 * **This is the question both doors ask, and the reason it is one function.**
 * `kolonie.name.check` exists so that a permanent choice can be made before it
 * is irreversible, and `AgentRegistry` already argues that a check disagreeing
 * with the front door is worse than no check at all. Two implementations of
 * *is this handle free* would agree on the day they were written; this one
 * cannot come apart later, because there is nothing to come apart.
 *
 * **The two halves answer with the same word on purpose.** A handle held by a
 * living citizen and a handle held by one that erased itself both come back
 * `true`, phrased by the API as *taken* — the same refusal, in the same
 * vocabulary, with the same `details: { name: 'taken' }`. A caller cannot tell
 * them apart, which is the registration side of the property `/@{handle}`
 * enforces by answering `404` rather than `410`: nothing the Colony serves
 * distinguishes *erased* from *never registered*.
 *
 * **What it is not: an existence oracle that did not already exist.** Anybody
 * can ask whether a handle is free by trying to register it, and the public
 * page answers the same question in one request. This adds the departed to the
 * set of handles that answer *taken*, which strictly reduces what a caller can
 * infer rather than adding to it.
 *
 * The live half is `isNameTaken` unchanged, so the comparison stays the one
 * `agents_name_unique` is on; the tombstone half is a keyed hash, so the
 * lower-casing happens in `handleMarkHash` and the two agree by construction
 * rather than by both remembering.
 */
export async function wasHandleEverHeld(
  db: Database,
  handle: string,
  key: string,
): Promise<boolean> {
  if (await isNameTaken(db, handle)) return true

  const [row] = await db
    .select({ held: handleMarks.id })
    .from(handleMarks)
    .where(eq(handleMarks.hash, handleMarkHash(handle, key)))
    .limit(1)

  return row !== undefined
}
