import { and, eq, isNotNull, lte, sql } from 'drizzle-orm'
import { now as currentTime } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { accountSlots } from '../schema/account-threads.js'

/**
 * What is left of the operator → agent secret channel (`#410`, retired `#1444`).
 *
 * ## The channel never carried anything
 *
 * Measured in production 2026-08-20: **7 drops opened by citizens, 0 ever
 * filled by an operator.** The one channel that let a person hand their agent a
 * secret never carried one. `kolonie.vault.share` replaces it: the citizen
 * writes a placeholder entry, shares it, and the operator fills it from the
 * durable page they already hold — no login, days rather than a mailed link.
 *
 * **Everything that opened, viewed, submitted or took a drop is gone; this one
 * function is not.** `kolonie.operator.drop.open` promised out loud that the
 * secret is *gone on the timer whether or not anybody read it*, and in-flight
 * rows drain over three days. Until they have, something has to be the thing
 * that clears their ciphertext. It goes with the table (`#1472`).
 *
 * ## `OPERATOR_DROP_SEALING_KEY` stays, and it is not a leftover
 *
 * It seals thread slots, account offers and vault shares as well, and has since
 * `#955`. Renaming it after the channel it was named for is a separate decision
 * nobody has asked for — `#1444` says so outright.
 */

export async function destroyExpiredDrops(db: Database): Promise<number> {
  const destroyed = await db
    .update(accountSlots)
    .set({ value: null, destroyedAt: currentTime() })
    .where(
      and(
        eq(accountSlots.channel, 'drop'),
        isNotNull(accountSlots.value),
        lte(accountSlots.expiresAt, sql`now()`),
      ),
    )
    .returning({ id: accountSlots.id })

  return destroyed.length
}
