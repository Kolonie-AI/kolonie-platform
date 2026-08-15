import { describe, expect, it } from 'vitest'
import { connectedClient, registeredCitizen } from '../../__fixtures__/mcp.js'
import { fakeAccountThreads } from '../../__fixtures__/account-threads.js'
import type { FakeProviderRecipes } from '../../__fixtures__/provider-recipes.js'

/**
 * The account conversation over MCP (`#930`).
 *
 * What is asserted here is the surface: which tools exist, what each refusal
 * says, and the one rule that cannot be got wrong anywhere — **a secret's value
 * is not in a read, and taking is what spends it**. Whether the storage holds
 * its constraints is asserted in `packages/db` against a real database.
 */
describe('the account conversation', () => {
  const opened = async (options: { readonly carriesSecrets?: boolean } = {}) => {
    const { colony, apiKey, agent } = await registeredCitizen()
    const accountThreads = fakeAccountThreads(options)
    const account = accountThreads.addAccount({ agentId: agent.id, kind: 'mailbox' })
    const { client, close } = await connectedClient(
      { ...colony, accountThreads },
      `Bearer ${apiKey}`,
    )

    const episode = await client.callTool({
      name: 'kolonie.accounts.thread',
      arguments: {
        op: 'open',
        accountId: account.id,
        kind: 'acquisition',
        title: 'Opening the mailbox',
      },
    })

    const episodeId = (episode.structuredContent as { episode: { id: string } }).episode.id
    return { client, close, accountThreads, account, episodeId, agent }
  }

  /** The id of the one slot a `put` opened, which is what every take needs. */
  const onlySlot = (put: unknown): string =>
    (
      (put as { structuredContent: { slots: readonly { id: string }[] } }).structuredContent
        .slots[0] as { id: string }
    ).id

  it('is two tools and no more than two', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(
      { ...colony, accountThreads: fakeAccountThreads() },
      `Bearer ${apiKey}`,
    )

    const { tools } = await client.listTools()
    const names = tools
      .map((tool) => tool.name)
      .filter((name) => name.startsWith('kolonie.accounts.'))

    expect(names).toContain('kolonie.accounts.thread')
    expect(names).toContain('kolonie.accounts.take')
    // The conversation adds exactly these two to the account family. A seventh
    // operation is an argument on the issue rather than a third entry here.
    expect(names.filter((name) => name.endsWith('.thread') || name.endsWith('.take'))).toHaveLength(
      2,
    )

    await close()
  })

  it('answers a call with no arguments with the open episodes, the caller’s turn first', async () => {
    const { client, close, accountThreads, account } = await opened()

    // A second episode, waiting on the agent, opened after the first: date
    // ordering alone would bury it.
    const second = accountThreads.addAccount({ agentId: undefined as never })
    void second

    await client.callTool({
      name: 'kolonie.accounts.thread',
      arguments: {
        op: 'open',
        accountId: account.id,
        kind: 'maintenance',
        title: 'The password stopped working',
        turn: 'agent',
      },
    })

    const waking = await client.callTool({ name: 'kolonie.accounts.thread', arguments: {} })
    const listed = waking.structuredContent as {
      op: string
      episodes: readonly { episode: { turn: string; title: string } }[]
    }

    expect(listed.op).toBe('read')
    expect(listed.episodes).toHaveLength(2)
    expect(listed.episodes[0]?.episode.turn).toBe('agent')
    expect(listed.episodes[0]?.episode.title).toBe('The password stopped working')
    expect(JSON.stringify(waking.content)).toContain('1 on your turn')

    await close()
  })

  it('reports a secret slot as filled and never carries its value', async () => {
    const { client, close, episodeId } = await opened()

    await client.callTool({
      name: 'kolonie.accounts.thread',
      arguments: {
        op: 'put',
        episodeId,
        slots: [
          { label: 'the address', value: 'held@example.test' },
          { label: 'the password', value: 'not-in-any-listing', secret: true },
        ],
      },
    })

    const read = await client.callTool({
      name: 'kolonie.accounts.thread',
      arguments: { op: 'read', episodeId },
    })

    const slots = (
      read.structuredContent as {
        slots: readonly { label: string; secret: boolean; filled: boolean; value: string | null }[]
      }
    ).slots
    const secret = slots.find((slot) => slot.label === 'the password')
    const open = slots.find((slot) => slot.label === 'the address')

    expect(secret).toMatchObject({ secret: true, filled: true, value: null })
    // The one that is not a secret is a value a listing may carry, and does.
    expect(open).toMatchObject({ secret: false, filled: true, value: 'held@example.test' })
    expect(JSON.stringify(read)).not.toContain('not-in-any-listing')

    await close()
  })

  it('puts a secret in the vault on the way out, and refuses a second take without touching it', async () => {
    const { client, close, accountThreads, episodeId } = await opened()

    const put = await client.callTool({
      name: 'kolonie.accounts.thread',
      arguments: {
        op: 'put',
        episodeId,
        slots: [{ label: 'the password', value: 'the-one-value', secret: true }],
      },
    })

    const slotId = (put.structuredContent as { slots: readonly { id: string }[] }).slots[0]?.id

    const taken = await client.callTool({
      name: 'kolonie.accounts.take',
      arguments: { slotId, vaultKey: 'mailbox/held' },
    })

    expect(taken.structuredContent).toMatchObject({
      secret: true,
      value: null,
      vaultKey: 'mailbox/held',
    })
    // It went into the vault rather than back through the transcript.
    expect(JSON.stringify(taken)).not.toContain('the-one-value')
    expect([...accountThreads.vaultContents().values()]).toContain('the-one-value')

    const again = await client.callTool({
      name: 'kolonie.accounts.take',
      arguments: { slotId, vaultKey: 'mailbox/somewhere-else' },
    })

    expect(again.isError).toBe(true)
    expect(JSON.stringify(again.content)).toContain('mailbox/held')

    // **The rejection case `#930` names**: the refusal left the vault exactly as
    // the first take wrote it — one entry, under the first key, with its value.
    const vault = accountThreads.vaultContents()
    expect(vault.size).toBe(1)
    expect([...vault.keys()][0]).toContain('mailbox/held')

    await close()
  })

  it('hands back a slot that is not a secret, and does not spend it', async () => {
    const { client, close, episodeId } = await opened()

    const put = await client.callTool({
      name: 'kolonie.accounts.thread',
      arguments: {
        op: 'put',
        episodeId,
        slots: [{ label: 'the code', value: '482913' }],
      },
    })

    const slotId = (put.structuredContent as { slots: readonly { id: string }[] }).slots[0]?.id

    const first = await client.callTool({ name: 'kolonie.accounts.take', arguments: { slotId } })
    const second = await client.callTool({ name: 'kolonie.accounts.take', arguments: { slotId } })

    // A code that has already expired is not a secret, and a second look is what
    // rescues a lost clipboard.
    expect(first.structuredContent).toMatchObject({ secret: false, value: '482913', takenAt: null })
    expect(second.structuredContent).toMatchObject({ secret: false, value: '482913' })

    await close()
  })

  it('refuses a pass with no note, and names the field', async () => {
    const { client, close, episodeId } = await opened()

    const passed = await client.callTool({
      name: 'kolonie.accounts.thread',
      arguments: { op: 'pass', episodeId, turn: 'operator' },
    })

    expect(passed.isError).toBe(true)
    // The refusal names the field rather than describing it, so a caller can act
    // on the sentence without reading the schema.
    const said = JSON.parse((passed.content as readonly { text: string }[])[0]!.text) as {
      message: string
    }
    expect(said.message).toContain('the field is "note"')

    const read = await client.callTool({
      name: 'kolonie.accounts.thread',
      arguments: { op: 'read', episodeId },
    })
    // Nothing was passed, so the turn is where it was.
    expect((read.structuredContent as { episode: { turn: string } }).episode.turn).toBe('nobody')

    await close()
  })

  it('refuses a failure with no wall, and says abandoned is the honest alternative', async () => {
    const { client, close, episodeId } = await opened()

    const closed = await client.callTool({
      name: 'kolonie.accounts.thread',
      arguments: { op: 'close', episodeId, outcome: 'failed' },
    })

    expect(closed.isError).toBe(true)
    expect(JSON.stringify(closed.content)).toContain('abandoned')

    const withWall = await client.callTool({
      name: 'kolonie.accounts.thread',
      arguments: {
        op: 'close',
        episodeId,
        outcome: 'failed',
        wall: 'The provider asked for a phone number no agent holds.',
      },
    })

    expect(withWall.structuredContent).toMatchObject({
      op: 'close',
      episode: { outcome: 'failed', turn: 'nobody' },
    })

    await close()
  })

  it('refuses an operation it does not have, and names the ones it does', async () => {
    const { client, close, episodeId } = await opened()

    const nonsense = await client.callTool({
      name: 'kolonie.accounts.thread',
      arguments: { op: 'delete', episodeId },
    })

    expect(nonsense.isError).toBe(true)
    const said = JSON.stringify(nonsense.content)
    for (const op of ['open', 'put', 'read', 'note', 'pass', 'close']) expect(said).toContain(op)
    expect(said).toContain('Nothing was written')

    await close()
  })

  it('answers an episode that is not the caller’s as one that does not exist', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const accountThreads = fakeAccountThreads()
    // An account on somebody else's record, with an episode on it.
    const elsewhere = accountThreads.addAccount({
      agentId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' as never,
    })
    const thread = await accountThreads.thread(elsewhere.id)
    const theirs = await accountThreads.openEpisode({
      threadId: thread!.id,
      openedBy: 'agent',
      kind: 'maintenance',
      title: 'Not yours',
    })

    const { client, close } = await connectedClient(
      { ...colony, accountThreads },
      `Bearer ${apiKey}`,
    )

    const read = await client.callTool({
      name: 'kolonie.accounts.thread',
      arguments: { op: 'read', episodeId: String(theirs.episode.id) },
    })

    expect(read.isError).toBe(true)
    // `not_found` rather than `forbidden`: an id must not become a way to learn
    // that somebody else holds one.
    expect(JSON.stringify(read.content)).toContain('No episode of yours has that id')

    await close()
  })

  /**
   * The other direction (`#931`).
   *
   * The half above is the agent filling a slot. These are the half where the
   * agent *asks* — the slot is opened empty, the operator answers it from a page
   * they sign in to, and the value lands in the vault under a name the agent
   * chose before anybody was asked for anything.
   */
  describe('a slot the operator owes', () => {
    it('lands in the vault under the key the agent named at the ask', async () => {
      const { client, close, accountThreads, episodeId, agent } = await opened()
      accountThreads.addOperator(agent.id, 'the-person')

      const put = await client.callTool({
        name: 'kolonie.accounts.thread',
        arguments: {
          op: 'put',
          episodeId,
          slots: [
            {
              label: 'the password',
              secret: true,
              awaits: 'operator',
              vaultKey: 'mailbox/held',
            },
          ],
        },
      })

      const slotId = onlySlot(put)
      // Opened empty and waiting: the read says which, because *nothing here
      // yet* and *your operator owes this* are not the same state.
      const asked = await client.callTool({
        name: 'kolonie.accounts.thread',
        arguments: { op: 'read', episodeId },
      })
      expect(JSON.stringify(asked.content)).toContain('waiting on your operator')

      const filled = await accountThreads.fillAsOperator({
        slotId: slotId as never,
        humanId: 'the-person',
        value: 'what-the-operator-typed',
      })
      expect(filled.outcome).toBe('filled')

      // No key at the take: it was named at the ask, and the take does not get
      // to move it.
      const taken = await client.callTool({
        name: 'kolonie.accounts.take',
        arguments: { slotId },
      })

      expect(taken.structuredContent).toMatchObject({
        secret: true,
        value: null,
        vaultKey: 'mailbox/held',
      })
      expect(JSON.stringify(taken)).not.toContain('what-the-operator-typed')
      expect([...accountThreads.vaultContents().values()]).toContain('what-the-operator-typed')

      await close()
    })

    it('is refused, with nothing written and nobody asked, when the name is already in use', async () => {
      const { client, close, accountThreads, episodeId, agent } = await opened()
      await accountThreads.vaultClaim('', agent.id, 'mailbox/held', 'the-one-already-there')
      const before = accountThreads.vaultContents()

      const refused = await client.callTool({
        name: 'kolonie.accounts.thread',
        arguments: {
          op: 'put',
          episodeId,
          slots: [
            { label: 'the address', value: 'held@example.test' },
            { label: 'the password', secret: true, awaits: 'operator', vaultKey: 'mailbox/held' },
          ],
        },
      })

      expect(refused.isError).toBe(true)
      const said = JSON.parse((refused.content as readonly { text: string }[])[0]!.text) as {
        message: string
      }
      expect(said.message).toContain('mailbox/held')

      /**
       * **The rejection case `#931` names.** The entry that was there is
       * byte-for-byte what it was — and the slot beside it, which was perfectly
       * well formed, was not opened either: `put` checks every slot before it
       * writes any, so a refusal leaves the episode where it stood.
       */
      expect(accountThreads.vaultContents()).toEqual(before)
      const read = await client.callTool({
        name: 'kolonie.accounts.thread',
        arguments: { op: 'read', episodeId },
      })
      expect((read.structuredContent as { slots: readonly unknown[] }).slots).toHaveLength(0)

      await close()
    })

    it('refuses a description that contradicts itself, and says which slot it was', async () => {
      const { client, close, episodeId } = await opened()

      const both = await client.callTool({
        name: 'kolonie.accounts.thread',
        arguments: {
          op: 'put',
          episodeId,
          slots: [{ label: 'the password', awaits: 'operator', value: 'mine-already' }],
        },
      })
      expect(both.isError).toBe(true)
      expect(JSON.stringify(both.content)).toContain('the password')

      const nowhereToLand = await client.callTool({
        name: 'kolonie.accounts.thread',
        arguments: {
          op: 'put',
          episodeId,
          slots: [{ label: 'the password', awaits: 'operator', secret: true }],
        },
      })
      expect(nowhereToLand.isError).toBe(true)
      // Named rather than described: the caller can act on the sentence.
      expect(JSON.stringify(nowhereToLand.content)).toContain('vaultKey')

      await close()
    })

    it('is destroyed by closing the episode, before its timer and before anybody read it', async () => {
      const { client, close, accountThreads, episodeId, agent } = await opened()
      accountThreads.addOperator(agent.id, 'the-person')

      const put = await client.callTool({
        name: 'kolonie.accounts.thread',
        arguments: {
          op: 'put',
          episodeId,
          slots: [{ label: 'the password', value: 'unread-when-it-closed', secret: true }],
        },
      })
      const slotId = onlySlot(put)

      await client.callTool({
        name: 'kolonie.accounts.thread',
        arguments: { op: 'close', episodeId, outcome: 'abandoned' },
      })

      const taken = await client.callTool({ name: 'kolonie.accounts.take', arguments: { slotId } })
      expect(taken.isError).toBe(true)
      expect(JSON.stringify(taken.content)).toContain('destroyed when its episode closes')
      expect(JSON.stringify(taken)).not.toContain('unread-when-it-closed')

      // The operator's side is shut in the same act, and by the same fact:
      // there is nothing in the slot to read from either end.
      const theirs = await accountThreads.readAsOperator(slotId as never, 'the-person')
      expect(theirs.outcome).toBe('closed')
      expect([...accountThreads.vaultContents().values()]).not.toContain('unread-when-it-closed')

      await close()
    })
  })

  it('refuses a secret where the Colony has no key, and keeps the rest of the conversation', async () => {
    const { client, close, episodeId } = await opened({ carriesSecrets: false })

    const refused = await client.callTool({
      name: 'kolonie.accounts.thread',
      arguments: {
        op: 'put',
        episodeId,
        slots: [{ label: 'the password', value: 'nowhere-to-put-this', secret: true }],
      },
    })

    expect(refused.isError).toBe(true)
    expect(JSON.stringify(refused.content)).toContain('kolonie.support.open')

    // The conversation itself still works — which is the whole reason the
    // surface does not disappear with the key.
    const noted = await client.callTool({
      name: 'kolonie.accounts.thread',
      arguments: {
        op: 'note',
        episodeId,
        note: 'The password has to change hands some other way.',
      },
    })

    expect(noted.isError).toBeFalsy()
    expect(noted.structuredContent).toMatchObject({ op: 'note' })

    await close()
  })

  /**
   * What the close hands back when the account is now real (`#933`).
   *
   * An acquisition that settled leaves the citizen holding an account it has
   * said nothing about — so the close carries the declaration prefilled from
   * the row it is closing, and, where an operator put a password in, the one
   * sentence about it that is worth saying. Both are derived at the close and
   * stored nowhere: D-002, and the reason `filledBy` survives the destruction.
   */
  describe('what a settled acquisition hands back', () => {
    const closedWith = async (
      outcome: string,
      options: { readonly operatorPassword?: boolean } = {},
    ) => {
      const { client, close, accountThreads, episodeId, agent } = await opened()

      if (options.operatorPassword === true) {
        accountThreads.addOperator(agent.id, 'the-person')
        const asked = await client.callTool({
          name: 'kolonie.accounts.thread',
          arguments: {
            op: 'put',
            episodeId,
            slots: [
              { label: 'the password', secret: true, awaits: 'operator', vaultKey: 'mailbox/held' },
            ],
          },
        })
        await accountThreads.fillAsOperator({
          slotId: onlySlot(asked) as never,
          humanId: 'the-person',
          value: 'the-one-they-chose',
        })
      }

      const closed = await client.callTool({
        name: 'kolonie.accounts.thread',
        arguments: { op: 'close', episodeId, outcome, wall: 'nothing worked' },
      })

      return { closed, close }
    }

    it('prefills the declaration from the account it just settled', async () => {
      const { closed, close } = await closedWith('created')

      expect(closed.structuredContent).toMatchObject({
        declares: {
          call: 'kolonie.accounts.declare',
          arguments: { kind: 'mailbox', identifier: 'held@example.test' },
        },
      })

      await close()
    })

    /**
     * An episode that failed settled nothing, so there is no account to declare
     * and offering one would be an invitation to write down something that does
     * not exist.
     */
    it('offers no declaration on an episode that did not settle', async () => {
      const { closed, close } = await closedWith('failed')

      expect(closed.structuredContent).not.toHaveProperty('declares')
      expect(closed.structuredContent).not.toHaveProperty('advice')

      await close()
    })

    /**
     * The password sentence, and the shape of it: the account is the agent's
     * now, and **nothing here requires anything**. A close that told a citizen
     * it must rotate the password would be the Colony issuing an instruction
     * about an account it does not hold.
     */
    it('says the password is the agent’s to change, when an operator set one', async () => {
      const { closed, close } = await closedWith('taken-over', { operatorPassword: true })

      const advice = (closed.structuredContent as { advice?: string }).advice
      expect(advice).toContain('An operator set a password')
      expect(advice).toContain('yours to decide')
      // Derived from the slot after the close destroyed its value, never from
      // the value itself.
      expect(JSON.stringify(closed)).not.toContain('the-one-they-chose')

      await close()
    })

    it('says nothing about a password nobody set', async () => {
      const { closed, close } = await closedWith('taken-over')

      expect(closed.structuredContent).not.toHaveProperty('advice')

      await close()
    })
  })

  /**
   * What the Atlas has on the provider, carried into the conversation (`#936`).
   *
   * **On the read as well as the open**, which is the half worth asserting: the
   * acquisition an operator starts from the wish list is opened by the operator,
   * so the agent's first sight of it is a `read`. A fragment that rode only on
   * `open` would miss the exact case the issue is about.
   *
   * **It decides nothing.** A provider recorded as refused is reported as
   * refused and the episode carries on, because a walk somebody made a year ago
   * is evidence and not a verdict.
   */
  describe('what the Atlas has on the provider', () => {
    const about = async (
      seed: (recipes: FakeProviderRecipes) => void,
      account: { readonly provider?: string | null } = {},
    ) => {
      const { colony, apiKey, agent } = await registeredCitizen()
      const accountThreads = fakeAccountThreads()
      seed(colony.recipes)
      const held = accountThreads.addAccount({
        agentId: agent.id,
        kind: 'mailbox',
        provider: account.provider === undefined ? 'mail.example' : account.provider,
      })
      const { client, close } = await connectedClient(
        { ...colony, accountThreads },
        `Bearer ${apiKey}`,
      )

      const opening = await client.callTool({
        name: 'kolonie.accounts.thread',
        arguments: {
          op: 'open',
          accountId: held.id,
          kind: 'acquisition',
          title: 'Getting you a mailbox at mail.example',
        },
      })
      const episodeId = (opening.structuredContent as { episode: { id: string } }).episode.id
      const read = await client.callTool({
        name: 'kolonie.accounts.thread',
        arguments: { op: 'read', episodeId },
      })

      return { opening, read, close }
    }

    it('hands the steps over on both the open and the read', async () => {
      const { opening, read, close } = await about((recipes) => {
        recipes.write({
          kind: 'mailbox',
          provider: 'mail.example',
          status: 'joinable',
          steps: [
            { actor: 'agent', instruction: 'sign up with the address you already hold' },
            { actor: 'operator', instruction: 'accept the terms' },
          ],
        })
      })

      for (const answered of [opening, read]) {
        expect(answered.structuredContent).toMatchObject({
          atlas: {
            state: 'walked',
            provider: 'mail.example',
            kind: 'mailbox',
            reviewed: true,
            operatorSteps: 1,
          },
        })
        expect(JSON.stringify(answered)).toContain('sign up with the address you already hold')
      }

      await close()
    })

    it('reports a refusal and opens the episode anyway', async () => {
      const { opening, read, close } = await about(
        (recipes) => {
          recipes.write({ kind: 'mailbox', provider: 'shut.example', status: 'refused' })
        },
        { provider: 'shut.example' },
      )

      expect(opening.structuredContent).toHaveProperty('episode')
      expect(read.structuredContent).toMatchObject({
        atlas: { state: 'closed', withdrawn: false, reason: 'no honest route in' },
      })

      await close()
    })

    it('says the provider is unwalked when nobody has written one down', async () => {
      const { read, close } = await about(() => {})

      expect(read.structuredContent).toMatchObject({
        atlas: { state: 'unwalked', provider: 'mail.example' },
      })

      await close()
    })

    /**
     * An account naming no provider is nothing the Atlas can be asked about, and
     * *unwalked* would be an answer to a question nobody put.
     */
    it('carries nothing where the account names no provider', async () => {
      const { opening, read, close } = await about(() => {}, { provider: null })

      expect(opening.structuredContent).not.toHaveProperty('atlas')
      expect(read.structuredContent).not.toHaveProperty('atlas')

      await close()
    })
  })
})
