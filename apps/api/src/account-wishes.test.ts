import { describe, expect, it } from 'vitest'
import type { AgentId } from '@kolonie-ai/core'
import { putOnWishList } from './account-wishes.js'
import { fakeWishList } from './__fixtures__/account-wishes.js'

/**
 * The shared list's surface (#527).
 *
 * **The refusal is what this file is for.** `#527` says outright *"No secrets in
 * it. It is words, on the terms `operator_requests` already sets — both free-text
 * boxes refuse secrets outright, and that refusal is what keeps `operator_drops`
 * meaning *a secret*."* This is the test that sentence asked for.
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
