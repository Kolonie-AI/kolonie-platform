import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import type { Database } from '../client.js'
import { registrationConfirmations } from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import {
  mintRegistrationConfirmation,
  registrationNameKey,
  spendRegistrationConfirmation,
} from './registration-confirmation.js'

const target = databaseTestTarget()

/**
 * The pause in front of the front door (`#875`).
 *
 * What is asserted here is the half that lives in SQL and no fake can stand in
 * for: that a token is spent exactly once, that presenting it for another name
 * leaves it alive, and that an expired one is refused as expired rather than as
 * unknown. The two refusal voices are `packages/core`'s and the call order is
 * `apps/api`'s.
 */
describe('a registration confirmation', () => {
  let db: Database

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await truncateAll(db)
  })

  it('confirms the name it was minted for', async () => {
    const { token, expiresAt } = await mintRegistrationConfirmation(db, 'vireo')

    expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now())
    await expect(spendRegistrationConfirmation(db, 'vireo', token)).resolves.toBe('confirmed')
  })

  /**
   * A caller that fixed its capitalisation between the two calls proposed the
   * same name both times. Folding here is the same rule `agents` compares names
   * with, so a second refusal for that would be a rule about typing.
   */
  it('folds case the way the front door does', async () => {
    const { token } = await mintRegistrationConfirmation(db, 'Vireo')

    await expect(spendRegistrationConfirmation(db, 'vIREO', token)).resolves.toBe('confirmed')
  })

  it('works once', async () => {
    const { token } = await mintRegistrationConfirmation(db, 'vireo')

    await expect(spendRegistrationConfirmation(db, 'vireo', token)).resolves.toBe('confirmed')
    await expect(spendRegistrationConfirmation(db, 'vireo', token)).resolves.toBe('spent')
  })

  it('does not recognise a token it never issued', async () => {
    await expect(spendRegistrationConfirmation(db, 'vireo', 'not-a-token')).resolves.toBe('unknown')
  })

  /**
   * The deliberate divergence from `erasureChallenges`, which burns its nonce on
   * presentation whatever else was wrong. There is no attacker here to deter —
   * the token confirms a name nobody holds — so a caller that pasted the one it
   * had minted for the other name it was weighing up keeps both.
   */
  it('leaves a token intact when it is presented for another name', async () => {
    const { token } = await mintRegistrationConfirmation(db, 'vireo')

    await expect(spendRegistrationConfirmation(db, 'kestrel', token)).resolves.toBe('other-name')
    await expect(spendRegistrationConfirmation(db, 'vireo', token)).resolves.toBe('confirmed')
  })

  it('refuses an expired token as expired, and spends it', async () => {
    const { token } = await mintRegistrationConfirmation(db, 'vireo')
    await db
      .update(registrationConfirmations)
      .set({
        createdAt: sql`now() - interval '2 hours'`,
        expiresAt: sql`now() - interval '1 hour'`,
      })
      .where(eq(registrationConfirmations.token, token))

    await expect(spendRegistrationConfirmation(db, 'vireo', token)).resolves.toBe('expired')
    await expect(spendRegistrationConfirmation(db, 'vireo', token)).resolves.toBe('spent')
  })

  /**
   * Two callers may hold live tokens for one name at once, and the front door's
   * own uniqueness check decides between them. A token that reserved a name
   * would let an anonymous caller park every name it liked for the price of a
   * refused call.
   */
  it('reserves nothing, so two tokens for one name both exist', async () => {
    const first = await mintRegistrationConfirmation(db, 'vireo')
    const second = await mintRegistrationConfirmation(db, 'vireo')

    expect(second.token).not.toBe(first.token)
    await expect(spendRegistrationConfirmation(db, 'vireo', first.token)).resolves.toBe('confirmed')
    await expect(spendRegistrationConfirmation(db, 'vireo', second.token)).resolves.toBe(
      'confirmed',
    )
  })

  it('stores the folded name and nothing about a caller', async () => {
    const { token } = await mintRegistrationConfirmation(db, '  Vireo  ')
    const [row] = await db
      .select()
      .from(registrationConfirmations)
      .where(eq(registrationConfirmations.token, token))

    expect(row?.nameKey).toBe('vireo')
    expect(registrationNameKey('  Vireo  ')).toBe('vireo')
    expect(Object.keys(row ?? {}).sort()).toEqual([
      'consumedAt',
      'createdAt',
      'expiresAt',
      'id',
      'nameKey',
      'token',
    ])
  })
})
