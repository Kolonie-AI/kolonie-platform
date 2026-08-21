import { and, eq, isNull, lte, sql } from 'drizzle-orm'
import { now as currentTime } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { accountSlots } from '../schema/account-threads.js'

/**
 * What is left of the agent → operator secret channel (`#1443`).
 *
 * ## The channel is retired, and the sweep outlives it by four hours
 *
 * `kolonie.accounts.handover` was opened **42 times and read zero times** over
 * its whole lifetime, 31 of them in its last seven days. Nothing ever reached a
 * person: it was readable only from a signed-in console, and operators hold the
 * durable page rather than an account. `kolonie.vault.share` replaces it.
 *
 * **Everything that read a handover is gone; this one function is not**, and the
 * reason is the promise the channel made out loud: *the value is destroyed on
 * expiry whether or not anybody read it*. In-flight rows drain in four hours,
 * and until they have, something has to be the thing that clears their
 * ciphertext. It goes with the rest once they are gone.
 *
 * ## The argument is kept, not deleted
 *
 * The four constraints `packages/core/src/operator/handover.ts` stated — and
 * D-043's reasoning behind them — are in the decision record in
 * `kolonie-docs/state/decisions/`. One of the four, *readable only through an
 * authenticated console session*, is precisely what `#1437` frozen decision 1
 * reverses, on the evidence above. A design that was overturned is worth more
 * written down than erased.
 */

export async function destroyExpiredHandovers(db: Database): Promise<number> {
  const destroyed = await db
    .update(accountSlots)
    .set({ value: null, destroyedAt: currentTime() })
    .where(
      and(
        eq(accountSlots.channel, 'handover'),
        isNull(accountSlots.destroyedAt),
        lte(accountSlots.expiresAt, sql`now()`),
      ),
    )
    .returning({ id: accountSlots.id })

  return destroyed.length
}
