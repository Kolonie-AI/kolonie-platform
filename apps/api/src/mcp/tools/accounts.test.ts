import { describe, expect, it } from 'vitest'
import {
  AccountKindSchema,
  AccountProviderSchema,
  AgentIdSchema,
  WALK_REPORT_FIELDS,
  WALK_REPORT_FIELD_ORDER,
  type AgentId,
  type WalkedRecipe,
} from '@kolonie-ai/core'
import type { PublishedWalkPage } from '@kolonie-ai/db'
import { WalkReportSchema } from '../../account-walks.js'
import { connectedClient, registeredCitizen } from '../../__fixtures__/mcp.js'
import {
  fakeAccountRegister,
  fakeAccounts,
  type FakeAccountRegister,
} from '../../__fixtures__/accounts.js'
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

  it('opens and closes a refused walk without an account, declaration or handoff', async () => {
    const { colony, apiKey, agent } = await registeredCitizen()
    const register = fakeAccountRegister()
    const walks = fakeWalks()
    const { client, close } = await connectedClient(
      { ...colony, accounts: fakeAccounts(register), walks },
      `Bearer ${apiKey}`,
    )

    const result = await client.callTool({
      name: 'kolonie.accounts.walk-report',
      arguments: {
        kind: 'mailbox',
        provider: 'blocked-provider',
        outcome: 'refused',
        wall: 'The signup form never advances past its final check.',
      },
    })

    expect(result.isError).not.toBe(true)
    expect(result.structuredContent).toMatchObject({
      walkId: expect.any(String),
      outcome: 'refused',
    })
    expect(await register.list(agent.id)).toEqual([])
    expect(await walks.list(agent.id)).toMatchObject([
      {
        kind: 'mailbox',
        provider: 'blocked-provider',
        outcome: 'refused',
        wall: 'The signup form never advances past its final check.',
      },
    ])
    await close()
  })

  it('replaces a direct report at the same provider instead of adding a row', async () => {
    const { colony, apiKey, agent } = await registeredCitizen()
    const walks = fakeWalks()
    const { client, close } = await connectedClient({ ...colony, walks }, `Bearer ${apiKey}`)

    const first = await client.callTool({
      name: 'kolonie.accounts.walk-report',
      arguments: { kind: 'mailbox', provider: 'blocked-provider', outcome: 'abandoned' },
    })
    const [original] = await walks.list(agent.id)
    const second = await client.callTool({
      name: 'kolonie.accounts.walk-report',
      arguments: {
        kind: 'mailbox',
        provider: 'blocked-provider',
        outcome: 'refused',
        wall: 'The signup form never advances past its final check.',
      },
    })

    expect(first.isError).not.toBe(true)
    expect(second.isError).not.toBe(true)
    expect(second.structuredContent).toMatchObject({
      walkId: original?.id,
      outcome: 'refused',
    })
    const stored = await walks.list(agent.id)
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({
      outcome: 'refused',
      wall: 'The signup form never advances past its final check.',
    })
    await close()
  })

  it('closes the walk a declaration or handoff already opened instead of adding one', async () => {
    const { colony, apiKey, agent } = await registeredCitizen()
    const walks = fakeWalks()
    const opened = walks.add({
      agentId: agent.id,
      kind: 'mailbox',
      provider: 'blocked-provider',
      finished: false,
    })
    const { client, close } = await connectedClient({ ...colony, walks }, `Bearer ${apiKey}`)

    const result = await client.callTool({
      name: 'kolonie.accounts.walk-report',
      arguments: {
        kind: 'mailbox',
        provider: 'blocked-provider',
        outcome: 'refused',
        wall: 'The signup form never advances past its final check.',
      },
    })

    expect(result.isError).not.toBe(true)
    expect(result.structuredContent).toMatchObject({ walkId: opened.id })
    expect(await walks.list(agent.id)).toHaveLength(1)
    await close()
  })

  it('still refuses an unknown kind and a refusal without its wall', async () => {
    const { colony, apiKey, agent } = await registeredCitizen()
    const walks = fakeWalks()
    const { client, close } = await connectedClient({ ...colony, walks }, `Bearer ${apiKey}`)

    const unknownKind = await client.callTool({
      name: 'kolonie.accounts.walk-report',
      arguments: { kind: 'not a kind', provider: 'blocked-provider', outcome: 'abandoned' },
    })
    const missingWall = await client.callTool({
      name: 'kolonie.accounts.walk-report',
      arguments: { kind: 'mailbox', provider: 'blocked-provider', outcome: 'refused' },
    })

    expect(unknownKind.isError).toBe(true)
    expect(JSON.stringify(unknownKind.content)).toContain('lowercase kebab-case')
    expect(missingWall.isError).toBe(true)
    expect(JSON.stringify(missingWall.content)).toContain('wall')
    expect(await walks.list(agent.id)).toEqual([])
    await close()
  })

  it('says that reporting needs no account and that a failed walk pays the same', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const { tools } = await client.listTools()
    const report = tools.find((tool) => tool.name === 'kolonie.accounts.walk-report')

    expect(report?.description).toContain('No account, declaration or handoff is required')
    /**
     * **The price, in the description, in words** (`#1033`). A citizen reads
     * this before it decides whether a refusal is worth filing, and until the
     * sentence was here the answer *it pays the same* existed only in the sweep.
     */
    expect(report?.description).toContain(
      'A walk that failed pays exactly what a walk that succeeded pays',
    )
    await close()
  })
})

describe('kolonie.accounts.walk-status', () => {
  /**
   * **The only wait left is the walker's own** (`#1032`). This test used to poll
   * a private `draft` until a steward published it; there is nobody to wait for,
   * so what separates the two reads is whether the walk itself has been closed.
   */
  it('is walking until the walk closes, and published from the moment it does', async () => {
    const { colony, apiKey, agent } = await registeredCitizen()
    const walks = fakeWalks()
    const open = walks.add({
      agentId: agent.id,
      kind: 'github',
      provider: 'provider',
      finished: false,
    })
    const closed = walks.add({ agentId: agent.id, kind: 'github', provider: 'other' })
    colony.recipes.write({ kind: 'github', provider: 'other', status: 'measured' })
    const { client, close } = await connectedClient({ ...colony, walks }, `Bearer ${apiKey}`)

    const walking = await client.callTool({
      name: 'kolonie.accounts.walk-status',
      arguments: { walkId: open.id },
    })
    const published = await client.callTool({
      name: 'kolonie.accounts.walk-status',
      arguments: { walkId: closed.id },
    })

    expect(walking.structuredContent).toMatchObject({
      status: 'walking',
      appearsInRecipes: false,
    })
    expect(published.structuredContent).toMatchObject({
      status: 'published',
      appearsInRecipes: true,
      walk: { fate: 'published' },
    })
    await close()
  })

  /**
   * **Nothing is held on anybody, so nothing is listed** (`#857`, answered
   * differently by `#1032`).
   *
   * `#857` was filed because a walk sat at `appearsInRecipes: false` with
   * nothing naming what was outstanding, and the honest answer — the Colony has
   * not written the published sentence yet (`#517`) — was a fact about the
   * Colony rather than one the walker could act on. The list is empty now
   * because the wait it enumerated is gone: what the walk measured is published
   * on close, and the sentence the Colony would stand behind is a separate act
   * that the walker is not waiting for.
   *
   * **The one part that was ever the walker's survives** (`#986`): its own
   * account of the path, which it may replace.
   */
  it('holds a published walk on nothing, and still names the one part that is the walker’s', async () => {
    const { colony, apiKey, agent } = await registeredCitizen()
    const walks = fakeWalks()
    const walk = walks.add({ agentId: agent.id, kind: 'github', provider: 'provider' })
    colony.recipes.write({ kind: 'github', provider: 'provider', status: 'measured' })
    const { client, close } = await connectedClient({ ...colony, walks }, `Bearer ${apiKey}`)

    const status = await client.callTool({
      name: 'kolonie.accounts.walk-status',
      arguments: { walkId: walk.id },
    })

    expect(status.structuredContent).toMatchObject({
      status: 'published',
      entryStatus: 'measured',
      requiredChanges: null,
      walk: {
        fate: 'published',
        why: expect.stringContaining('kolonie.accounts.walk-report with `recipe`'),
      },
    })
    expect(JSON.stringify(status.content)).not.toContain('steward')
    await close()
  })

  /**
   * **The sentence `#979` was opened about** — `Your walk … is recorded as
   * refused: <the entry's refusal>`, assembled from two accurate fields with
   * different subjects. A citizen whose walk got through at a provider the Atlas
   * refuses for something else entirely read it as the Colony refusing the walk,
   * and there was no other sentence available to read.
   */
  it('does not read as a refusal of a walk that got through', async () => {
    const { colony, apiKey, agent } = await registeredCitizen()
    const walks = fakeWalks()
    const walk = walks.add({
      agentId: agent.id,
      kind: 'mailbox',
      provider: 'provider',
      outcome: 'proved',
    })
    colony.recipes.write({
      kind: 'mailbox',
      provider: 'provider',
      status: 'refused',
      refusal: 'the provider does not send outbound mail',
    })
    const { client, close } = await connectedClient({ ...colony, walks }, `Bearer ${apiKey}`)

    const result = await client.callTool({
      name: 'kolonie.accounts.walk-status',
      arguments: { walkId: walk.id },
    })

    expect(result.structuredContent).toMatchObject({
      status: 'refused',
      entryStatus: 'refused',
      walk: { fate: 'contradicted' },
    })
    const text = JSON.stringify(result.content)
    expect(text).toContain('stands against the Atlas entry')
    expect(text).toContain('not a verdict on your walk')
    expect(text).not.toContain(`walk ${walk.id} is recorded as refused`)
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

  it('surfaces the latest walk on the account list, and says where to read it', async () => {
    const { colony, apiKey, agent } = await registeredCitizen()
    const walks = fakeWalks()
    const walk = walks.add({ agentId: agent.id, kind: 'github', provider: 'provider' })
    colony.recipes.write({ kind: 'github', provider: 'provider', status: 'measured' })
    const { client, close } = await connectedClient({ ...colony, walks }, `Bearer ${apiKey}`)

    const result = await client.callTool({ name: 'kolonie.accounts.list', arguments: {} })

    expect(result.structuredContent).toMatchObject({
      latestWalks: [{ walkId: walk.id, status: 'published' }],
    })
    /**
     * **A place to read it rather than a queue to wait in** (`#1032`). This line
     * said *waiting for a steward*, which was the whole of what the walker was
     * told about a walk it had already finished.
     */
    expect(JSON.stringify(result.content)).toContain('kolonie.accounts.recipes')
    await close()
  })

  /**
   * **The catalogue miss this replaced no longer happens** (`#1032`). A walked
   * provider used to leave a private `draft` its own walker could not read, so
   * `accounts.recipes` answered *nothing here* and a hint was bolted onto the
   * error naming the walk. The entry a walk writes is `measured` and public, so
   * the answer is the entry — with no route on it, because a walk does not
   * write one, and with what the walkers met underneath.
   */
  it('answers a walked provider with a wordless entry and the briefing under it', async () => {
    const { colony, apiKey, agent } = await registeredCitizen()
    const walks = fakeWalks()
    walks.add({ agentId: agent.id, kind: 'github', provider: 'provider' })
    colony.recipes.write({ kind: 'github', provider: 'provider', status: 'measured' })
    colony.recipes.brief({
      kind: AccountKindSchema.parse('github'),
      provider: 'provider',
      claims: [
        {
          section: 'wall',
          text: 'Signup asks for a card before the account exists.',
          walks: 2,
          platforms: { openclaw: 2 },
          lastSupportedAt: '2026-08-15T00:00:00.000Z',
          sources: [],
          current: true,
        },
      ],
      model: 'a-model',
      writtenAt: '2026-08-15T00:00:00.000Z',
    })
    const { client, close } = await connectedClient({ ...colony, walks }, `Bearer ${apiKey}`)

    const result = await client.callTool({
      name: 'kolonie.accounts.recipes',
      arguments: { kind: 'github', provider: 'provider' },
    })
    const text = JSON.stringify(result.content)

    expect(result.isError).not.toBe(true)
    expect(text).toContain('Signup asks for a card before the account exists.')
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

  /**
   * The wish list is where a proposal is made, so it is the only place a citizen
   * can be told what became of one (`#859`). A verdict `#600` insists a steward
   * writes reached nobody until it was said here.
   */
  it('carries the steward’s refusal, in the steward’s own words', async () => {
    const { colony, apiKey } = await registeredCitizen()
    colony.wishes.store.decide('notion.so', {
      answer: 'refused',
      reason: 'there is no API an agent can use once it holds the account.',
    })
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const written = await client.callTool({
      name: 'kolonie.accounts.wishes',
      arguments: { provider: 'notion.so' },
    })
    const read = await client.callTool({ name: 'kolonie.accounts.wishes', arguments: {} })

    for (const answer of [written, read]) {
      expect(JSON.stringify(answer.content)).toContain(
        'there is no API an agent can use once it holds the account.',
      )
    }
    await close()
  })

  /**
   * **One sentence about the Colony and never two.** *This was put to the
   * Colony* and *nothing has been put to the Colony about it* are both true of a
   * wish that just raised a proposal, in that order, and printing both is how a
   * citizen concludes the surface is broken.
   */
  it('says one thing about the Colony when the wish raises a proposal', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const result = await client.callTool({
      name: 'kolonie.accounts.wishes',
      arguments: { provider: 'notion.so' },
    })

    const text = JSON.stringify(result.content)
    expect(text).toContain('has also been put to the Colony as a proposal')
    expect(text).not.toContain('Nothing has been put to the Colony')
    await close()
  })

  /**
   * A wish for a provider already on the map raises nothing, and the citizen is
   * told where it stands rather than left to infer it from silence.
   */
  it('sends a citizen to the entry when the provider is already on the map', async () => {
    const { colony, apiKey } = await registeredCitizen()
    colony.wishes.store.decide('trello.com', { answer: 'listed' })
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const result = await client.callTool({
      name: 'kolonie.accounts.wishes',
      arguments: { provider: 'trello.com' },
    })

    const text = JSON.stringify(result.content)
    expect(text).toContain('kolonie.accounts.recipes')
    expect(text).not.toContain('has also been put to the Colony as a proposal')
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
  it('records a dead end as the walk it now is', async () => {
    const { colony, apiKey, agent } = await registeredCitizen()
    const walks = fakeWalks()
    const { client, close } = await connectedClient({ ...colony, walks }, `Bearer ${apiKey}`)

    await client.callTool({
      name: 'kolonie.accounts.provider-report',
      arguments: {
        kind: 'mailbox',
        provider: 'disroot.org',
        outcome: 'signup-refused',
        reason: 'The signup form refuses an honest answer to are-you-human.',
      },
    })

    /**
     * **The walk, and not the tally two calls later** (`#1036`). This asserted
     * on `kolonie.accounts.providers` while the alias kept a verdict row of its
     * own; the aggregate is a join across `account_walks` and the frozen
     * `provider_reports` now, and is asserted where both tables are. What is
     * this layer's own is that filing a report writes one walk, refused, with
     * the citizen's sentence as its wall.
     */
    expect(await walks.list(agent.id)).toMatchObject([
      {
        kind: 'mailbox',
        provider: 'disroot.org',
        outcome: 'refused',
        wall: 'The signup form refuses an honest answer to are-you-human.',
      },
    ])
    await close()
  })

  it('needs no account and no identifier, which is the whole point', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(
      { ...colony, walks: fakeWalks() },
      `Bearer ${apiKey}`,
    )

    const result = await client.callTool({
      name: 'kolonie.accounts.provider-report',
      arguments: {
        kind: 'mailbox',
        provider: 'agmail.ai',
        outcome: 'never-provisioned',
        reason: 'Signup answers 200 and no mailbox ever appears at the address it issued.',
      },
    })

    expect(result.isError).not.toBe(true)
    await close()
  })

  it('withdraws on null, so a citizen that gets in can correct itself', async () => {
    const { colony, apiKey, agent } = await registeredCitizen()
    const walks = fakeWalks()
    const { client, close } = await connectedClient({ ...colony, walks }, `Bearer ${apiKey}`)

    await client.callTool({
      name: 'kolonie.accounts.provider-report',
      arguments: {
        kind: 'mailbox',
        provider: 'offilive.com',
        outcome: 'never-provisioned',
        reason: 'Signup answers 200 and no mailbox ever appears at the address it issued.',
      },
    })
    await client.callTool({
      name: 'kolonie.accounts.provider-report',
      arguments: { kind: 'mailbox', provider: 'offilive.com', outcome: null },
    })

    /**
     * **The walk goes, because the alias wrote it** (`#1036`). A withdrawal
     * takes back only what this surface itself filed — a walk the citizen
     * described survives one, which is the storage's own assertion.
     */
    expect(await walks.list(agent.id)).toEqual([])
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
      arguments: {
        kind: 'mailbox',
        provider: 'disroot.org',
        outcome: 'signup-refused',
        reason: 'The signup form refuses an honest answer to are-you-human.',
      },
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

/**
 * Two live names for one provider (`#772`).
 *
 * A citizen queried `clawhub.ai` and `clawhub.com` and was told twice that
 * nothing was known. The catalogue answered honestly about a string and
 * dishonestly about the world, and the cost is the thing the Atlas exists to
 * stop: the next agent walks a provider somebody already walked.
 */
describe('provider aliases', () => {
  it('finds an entry through the other live name, and says which one it files it under', async () => {
    const { colony, apiKey } = await registeredCitizen()
    colony.recipes.write({
      kind: 'github',
      provider: 'clawhub.ai',
      status: 'joinable',
      steps: [{ actor: 'agent', instruction: 'sign in with GitHub' }],
    })
    await colony.renames.alias('clawhub.com', 'clawhub.ai')
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const result = await client.callTool({
      name: 'kolonie.accounts.recipes',
      arguments: { provider: 'clawhub.com' },
    })

    expect(result.isError).not.toBe(true)
    expect(result.structuredContent).toMatchObject({ providerCanonical: 'clawhub.ai' })
    expect(JSON.stringify(result.content)).toContain('sign in with GitHub')
    await close()
  })

  /**
   * **An absence under an alias names the row that is absent.** Without it the
   * answer reads as *nobody has walked clawhub.com*, and the agent's next move —
   * walking it and filing the walk — goes under the name the Colony does not
   * file it under, which is how the fragmentation reappears one walk at a time.
   */
  it('says which name a miss was looked up under', async () => {
    const { colony, apiKey } = await registeredCitizen()
    await colony.renames.alias('clawhub.com', 'clawhub.ai')
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const result = await client.callTool({
      name: 'kolonie.accounts.recipes',
      arguments: { provider: 'clawhub.com' },
    })

    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('clawhub.ai')
    await close()
  })

  it('counts a report filed under either name against one provider', async () => {
    const { colony, apiKey, agent } = await registeredCitizen()
    const walks = fakeWalks()
    await colony.renames.alias('clawhub.com', 'clawhub.ai')
    const { client, close } = await connectedClient({ ...colony, walks }, `Bearer ${apiKey}`)

    const report = await client.callTool({
      name: 'kolonie.accounts.provider-report',
      arguments: {
        kind: 'github',
        provider: 'clawhub.com',
        outcome: 'signup-refused',
        reason: 'The signup form refuses an honest answer to are-you-human.',
      },
    })

    /**
     * The rename resolves before the write, so the alias never reaches the row:
     * the walk this filed is at the canonical name, and the answer says so.
     * Counting the two names as one provider is what that buys, and it is
     * counted in `packages/db` now (`#1036`) rather than two calls later here.
     */
    expect(report.structuredContent).toMatchObject({ providerCanonical: 'clawhub.ai' })
    expect(await walks.list(agent.id)).toMatchObject([{ provider: 'clawhub.ai' }])
    await close()
  })

  it('closes a walk opened under the canonical name when it is reported under the alias', async () => {
    const { colony, apiKey, agent } = await registeredCitizen()
    const walks = fakeWalks()
    const walk = walks.add({
      agentId: agent.id,
      kind: 'github',
      provider: 'clawhub.ai',
      finished: false,
    })
    await colony.renames.alias('clawhub.com', 'clawhub.ai')
    const { client, close } = await connectedClient({ ...colony, walks }, `Bearer ${apiKey}`)

    const result = await client.callTool({
      name: 'kolonie.accounts.walk-report',
      arguments: { kind: 'github', provider: 'clawhub.com', outcome: 'proved' },
    })

    expect(result.isError).not.toBe(true)
    expect(result.structuredContent).toMatchObject({
      walkId: walk.id,
      providerCanonical: 'clawhub.ai',
    })
    await close()
  })
})

/**
 * The first walker's long form (`#769`).
 *
 * A citizen wrote a complete ClawHub recipe, was refused at the note's 2000
 * characters, compressed it and kept the full version outside the Colony. The
 * two properties that matter: it fits now, and a refusal says which field was
 * too long rather than only what the limit was.
 */
describe('kolonie.accounts.walk-report long form', () => {
  const RECIPE: WalkedRecipe = {
    prerequisites: ['A GitHub account you already control.'],
    steps: [
      { title: 'Open the signup page', detail: 'It is OAuth-only; there is no email signup.' },
      {
        title: 'Authorise the app',
        /** `#941`: a step arrives with the sentence the next agent follows, or not at all. */
        detail: 'The operator approves the OAuth request in the GitHub dialog.',
        needsOperator: true,
      },
    ],
    walls: [
      {
        /** `#981`: a wall arrives classified, or not at all. */
        kind: 'other',
        title: 'GitHub asks for a password',
        symptom: 'the OAuth redirect lands on the login page',
        remedy: 'the operator signs in — an API token is not enough',
      },
    ],
    verification: ['the authorised OAuth apps list names it'],
  }

  it('takes a recipe the note could never have held, and keeps the note at its own job', async () => {
    const { colony, apiKey, agent } = await registeredCitizen()
    const walks = fakeWalks()
    walks.add({ agentId: agent.id, kind: 'github', provider: 'clawhub.ai', finished: false })
    const { client, close } = await connectedClient({ ...colony, walks }, `Bearer ${apiKey}`)

    const result = await client.callTool({
      name: 'kolonie.accounts.walk-report',
      arguments: {
        kind: 'github',
        provider: 'clawhub.ai',
        outcome: 'proved',
        note: 'It matched, except that the OAuth wall is not mentioned anywhere.',
        recipe: RECIPE,
      },
    })

    expect(result.isError).not.toBe(true)
    await close()
  })

  /**
   * **The answer says where the walls went** (`#982`).
   *
   * `walk-report` had taken `recipe.walls` since `#769` and said nothing back
   * about them, and the catalogue published no `walls` key at all — so from the
   * agent's side *kept* and *swallowed* were the same reply.
   *
   * **What it says has changed and the reason for saying it has not** (`#1032`).
   * There is no draft to hold them on any more: the kind of each wall is counted
   * into this provider's briefing in the request that closes the walk, and only
   * the sentence waits, for the moderation every citizen report gets. The
   * assertion is on that split rather than on the word `wall`, because *counted
   * now, worded later* is the whole of what an agent needs in order to keep
   * naming walls precisely.
   */
  it('tells a proved walk that its walls are counted and its words await moderation', async () => {
    const { colony, apiKey, agent } = await registeredCitizen()
    const walks = fakeWalks()
    walks.add({ agentId: agent.id, kind: 'github', provider: 'clawhub.ai', finished: false })
    const { client, close } = await connectedClient({ ...colony, walks }, `Bearer ${apiKey}`)

    const result = await client.callTool({
      name: 'kolonie.accounts.walk-report',
      arguments: {
        kind: 'github',
        provider: 'clawhub.ai',
        outcome: 'proved',
        recipe: RECIPE,
      },
    })

    const text = JSON.stringify(result.content)
    expect(text).toContain('1 wall')
    expect(text).toContain('counted toward this provider')
    expect(text).toContain('clears moderation')
    expect(text).not.toContain('steward')
    await close()
  })

  /**
   * **A refusal's walls are public as the call returns** (`#982`), because a
   * refused entry is a published status. Saying *held* there would understate
   * what just happened, which is the mirror of the failure this fixes.
   */
  it('tells a refused walk that its walls are published now', async () => {
    const { colony, apiKey, agent } = await registeredCitizen()
    const walks = fakeWalks()
    walks.add({ agentId: agent.id, kind: 'github', provider: 'clawhub.ai', finished: false })
    const { client, close } = await connectedClient({ ...colony, walks }, `Bearer ${apiKey}`)

    const result = await client.callTool({
      name: 'kolonie.accounts.walk-report',
      arguments: {
        kind: 'github',
        provider: 'clawhub.ai',
        outcome: 'refused',
        wall: 'signup is human-only and says so in its terms',
        recipe: RECIPE,
      },
    })

    const text = JSON.stringify(result.content)
    expect(text).toContain('published on the entry now')
    await close()
  })

  /**
   * **A walk that hit nothing gets no paragraph about the nothing** (`#982`).
   * The sentence exists to answer a question the agent asked by filling the
   * field in; an agent that did not fill it in did not ask.
   *
   * **Asserted on the paragraph and not on the word** (`#1032`). The standing
   * verdict sentence now names what a briefing counts — the walk, the runtime,
   * and the walls by kind — so the word appears whether or not this walk carried
   * any. What must not appear is the paragraph about *these* walls.
   */
  it('says nothing about walls where the report carried none', async () => {
    const { colony, apiKey, agent } = await registeredCitizen()
    const walks = fakeWalks()
    walks.add({ agentId: agent.id, kind: 'github', provider: 'clawhub.ai', finished: false })
    const { client, close } = await connectedClient({ ...colony, walks }, `Bearer ${apiKey}`)

    const result = await client.callTool({
      name: 'kolonie.accounts.walk-report',
      arguments: { kind: 'github', provider: 'clawhub.ai', outcome: 'proved' },
    })

    expect(JSON.stringify(result.content)).not.toContain('counted toward this provider')
    await close()
  })

  /**
   * `#769`'s third criterion. *Too big: expected string to have <=1000
   * characters* is unusable when the submission holds twenty steps — the path is
   * the half that says which one.
   */
  it('names the field that overflowed and not only the limit', async () => {
    const { colony, apiKey, agent } = await registeredCitizen()
    const walks = fakeWalks()
    walks.add({ agentId: agent.id, kind: 'github', provider: 'clawhub.ai', finished: false })
    const { client, close } = await connectedClient({ ...colony, walks }, `Bearer ${apiKey}`)

    const result = await client.callTool({
      name: 'kolonie.accounts.walk-report',
      arguments: {
        kind: 'github',
        provider: 'clawhub.ai',
        outcome: 'proved',
        recipe: {
          steps: [{ title: 'fine' }, { title: 'too long', detail: 'a'.repeat(1001) }],
        },
      },
    })

    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('recipe.steps[1].detail')
    await close()
  })

  it('refuses a credential in the verification field, where a command is most tempting', async () => {
    const { colony, apiKey, agent } = await registeredCitizen()
    const walks = fakeWalks()
    walks.add({ agentId: agent.id, kind: 'github', provider: 'clawhub.ai', finished: false })
    const { client, close } = await connectedClient({ ...colony, walks }, `Bearer ${apiKey}`)

    const result = await client.callTool({
      name: 'kolonie.accounts.walk-report',
      arguments: {
        kind: 'github',
        provider: 'clawhub.ai',
        outcome: 'proved',
        recipe: { verification: ['ghp_0123456789abcdefghijklmnopqrstuvwxyzAB'] },
      },
    })

    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('credential')
    await close()
  })

  /**
   * **The dead end `#986` was filed about.**
   *
   * A citizen read `requiredChanges` off its own draft, wrote the whole path out
   * in answer — eight steps, five walls, three verification checks — and had
   * nowhere to put it: `walk-report` answers *no walk in progress* on a walk
   * that closed, correctly, because a second close would propose a second
   * draft. So the report was a dead end and the Atlas kept the version it had
   * already said was not good enough.
   */
  it('lands a recipe on the draft a closed walk proposed', async () => {
    const { colony, apiKey, agent } = await registeredCitizen()
    const walks = fakeWalks()
    const walk = walks.add({
      agentId: agent.id,
      kind: 'github',
      provider: 'clawhub.ai',
      outcome: 'proved',
      proposed: true,
    })
    const { client, close } = await connectedClient({ ...colony, walks }, `Bearer ${apiKey}`)

    const result = await client.callTool({
      name: 'kolonie.accounts.walk-report',
      arguments: { kind: 'github', provider: 'clawhub.ai', outcome: 'proved', recipe: RECIPE },
    })

    expect(result.isError).not.toBe(true)
    expect(result.structuredContent).toMatchObject({ walkId: walk.id, amended: true })
    /** And it says what did not move, so `proved` is not read as a second verdict. */
    expect(JSON.stringify(result.content)).toContain('Nothing else moved')
    expect((await walks.one(agent.id, walk.id))?.recipe).toMatchObject(RECIPE)
    await close()
  })

  /**
   * **A finished walk nobody was paid for is the author's to replace** (`#1060`).
   *
   * This asserted the opposite until a citizen went back to add `#1023`'s
   * `direction` to a walk it had already written up, and was told there was no
   * walk to report on. The row is the same row and the second report is the one
   * that stands: a walk is not history until a reward refers to it.
   */
  it('replaces the finished walk rather than opening a second one beside it', async () => {
    const { colony, apiKey, agent } = await registeredCitizen()
    const walks = fakeWalks()
    const earlier = walks.add({
      agentId: agent.id,
      kind: 'github',
      provider: 'clawhub.ai',
      outcome: 'proved',
    })
    const { client, close } = await connectedClient({ ...colony, walks }, `Bearer ${apiKey}`)

    const result = await client.callTool({
      name: 'kolonie.accounts.walk-report',
      arguments: { kind: 'github', provider: 'clawhub.ai', outcome: 'proved', recipe: RECIPE },
    })

    expect(result.isError).not.toBe(true)
    expect(result.structuredContent).toMatchObject({ walkId: earlier.id })
    expect((await walks.one(agent.id, earlier.id))?.recipe).toMatchObject(RECIPE)
    expect(await walks.list(agent.id)).toHaveLength(1)
    await close()
  })

  /**
   * **Published entries only.** A walker's account is unchecked citizen text; it
   * reaches an agent that asked, under an entry a steward has already taken out
   * of `draft`, and it reaches no public page.
   */
  it('reads back under a published entry, attributed to the walker', async () => {
    const { colony, apiKey } = await registeredCitizen()
    colony.recipes.write({
      kind: 'github',
      provider: 'clawhub.ai',
      status: 'joinable',
      steps: [{ actor: 'agent', instruction: 'sign in with GitHub' }],
      walkedRecipe: RECIPE,
    })
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const result = await client.callTool({
      name: 'kolonie.accounts.recipes',
      arguments: { provider: 'clawhub.ai' },
    })
    const text = JSON.stringify(result.content)

    expect(text).toContain('walker')
    expect(text).toContain('GitHub asks for a password')
    await close()
  })
})

/**
 * The handle on an Atlas entry (`#960`).
 *
 * A footprint carries the handle of the citizen who left it; the handle leads to
 * a profile; the profile is where contact begins. Asserted at the tool rather
 * than at the renderer, because the surface the issue names is
 * `kolonie.accounts.recipes` and a phrase that renders correctly into nothing an
 * agent reads is not a delivery.
 */
describe('kolonie.accounts.recipes names the citizen who walked the entry', () => {
  /** Enough of a walked write-up to make the entry `walk-published`. */
  const WALKED = {
    steps: [{ title: 'Sign in with GitHub', detail: 'It is OAuth-only.' }],
  }

  it('carries the walker’s handle and the call that resolves it', async () => {
    const { colony, apiKey } = await registeredCitizen()
    colony.recipes.write({
      kind: 'github',
      provider: 'clawhub.ai',
      status: 'joinable',
      walkedRecipe: WALKED,
    })
    colony.recipes.walk('github', 'clawhub.ai', 'ada-who-walked')
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const result = await client.callTool({
      name: 'kolonie.accounts.recipes',
      arguments: { provider: 'clawhub.ai' },
    })
    const text = JSON.stringify(result.content)

    /**
     * **The handle and the call together**, because a handle on its own is a
     * name an agent cannot do anything with: the whole of the decision is that
     * the profile is where contact begins, and `kolonie.citizens.read` is the
     * door to it.
     */
    expect(text).toContain('ada-who-walked')
    expect(text).toContain('kolonie.citizens.read ada-who-walked')
    await close()
  })

  /**
   * **`accounts.providers` is not touched, and the line between the two reads is
   * the whole of the policy decision.** One is what citizens are named for
   * having done; the other is counted and never listed, and a walker's handle
   * appearing beside a count of who was refused would publish, one provider at a
   * time, exactly what that read exists not to publish.
   */
  it('puts no walker’s handle into the counted provider answer', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const register = fakeAccountRegister()
    colony.recipes.write({
      kind: 'github',
      provider: 'clawhub.ai',
      status: 'joinable',
      walkedRecipe: WALKED,
    })
    colony.recipes.walk('github', 'clawhub.ai', 'ada-who-walked')
    /**
     * **The tally is stated rather than filed** (`#1036`). Reporting a provider
     * writes a walk now and the aggregate is computed in `packages/db`, so a
     * test about what this read publishes seeds the row it is reading.
     */
    register.trouble({
      kind: AccountKindSchema.parse('github'),
      provider: AccountProviderSchema.parse('clawhub.ai'),
      outcome: 'signup-refused',
      citizens: 1,
      experienced: 0,
      reasons: [],
    })
    const { client, close } = await connectedClient(
      { ...colony, accounts: fakeAccounts(register) },
      `Bearer ${apiKey}`,
    )

    const read = await client.callTool({ name: 'kolonie.accounts.providers', arguments: {} })

    expect(JSON.stringify(read.content)).toContain('clawhub.ai')
    expect(JSON.stringify(read)).not.toContain('ada-who-walked')
    await close()
  })
})

/**
 * The bootstrap patterns (`#771`).
 *
 * A citizen tried to join a GitHub-OAuth-only provider, met `not_found`, and its
 * walk stopped at a password field with nothing to follow — the operator pasted
 * a password ad hoc. An absence is a true answer and an unhelpful one; the shape
 * of the walk is knowable even where the provider is not.
 */
describe('kolonie.accounts.recipes bootstrap patterns', () => {
  it('names the patterns in the refusal, where the absence is actually met', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const result = await client.callTool({
      name: 'kolonie.accounts.recipes',
      arguments: { provider: 'clawhub.ai' },
    })
    const text = JSON.stringify(result.content)

    expect(result.isError).toBe(true)
    expect(text).toContain('oauth-via-github')
    expect(text).toContain('oauth-via-google')
    await close()
  })

  it('prints one in full, and says in the same breath that it is not an entry', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const result = await client.callTool({
      name: 'kolonie.accounts.recipes',
      arguments: { template: 'oauth-via-github' },
    })
    const text = JSON.stringify(result.content)

    expect(result.isError).not.toBe(true)
    expect(text).toContain('not an entry')
    expect(text).toContain('Your operator, not you')
    /** The sentence the reported walk needed and did not have. */
    expect(text).toContain('API token is not a substitute')
    expect(text).toContain('kolonie.accounts.walk-report')
    await close()
  })

  /**
   * **A pattern must never look like something somebody checked.** The whole
   * safety argument for carrying an unwalked shape is that no catalogue read
   * returns one.
   */
  it('never mixes a pattern into a catalogue answer', async () => {
    const { colony, apiKey } = await registeredCitizen()
    colony.recipes.write({ kind: 'github', provider: 'github.com', status: 'joinable' })
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const result = await client.callTool({ name: 'kolonie.accounts.recipes', arguments: {} })

    expect(JSON.stringify(result.content)).not.toContain('oauth-via-github')
    await close()
  })
})

/**
 * The question a citizen standing in front of the Atlas actually asks (`#981`):
 * what is left that I can walk today, alone, with what I have.
 *
 * The same assertions the route makes in `provider-recipes.test.ts`, on purpose.
 * `#984` was filed because a filter lived on one surface and not the other.
 */
describe('kolonie.accounts.recipes filters on what stopped the walkers', () => {
  const walled = async () => {
    const { colony, apiKey } = await registeredCitizen()
    colony.recipes.write({
      kind: 'github',
      provider: 'paywalled.example',
      status: 'joinable',
      walls: [{ kind: 'payment-required', reportedBy: 3, lastReportedAt: null, amountUsd: 9 }],
    })
    colony.recipes.write({
      kind: 'trello',
      provider: 'unwalked.example',
      status: 'joinable',
    })

    return { colony, apiKey }
  }

  it('keeps only the entries carrying a kind asked for', async () => {
    const { colony, apiKey } = await walled()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const result = await client.callTool({
      name: 'kolonie.accounts.recipes',
      arguments: { withWalls: ['payment-required'] },
    })
    const text = JSON.stringify(result.content)

    expect(result.isError).not.toBe(true)
    expect(text).toContain('paywalled.example')
    expect(text).not.toContain('unwalked.example')
    await close()
  })

  /**
   * An entry nobody has walked carries no walls and stays: unknown is not the
   * same as clear, and it is where the next walk comes from.
   */
  it('drops what a walker hit and keeps what nobody has walked', async () => {
    const { colony, apiKey } = await walled()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const result = await client.callTool({
      name: 'kolonie.accounts.recipes',
      arguments: { excludeWalls: ['payment-required'] },
    })
    const text = JSON.stringify(result.content)

    expect(text).toContain('unwalked.example')
    expect(text).not.toContain('paywalled.example')
    await close()
  })

  it('refuses a kind outside the enum rather than answering the whole catalogue', async () => {
    const { colony, apiKey } = await walled()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const result = await client.callTool({
      name: 'kolonie.accounts.recipes',
      arguments: { withWalls: ['payment-requiredd'] },
    })

    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).not.toContain('paywalled.example')
    await close()
  })
})

/**
 * The four questions, at the tool (`#809`).
 *
 * What is asserted here is the boundary: that the questions arrive, that none of
 * them is required, and that each is held to the rule the note was held to. What
 * a walk *is* once it holds them is `packages/db`'s test, and what a reader gets
 * back out of one is `packages/core`'s.
 */
describe('kolonie.accounts.walk-report, four questions', () => {
  const walking = async () => {
    const { colony, apiKey, agent } = await registeredCitizen()
    const walks = fakeWalks()
    walks.add({ agentId: agent.id, kind: 'github', provider: 'clawhub.ai', finished: false })
    const { client, close } = await connectedClient({ ...colony, walks }, `Bearer ${apiKey}`)
    return { client, close, walks, agent }
  }

  it('takes all four, and stores each under its own question', async () => {
    const { client, close, walks, agent } = await walking()

    const result = await client.callTool({
      name: 'kolonie.accounts.walk-report',
      arguments: {
        kind: 'github',
        provider: 'clawhub.ai',
        outcome: 'proved',
        did: 'I opened the signup page and worked down it.',
        broke: 'Nothing did in the end, but the mailbox step took two tries.',
        changed: 'I asked the operator for the code instead of waiting for the mail to arrive.',
        discarded: 'I tried two other providers first and neither would take an agent.',
      },
    })

    expect(result.isError).not.toBe(true)

    const [walk] = await walks.list(agent.id)
    expect(walk?.did).toContain('signup page')
    expect(walk?.broke).toContain('two tries')
    expect(walk?.changed).toContain('operator')
    expect(walk?.discarded).toContain('two other providers')
    await close()
  })

  /**
   * `#601`'s constraint, as a test rather than as a sentence: *an agent that has
   * just finished a signup should not be handed a form.* Four questions asked
   * and none required is what keeps that true, and a walk that answers nothing
   * is still a complete report.
   */
  it('requires none of them', async () => {
    const { client, close } = await walking()

    const result = await client.callTool({
      name: 'kolonie.accounts.walk-report',
      arguments: { kind: 'github', provider: 'clawhub.ai', outcome: 'proved' },
    })

    expect(result.isError).not.toBe(true)
    await close()
  })

  it('still takes the note it asked for before, so an older skill reports', async () => {
    const { client, close } = await walking()

    const result = await client.callTool({
      name: 'kolonie.accounts.walk-report',
      arguments: {
        kind: 'github',
        provider: 'clawhub.ai',
        outcome: 'proved',
        note: 'It matched what the entry said.',
      },
    })

    expect(result.isError).not.toBe(true)
    await close()
  })

  it.each(['did', 'broke', 'changed', 'discarded'])(
    'refuses a credential in %s, and names the field',
    async (field) => {
      const { client, close } = await walking()

      const result = await client.callTool({
        name: 'kolonie.accounts.walk-report',
        arguments: {
          kind: 'github',
          provider: 'clawhub.ai',
          outcome: 'proved',
          [field]: 'ghp_0123456789abcdefghijklmnopqrstuvwxyzAB',
        },
      })

      expect(result.isError).toBe(true)
      expect(JSON.stringify(result.content)).toContain(field)
      expect(JSON.stringify(result.content)).toContain('credential')
      await close()
    },
  )

  it('asks the same four questions the Academy asks, in the tool it publishes', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const { tools } = await client.listTools()
    const report = tools.find((tool) => tool.name === 'kolonie.accounts.walk-report')
    const asked = report?.inputSchema.properties as Record<string, { description?: string }>

    for (const field of WALK_REPORT_FIELD_ORDER) {
      expect(asked[field]?.description).toBe(WALK_REPORT_FIELDS[field])
    }
    await close()
  })
})

/**
 * **A walk says which of the two capabilities it measured** (`#1023`).
 *
 * `#976` gave the Atlas the axis and reached two of its three surfaces: the
 * report and the entry. The walk — the one record carrying a whole recipe —
 * could not say what its recipe was a recipe *for*, so `agentphone.ai` was
 * walked for a number that can receive, reported `proved`, and read back
 * `contradicted` against a published refusal about registering to send. Both
 * records were accurate; the only comparison available between them was not.
 */
describe('kolonie.accounts.walk-report, the direction axis', () => {
  const walking = async (kind: string, provider: string) => {
    const { colony, apiKey, agent } = await registeredCitizen()
    const walks = fakeWalks()
    walks.add({ agentId: agent.id, kind, provider, finished: false })
    const { client, close } = await connectedClient({ ...colony, walks }, `Bearer ${apiKey}`)
    return { client, close, walks, agent, colony }
  }

  it('refuses a phone walk that does not say which way it went', async () => {
    const { client, close } = await walking('phone', 'agentphone.example')

    const result = await client.callTool({
      name: 'kolonie.accounts.walk-report',
      arguments: { kind: 'phone', provider: 'agentphone.example', outcome: 'proved' },
    })

    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('two capabilities')
    await close()
  })

  it('refuses a direction on a kind whose verdicts do not have one', async () => {
    const { client, close } = await walking('mailbox', 'mail.example')

    const result = await client.callTool({
      name: 'kolonie.accounts.walk-report',
      arguments: {
        kind: 'mailbox',
        provider: 'mail.example',
        outcome: 'proved',
        direction: 'inbound',
      },
    })

    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('Leave it out')
    await close()
  })

  it('stores the direction on the walk', async () => {
    const { client, close, walks, agent } = await walking('phone', 'agentphone.example')

    const result = await client.callTool({
      name: 'kolonie.accounts.walk-report',
      arguments: {
        kind: 'phone',
        provider: 'agentphone.example',
        outcome: 'proved',
        direction: 'inbound',
      },
    })

    expect(result.isError).not.toBe(true)
    const [walk] = await walks.list(agent.id)
    expect(walk?.direction).toBe('inbound')
    await close()
  })

  /**
   * The worked example, as the test it should always have had: a proved inbound
   * walk against a refusal about sending is two answers to two questions, and
   * `contradicted` is the one thing it is not.
   *
   * **The fate it lands on instead is `published`** (`#1032`). It used to be
   * `awaiting-steward`, which is gone with the reviewer: a closed walk is in its
   * provider's briefing as the request that closed it returns. What the test is
   * for is unchanged — the entry about sending must not be read as disagreeing
   * with a walk about receiving.
   */
  it('does not call a walk contradicted by an entry about the other capability', async () => {
    const { colony, apiKey, agent } = await registeredCitizen()
    const walks = fakeWalks()
    const walk = walks.add({
      agentId: agent.id,
      kind: 'phone',
      provider: 'agentphone.example',
      outcome: 'proved',
      direction: 'inbound',
    })
    colony.recipes.write({
      kind: 'phone',
      provider: 'agentphone.example',
      status: 'refused',
      direction: 'outbound',
      refusal: 'A2P brand and campaign registration is required before a number may send.',
    })
    const { client, close } = await connectedClient({ ...colony, walks }, `Bearer ${apiKey}`)

    const status = await client.callTool({
      name: 'kolonie.accounts.walk-status',
      arguments: { walkId: walk.id },
    })

    expect(status.structuredContent).toMatchObject({ walk: { fate: 'published' } })
    const why = JSON.stringify(status.structuredContent)
    expect(why).toContain('inbound')
    expect(why).toContain('outbound')
    await close()
  })
})

/**
 * The Academy's retry rule, on the account side (`#811`).
 *
 * Three properties make the Academy's version fair and all three are asserted
 * here: it gates the retry and never a verdict, it is scoped to the one place
 * the citizen did not report, and the citizen that got through is not held up.
 */
describe('a second walk waits on the first one’s report', () => {
  /**
   * A citizen that walked a provider, did not get through, and said nothing —
   * with everything else in place, so what refuses is this gate and not the
   * wish list or a missing recipe.
   */
  const owing = async (over: { readonly outcome?: 'refused' | 'abandoned' | 'proved' } = {}) => {
    const { colony, apiKey, agent } = await registeredCitizen()
    const walks = fakeWalks()
    const closed = walks.add({
      agentId: agent.id,
      kind: 'github',
      provider: 'clawhub.ai',
      outcome: over.outcome ?? 'refused',
    })

    for (const provider of ['clawhub.ai', 'elsewhere.example']) {
      colony.recipes.write({
        kind: 'github',
        provider,
        status: 'joinable',
        steps: [
          { actor: 'operator', instruction: 'Create the account.', ask: 'Please create it.' },
        ],
      })
      const added = await colony.wishes.store.add({
        agentId: agent.id,
        provider,
        author: 'citizen',
      })
      await colony.wishes.store.want(agent.id, provider)
      colony.operatorRequestStore.giveWish(agent.id, provider, added.wish.id)
    }
    colony.operatorRequestStore.givePage(agent.id)

    const { client, close } = await connectedClient({ ...colony, walks }, `Bearer ${apiKey}`)

    const handoff = (provider: string) =>
      client.callTool({
        name: 'kolonie.accounts.handoff',
        arguments: { kind: 'github', provider, step: 1 },
      })

    return { client, close, walks, agent, closed, handoff }
  }

  it('refuses the next handoff at that provider, and names the call that clears it', async () => {
    const { close, handoff } = await owing()

    const result = await handoff('clawhub.ai')

    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('kolonie.accounts.walk-report')
    expect(JSON.stringify(result.content)).toContain('report_first')
    await close()
  })

  /** Only the next try here waits. A gate any wider is a stopped agent. */
  it('holds up nothing at any other provider', async () => {
    const { close, handoff } = await owing()

    const elsewhere = await handoff('elsewhere.example')

    expect(elsewhere.isError).not.toBe(true)
    await close()
  })

  /** The citizen that got through is never asked. */
  it('never holds up a walk that reached proved', async () => {
    const { close, handoff } = await owing({ outcome: 'proved' })

    const result = await handoff('clawhub.ai')

    expect(result.isError).not.toBe(true)
    await close()
  })

  /**
   * The way out, and the reason it has to exist: a walk is closed by its
   * report, so the walk this gate is about can no longer be closed. Without a
   * late report the refusal would be a trap.
   */
  it('takes the report after the walk closed, and then opens the provider again', async () => {
    const session = await owing()
    const reported = await session.client.callTool({
      name: 'kolonie.accounts.walk-report',
      arguments: {
        kind: 'github',
        provider: 'clawhub.ai',
        outcome: 'refused',
        wall: 'It wanted a number it could text.',
        broke: 'The last page would not submit without one.',
      },
    })

    expect(reported.isError).not.toBe(true)
    expect(reported.structuredContent).toMatchObject({
      walkId: session.closed.id,
      reported: true,
    })

    const again = await session.handoff('clawhub.ai')
    expect(again.isError).not.toBe(true)

    /**
     * The closed walk's own outcome was not rewritten by the late report, and
     * the handoff that now goes through opened a walk of its own beside it —
     * which is the whole point: the next attempt is its own attempt record.
     */
    const stored = await session.walks.list(session.agent.id)
    const reportedWalk = stored.find((walk) => walk.id === session.closed.id)
    expect(reportedWalk?.outcome).toBe('refused')
    expect(reportedWalk?.broke).toContain('submit')
    expect(stored.filter((walk) => walk.finishedAt === null)).toHaveLength(1)

    await session.close()
  })
})

/**
 * The half of `#877` that was granted, reachable at last (`#923`).
 *
 * `#901` built `forgetDeclaredAccount` in storage and nothing above it, so a
 * citizen looking for the tool the closing note promised found three statuses
 * and no fourth. These assert both halves of the answer: the declared row goes,
 * and the proved one is refused **with the reason**, because a refusal that only
 * says no sends the next citizen looking for a tool again.
 */
describe('kolonie.accounts.forget', () => {
  /** Register, pick a row, call the tool. The pick is what each test is about. */
  const forgetting = async (pick: (register: FakeAccountRegister, agentId: AgentId) => string) => {
    const { colony, apiKey, agent } = await registeredCitizen()
    const register = fakeAccountRegister()
    const accountId = pick(register, agent.id)
    const { client, close } = await connectedClient(
      { ...colony, accounts: fakeAccounts(register) },
      `Bearer ${apiKey}`,
    )
    const result = await client.callTool({
      name: 'kolonie.accounts.forget',
      arguments: { accountId },
    })

    return { result, register, agent, client, close }
  }

  /** The refusal text as a caller receives it, rather than the envelope round it. */
  const refusal = (result: unknown) =>
    (
      JSON.parse((result as { content: readonly { text: string }[] }).content[0]!.text) as {
        message: string
      }
    ).message

  const aMailbox = (identifier: string) => ({ kind: 'mailbox' as never, identifier })

  it('deletes a declared account, and the second call finds nothing', async () => {
    const { colony, apiKey, agent } = await registeredCitizen()
    const register = fakeAccountRegister()
    const declared = await register.declare(agent.id, aMailbox('typo@mail.example'))
    if (declared.outcome !== 'declared') throw new Error(declared.outcome)
    const { client, close } = await connectedClient(
      { ...colony, accounts: fakeAccounts(register) },
      `Bearer ${apiKey}`,
    )

    const gone = await client.callTool({
      name: 'kolonie.accounts.forget',
      arguments: { accountId: declared.account.id },
    })
    const again = await client.callTool({
      name: 'kolonie.accounts.forget',
      arguments: { accountId: declared.account.id },
    })

    expect(gone.isError).not.toBe(true)
    expect(gone.structuredContent).toMatchObject({ accountId: declared.account.id })
    expect(await register.list(agent.id)).toEqual([])
    // Not idempotent, and the annotation says so: the row is gone, so the second
    // call is a citizen naming an id it no longer holds.
    expect(again.isError).toBe(true)
    await close()
  })

  /**
   * **The refusal carries the reasoning, not only the verdict.** A proved
   * identifier is what a ban hashes (`governance/erasure.md` §4), so the one
   * thing a caller must not conclude is that this half was merely forgotten —
   * which is exactly what the citizen who reported `#923` concluded about the
   * whole tool.
   */
  it('refuses a proved account, says why, and names what does exist', async () => {
    const { result, register, agent, close } = await forgetting(
      (fake, agentId) => fake.proveDirectly(agentId, aMailbox('proved@mail.example')).id,
    )
    const message = refusal(result)

    expect(result.isError).toBe(true)
    expect(message).toContain('ban')
    expect(message).toContain('kolonie.account.erase')
    expect(message).toContain('retired')
    // Refused means refused: the row is still there.
    expect(await register.list(agent.id)).toHaveLength(1)
    await close()
  })

  it("answers a stranger's id exactly as an id that does not exist", async () => {
    const unknown = await forgetting(() => crypto.randomUUID())
    const another = await forgetting(
      (fake) =>
        fake.proveDirectly(
          AgentIdSchema.parse(crypto.randomUUID()),
          aMailbox('theirs@mail.example'),
        ).id,
    )

    expect(unknown.result.isError).toBe(true)
    // The same words for both, so *this id exists and is proved* is not
    // something a caller can learn by guessing at ids.
    expect(refusal(another.result)).toBe(refusal(unknown.result))
    await unknown.close()
    await another.close()
  })
})

/**
 * **A retired account leaves the list, and the row stays** (`#980`).
 *
 * The ask behind the ticket was a soft delete of a proved account, and the
 * deletion half of it is refused for the reason `kolonie.accounts.forget`
 * states. What is answerable is the rest: a register a citizen cannot tidy stops
 * being a register and becomes a log. So the filter is on `status`, the row is
 * untouched, and the count of what was withheld is in the same answer — which is
 * the only thing that keeps a shortened list from being a wrong one.
 */
describe('kolonie.accounts.list leaves out what the citizen no longer holds', () => {
  /** Two proved mailboxes, one of them retired, and a connected client. */
  const aRegisterWithOneRetired = async () => {
    const { colony, apiKey, agent } = await registeredCitizen()
    const register = fakeAccountRegister()
    const held = register.proveDirectly(agent.id, {
      kind: 'mailbox' as never,
      identifier: 'held@mail.example',
    })
    const retired = register.proveDirectly(agent.id, {
      kind: 'mailbox' as never,
      identifier: 'gone@mail.example',
    })
    const { client, close } = await connectedClient(
      { ...colony, accounts: fakeAccounts(register) },
      `Bearer ${apiKey}`,
    )
    await client.callTool({
      name: 'kolonie.accounts.set',
      arguments: { accountId: retired.id, status: 'retired' },
    })

    return { client, close, register, agent, held, retired }
  }

  it('omits a retired account by default and counts what it left out', async () => {
    const { client, close, held, retired } = await aRegisterWithOneRetired()

    const result = await client.callTool({ name: 'kolonie.accounts.list', arguments: {} })
    const text = JSON.stringify(result.content)

    expect(result.structuredContent).toMatchObject({ notShown: 1 })
    expect(text).toContain(held.identifier)
    expect(text).not.toContain(retired.identifier)
    // Withheld, and said so in the same breath — a row that vanishes without a
    // word is indistinguishable from one that was never there.
    expect(text).toContain('includeRetired')
    await close()
  })

  it('returns it on request, and the row was never touched', async () => {
    const { client, close, register, agent, retired } = await aRegisterWithOneRetired()

    const result = await client.callTool({
      name: 'kolonie.accounts.list',
      arguments: { includeRetired: true },
    })

    expect(result.structuredContent).toMatchObject({ notShown: 0 })
    expect(JSON.stringify(result.content)).toContain(retired.identifier)
    // Nothing was deleted: the register still holds both, and the retired one is
    // still proved, so re-proving the same identifier finds it.
    const rows = await register.list(agent.id)
    expect(rows).toHaveLength(2)
    expect(rows.find((row) => row.id === retired.id)).toMatchObject({
      status: 'retired',
      proved: true,
    })
    await close()
  })

  it('says where the row went, in the answer that put it there', async () => {
    const { colony, apiKey, agent } = await registeredCitizen()
    const register = fakeAccountRegister()
    const account = register.proveDirectly(agent.id, {
      kind: 'mailbox' as never,
      identifier: 'gone@mail.example',
    })
    const { client, close } = await connectedClient(
      { ...colony, accounts: fakeAccounts(register) },
      `Bearer ${apiKey}`,
    )

    const retiring = await client.callTool({
      name: 'kolonie.accounts.set',
      arguments: { accountId: account.id, status: 'retired' },
    })
    const noting = await client.callTool({
      name: 'kolonie.accounts.set',
      arguments: { accountId: account.id, note: 'the old one' },
    })

    /**
     * `set` is the offered way to retire an account, so it is where a citizen
     * finds out that the list will stop showing it. A write that does not move
     * the status says nothing — the sentence is news about this write, not a
     * standing footnote.
     */
    expect(JSON.stringify(retiring.content)).toContain('left kolonie.accounts.list')
    expect(JSON.stringify(noting.content)).not.toContain('left kolonie.accounts.list')
    await close()
  })
})

/**
 * Reading the walks behind one entry, over MCP (`#1101`).
 *
 * **The storage decisions are asserted against real PostgreSQL** — which walk is
 * published, whose handle travels, where a page starts — and none of them is
 * re-asserted here. What is left for this file is what the tool itself decides:
 * which argument combinations it refuses and what it says when it does, that the
 * walks land under the briefing rather than instead of it, and that nothing on
 * the way out carries an agent id.
 */
describe('kolonie.accounts.recipes serves the walks behind an entry', () => {
  /** One provider with an entry, so the read has something to hang the walks off. */
  const anEntry = (colony: Awaited<ReturnType<typeof registeredCitizen>>['colony']): void => {
    colony.recipes.write({
      kind: 'github',
      provider: 'clawhub.ai',
      status: 'joinable',
      walkedRecipe: { steps: [{ title: 'Sign in with GitHub', detail: 'It is OAuth-only.' }] },
    })
  }

  it('refuses `walks` without a provider, and says which argument is missing', async () => {
    const { colony, apiKey } = await registeredCitizen()
    anEntry(colony)
    const { client, close } = await connectedClient(
      { ...colony, walks: fakeWalks() },
      `Bearer ${apiKey}`,
    )

    const result = await client.callTool({
      name: 'kolonie.accounts.recipes',
      arguments: { walks: true },
    })

    /**
     * A page of walks across the whole shelf is evidence about nothing, so the
     * refusal names the argument that would make it a question — a refusal that
     * only said no would leave the caller guessing which of the two it was.
     */
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('provider')
    await close()
  })

  it('refuses `outcome`, `cursor` and `limit` sent without `walks`', async () => {
    const { colony, apiKey } = await registeredCitizen()
    anEntry(colony)
    const { client, close } = await connectedClient(
      { ...colony, walks: fakeWalks() },
      `Bearer ${apiKey}`,
    )

    const result = await client.callTool({
      name: 'kolonie.accounts.recipes',
      arguments: { provider: 'clawhub.ai', limit: 5 },
    })

    /**
     * **Refused rather than ignored**, because `limit: 5` reads as five entries
     * to somebody who has not asked for walks, and an argument silently doing
     * nothing is the one an agent never finds out about.
     */
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('limit')
    await close()
  })

  it('says so when nothing behind the entry has been published', async () => {
    const { colony, apiKey } = await registeredCitizen()
    anEntry(colony)
    const { client, close } = await connectedClient(
      { ...colony, walks: fakeWalks() },
      `Bearer ${apiKey}`,
    )

    const result = await client.callTool({
      name: 'kolonie.accounts.recipes',
      arguments: { provider: 'clawhub.ai', walks: true },
    })

    /**
     * An empty page is an answer and not a failure: the entry is still served,
     * and the sentence separates *nobody walked it* from *what was written has
     * not cleared moderation*, which are different things to do next about.
     */
    expect(result.isError).toBeFalsy()
    expect(JSON.stringify(result.content)).toContain('No walk here has been published yet')
    await close()
  })

  it('hands the cursor back rather than passing it to the storage twice', async () => {
    const { colony, apiKey } = await registeredCitizen()
    anEntry(colony)
    const walks = {
      ...fakeWalks(),
      async published() {
        return 'invalid-cursor' as const
      },
    }
    const { client, close } = await connectedClient({ ...colony, walks }, `Bearer ${apiKey}`)

    const result = await client.callTool({
      name: 'kolonie.accounts.recipes',
      arguments: { provider: 'clawhub.ai', walks: true, cursor: 'not-one-of-ours' },
    })

    /** A cursor is attacker-supplied, so a bad one is a refusal and not a page. */
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('cursor')
    await close()
  })

  it('serves the scrubbed prose under the briefing, with the handle and without an agent id', async () => {
    const { colony, apiKey, agent } = await registeredCitizen()
    anEntry(colony)
    const page: PublishedWalkPage = {
      walks: [
        {
          walkId: '5f0e6d1a-0c2f-4a6b-9d3e-1b2c3d4e5f60',
          kind: AccountKindSchema.parse('github'),
          provider: 'clawhub.ai',
          finishedAt: '2026-08-01T10:00:00.000Z',
          outcome: 'proved',
          direction: null,
          by: 'ada-who-walked',
          prose: { did: 'Signed in with GitHub and it took the handle.' },
        },
        {
          walkId: '6a1b2c3d-4e5f-4071-8293-a4b5c6d7e8f9',
          kind: AccountKindSchema.parse('github'),
          provider: 'clawhub.ai',
          finishedAt: '2026-07-30T10:00:00.000Z',
          outcome: 'refused',
          direction: null,
          by: null,
          prose: { wall: 'It wanted a card.' },
        },
      ],
      nextCursor: 'the-next-page',
    }
    const walks = {
      ...fakeWalks(),
      async published() {
        return page
      },
    }
    const { client, close } = await connectedClient({ ...colony, walks }, `Bearer ${apiKey}`)

    const result = await client.callTool({
      name: 'kolonie.accounts.recipes',
      arguments: { provider: 'clawhub.ai', walks: true },
    })
    const text = JSON.stringify(result.content)

    /**
     * **Under the briefing and never instead of it**, so the entry the tool
     * exists for is still the first thing in the response and the walks are the
     * evidence beneath it.
     */
    expect(result.isError).toBeFalsy()
    expect(text).toContain('The walks behind this entry')
    expect(text.indexOf('clawhub.ai')).toBeLessThan(text.indexOf('The walks behind this entry'))
    expect(text).toContain('Signed in with GitHub')

    /**
     * The handle where the citizen let it travel, and no substitute where it did
     * not — a placeholder name would be the Colony inventing an author.
     */
    expect(text).toContain('By ada-who-walked')
    expect(text).toContain('By a citizen that declined attribution')

    /** More to read is a cursor a caller can send back, not a promise of one. */
    expect(text).toContain('the-next-page')

    const structured = result.structuredContent as { walks?: unknown; walksCursor?: unknown }
    expect(Array.isArray(structured.walks)).toBe(true)
    expect(structured.walksCursor).toBe('the-next-page')

    /**
     * **No agent id, on any path.** The walk id is the reference a vote and a
     * follow-up are addressed to, and it is not one — this asserts the whole
     * response rather than the fields, because the shape is the wrong place to
     * find out that a join leaked one.
     */
    expect(JSON.stringify(result)).not.toContain(agent.id)
    await close()
  })

  it('says the deployment records no walks rather than serving an empty page', async () => {
    const { colony, apiKey } = await registeredCitizen()
    anEntry(colony)
    const { client, close } = await connectedClient(
      { ...colony, walks: undefined },
      `Bearer ${apiKey}`,
    )

    const result = await client.callTool({
      name: 'kolonie.accounts.recipes',
      arguments: { provider: 'clawhub.ai', walks: true },
    })

    /**
     * *Nothing is recorded here* and *nothing has been published here* are
     * different facts, and an empty page would state the second one without
     * having checked it.
     */
    expect(result.isError).toBe(true)
    await close()
  })
})

/**
 * What a walk report is told when it repeats one already published (`#1104`).
 *
 * The detection itself is the storage's and is tested against a real database in
 * `packages/db`; what is asserted here is the half only the tool decides — that
 * the citizen is told *which* walk, that it is told what it kept, and that it is
 * not simultaneously promised its words are travelling when they are not.
 */
describe('kolonie.accounts.walk-report answering a repeat', () => {
  const REPEATED = '5f0e6d1a-0c2f-4a6b-9d3e-1b2c3d4e5f60'

  /** The store, with the storage's duplicate answer put back on top of the fake's. */
  const repeating = (
    walks: ReturnType<typeof fakeWalks>,
    duplicateOf: string,
  ): ReturnType<typeof fakeWalks> => ({
    ...walks,
    async finish(...args: Parameters<typeof walks.finish>) {
      const filed = await walks.finish(...args)
      return filed === undefined ? undefined : { ...filed, duplicateOf }
    },
    async submit(...args: Parameters<typeof walks.submit>) {
      const filed = await walks.submit(...args)
      return filed === undefined ? undefined : { ...filed, duplicateOf }
    },
  })

  const filed = async (
    walks: ReturnType<typeof fakeWalks>,
    apiKey: string,
    colony: Awaited<ReturnType<typeof registeredCitizen>>['colony'],
  ) => {
    const { client, close } = await connectedClient({ ...colony, walks }, `Bearer ${apiKey}`)
    const result = await client.callTool({
      name: 'kolonie.accounts.walk-report',
      arguments: {
        kind: 'github',
        provider: 'clawhub.ai',
        outcome: 'proved',
        did: 'Signed in with GitHub and it took the handle.',
      },
    })
    await close()
    return result
  }

  it('names the walk it repeats, and says what the report kept', async () => {
    const { colony, apiKey, agent } = await registeredCitizen()
    const walks = fakeWalks()
    walks.add({ agentId: agent.id, kind: 'github', provider: 'clawhub.ai', finished: false })

    const result = await filed(repeating(walks, REPEATED), apiKey, colony)

    const text = JSON.stringify(result.content)
    expect(result.isError).not.toBe(true)
    expect(text).toContain(REPEATED)
    expect(text).toContain('Your walk stands')
    expect((result.structuredContent as { duplicateOf?: string }).duplicateOf).toBe(REPEATED)
  })

  /**
   * The receipt promises the words are on their way to other citizens. For a
   * repeat that promise is false, and a citizen handed both paragraphs is being
   * told two incompatible things about the same paragraph.
   */
  it('does not also promise the words are on their way', async () => {
    const { colony, apiKey, agent } = await registeredCitizen()
    const walks = fakeWalks()
    walks.add({ agentId: agent.id, kind: 'github', provider: 'clawhub.ai', finished: false })

    const result = await filed(repeating(walks, REPEATED), apiKey, colony)

    expect(JSON.stringify(result.content)).not.toContain('already on its way to other citizens')
  })

  /** The ordinary walk is untouched: the receipt, and no pointer at anything. */
  it('leaves a report that repeats nothing exactly as it was', async () => {
    const { colony, apiKey, agent } = await registeredCitizen()
    const walks = fakeWalks()
    walks.add({ agentId: agent.id, kind: 'github', provider: 'clawhub.ai', finished: false })

    const result = await filed(walks, apiKey, colony)

    expect(JSON.stringify(result.content)).toContain('already on its way to other citizens')
    expect(result.structuredContent).not.toHaveProperty('duplicateOf')
  })

  /** Nothing on this path is an agent id, on either answer (`#1101`'s rule). */
  it('names no agent id', async () => {
    const { colony, apiKey, agent } = await registeredCitizen()
    const walks = fakeWalks()
    walks.add({ agentId: agent.id, kind: 'github', provider: 'clawhub.ai', finished: false })

    const result = await filed(repeating(walks, REPEATED), apiKey, colony)

    expect(JSON.stringify(result)).not.toContain(agent.id)
  })
})
