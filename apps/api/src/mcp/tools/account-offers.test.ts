import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { AgentId } from '@kolonie-ai/core'
import { FAKE_CALLER_IP } from '../../__fixtures__/colony/index.js'
import { connectedClient, registeredCitizen } from '../../__fixtures__/mcp.js'
import {
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

  it('is four tools, and none of them asks whether a handle is taken', async () => {
    const { client, close } = await giver()

    const { tools } = await client.listTools()
    const names = tools.map((tool) => tool.name)

    // Two on the giver's side (`#1125`) and two on the recipient's (`#1126`).
    expect(names).toContain('kolonie.accounts.give')
    expect(names).toContain('kolonie.accounts.withdraw-offer')
    expect(names).toContain('kolonie.accounts.accept')
    expect(names).toContain('kolonie.accounts.decline')
    // And nothing that answers *does anybody hold this handle*. Decision 5 is a
    // property of the whole surface, so it is asserted over the whole surface:
    // a tool added later to look a citizen up would fail here.
    expect(names.filter((name) => name.includes('handle'))).toHaveLength(0)

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

  /**
   * `#1213`: what is asked for is the credential, so a declared row with one is
   * given and a proved row without one is not. Both halves are here, because
   * the refusal that used to answer the first of them is the thing being
   * removed and a test that only asserted the new pass would not notice it
   * coming back as a differently-worded conflict.
   */
  it('offers a declared account that names a vault entry the giver holds', async () => {
    const { client, close, offers, agent } = await giver()

    offers.citizen('recipient-agent' as AgentId, 'recipient')
    const declared = offers.hold(agent.id, {
      kind: 'mailbox',
      identifier: 'declared@example.test',
      proved: false,
    })

    const result = await give(client, { accountId: declared, to: 'recipient' })

    expect(offered(result).account).toMatchObject({ identifier: 'declared@example.test' })
    expect(offers.hasParcel(offered(result).offerId)).toBe(true)
    expect(textOf(result)).not.toContain('prove')

    await close()
  })

  it('refuses an account with no vault key, and an empty vault entry', async () => {
    const { client, close, offers, agent } = await giver()

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

    const noKey = refusal(await give(client, { accountId: keyless, to: 'recipient' }))
    const nothing = refusal(await give(client, { accountId: empty, to: 'recipient' }))

    expect(noKey.code).toBe('conflict')
    expect(noKey.details?.reason).toBe(OFFER_NO_VAULT_KEY)
    expect(noKey.message).toContain('kolonie.vault.set')
    // The story is the missing credential and not the missing proof (`#1213`).
    expect(noKey.message).not.toContain('kolonie.accounts.prove')

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

  /**
   * The recipient's half (`#1126`), over MCP.
   *
   * Two citizens in **one** Colony, each connected with the key it was actually
   * issued: a recipient faked beside the giver rather than registered into the
   * same store could prove a hand-over that never crossed between them.
   *
   * What is asserted here is the surface — what the two tools answer, what each
   * refusal says, and what the receipt tells a recipient it has *not* got.
   * Whether the parcel opens, whether the giver's row is deleted rather than
   * retired and whether the five writes are one transaction is asserted in
   * `packages/db` against a real database.
   */
  describe('taking an offer', () => {
    /** The giver's own name for the credential, which `hold` derives. */
    const GIVER_VAULT_KEY = 'mailbox/spare@example.test'
    /** The recipient's name for it, and the one decision `accept` asks for. */
    const MINE = 'mine/the-mailbox'

    const pair = async (over: { readonly proved?: boolean } = {}) => {
      const { colony, apiKey, agent } = await registeredCitizen()
      const offers = colony.accountOfferStore
      const accountId = offers.hold(agent.id, {
        kind: 'mailbox',
        identifier: 'spare@example.test',
        provider: 'mail.tm',
        ...(over.proved === undefined ? {} : { proved: over.proved }),
      })

      const registered = await colony.registry.register(
        { name: 'recipient', platform: 'openclaw' },
        { ip: FAKE_CALLER_IP },
      )
      if (registered.outcome !== 'registered') throw new Error('fixture failed to register')
      const recipient = registered.response.agent
      // Both handles, because the receipt names the giver: an offer store that
      // knew only the recipient would answer *a-citizen* and prove nothing.
      offers.citizen(agent.id, 'canary')
      offers.citizen(recipient.id, 'recipient')

      const giverSide = await connectedClient(colony, `Bearer ${apiKey}`)
      const recipientSide = await connectedClient(
        colony,
        `Bearer ${registered.response.credentials.apiKey}`,
      )

      const offer = offered(await give(giverSide.client, { accountId, to: 'recipient' }))

      return {
        offers,
        accountId,
        giver: agent,
        recipient,
        offerId: offer.offerId,
        client: recipientSide.client,
        giverClient: giverSide.client,
        close: async () => {
          await recipientSide.close()
          await giverSide.close()
        },
      }
    }

    const accept = async (
      client: Awaited<ReturnType<typeof pair>>['client'],
      args: { offerId: string; vaultKey?: string },
    ) =>
      client.callTool({
        name: 'kolonie.accounts.accept',
        arguments: { offerId: args.offerId, vaultKey: args.vaultKey ?? MINE },
      })

    it('moves the account, names the giver, and opens the parcel into the recipient’s vault', async () => {
      const { client, close, offers, accountId, giver: from, recipient, offerId } = await pair()

      const result = await accept(client, { offerId })

      expect(result.isError).toBeFalsy()
      expect(result.structuredContent).toMatchObject({
        fromHandle: 'canary',
        vaultKey: MINE,
        account: { kind: 'mailbox', identifier: 'spare@example.test', provider: 'mail.tm' },
      })

      // The move: one row where there were two, and it is the recipient's.
      expect(offers.row(accountId)).toBeUndefined()
      expect(offers.rowsOf(from.id)).toHaveLength(0)
      expect(offers.rowsOf(recipient.id)).toHaveLength(1)
      expect(offers.holdsVaultEntry(recipient.id, MINE)).toBe(true)
      // Decision 12 as `#1214` corrects it: the giver's own entry is still
      // there — what was handed over is a copy of the secret, not the giver's
      // filing — and it no longer opens, because custody went with the account.
      expect(offers.holdsVaultEntry(from.id, GIVER_VAULT_KEY)).toBe(true)
      expect(offers.spentVaultEntry(from.id, GIVER_VAULT_KEY)).toBe(true)
      expect(offers.isOpen(offerId)).toBe(false)

      const text = textOf(result)
      expect(text).toContain('spare@example.test')
      expect(text).toContain('canary')
      expect(text).toContain('kolonie.vault.get')

      await close()
    })

    /**
     * What a recipient is owed is the *absence* — the receipt has to say what
     * did not come with the account, because a recipient that assumed proof
     * came too will offer a mailbox to a quest it cannot pass the rung for.
     */
    it('arrives unproved and out of work matching, and the receipt says both', async () => {
      const { client, close, offers, recipient, offerId } = await pair()

      const result = await accept(client, { offerId })

      const arrived = offers.rowsOf(recipient.id)[0]
      expect(arrived).toMatchObject({ proved: false, forWork: false, vaultKey: MINE })

      const text = textOf(result)
      expect(text).toContain('unproved')
      // Named with the call that undoes it: *out of work matching* with no way
      // back is a sentence that reads as a penalty rather than as a default.
      expect(text).toContain('out of work matching')
      expect(text).toContain('kolonie.accounts.set')
      expect(text).toContain('forWork')

      await close()
    })

    /**
     * `#1213`, from the receiving end. A declared account moves with its
     * credential and arrives saying exactly what it said before: the register is
     * not made to agree with the transfer, because the transfer checked nothing.
     */
    it('takes a declared account, credential and all, without inventing a proof', async () => {
      const {
        client,
        close,
        offers,
        accountId,
        giver: from,
        recipient,
        offerId,
      } = await pair({ proved: false })

      const result = await accept(client, { offerId })

      expect(result.isError).toBeFalsy()
      expect(offers.row(accountId)).toBeUndefined()
      expect(offers.rowsOf(from.id)).toHaveLength(0)
      expect(offers.rowsOf(recipient.id)[0]).toMatchObject({ proved: false, vaultKey: MINE })
      expect(offers.holdsVaultEntry(recipient.id, MINE)).toBe(true)

      await close()
    })

    /**
     * Decision 5 arriving on this side. An offer written to a handle this
     * citizen does not hold is not *refused* — there is nothing to refuse,
     * because a parcel was never sealed for it — and the answer is the same
     * `not_found` as an id nobody ever issued.
     */
    it('answers an offer addressed to somebody else exactly as one that never existed', async () => {
      const { client, close, giverClient, offers, giver: from, offerId } = await pair()
      const elsewhere = offers.hold(from.id, {
        kind: 'mailbox',
        identifier: 'other@example.test',
      })
      const toSomebodyElse = offered(
        await give(giverClient, { accountId: elsewhere, to: 'a-third-citizen' }),
      ).offerId

      const theirs = refusal(await accept(client, { offerId: toSomebodyElse }))
      const nobodys = refusal(await accept(client, { offerId: randomUUID() }))

      expect(theirs.code).toBe('not_found')
      expect(theirs).toEqual(nobodys)
      // And the parcel was not read on the way to saying so. This is the
      // binding the storage does with the offer id: a refusal that had opened
      // it would have spent an offer the addressee can still take.
      expect(offers.isOpen(offerId)).toBe(true)
      expect(offers.hasParcel(offerId)).toBe(true)

      await close()
    })

    it('refuses a vault name the recipient is using, and leaves that entry and the offer alone', async () => {
      const { client, close, offers, accountId, recipient, offerId } = await pair()
      offers.storeVaultEntry(recipient.id, MINE)

      const refused = refusal(await accept(client, { offerId }))

      expect(refused.code).toBe('conflict')
      expect(refused.details).toMatchObject({ reason: 'vault_key_taken', vaultKey: MINE })
      // Nothing a giver does may destroy a credential the recipient relies on,
      // and nothing is spent saying so: the offer is still there to accept
      // under another name, and the account has not moved.
      expect(offers.isOpen(offerId)).toBe(true)
      expect(offers.row(accountId)).toBeDefined()
      expect(offers.rowsOf(recipient.id)).toHaveLength(0)

      const second = await accept(client, { offerId, vaultKey: 'mine/somewhere-else' })
      expect(second.isError).toBeFalsy()

      await close()
    })

    /**
     * The refusal the issue does not enumerate, and it has to exist: one row
     * per kind and identifier per citizen is a database constraint, and an
     * insert that met it inside the transaction would raise after the parcel
     * had already been unsealed.
     */
    it('refuses an account the recipient already holds under that identifier', async () => {
      const { client, close, offers, recipient, offerId } = await pair()
      offers.hold(recipient.id, {
        kind: 'mailbox',
        identifier: 'spare@example.test',
        vaultKey: 'mine/already',
      })

      const refused = refusal(await accept(client, { offerId }))

      expect(refused.code).toBe('conflict')
      expect(refused.details).toMatchObject({ reason: 'account_already_held' })
      expect(offers.isOpen(offerId)).toBe(true)
      // The entry it would have landed in was not written either.
      expect(offers.holdsVaultEntry(recipient.id, MINE)).toBe(false)

      await close()
    })

    it('cannot be accepted twice', async () => {
      const { client, close, offerId } = await pair()

      await accept(client, { offerId })
      const again = refusal(await accept(client, { offerId, vaultKey: 'mine/again' }))

      expect(again.code).toBe('not_found')

      await close()
    })

    describe('declining', () => {
      it('deletes the offer and its parcel, and leaves the account exactly where it was', async () => {
        const { client, close, offers, accountId, giver: from, recipient, offerId } = await pair()
        const before = offers.row(accountId)

        const result = await client.callTool({
          name: 'kolonie.accounts.decline',
          arguments: { offerId },
        })

        expect(result.isError).toBeFalsy()
        expect(result.structuredContent).toMatchObject({ offerId, declined: true })
        expect(textOf(result)).toContain('still theirs')
        expect(offers.isOpen(offerId)).toBe(false)
        expect(offers.hasParcel(offerId)).toBe(false)
        // Untouched, column for column — proved, listed, and still the giver's.
        expect(offers.row(accountId)).toEqual(before)
        expect(offers.rowsOf(from.id)).toHaveLength(1)
        expect(offers.rowsOf(recipient.id)).toHaveLength(0)
        expect(offers.holdsVaultEntry(recipient.id, MINE)).toBe(false)

        await close()
      })

      it('lets the giver hand the account to somebody else afterwards', async () => {
        const { client, close, giverClient, accountId, offerId } = await pair()

        await client.callTool({ name: 'kolonie.accounts.decline', arguments: { offerId } })
        const again = await give(giverClient, { accountId, to: 'second-thoughts' })

        expect(again.isError).toBeFalsy()
        expect(offered(again).toHandle).toBe('second-thoughts')

        await close()
      })

      it('answers somebody else’s offer and one nobody has, alike', async () => {
        const { client, close, giverClient, offers, giver: from, offerId } = await pair()
        const elsewhere = offers.hold(from.id, {
          kind: 'mailbox',
          identifier: 'other@example.test',
        })
        const toSomebodyElse = offered(
          await give(giverClient, { accountId: elsewhere, to: 'a-third-citizen' }),
        ).offerId

        const decline = (id: string) =>
          client.callTool({ name: 'kolonie.accounts.decline', arguments: { offerId: id } })

        const theirs = refusal(await decline(toSomebodyElse))
        const nobodys = refusal(await decline(randomUUID()))

        expect(theirs.code).toBe('not_found')
        expect(theirs).toEqual(nobodys)
        // And declining what was not addressed to you does not close it.
        expect(offers.isOpen(toSomebodyElse)).toBe(true)
        expect(offers.isOpen(offerId)).toBe(true)

        await close()
      })
    })
  })
})
