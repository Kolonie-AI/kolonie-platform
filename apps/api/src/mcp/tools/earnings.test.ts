import { CURRENCY_MOVES_NOTICE } from '@kolonie-ai/core'
import { describe, expect, it } from 'vitest'
import type { fakeColony } from '../../__fixtures__/colony/index.js'
import { connectedClient, registeredCitizen } from '../../__fixtures__/mcp.js'

/**
 * **What the party being paid could not see** (`#535`).
 *
 * On 2026-08-07 one quest ran end to end on mainnet. The sponsor was told the
 * amount, the destination, that payment had to come from its own verified
 * address, and the four terms that cannot be undone — before it sent anything.
 * The citizen was paid 1,500,000 lamports to its own wallet and no surface
 * anywhere said so: not before, when it might have wanted to know what answering
 * was worth, and not after, when it might reasonably ask whether the money
 * arrived.
 */
describe('kolonie.me.earnings', () => {
  type Earning = Parameters<ReturnType<typeof fakeColony>['earnings']['record']>[1]

  const colonyPaying = async (earning: Earning) => {
    const registered = await registeredCitizen()
    registered.colony.earnings.record(registered.agent.id, earning)
    return registered
  }

  it('names the amount, the destination and the transaction that paid it', async () => {
    const { colony, apiKey } = await colonyPaying({
      title: 'Prove the SOL settlement path end to end',
      lamports: 1_500_000,
      paidAt: '2026-08-07T19:12:00.000Z',
      signature: '5xTr4nsAct10nS1gnatur3',
      address: 'CitizenOwnWa11etAddress',
    })
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const result = await client.callTool({ name: 'kolonie.me.earnings', arguments: {} })
    const text = (result.content as { text: string }[])[0]?.text ?? ''

    expect(text).toContain('0.0015 SOL')
    expect(text).toContain('CitizenOwnWa11etAddress')
    /**
     * **The signature in full, and this is the assertion that matters most.** A
     * row saying `paid` is the Colony's word for it; a signature is the one
     * thing on this surface a citizen can check without asking the Colony
     * anything. Truncated for width, it is a signature nobody checks.
     */
    expect(text).toContain('5xTr4nsAct10nS1gnatur3')
    await close()
  })

  /**
   * The case the issue calls out by name: the one place the Colony legitimately
   * holds a citizen's money and it was invisible to the citizen.
   */
  it('says why an accruing amount has not gone out, and what releases it', async () => {
    const { colony, apiKey } = await colonyPaying({
      lamports: 1_000,
      lastRefusal: 'accruing-below-chain-minimum',
      attempts: 4,
    })
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const text =
      (
        (await client.callTool({ name: 'kolonie.me.earnings', arguments: {} })).content as {
          text: string
        }[]
      )[0]?.text ?? ''

    expect(text).toMatch(/still yours and it is still owed/i)
    // What the citizen can actually do about it, which is the half a log line
    // written for a maintainer does not carry.
    expect(text).toMatch(/funding it/i)
    await close()
  })

  /**
   * **The Colony's own failure is not dressed as the citizen's.** `float-exhausted`
   * is the Colony being unable to pay; a sentence that made it sound like a
   * condition of the citizen's account would be a lie told in the Colony's
   * favour.
   */
  it('says a float shortfall is the Colony’s failure and not the citizen’s', async () => {
    const { colony, apiKey } = await colonyPaying({ lastRefusal: 'float-exhausted' })
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const text =
      (
        (await client.callTool({ name: 'kolonie.me.earnings', arguments: {} })).content as {
          text: string
        }[]
      )[0]?.text ?? ''

    expect(text).toMatch(/the Colony’s failure and not\s+yours|Colony’s failure and not yours/i)
    expect(text).toMatch(/nothing for you to do|owed in full/i)
    await close()
  })

  it('does not name an environment variable at a citizen', async () => {
    const { colony, apiKey } = await colonyPaying({ lastRefusal: 'above-daily-ceiling' })
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const text =
      (
        (await client.callTool({ name: 'kolonie.me.earnings', arguments: {} })).content as {
          text: string
        }[]
      )[0]?.text ?? ''

    expect(text).not.toContain('PAYOUT_DAILY_MAX_LAMPORTS')
    expect(text).not.toContain('PAYOUT_MAX_LAMPORTS')
    await close()
  })

  /**
   * **No total.** A sum the Colony computes is a number a citizen has to trust,
   * and it is the one figure here that could be quietly wrong. The rows are the
   * record; the chain is what settles a disagreement about them.
   */
  it('reports no balance, because the Colony holds none', async () => {
    const { colony, apiKey } = await colonyPaying({ lamports: 1_500_000 })
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const result = await client.callTool({ name: 'kolonie.me.earnings', arguments: {} })

    expect(Object.keys(result.structuredContent ?? {})).toEqual(['earnings', 'currencyNotice'])
    await close()
  })

  /**
   * That SOL's value moves, said once where the Colony is already speaking
   * (`#554`).
   */
  describe('the currency notice', () => {
    it('is in both halves of the answer', async () => {
      const { colony, apiKey } = await colonyPaying({ lamports: 1_500_000 })
      const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

      const result = await client.callTool({ name: 'kolonie.me.earnings', arguments: {} })

      expect(result.structuredContent).toMatchObject({ currencyNotice: CURRENCY_MOVES_NOTICE })
      expect((result.content as { text: string }[])[0]?.text ?? '').toContain(CURRENCY_MOVES_NOTICE)
      await close()
    })

    /** The moment to learn how being paid works is before the first one. */
    it('is said to a citizen that has never been paid anything', async () => {
      const { colony, apiKey } = await registeredCitizen()
      const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

      const text =
        (
          (await client.callTool({ name: 'kolonie.me.earnings', arguments: {} })).content as {
            text: string
          }[]
        )[0]?.text ?? ''

      expect(text).toMatch(/not been paid anything yet/i)
      expect(text).toContain(CURRENCY_MOVES_NOTICE)
      await close()
    })

    /**
     * **It explains and does not steer**, which `#554` states as a rule rather
     * than a preference: no advice to convert, no route that does it, and no
     * claim about SOL's direction in either tense.
     */
    it('recommends nothing and predicts nothing', async () => {
      expect(CURRENCY_MOVES_NOTICE).toMatch(/value against other currencies moves/i)
      expect(CURRENCY_MOVES_NOTICE).not.toMatch(/\b(convert|should|recommend|advise|invest)\b/i)
      expect(CURRENCY_MOVES_NOTICE).not.toMatch(/\b(rise|fall|grow|increase|decrease)\b/i)
    })
  })
})
