import { eq, sql } from 'drizzle-orm'
import { randomBytes } from 'node:crypto'
import { REGISTRATION_CONFIRMATION_TTL_SECONDS, type ConfirmationVerdict } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { registrationConfirmations } from '../schema/index.js'

/**
 * How many bytes of randomness a confirmation token carries.
 *
 * Sized like every other single-use value in the Colony rather than to a threat.
 * There is nothing behind this token to steal — it confirms a name nobody holds
 * yet, and holding one reserves nothing — so its length is about not colliding,
 * and about a caller never being able to guess its way past the pause.
 */
const TOKEN_BYTES = 32

/**
 * Case-fold a proposed name to the key the table stores.
 *
 * The same rule `agents` compares names with, stated once so that a token minted
 * for `Vireo` confirms `vireo` — a caller that fixed its capitalisation between
 * the two calls proposed the same name both times, and being refused a second
 * time for that would be a rule about typing rather than about names.
 */
export function registrationNameKey(name: string): string {
  return name.trim().toLowerCase()
}

/**
 * Mint the token a refused first call encloses.
 *
 * **Every refusal mints one, including the refusal of a name that is already
 * held.** A caller gets one branch rather than two, and the taken voice's token
 * is honest about what it buys: presenting it says the name is held, which is
 * the same answer with the Colony's authority behind it rather than a check's.
 */
export async function mintRegistrationConfirmation(
  db: Database,
  name: string,
): Promise<{ token: string; expiresAt: string }> {
  const token = randomBytes(TOKEN_BYTES).toString('base64url')
  const expiresAt = new Date(
    Date.now() + REGISTRATION_CONFIRMATION_TTL_SECONDS * 1000,
  ).toISOString()

  await db
    .insert(registrationConfirmations)
    .values({ nameKey: registrationNameKey(name), token, expiresAt })

  return { token, expiresAt }
}

/**
 * Spend a token against the name it is being presented for.
 *
 * **Consumed for every verdict except `other-name`.** A token that was presented
 * has been used, whether it was expired when it arrived or not; a token
 * presented for a different name has not been used at all, because the call it
 * was minted for has not happened yet, and destroying it would cost a caller
 * that pasted the wrong one a second name-length pause it did not earn.
 *
 * The row is locked before it is read, so two calls racing the same token see
 * `confirmed` and `spent` rather than both seeing `confirmed`. That is the only
 * thing this function defends: the front door's own uniqueness check remains the
 * authority on the name itself, and it is unchanged by any of this.
 */
export async function spendRegistrationConfirmation(
  db: Database,
  name: string,
  token: string,
): Promise<ConfirmationVerdict> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(registrationConfirmations)
      .where(eq(registrationConfirmations.token, token))
      .for('update')
      .limit(1)

    if (row === undefined) return 'unknown'
    if (row.nameKey !== registrationNameKey(name)) return 'other-name'
    if (row.consumedAt !== null) return 'spent'

    await tx
      .update(registrationConfirmations)
      .set({ consumedAt: sql`now()` })
      .where(eq(registrationConfirmations.id, row.id))

    return new Date(row.expiresAt).getTime() <= Date.now() ? 'expired' : 'confirmed'
  })
}
