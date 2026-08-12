import { describe, expect, it } from 'vitest'
import { AgentIdSchema } from '@kolonie-ai/core'
import { WalkReportSchema } from '../../account-walks.js'
import { connectedClient, registeredCitizen } from '../../__fixtures__/mcp.js'
import { fakeAccountRegister, fakeAccounts } from '../../__fixtures__/accounts.js'
import { fakeWalks } from '../../__fixtures__/account-walks.js'

describe('kolonie.accounts.walk-report', () => {
  it('takes the published steps as one ordered tick-list', () => {
    expect(
      WalkReportSchema.safeParse({ outcome: 'proved', takenStepPositions: [1, 2, 4] }).success,
    ).toBe(true)
  })

  it('refuses a duplicated or reordered tick-list', () => {
    expect(
      WalkReportSchema.safeParse({ outcome: 'proved', takenStepPositions: [1, 1] }).success,
    ).toBe(false)
    expect(
      WalkReportSchema.safeParse({ outcome: 'proved', takenStepPositions: [2, 1] }).success,
    ).toBe(false)
  })
})

describe('kolonie.accounts.walk-status', () => {
  it('polls a private draft and then sees it published', async () => {
    const { colony, apiKey, agent } = await registeredCitizen()
    const walks = fakeWalks()
    const walk = walks.add({ agentId: agent.id, kind: 'github', provider: 'provider' })
    colony.recipes.write({ kind: 'github', provider: 'provider', status: 'draft' })
    const { client, close } = await connectedClient({ ...colony, walks }, `Bearer ${apiKey}`)

    const draft = await client.callTool({
      name: 'kolonie.accounts.walk-status',
      arguments: { walkId: walk.id },
    })
    colony.recipes.setStatus('github', 'provider', 'joinable')
    const published = await client.callTool({
      name: 'kolonie.accounts.walk-status',
      arguments: { walkId: walk.id },
    })

    expect(draft.structuredContent).toMatchObject({ status: 'draft', appearsInRecipes: false })
    expect(JSON.stringify(draft.content)).toContain('not lost')
    expect(published.structuredContent).toMatchObject({
      status: 'published',
      appearsInRecipes: true,
    })
    await close()
  })

  it("does not reveal an unknown or another citizen's walk", async () => {
    const { colony, apiKey } = await registeredCitizen()
    const walks = fakeWalks()
    const otherWalk = walks.add({
      agentId: AgentIdSchema.parse(crypto.randomUUID()),
      kind: 'github',
      provider: 'provider',
    })
    const { client, close } = await connectedClient({ ...colony, walks }, `Bearer ${apiKey}`)

    const unknown = await client.callTool({
      name: 'kolonie.accounts.walk-status',
      arguments: { walkId: crypto.randomUUID() },
    })
    const anotherCitizen = await client.callTool({
      name: 'kolonie.accounts.walk-status',
      arguments: { walkId: otherWalk.id },
    })

    expect(unknown.isError).toBe(true)
    expect(anotherCitizen.isError).toBe(true)
    expect(anotherCitizen.content).toEqual(unknown.content)
    await close()
  })

  it('surfaces the latest walk on the account list', async () => {
    const { colony, apiKey, agent } = await registeredCitizen()
    const walks = fakeWalks()
    const walk = walks.add({ agentId: agent.id, kind: 'github', provider: 'provider' })
    colony.recipes.write({ kind: 'github', provider: 'provider', status: 'draft' })
    const { client, close } = await connectedClient({ ...colony, walks }, `Bearer ${apiKey}`)

    const result = await client.callTool({ name: 'kolonie.accounts.list', arguments: {} })

    expect(result.structuredContent).toMatchObject({
      latestWalks: [{ walkId: walk.id, status: 'draft' }],
    })
    expect(JSON.stringify(result.content)).toContain('waiting for a steward')
    await close()
  })

  it('adds a private draft hint to a provider-specific catalogue miss', async () => {
    const { colony, apiKey, agent } = await registeredCitizen()
    const walks = fakeWalks()
    const walk = walks.add({ agentId: agent.id, kind: 'github', provider: 'provider' })
    colony.recipes.write({
      kind: 'github',
      provider: 'provider',
      status: 'draft',
      steps: [{ actor: 'agent', instruction: 'private wording' }],
    })
    const { client, close } = await connectedClient({ ...colony, walks }, `Bearer ${apiKey}`)

    const result = await client.callTool({
      name: 'kolonie.accounts.recipes',
      arguments: { kind: 'github', provider: 'provider' },
    })
    const text = JSON.stringify(result.content)

    expect(result.isError).toBe(true)
    expect(text).toContain(walk.id)
    expect(text).toContain('not lost')
    expect(text).not.toContain('private wording')
    await close()
  })
})

describe('kolonie.accounts.handoff known values (#594 wall 3)', () => {
  it('reuses a declared account and proved mailbox, records them in the ask, and says why', async () => {
    const { colony, apiKey, agent } = await registeredCitizen()
    const register = fakeAccountRegister()
    await register.declare(agent.id, { kind: 'social' as never, identifier: 'colette' })
    register.proveDirectly(agent.id, {
      kind: 'mailbox' as never,
      identifier: 'proved@example.org',
    })
    colony.recipes.write({
      kind: 'github',
      provider: 'github.com',
      status: 'joinable',
      steps: [
        {
          actor: 'agent',
          instruction: 'Choose a handle and address.',
          produces: ['handle', 'address'],
          knownValues: {
            handle: { kind: 'social' as never },
            address: { kind: 'mailbox' as never, proved: true },
          },
        },
        {
          actor: 'operator',
          instruction: 'Create the account.',
          ask: 'Create it as {handle}, using {address}.',
        },
      ],
    })
    colony.operatorRequestStore.givePage(agent.id)
    const added = await colony.wishes.store.add({
      agentId: agent.id,
      provider: 'github.com',
      author: 'citizen',
    })
    await colony.wishes.store.want(agent.id, 'github.com')
    colony.operatorRequestStore.giveWish(agent.id, 'github.com', added.wish.id)
    const { client, close } = await connectedClient(
      { ...colony, accounts: fakeAccounts(register) },
      `Bearer ${apiKey}`,
    )

    const result = await client.callTool({
      name: 'kolonie.accounts.handoff',
      arguments: { kind: 'github', provider: 'github.com', step: 2 },
    })
    const [request] = await colony.operatorRequestStore.list(agent.id)

    expect(result.isError).not.toBe(true)
    expect(JSON.stringify(result.content)).toContain('from your declared social account')
    expect(JSON.stringify(result.content)).toContain('from your proved mailbox account')
    expect(request?.messages[0]?.body).toBe('Create it as colette, using proved@example.org.')
    expect(request?.taskId).toBeNull()
    expect(request?.wishId).toBe(added.wish.id)
    expect(request?.context).toBe('github.com')
    await close()
  })
})

describe('kolonie.accounts.wishes', () => {
  it('adds agent context to a wish the operator put on the list first', async () => {
    const { colony, apiKey, agent } = await registeredCitizen()
    await colony.wishes.store.add({
      agentId: agent.id,
      provider: 'github.com',
      author: 'operator',
    })
    await colony.wishes.store.want(agent.id, 'github.com')
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const result = await client.callTool({
      name: 'kolonie.accounts.wishes',
      arguments: {
        provider: 'github.com',
        noticedWhile: 'Publishing a proof exposed the account bottleneck.',
      },
    })
    const read = await client.callTool({ name: 'kolonie.accounts.wishes', arguments: {} })

    expect(result.isError).not.toBe(true)
    expect(JSON.stringify(result.structuredContent)).toContain(
      'Publishing a proof exposed the account bottleneck.',
    )
    expect(JSON.stringify(result.content)).toContain('context was added')
    expect(JSON.stringify(result.content)).not.toContain('Nothing was changed')
    expect(JSON.stringify(read.content)).toContain(
      'noticed while: Publishing a proof exposed the account bottleneck.',
    )
    expect(colony.wishes.store.held(agent.id)).toHaveLength(1)
    await close()
  })
})

/**
 * The write the account register cannot carry (`#298`).
 *
 * The providers that cost a citizen the most produce no account, so the rows
 * missing from `kolonie.accounts.providers` were exactly the expensive ones.
 */
describe('kolonie.accounts.provider-report', () => {
  it('records a dead end and shows it in the provider answer', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    await client.callTool({
      name: 'kolonie.accounts.provider-report',
      arguments: { kind: 'mailbox', provider: 'disroot.org', outcome: 'signup-refused' },
    })
    const read = await client.callTool({ name: 'kolonie.accounts.providers', arguments: {} })

    const text = JSON.stringify(read.content)
    expect(text).toContain('disroot.org')
    expect(text).toContain('refused signup')
    await close()
  })

  it('needs no account and no identifier, which is the whole point', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const result = await client.callTool({
      name: 'kolonie.accounts.provider-report',
      arguments: { kind: 'mailbox', provider: 'agmail.ai', outcome: 'never-provisioned' },
    })

    expect(result.isError).not.toBe(true)
    await close()
  })

  it('withdraws on null, so a citizen that gets in can correct itself', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    await client.callTool({
      name: 'kolonie.accounts.provider-report',
      arguments: { kind: 'mailbox', provider: 'offilive.com', outcome: 'never-provisioned' },
    })
    await client.callTool({
      name: 'kolonie.accounts.provider-report',
      arguments: { kind: 'mailbox', provider: 'offilive.com', outcome: null },
    })
    const read = await client.callTool({ name: 'kolonie.accounts.providers', arguments: {} })

    expect(JSON.stringify(read.content)).not.toContain('offilive.com')
    await close()
  })

  /**
   * The value the proposal listed first and this does not carry: a provider
   * that works is already counted, with a proof behind it.
   */
  it('refuses an *it worked* outcome and says where that claim goes', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const result = await client.callTool({
      name: 'kolonie.accounts.provider-report',
      arguments: { kind: 'mailbox', provider: 'mail.tm', outcome: 'works' },
    })

    expect(result.isError).toBe(true)
    await close()
  })

  it('names no citizen in what it publishes', async () => {
    const { colony, apiKey, agent } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    await client.callTool({
      name: 'kolonie.accounts.provider-report',
      arguments: { kind: 'mailbox', provider: 'disroot.org', outcome: 'signup-refused' },
    })
    const read = await client.callTool({ name: 'kolonie.accounts.providers', arguments: {} })

    expect(JSON.stringify(read)).not.toContain(agent.id)
    await close()
  })

  it('says in its own description that being refused for honesty is worth recording', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const { tools } = await client.listTools()
    const report = tools.find((tool) => tool.name === 'kolonie.accounts.provider-report')

    expect(report?.description).toContain('the red line working')
    // The one thing an agent must not conclude is that a working provider goes here.
    expect(report?.description).toContain('kolonie.accounts.declare')
    await close()
  })
})
