import { describe, expect, it } from 'vitest'
import { AgentIdSchema, WALK_REPORT_FIELDS, WALK_REPORT_FIELD_ORDER } from '@kolonie-ai/core'
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

  /**
   * **What the draft is held on, said out loud** (`#857`).
   *
   * *Waiting for a steward* was true and unactionable: the citizen who filed
   * `#857` watched a walk sit at `appearsInRecipes: false` with nothing naming
   * what was outstanding, and the usual answer — the Colony has not written the
   * published sentence yet (`#517`) — is a fact about the Colony rather than one
   * the walker could have fixed by walking again.
   */
  it('names what a wordless draft is still held on', async () => {
    const { colony, apiKey, agent } = await registeredCitizen()
    const walks = fakeWalks()
    const walk = walks.add({ agentId: agent.id, kind: 'github', provider: 'provider' })
    colony.recipes.write({
      kind: 'github',
      provider: 'provider',
      status: 'draft',
      steps: [{ actor: 'agent' }],
      proves: null,
    })
    const { client, close } = await connectedClient({ ...colony, walks }, `Bearer ${apiKey}`)

    const draft = await client.callTool({
      name: 'kolonie.accounts.walk-status',
      arguments: { walkId: walk.id },
    })

    expect(draft.structuredContent).toMatchObject({
      status: 'draft',
      requiredChanges: [expect.stringContaining('no instruction')],
    })
    expect(JSON.stringify(draft.content)).toContain('held on')
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
    const { colony, apiKey } = await registeredCitizen()
    await colony.renames.alias('clawhub.com', 'clawhub.ai')
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const report = await client.callTool({
      name: 'kolonie.accounts.provider-report',
      arguments: { kind: 'github', provider: 'clawhub.com', outcome: 'signup-refused' },
    })
    const read = await client.callTool({ name: 'kolonie.accounts.providers', arguments: {} })

    expect(report.structuredContent).toMatchObject({ providerCanonical: 'clawhub.ai' })
    expect(JSON.stringify(read.content)).toContain('clawhub.ai')
    expect(JSON.stringify(read.content)).not.toContain('clawhub.com')
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
  const RECIPE = {
    prerequisites: ['A GitHub account you already control.'],
    steps: [
      { title: 'Open the signup page', detail: 'It is OAuth-only; there is no email signup.' },
      { title: 'Authorise the app', needsOperator: true },
    ],
    walls: [
      {
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
