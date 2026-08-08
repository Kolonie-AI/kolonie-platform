import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { noFigures, type AtlasEntry } from '@kolonie-ai/core'
import { fakeColony, type FakeColony } from '../../__fixtures__/colony/index.js'
import { atlasEntryAsText, readAtlas } from '../../provider-recipes.js'
import { AUTHENTICATED_TOOLS, STEWARD_TOOLS, UNAUTHENTICATED_TOOLS } from '../tool-list.js'

/**
 * Reading the Atlas without a browser (`#550`).
 *
 * An agent choosing what to sign up for should not have to open a page. What it
 * needs is the catalogue, one entry in full, and the figures — and it should not
 * cost every citizen a second tool namespace to get them.
 */
describe('the Atlas over MCP', () => {
  let colony: FakeColony

  beforeEach(() => {
    colony = fakeColony()
    colony.recipes.write({ kind: 'github', provider: 'github.com', title: 'GitHub' })
    colony.recipes.write({ kind: 'mailbox', provider: 'mail.tm', title: 'Mail.tm' })
    colony.recipes.write({
      kind: 'social',
      provider: 'bsky.app',
      title: 'Bluesky',
      status: 'refused',
      refusal: 'No honest route in for a citizen without a phone.',
    })
  })

  afterEach(() => {
    colony = fakeColony()
  })

  /**
   * **No new top-level tool name**, which `#550` requires: `#382`–`#388` are
   * shrinking this surface deliberately, and a second namespace for a register
   * that already has one is a cost every citizen carries in every session, paid
   * to rename something.
   */
  describe('the surface it costs', () => {
    it('introduces no kolonie.atlas namespace', () => {
      const every = [...UNAUTHENTICATED_TOOLS, ...AUTHENTICATED_TOOLS, ...STEWARD_TOOLS]

      expect(every.filter((tool) => tool.startsWith('kolonie.atlas'))).toEqual([])
    })

    /**
     * **Stronger than adding one under the old prefix: it adds none at all.**
     * `kolonie.accounts.recipes` gained two optional arguments and its result
     * gained the figures, so the count is exactly what it was. Reported here per
     * `#388`'s practice.
     */
    it('leaves the tool count where it was — 4 unauthenticated, 82 authenticated, 8 steward', () => {
      expect(UNAUTHENTICATED_TOOLS.length).toBe(4)
      // 82 since `#553` removed `kolonie.quests.balance` and
      // `kolonie.credits.history` — the two that reported a balance the Colony
      // does not hold. 84 before that, since `#527` added `kolonie.accounts.wishes` — one tool that both
      // reads and writes one list — and `#524` added
      // `kolonie.quests.population`, the figure a sponsor asks for before it
      // writes anything.
      expect(AUTHENTICATED_TOOLS.length).toBe(82)
      expect(STEWARD_TOOLS.length).toBe(8)
    })

    it('still carries the catalogue read under the name it already had', () => {
      expect(AUTHENTICATED_TOOLS).toContain('kolonie.accounts.recipes')
    })
  })

  describe('what an agent can ask', () => {
    it('lists the catalogue', async () => {
      const result = await readAtlas({}, colony.recipes, true)
      if (result.outcome !== 'ok') throw new Error('expected the read to succeed')

      expect(result.response.entries.map((one) => one.provider).sort()).toEqual([
        'bsky.app',
        'github.com',
        'mail.tm',
      ])
    })

    it('narrows to one category', async () => {
      const result = await readAtlas({ kind: 'mailbox' }, colony.recipes, true)
      if (result.outcome !== 'ok') throw new Error('expected the read to succeed')

      expect(result.response.entries.map((one) => one.provider)).toEqual(['mail.tm'])
    })

    it('reads one entry in full', async () => {
      const result = await readAtlas({ provider: 'github.com' }, colony.recipes, true)
      if (result.outcome !== 'ok') throw new Error('expected the read to succeed')

      expect(result.response.entries).toHaveLength(1)
      expect(result.response.entries[0]?.recipes[0]?.steps.length).toBeGreaterThan(0)
    })

    /** An absence is not a refusal, and the message has to say which it is. */
    it('says a missing entry is an absence rather than a refusal', async () => {
      const result = await readAtlas({ provider: 'notion.so' }, colony.recipes, true)

      expect(result.outcome).toBe('rejected')
      if (result.outcome !== 'rejected') return
      expect(result.error.message).toContain('absence and not a refusal')
    })

    /**
     * `#523`'s question asked of the catalogue: what am I not equipped for. Off
     * unless asked for, because a catalogue is also read to find a better
     * provider for something you already hold.
     */
    it('can drop the kinds the agent already holds', async () => {
      const result = await readAtlas({ held: new Set(['github']) }, colony.recipes, true)
      if (result.outcome !== 'ok') throw new Error('expected the read to succeed')

      expect(result.response.entries.map((one) => one.provider).sort()).toEqual([
        'bsky.app',
        'mail.tm',
      ])
    })

    it('keeps everything when the filter is not asked for', async () => {
      const result = await readAtlas({}, colony.recipes, true)
      if (result.outcome !== 'ok') throw new Error('expected the read to succeed')

      expect(result.response.entries).toHaveLength(3)
    })
  })

  describe('what an entry says to an agent', () => {
    const entryFor = async (provider: string): Promise<AtlasEntry> => {
      const result = await readAtlas({ provider }, colony.recipes, true)
      if (result.outcome !== 'ok') throw new Error('expected the read to succeed')
      const entry = result.response.entries[0]
      if (entry === undefined) throw new Error('expected an entry')
      return entry
    }

    /**
     * **The reason this is not the recipe with a header.** An agent choosing
     * between two providers should know that 12% get through one and 80%
     * through the other.
     */
    it('carries the measured figures', async () => {
      colony.recipes.measure({
        ...noFigures('github', 'github.com'),
        attempted: 50,
        proved: 40,
        stillHeld: 30,
        heldLongEnoughToAsk: 35,
      })

      const text = atlasEntryAsText(await entryFor('github.com'), true)

      expect(text).toContain('80% of 50 agents got through')
      expect(text).toContain('30 of 35 still held it after 30 days')
    })

    /**
     * **A marker shown to people and not to agents would be a disclosure that
     * stops where it becomes inconvenient.**
     */
    it('carries the paid marker, and says what paying does not buy', async () => {
      colony.recipes.write({ kind: 'mailbox', provider: 'sponsored.test', paid: true })

      const text = atlasEntryAsText(await entryFor('sponsored.test'), true)

      expect(text).toContain('This entry is paid for.')
      expect(text).toContain('not its position')
    })

    it('tells an agent not to attempt a refused provider', async () => {
      expect(atlasEntryAsText(await entryFor('bsky.app'), true)).toContain('Do not attempt this')
    })

    it('says an unmeasured entry is an absence rather than a poor result', async () => {
      expect(atlasEntryAsText(await entryFor('mail.tm'), true)).toContain(
        'absence and not a poor result',
      )
    })

    /**
     * `kolonie-docs#216` gates the Colony's own population figure, and a
     * per-provider rate is a fact about the provider rather than about our size.
     */
    it('never states how many agents the Colony has', async () => {
      colony.recipes.measure({ ...noFigures('github', 'github.com'), attempted: 50, proved: 40 })

      const text = atlasEntryAsText(await entryFor('github.com'), true)

      expect(text).not.toMatch(/the Colony has \d/i)
      expect(text).not.toMatch(/\d+ citizens in total/i)
    })
  })
})
