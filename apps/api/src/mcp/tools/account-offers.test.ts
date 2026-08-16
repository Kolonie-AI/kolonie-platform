import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { AgentId } from '@kolonie-ai/core'
import { connectedClient, registeredCitizen } from '../../__fixtures__/mcp.js'
import {
  OFFER_ACCOUNT_NOT_PROVED,
  OFFER_ALREADY_OPEN,
  OFFER_NO_VAULT_KEY,
  OFFER_NOTHING_TO_GIVE,
  OFFER_REACH_MAILBOX,
  OFFER_SHARED_VAULT_KEY,
} from '../../account-offers.js'

/**
 * An account offered from one citizen to another, over MCP (`#1125`).
 *
 * The surface is what is asserted here: which tools exist, what each refusal
 * says, and **the refusal that is not there**. Whether a parcel opens, and
 * whether the storage holds its constraints, is asserted in `packages/db`
 * against a real database and a real primitive.
 */
describe('offering an account to another citizen', () => {
  type Offered = {
    readonly offerId: string
    readonly toHandle: string
    readonly expiresAt: string
    readonly account: {
      readonly kind: string
      readonly identifier: string
      readonly provider: string | null
    }
  }

  const offered = (result: unknown): Offered =>
    (result as { structuredContent: Offered }).structuredContent

  const refusal = (result: unknown) =>
    (
      result as {
        structuredContent: {
          error: { code: string; message: string; details?: Record<string, string> }
        }
      }
    ).structuredContent.error

  const textOf = (result: unknown): string =>
    JSON.stringify((result as { content: unknown }).content)

  /** A citizen holding one proved, givable mailbox, connected over MCP. */
  const giver = async () => {
    const { colony, apiKey, agent } = await registeredCitizen()
    const offers = colony.accountOfferStore
    const accountId = offers.hold(agent.id, {
      kind: 'mailbox',
      identifier: 'spare@example.test',
      provider: 'mail.tm',
    })
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)
    return { client, close, offers, accountId, agent }
  }

  const give = async (
    client: Awaited<ReturnType<typeof giver>>['client'],
    args: { accountId: string; to: string; confirm?: string },
  ) => client.callTool({ name: 'kolonie.accounts.give', arguments: args })

  it('is two tools, and neither of them asks whether a handle is taken', async () => {
    const { client, close } = await giver()

    const { tools } = await client.listTools()
    const names = tools.map((tool) => tool.name)

    expect(names).toContain('kolonie.accounts.give')
    expect(names).toContain('kolonie.accounts.withdraw-offer')
    // The giver's half is these two. The receiving half is `#1126`, and until
    // it lands there is nothing here that reads an offer from the other side.
    expect(names.filter((name) => name.startsWith('kolonie.accounts.accept'))).toHaveLength(0)

    await close()
  })

  it('writes an offer and says what was offered, until when, and how to take it back', async () => {
    const { client, close, offers, accountId } = await giver()
    offers.citizen('recipient-agent' as AgentId, 'recipient')

    const result = await give(client, { accountId, to: 'recipient' })

    expect(result.isError).toBeFalsy()
    expect(offered(result)).toMatchObject({
      toHandle: 'recipient',
      account: { kind: 'mailbox', identifier: 'spare@example.test', provider: 'mail.tm' },
    })

    const text = textOf(result)
    expect(text).toContain('spare@example.test')
    expect(text).toContain('kolonie.accounts.withdraw-offer')
    // Nothing about the account changed, and the sentence has to say so: a
    // giver that believes the mailbox has already gone will stop using it.
    expect(text).toContain('still yours')

    await close()
  })

  it('echoes the handle as the giver typed it, not as it is held', async () => {
    const { client, close, offers, accountId } = await giver()
    offers.citizen('recipient-agent' as AgentId, 'recipient')

    const result = await give(client, { accountId, to: 'ReCiPiEnT' })

    expect(offered(result).toHandle).toBe('ReCiPiEnT')

    await close()
  })

  /**
   * Decision 5, and the assertion the whole feature stands on.
   *
   * The same account and the **same handle string**, given once while nobody
   * answers to it and once while somebody does — so the two answers may differ
   * in nothing but the id and the expiry. Underneath they are genuinely
   * different calls, which `hasParcel` is here to prove: without it a surface
   * that never wrote a parcel at all would pass this test.
   */
  it('answers identically whether or not anybody holds the handle', async () => {
    const { client, close, offers, accountId } = await giver()

    const toNobody = await give(client, { accountId, to: 'perhaps-nobody' })
    await client.callTool({
      name: 'kolonie.accounts.withdraw-offer',
      arguments: { offerId: offered(toNobody).offerId },
    })

    offers.citizen('recipient-agent' as AgentId, 'perhaps-nobody')
    const toSomebody = await give(client, { accountId, to: 'perhaps-nobody' })

    const anonymise = (result: unknown) => {
      const body = offered(result)
      return { ...body, offerId: 'ID', expiresAt: 'WHEN' }
    }
    const anonymiseText = (result: unknown) =>
      textOf(result)
        .replaceAll(offered(result).offerId, 'ID')
        .replaceAll(offered(result).expiresAt, 'WHEN')

    expect(toNobody.isError).toBeFalsy()
    expect(toSomebody.isError).toBeFalsy()
    expect(Object.keys(anonymise(toSomebody))).toEqual(Object.keys(anonymise(toNobody)))
    expect(anonymise(toSomebody)).toEqual(anonymise(toNobody))
    expect(anonymiseText(toSomebody)).toEqual(anonymiseText(toNobody))

    // The two calls really were different, and the difference is the one thing
    // the giver was not told.
    expect(offers.hasParcel(offered(toNobody).offerId)).toBe(false)
    expect(offers.hasParcel(offered(toSomebody).offerId)).toBe(true)

    await close()
  })

  it('refuses an account that is not yours, and one that does not exist, the same way', async () => {
    const { client, close, offers } = await giver()
    const somebodyElses = offers.hold('another-agent' as AgentId, {
      kind: 'mailbox',
      identifier: 'theirs@example.test',
    })

    const missing = refusal(await give(client, { accountId: randomUUID(), to: 'recipient' }))
    const theirs = refusal(await give(client, { accountId: somebodyElses, to: 'recipient' }))

    expect(missing.code).toBe('not_found')
    expect(theirs).toEqual(missing)

    await close()
  })

  it('refuses a declared account, an account with no vault key, and an empty vault entry', async () => {
    const { client, close, offers, agent } = await giver()

    const declared = offers.hold(agent.id, {
      kind: 'mailbox',
      identifier: 'declared@example.test',
      proved: false,
    })
    const keyless = offers.hold(agent.id, {
      kind: 'mailbox',
      identifier: 'keyless@example.test',
      vaultKey: null,
    })
    // A vaultKey pointing at nothing: the name is on the account and the entry
    // behind it cannot be opened with the key being presented.
    const empty = offers.hold(agent.id, {
      kind: 'mailbox',
      identifier: 'empty@example.test',
      vaultKey: 'mailbox/nothing-stored-here',
    })
    offers.forgetVaultEntry(agent.id, 'mailbox/nothing-stored-here')

    const notProved = refusal(await give(client, { accountId: declared, to: 'recipient' }))
    const noKey = refusal(await give(client, { accountId: keyless, to: 'recipient' }))
    const nothing = refusal(await give(client, { accountId: empty, to: 'recipient' }))

    expect(notProved.code).toBe('conflict')
    expect(notProved.details?.reason).toBe(OFFER_ACCOUNT_NOT_PROVED)
    expect(notProved.message).toContain('kolonie.accounts.prove')

    expect(noKey.details?.reason).toBe(OFFER_NO_VAULT_KEY)
    expect(noKey.message).toContain('kolonie.vault.set')

    expect(nothing.details?.reason).toBe(OFFER_NOTHING_TO_GIVE)
    expect(nothing.message).toContain('kolonie.vault.list')

    await close()
  })

  it('refuses the one mailbox the Colony writes to', async () => {
    const { client, close, offers, agent } = await giver()
    const reach = offers.hold(agent.id, {
      kind: 'mailbox',
      identifier: 'reach@example.test',
      reachMailbox: true,
    })

    const refused = refusal(await give(client, { accountId: reach, to: 'recipient' }))

    expect(refused.code).toBe('conflict')
    expect(refused.details?.reason).toBe(OFFER_REACH_MAILBOX)
    expect(refused.message).toContain('kolonie.mailboxes.promote')

    await close()
  })

  it('refuses your own handle, and says so rather than writing an offer', async () => {
    const { client, close, offers, accountId, agent } = await giver()
    offers.citizen(agent.id, 'canary')

    const refused = refusal(await give(client, { accountId, to: 'canary' }))

    expect(refused.code).toBe('validation_failed')
    expect(refused.message).toContain('your own handle')

    await close()
  })

  it('names the open offer rather than redirecting it', async () => {
    const { client, close, accountId } = await giver()
    const first = offered(await give(client, { accountId, to: 'first-choice' }))

    const refused = refusal(await give(client, { accountId, to: 'second-thoughts' }))

    expect(refused.code).toBe('conflict')
    expect(refused.details?.reason).toBe(OFFER_ALREADY_OPEN)
    expect(refused.details?.offerId).toBe(first.offerId)
    expect(refused.details?.toHandle).toBe('first-choice')
    expect(refused.message).toContain('kolonie.accounts.withdraw-offer')

    await close()
  })

  it('pauses when the vault entry opens other accounts, and proceeds on the token', async () => {
    const { client, close, offers, agent } = await giver()
    const shared = offers.hold(agent.id, {
      kind: 'mailbox',
      identifier: 'shared@example.test',
      sharedWith: [{ kind: 'website', identifier: 'example.test' }],
    })

    const paused = refusal(await give(client, { accountId: shared, to: 'recipient' }))

    expect(paused.code).toBe('confirmation_required')
    expect(paused.details?.reason).toBe(OFFER_SHARED_VAULT_KEY)
    // The accounts that would go with it, by name: a citizen cannot weigh a
    // consequence it has not been told the size of.
    expect(paused.details?.sharedWith).toContain('website example.test')
    expect(paused.message).toContain('website example.test')
    expect(paused.message).toContain('Nothing has happened yet')

    const token = paused.details?.confirmationToken
    expect(token).toBeTruthy()
    // The token is in the message as well as in `details`, because `details` is
    // documented as additional to the message rather than instead of it.
    expect(paused.message).toContain(token as string)

    const proceeded = await give(client, {
      accountId: shared,
      to: 'recipient',
      confirm: token as string,
    })

    expect(proceeded.isError).toBeFalsy()
    expect(offered(proceeded).account.identifier).toBe('shared@example.test')

    await close()
  })

  it('will not carry a credential on a Colony with no sealing key, and says why', async () => {
    const { client, close, offers, accountId } = await giver()
    offers.loseSealingKey()

    const refused = refusal(await give(client, { accountId, to: 'recipient' }))

    expect(refused.code).toBe('rung_unavailable')
    // Not the citizen's fault and not the citizen's problem to fix: the
    // sentence has to close the question rather than send it looking.
    expect(refused.message).toContain('Nothing is wrong with your request')

    await close()
  })

  describe('taking an offer back', () => {
    it('deletes the offer and the parcel, and lets the account be given again', async () => {
      const { client, close, offers, accountId } = await giver()
      offers.citizen('recipient-agent' as AgentId, 'first-choice')
      const first = offered(await give(client, { accountId, to: 'first-choice' }))
      expect(offers.hasParcel(first.offerId)).toBe(true)

      const withdrawn = await client.callTool({
        name: 'kolonie.accounts.withdraw-offer',
        arguments: { offerId: first.offerId },
      })

      expect(withdrawn.isError).toBeFalsy()
      expect(withdrawn.structuredContent).toMatchObject({
        offerId: first.offerId,
        withdrawn: true,
      })
      expect(textOf(withdrawn)).toContain('cost you nothing')
      expect(offers.hasParcel(first.offerId)).toBe(false)

      // The redirect: two calls rather than one, and the second one works.
      const second = await give(client, { accountId, to: 'second-thoughts' })
      expect(second.isError).toBeFalsy()
      expect(offered(second).toHandle).toBe('second-thoughts')

      await close()
    })

    it('refuses an offer that is gone, and one that was never yours', async () => {
      const { client, close, offers, accountId, agent } = await giver()
      void agent
      const mine = offered(await give(client, { accountId, to: 'recipient' }))
      const theirAccount = offers.hold('another-agent' as AgentId, {
        kind: 'mailbox',
        identifier: 'theirs@example.test',
      })
      const theirOffer = await offers.give(
        {
          fromAgentId: 'another-agent' as AgentId,
          accountId: theirAccount,
          toHandle: 'recipient',
        },
        'their-token',
      )
      if (theirOffer.outcome !== 'offered') throw new Error('fixture failed to offer')

      const withdraw = (offerId: string) =>
        client.callTool({ name: 'kolonie.accounts.withdraw-offer', arguments: { offerId } })

      await withdraw(mine.offerId)
      const twice = refusal(await withdraw(mine.offerId))
      const theirs = refusal(await withdraw(theirOffer.offerId))

      expect(twice.code).toBe('not_found')
      // Somebody else's open offer answers exactly as a withdrawn one: this
      // surface is not a way to learn that an offer exists.
      expect(theirs).toEqual(twice)

      await close()
    })
  })
})
