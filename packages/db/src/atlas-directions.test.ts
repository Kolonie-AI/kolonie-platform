import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { AccountKindSchema, type RecipeStatus } from '@kolonie-ai/core'
import type { Database } from './client.js'
import { connectForTests, databaseTestTarget, truncateAll } from './testing.js'
import { scopeTelephonyDirections } from './atlas-directions.js'
import {
  providerRecipe,
  scopeProviderDirection,
  writeProviderRecipe,
} from './storage/provider-recipes.js'

const target = databaseTestTarget()
const PHONE = AccountKindSchema.parse('phone')
const MAILBOX = AccountKindSchema.parse('mailbox')

/**
 * The pass that says which capability the telephony verdicts were measured
 * against (`#976`).
 *
 * **Against a real Postgres, because the guard being tested is a `where`
 * clause.** Everything this pass promises — that it changes no verdict, that a
 * citizen's own scope outranks it, that a second deploy writes nothing — is a
 * property of one update statement, and none of it can be shown by calling the
 * function with a fake.
 */
describe('scoping a verdict to the direction it measured', () => {
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

  const shelved = async (
    provider: string,
    over: { status?: RecipeStatus; refusal?: string | null } = {},
  ) => {
    await writeProviderRecipe(db, {
      kind: PHONE,
      provider,
      title: provider,
      status: over.status ?? 'refused',
      category: 'telephony',
      steps: [],
      refusal:
        over.refusal === null
          ? null
          : (over.refusal ?? 'A2P registration wants a registered brand.'),
    })
  }

  it('records the direction and touches nothing else about the verdict', async () => {
    await shelved('agentphone.ai')

    expect(
      await scopeProviderDirection(db, {
        kind: PHONE,
        provider: 'agentphone.ai',
        direction: 'outbound',
      }),
    ).toBe(true)

    const entry = await providerRecipe(db, PHONE, 'agentphone.ai')

    expect(entry?.direction).toBe('outbound')
    /** Still refused — for sending, which is what it always said. */
    expect(entry?.status).toBe('refused')
    expect(entry?.refusal).toBe('A2P registration wants a registered brand.')
  })

  /**
   * **The guard, and the reason it is in the `where` rather than in a caller.** A
   * scope somebody recorded deliberately outranks a judgement made about rows
   * written before the axis existed.
   */
  it('leaves a scope somebody already recorded exactly as it stands', async () => {
    await shelved('agentphone.ai')
    await scopeProviderDirection(db, {
      kind: PHONE,
      provider: 'agentphone.ai',
      direction: 'inbound',
    })

    const moved = await scopeProviderDirection(db, {
      kind: PHONE,
      provider: 'agentphone.ai',
      direction: 'outbound',
    })

    expect(moved).toBe(false)
    expect((await providerRecipe(db, PHONE, 'agentphone.ai'))?.direction).toBe('inbound')
  })

  it('creates nothing for a provider no shelf holds', async () => {
    const moved = await scopeProviderDirection(db, {
      kind: PHONE,
      provider: 'never-walked.example',
      direction: 'outbound',
    })

    expect(moved).toBe(false)
    expect(await providerRecipe(db, PHONE, 'never-walked.example')).toBeUndefined()
  })

  /**
   * A kind with no axis is a mistake in the caller, and a stack trace naming the
   * function is worth more to whoever made it than a constraint violation four
   * frames down.
   */
  it('refuses a kind that has no direction to scope', async () => {
    await expect(
      scopeProviderDirection(db, {
        kind: MAILBOX,
        provider: 'mail.example',
        direction: 'inbound',
      }),
    ).rejects.toThrow('no direction to scope')
  })

  describe('the telephony pass', () => {
    it('scopes the verdicts the Colony has measured, and reports the rest', async () => {
      await shelved('agentphone.ai')
      await shelved('agentmessage.io')

      const result = await scopeTelephonyDirections(db)

      expect(result.scoped).toBe(2)
      /** `mobile-text-alerts.com`, whose row this test never wrote. */
      expect(result.untouched).toBe(1)
      expect((await providerRecipe(db, PHONE, 'agentmessage.io'))?.direction).toBe('outbound')
    })

    it('is idempotent, so a second deploy writes nothing and says so', async () => {
      await shelved('agentphone.ai')

      const first = await scopeTelephonyDirections(db)
      const second = await scopeTelephonyDirections(db)

      expect(first.scoped).toBe(1)
      expect(second.scoped).toBe(0)
    })

    /**
     * **`twilio.com` is deliberately not on the list**, and a test says so
     * because the omission is the kind that reads as an oversight. It is a
     * working entry the Colony receives on: scoping it to sending would tell an
     * inbound reader that nobody has measured the very number the Colony
     * receives on.
     */
    it('leaves the working entry unscoped', async () => {
      await shelved('twilio.com', { status: 'measured', refusal: null })

      await scopeTelephonyDirections(db)

      expect((await providerRecipe(db, PHONE, 'twilio.com'))?.direction).toBeNull()
    })
  })
})
