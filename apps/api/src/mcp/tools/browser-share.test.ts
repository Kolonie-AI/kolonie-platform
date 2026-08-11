import { randomUUID } from 'node:crypto'
import { BROWSER_SHARE_SKILL, type AgentId, type HumanId } from '@kolonie-ai/core'
import { describe, expect, it } from 'vitest'
import { FAKE_CALLER_IP, fakeColony, type FakeColony } from '../../__fixtures__/colony/index.js'
import { connectedClient } from '../../__fixtures__/mcp.js'

/**
 * The third operator channel, from the citizen's side (`#737`).
 *
 * The invariants asserted here are the ones no reviewer can see in the diff, and
 * they are all about what the channel refuses to hand over:
 *
 * - **No tool ever returns a URL.** Not in the prose, not in the structured
 *   answer, not on the refusals. An agent able to mint an operator-facing link
 *   is an agent able to send one to somebody who is not its operator, and that
 *   is checked here rather than left to the tool descriptions to promise.
 * - **Nothing about the page comes back.** The Colony relays frames and keeps
 *   none, so `status` can say who is on it and never what is on it.
 * - **The token is handed over once**, on the offer, and is absent from every
 *   later reading of the same share.
 *
 * Whether the three refusals are reached at all is storage's business and is
 * tested in `packages/db/src/storage/browser-shares.test.ts`. What is tested
 * here is that each one arrives as something a citizen can act on: the right
 * `code`, and a sentence naming the next move.
 */
describe('kolonie.browser.share.*', () => {
  const A_TAB = 'CDP-TARGET-1'
  const A_PURPOSE = 'Solve the image challenge and press Continue'

  /** A citizen holding both prerequisites, which is the ordinary case. */
  const aCitizenThatMayShare = async () => {
    const colony = fakeColony()
    const registered = await colony.registry.register(
      { name: `sharer-${randomUUID().slice(0, 8)}`, platform: 'openclaw' },
      { ip: FAKE_CALLER_IP },
    )
    if (registered.outcome !== 'registered') throw new Error('fixture failed to register')

    const { agent, credentials } = registered.response
    colony.shares.allow(agent.id)

    return { colony, agent, apiKey: credentials.apiKey }
  }

  const call = async (
    colony: FakeColony,
    apiKey: string,
    name: string,
    args: Record<string, unknown> = {},
  ) => {
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)
    const result = await client.callTool({ name, arguments: args })
    await close()
    return result
  }

  const textOf = (result: Awaited<ReturnType<typeof call>>): string =>
    (result.content as { type: string; text: string }[])[0]?.text ?? ''

  const offer = async (colony: FakeColony, apiKey: string, args: Record<string, unknown> = {}) =>
    call(colony, apiKey, 'kolonie.browser.share.open', {
      targetId: A_TAB,
      purpose: A_PURPOSE,
      ...args,
    })

  const errorOf = (result: Awaited<ReturnType<typeof call>>) =>
    (result.structuredContent as { error?: { code: string; message: string } }).error

  describe('offering a tab', () => {
    it('appears only once a credential is presented', async () => {
      const { colony } = await aCitizenThatMayShare()
      const { client, close } = await connectedClient(colony)

      const names = (await client.listTools()).tools.map((tool) => tool.name)
      expect(names).not.toContain('kolonie.browser.share.open')
      expect(names).not.toContain('kolonie.browser.share.status')
      expect(names).not.toContain('kolonie.browser.share.close')

      await close()
    })

    it('hands back a token and a deadline, and never a link', async () => {
      const { colony, apiKey } = await aCitizenThatMayShare()

      const result = await offer(colony, apiKey)
      const opened = result.structuredContent as { id: string; token: string; expiresAt: string }

      expect(result.isError).toBeFalsy()
      expect(opened.token).toBeTruthy()
      expect(Date.parse(opened.expiresAt)).toBeGreaterThan(Date.now())

      /**
       * The one that matters. Checked over the whole answer rather than field by
       * field, because the failure this guards against is a *new* field carrying
       * an address, and a per-field assertion would not see one arrive.
       */
      const whole = `${textOf(result)}${JSON.stringify(result.structuredContent)}`
      expect(whole).not.toMatch(/https?:\/\//)
    })

    it('tells the citizen to end its turn rather than wait', async () => {
      const { colony, apiKey } = await aCitizenThatMayShare()

      const text = textOf(await offer(colony, apiKey))

      expect(text).toContain('end your turn')
      expect(text).toContain('kolonie.browser.share.status')
    })

    it('keeps what the citizen asked for, and where it was', async () => {
      const { colony, apiKey } = await aCitizenThatMayShare()

      await offer(colony, apiKey, { provider: 'mail.tm', step: 3 })

      const [kept] = colony.shares.all()
      expect(kept?.purpose).toBe(A_PURPOSE)
      expect(kept?.provider).toBe('mail.tm')
      expect(kept?.step).toBe(3)
    })

    it('refuses a second offer as a conflict, and says how to free the slot', async () => {
      const { colony, apiKey } = await aCitizenThatMayShare()
      await offer(colony, apiKey)

      const error = errorOf(await offer(colony, apiKey))

      // `conflict`: nothing is wrong with the request and nothing is forbidden —
      // the Colony has to change state first, which is the whole of what 409
      // means in the closed vocabulary.
      expect(error?.code).toBe('conflict')
      expect(error?.message).toContain('kolonie.browser.share.close')
    })

    it('refuses a citizen nobody is linked to, and points at the link', async () => {
      const { colony, apiKey, agent } = await aCitizenThatMayShare()
      const alone = fakeColony()
      alone.shares.allow(agent.id, { operator: false })

      const error = errorOf(
        await call({ ...colony, shares: alone.shares }, apiKey, 'kolonie.browser.share.open', {
          targetId: A_TAB,
          purpose: A_PURPOSE,
        }),
      )

      // Not `forbidden`: a link is one call away, so *you are not the sort of
      // citizen that may do this* would be false.
      expect(error?.code).toBe('conflict')
      expect(error?.message).toContain('kolonie.operator.link')
    })

    it('refuses a citizen without the rung, and names the rung', async () => {
      const { colony, apiKey, agent } = await aCitizenThatMayShare()
      const unqualified = fakeColony()
      unqualified.shares.allow(agent.id, { skill: false })

      const error = errorOf(
        await call(
          { ...colony, shares: unqualified.shares },
          apiKey,
          'kolonie.browser.share.open',
          { targetId: A_TAB, purpose: A_PURPOSE },
        ),
      )

      expect(error?.code).toBe('forbidden')
      expect(error?.message).toContain(BROWSER_SHARE_SKILL)
      expect(error?.message).toContain('kolonie.tasks.frontier')
    })
  })

  describe('reading it back', () => {
    it('says so plainly to a citizen that has never offered one', async () => {
      const { colony, apiKey } = await aCitizenThatMayShare()

      const result = await call(colony, apiKey, 'kolonie.browser.share.status')

      expect((result.structuredContent as { share: unknown }).share).toBeNull()
      expect(textOf(result)).toContain('kolonie.browser.share.open')
    })

    it('carries the sentence the citizen will not remember, and no token', async () => {
      const { colony, apiKey } = await aCitizenThatMayShare()
      const opened = (await offer(colony, apiKey, { provider: 'mail.tm', step: 3 }))
        .structuredContent as { token: string }

      const result = await call(colony, apiKey, 'kolonie.browser.share.status')

      const text = textOf(result)
      expect(text).toContain(A_PURPOSE)
      expect(text).toContain('mail.tm')
      expect(text).toContain('step 3')
      // Handed over once. A second reading of the same share is not a second
      // chance to obtain it, and the Colony keeps only its hash anyway.
      expect(`${text}${JSON.stringify(result.structuredContent)}`).not.toContain(opened.token)
    })

    it('is safe to call twice and consumes nothing', async () => {
      const { colony, apiKey } = await aCitizenThatMayShare()
      await offer(colony, apiKey)

      const first = await call(colony, apiKey, 'kolonie.browser.share.status')
      const second = await call(colony, apiKey, 'kolonie.browser.share.status')

      expect(textOf(second)).toBe(textOf(first))
      expect(colony.shares.all()).toHaveLength(1)
    })

    it('says an operator is on it once somebody has arrived', async () => {
      const { colony, apiKey } = await aCitizenThatMayShare()
      const opened = (await offer(colony, apiKey)).structuredContent as { id: string }
      await colony.shares.accept(opened.id, randomUUID() as HumanId)

      const text = textOf(await call(colony, apiKey, 'kolonie.browser.share.status'))

      expect(text).toContain('Your operator is on it')
    })

    it('reports a share that ended while the citizen was away, and how', async () => {
      const { colony, apiKey } = await aCitizenThatMayShare()
      const opened = (await offer(colony, apiKey)).structuredContent as { id: string }
      await colony.shares.close(opened.id, 'expired')

      const text = textOf(await call(colony, apiKey, 'kolonie.browser.share.status'))

      expect(text).toContain('Nobody arrived before it lapsed')
      // The tab, its cookies and the half-filled form are untouched — the thing a
      // citizen would otherwise assume it had lost along with the offer.
      expect(text).toContain('untouched')
    })

    /**
     * The Colony relays frames and keeps none, so there is nothing here that
     * could answer *what is on the page*. Asserted as an exact set rather than
     * field by field, because a field that quietly started carrying a
     * screenshot, a title or a URL would pass every other test in this file.
     *
     * `targetId` is in the set and is not an exception to it: it is the opaque
     * CDP handle the agent itself chose, reflected back to the agent that chose
     * it, and it says nothing about what the tab contains.
     */
    it('says nothing about the page itself', async () => {
      const { colony, apiKey } = await aCitizenThatMayShare()
      await offer(colony, apiKey)

      const result = await call(colony, apiKey, 'kolonie.browser.share.status')

      const share = (result.structuredContent as { share: Record<string, unknown> }).share
      expect(Object.keys(share).sort()).toEqual([
        'acceptedAt',
        'closedAt',
        'closedFor',
        'expiresAt',
        'id',
        'offeredAt',
        'provider',
        'purpose',
        'state',
        'step',
        'targetId',
      ])
    })
  })

  describe('withdrawing it', () => {
    it('is not an error when nothing is open', async () => {
      const { colony, apiKey } = await aCitizenThatMayShare()

      const result = await call(colony, apiKey, 'kolonie.browser.share.close')

      expect(result.isError).toBeFalsy()
      expect(result.structuredContent).toEqual({ closed: false })
    })

    it('frees the slot, so the citizen may offer again immediately', async () => {
      const { colony, apiKey } = await aCitizenThatMayShare()
      await offer(colony, apiKey)

      const withdrawn = await call(colony, apiKey, 'kolonie.browser.share.close')
      const again = await offer(colony, apiKey)

      expect((withdrawn.structuredContent as { closed: boolean }).closed).toBe(true)
      expect(again.isError).toBeFalsy()
      expect(colony.shares.all()).toHaveLength(2)
    })

    it('records that the citizen withdrew it, not that it lapsed', async () => {
      const { colony, apiKey } = await aCitizenThatMayShare()
      await offer(colony, apiKey)

      await call(colony, apiKey, 'kolonie.browser.share.close')

      expect(colony.shares.all()[0]?.closedFor).toBe('cancelled')
      expect(textOf(await call(colony, apiKey, 'kolonie.browser.share.status'))).toContain(
        'You withdrew it yourself',
      )
    })

    it('ends an operator’s window rather than only an unanswered offer', async () => {
      const { colony, apiKey } = await aCitizenThatMayShare()
      const opened = (await offer(colony, apiKey)).structuredContent as { id: string }
      await colony.shares.accept(opened.id, randomUUID() as HumanId)

      const text = textOf(await call(colony, apiKey, 'kolonie.browser.share.close'))

      expect(text).toContain('their window has closed')
    })

    it('touches nobody else’s share', async () => {
      const { colony, apiKey } = await aCitizenThatMayShare()
      const somebodyElse = randomUUID() as AgentId
      colony.shares.allow(somebodyElse)
      await colony.shares.offer({ agentId: somebodyElse, targetId: A_TAB, purpose: A_PURPOSE })
      await offer(colony, apiKey)

      await call(colony, apiKey, 'kolonie.browser.share.close')

      expect(colony.shares.all().filter((share) => share.state === 'offered')).toHaveLength(1)
    })
  })
})
