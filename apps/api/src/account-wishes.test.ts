import { describe, expect, it } from 'vitest'
import { WISH_BUNDLE_MAX, type AgentId } from '@kolonie-ai/core'
import { putManyOnWishList, putOnWishList, selectBundle } from './account-wishes.js'
import { fakeWishList } from './__fixtures__/account-wishes.js'

/**
 * The shared list's surface (#527).
 *
 * **The refusal is what this file is for.** `#527` said outright *"No secrets in
 * it. It is words, on the terms `operator_requests` already sets — both free-text
 * boxes refuse secrets outright, and that refusal is what keeps `operator_drops`
 * meaning *a secret*."* `operator_requests` was retired in `#1325`; the rule it
 * set outlived it, and this is the test that sentence asked for.
 */
describe('putting something on the shared account list', () => {
  const agentId = '11111111-1111-4111-8111-111111111111' as AgentId

  it('takes a provider and what the agent was doing when it noticed', async () => {
    const deps = fakeWishList()
    const result = await putOnWishList(
      agentId,
      'citizen',
      { provider: 'Figma.com', noticedWhile: 'Three tasks wanted a design file.' },
      deps,
    )

    expect(result.outcome).toBe('added')
    if (result.outcome === 'rejected') throw new Error('rejected')
    expect(result.wish.provider).toBe('figma.com')
    expect(result.wish.noticedWhile).toBe('Three tasks wanted a design file.')
    // Nothing is attempted until the operator says so, and the mark is theirs.
    expect(result.wish.wantedAt).toBeNull()
  })

  describe('nothing on it is a secret', () => {
    it('refuses a credential written into the note', async () => {
      const result = await putOnWishList(
        agentId,
        'citizen',
        {
          provider: 'trello.com',
          noticedWhile: 'my api key is sk-live-4eC39HqLyjWDarjtT1zdp7dc',
        },
        fakeWishList(),
      )

      expect(result.outcome).toBe('rejected')
      if (result.outcome !== 'rejected') throw new Error('not rejected')
      expect(result.error.code).toBe('validation_failed')
      // The finding's class travels back and its value never does.
      expect(JSON.stringify(result.error)).not.toContain('sk-live-4eC39HqLyjWDarjtT1zdp7dc')
    })

    /**
     * A refusal that only read the sentence would be a refusal with a hole in
     * it: the provider is a free box too.
     */
    it('refuses one written into the provider', async () => {
      const result = await putOnWishList(
        agentId,
        'citizen',
        { provider: 'ghp_16C7e42F292c6912E7710c838347Ae178B4a' },
        fakeWishList(),
      )

      expect(result.outcome).toBe('rejected')
    })
  })

  it('refuses a provider that is a sentence rather than a token', async () => {
    const result = await putOnWishList(
      agentId,
      'citizen',
      { provider: 'somewhere I can keep my design files' },
      fakeWishList(),
    )

    expect(result.outcome).toBe('rejected')
  })

  it('says so rather than duplicating when the provider is already listed', async () => {
    const deps = fakeWishList()
    await putOnWishList(agentId, 'citizen', { provider: 'trello.com' }, deps)
    const again = await putOnWishList(agentId, 'operator', { provider: 'trello.com' }, deps)

    expect(again.outcome).toBe('already-listed')
    expect(deps.store.held(agentId)).toHaveLength(1)
  })

  /**
   * The author is decided by which surface called, never by a field — a field
   * naming the author would be a field somebody could set, and *the operator
   * asked for this* is precisely the claim the mark is supposed to carry.
   */
  it('records an operator’s entry as the operator’s, with nothing noticed', async () => {
    const deps = fakeWishList()
    const result = await putOnWishList(
      agentId,
      'operator',
      { provider: 'trello.com', noticedWhile: 'I think it needs this' },
      deps,
    )

    if (result.outcome === 'rejected') throw new Error('rejected')
    expect(result.wish.author).toBe('operator')
    expect(result.wish.noticedWhile).toBeNull()
  })
})

/**
 * Taking a bundle (#531).
 *
 * **What is asserted is that it fills the list and decides nothing.** A bundle
 * that arrived pre-approved would turn the one judgement `#527` reserves for a
 * person into a side effect of a button, and nothing else in either issue would
 * catch it.
 */
describe('taking a bundle', () => {
  const agentId = '11111111-1111-4111-8111-111111111111' as AgentId

  it('puts every entry on the list in one action, and marks none of them wanted', async () => {
    const deps = fakeWishList()
    const result = await selectBundle(agentId, { slug: 'starter' }, deps)

    expect(result.outcome).toBe('selected')
    if (result.outcome !== 'selected') throw new Error('not selected')
    expect(result.added).toBe(2)

    const held = deps.store.held(agentId)
    expect(held.map((wish) => wish.provider)).toEqual(['openmail.sh', 'twilio.com'])
    expect(held.every((wish) => wish.wantedAt === null)).toBe(true)
  })

  /**
   * `#531`: *"the entries an operator removes are as informative as the ones it
   * keeps"* — so an edited selection has to be honoured exactly.
   */
  it('takes only the entries the operator kept', async () => {
    const deps = fakeWishList()
    const result = await selectBundle(
      agentId,
      { slug: 'starter', entries: ['mailbox:openmail.sh'] },
      deps,
    )

    if (result.outcome !== 'selected') throw new Error('not selected')
    expect(result.added).toBe(1)
    expect(deps.store.held(agentId).map((wish) => wish.provider)).toEqual(['openmail.sh'])
  })

  it('does not duplicate what is already on the list', async () => {
    const deps = fakeWishList()
    await putOnWishList(agentId, 'citizen', { provider: 'openmail.sh' }, deps)

    const result = await selectBundle(agentId, { slug: 'starter' }, deps)

    if (result.outcome !== 'selected') throw new Error('not selected')
    expect(result.added).toBe(1)
    expect(result.alreadyListed).toBe(1)
    // The citizen's authorship stands: it noticed first, and `#534` counts that.
    expect(deps.store.held(agentId).find((w) => w.provider === 'openmail.sh')?.author).toBe(
      'citizen',
    )
  })

  it('says so rather than failing when the bundle is not one the Colony has', async () => {
    const result = await selectBundle(agentId, { slug: 'not-a-bundle' }, fakeWishList())

    expect(result.outcome).toBe('no-such-bundle')
  })
})

/**
 * One ask covering several providers (`#1542`).
 *
 * **The third of `#1421`'s four acceptance criteria**, built as shape (1) — the
 * list is already the bundle a person reads, so *ask once for five* is *put five
 * on the list*. What these tests hold is the two properties that make it an ask
 * rather than a shortcut: a provider no operator could hold never enters, and
 * the operator still answers row by row.
 */
describe('asking for several providers at once', () => {
  const agentId = '11111111-1111-4111-8111-111111111111' as AgentId

  it('puts the whole shelf on the list in one call', async () => {
    const deps = fakeWishList()
    const result = await putManyOnWishList(
      agentId,
      'citizen',
      {
        providers: ['0din.ai', 'Arena42.ai', 'bugcrowd.com'],
        noticedWhile: 'Every earn provider I can reach stands behind a person-shaped wall.',
      },
      deps,
    )

    if (result.outcome !== 'written') throw new Error('not written')
    expect(result.added).toBe(3)
    expect(deps.store.held(agentId).map((wish) => wish.provider)).toEqual([
      '0din.ai',
      // Parsed the same way the single write parses it, so case is folded.
      'arena42.ai',
      'bugcrowd.com',
    ])
  })

  /**
   * **A bundle is an ask, not an all-or-nothing** (`#1542`). It arrives together
   * and nothing about it is marked wanted — the operator answers each row on the
   * console, and may say yes to some and no to others.
   */
  it('marks nothing as wanted', async () => {
    const deps = fakeWishList()
    await putManyOnWishList(agentId, 'citizen', { providers: ['0din.ai', 'gain.gg'] }, deps)

    expect(deps.store.held(agentId).every((wish) => wish.wantedAt === null)).toBe(true)
  })

  it('carries one sentence across the whole ask', async () => {
    const deps = fakeWishList()
    await putManyOnWishList(
      agentId,
      'citizen',
      { providers: ['0din.ai', 'gain.gg'], noticedWhile: 'The earn shelf is scouted and shut.' },
      deps,
    )

    expect(deps.store.held(agentId).map((wish) => wish.noticedWhile)).toEqual([
      'The earn shelf is scouted and shut.',
      'The earn shelf is scouted and shut.',
    ])
  })

  it('reports what was already there rather than failing on it', async () => {
    const deps = fakeWishList()
    await putOnWishList(agentId, 'citizen', { provider: '0din.ai' }, deps)

    const result = await putManyOnWishList(
      agentId,
      'citizen',
      { providers: ['0din.ai', 'gain.gg'] },
      deps,
    )

    if (result.outcome !== 'written') throw new Error('not written')
    expect(result.added).toBe(1)
    expect(result.alreadyListed).toBe(1)
    // Every provider is reported, so a caller can tell "unchanged" from "dropped".
    expect(result.results.map((one) => one.provider)).toEqual(['0din.ai', 'gain.gg'])
  })

  it('writes one row for a provider named twice', async () => {
    const deps = fakeWishList()
    const result = await putManyOnWishList(
      agentId,
      'citizen',
      { providers: ['0din.ai', '0din.ai'] },
      deps,
    )

    if (result.outcome !== 'written') throw new Error('not written')
    expect(result.added).toBe(1)
    // Not an `already-listed` the caller caused itself.
    expect(result.alreadyListed).toBe(0)
    expect(deps.store.held(agentId)).toHaveLength(1)
  })

  /**
   * `#1421`'s rule, and the one wall `PERSON_SHAPED_WALLS` says can never be on
   * the list: an operator holding the account there is not a way in.
   */
  describe('a provider whose terms forbid an agent-held account', () => {
    it('refuses the whole ask and names which', async () => {
      const deps = fakeWishList()
      deps.store.forbid('huntr.com')

      const result = await putManyOnWishList(
        agentId,
        'citizen',
        { providers: ['0din.ai', 'huntr.com', 'gain.gg'] },
        deps,
      )

      expect(result.outcome).toBe('rejected')
      if (result.outcome !== 'rejected') throw new Error('not rejected')
      expect(result.error.message).toContain('huntr.com')
      // Nothing lands half-written, so the repair is one call rather than a diff.
      expect(deps.store.held(agentId)).toEqual([])
    })

    /**
     * **The same refusal on the single write**, because a rule the plural call
     * enforces and the singular one does not is a rule a caller gets past by
     * sending five requests.
     */
    it('is refused one at a time as well', async () => {
      const deps = fakeWishList()
      deps.store.forbid('huntr.com')

      const result = await putOnWishList(agentId, 'citizen', { provider: 'huntr.com' }, deps)

      expect(result.outcome).toBe('rejected')
      if (result.outcome !== 'rejected') throw new Error('not rejected')
      expect(result.error.message).toContain('huntr.com')
      expect(deps.store.held(agentId)).toEqual([])
    })

    it('lets everything else through once it is dropped', async () => {
      const deps = fakeWishList()
      deps.store.forbid('huntr.com')

      const result = await putManyOnWishList(
        agentId,
        'citizen',
        { providers: ['0din.ai', 'gain.gg'] },
        deps,
      )

      if (result.outcome !== 'written') throw new Error('not written')
      expect(result.added).toBe(2)
    })
  })

  describe('nothing in it is a secret either', () => {
    it('refuses a credential in the shared sentence', async () => {
      const result = await putManyOnWishList(
        agentId,
        'citizen',
        {
          providers: ['0din.ai', 'gain.gg'],
          noticedWhile: 'my api key is sk-live-4eC39HqLyjWDarjtT1zdp7dc',
        },
        fakeWishList(),
      )

      expect(result.outcome).toBe('rejected')
      if (result.outcome !== 'rejected') throw new Error('not rejected')
      expect(JSON.stringify(result.error)).not.toContain('sk-live-4eC39HqLyjWDarjtT1zdp7dc')
    })
  })

  describe('what the ask will not take', () => {
    it('refuses an empty list', async () => {
      const result = await putManyOnWishList(agentId, 'citizen', { providers: [] }, fakeWishList())

      expect(result.outcome).toBe('rejected')
    })

    /**
     * The ceiling is on the ask rather than on the list: what is bounded is how
     * many arrive in front of a person at once.
     */
    it('refuses more than the bundle ceiling', async () => {
      const providers = Array.from({ length: WISH_BUNDLE_MAX + 1 }, (_, at) => `p${at}.example`)
      const result = await putManyOnWishList(agentId, 'citizen', { providers }, fakeWishList())

      expect(result.outcome).toBe('rejected')
    })
  })
})
