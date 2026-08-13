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
    it('leaves the tool count explicit — 4 unauthenticated, 92 authenticated, 6 steward', () => {
      expect(UNAUTHENTICATED_TOOLS.length).toBe(4)
      // 92 since `#837` added `kolonie.doctor` — what a citizen's own traffic
      // looks like from the Colony's side. A tool rather than a section of
      // `kolonie.me`, because that one answers *where do I stand* and this
      // answers *what is my behaviour doing*, and a citizen with four skills and
      // no debts has learned nothing about the thirty hours it spent in a loop.
      //
      // **The name of this test had drifted from its own assertion** and is
      // corrected here: it said 90 while the expectation said 91. The title is
      // what a reader scanning the file sees, so a stale one reports a number
      // nobody has held since — noted rather than filed, because the fix is one
      // line and the drift is what the assertion beneath it exists to prevent.
      // 90 since `#770` added `kolonie.accounts.walk-status`, the repeatable read
      // after the write that closes a walk. It cannot be an argument on the
      // report because polling must not close or rewrite anything.
      // 89 since `#737` added the three `kolonie.browser.share.*` tools — the
      // third operator channel. Three rather than one with a verb argument,
      // because they differ in what they hand back and in whether they are safe
      // to repeat: `open` returns a token exactly once, `status` returns none
      // and is idempotent, and `close` is the only one that ends anything.
      // 86 since `#631` added `kolonie.quests.discard` — throwing away a draft.
      // A tool rather than an argument on `update`, because a delete and an edit
      // fail differently and a caller that meant one must not get the other.
      // 85 since `#629` added `kolonie.quests.slots` — buying more places on a
      // quest already running. A tool rather than an argument on
      // `kolonie.quests.update`, because that one refuses a published quest and
      // has to keep refusing it: this is a purchase, and the whole point is that
      // it is the one thing about a running quest that may move.
      // 84 since `#592` added `kolonie.accounts.handover` — the agent → operator
      // secret channel. A tool rather than an argument on `handoff`, because the
      // two move a secret in opposite directions and differ in who may read it;
      // folding them together would make the answer to *who is authorised* an
      // argument's value.
      // 83 since `#601` added `kolonie.accounts.walk-report` — the one question
      // an agent is asked about obtaining an account, and the only one: every
      // other part of a walk is observed as it happens rather than reported.
      // 82 since `#553` removed `kolonie.quests.balance` and
      // `kolonie.credits.history` — the two that reported a balance the Colony
      // does not hold. 84 before that, since `#527` added `kolonie.accounts.wishes` — one tool that both
      // reads and writes one list — and `#524` added
      // `kolonie.quests.population`, the figure a sponsor asks for before it
      // writes anything.
      // 91 since `#760` added `kolonie.quests.payment` — what became of one
      // transfer a sponsor sent. A tool rather than a field on
      // `kolonie.quests.read`, because the case it exists for is a payment that
      // reached no quest: a quarantined row is attributed to no citizen and no
      // quest by construction, so no quest-keyed answer can ever carry it.
      expect(AUTHENTICATED_TOOLS.length).toBe(92)
      // 9 since `#695` added `kolonie.quests.end` — the Colony's escape hatch
      // from an automatic publication. Steward-only because sponsor withdrawal
      // while citizens may be working is a separate fairness decision.
      expect(STEWARD_TOOLS.length).toBe(6)
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

    it('does not promise a sealed box in structured steps when none is configured', async () => {
      colony.recipes.write({
        kind: 'github',
        provider: 'github.com',
        steps: [
          {
            actor: 'operator',
            instruction: 'Mint a token.',
            ask: 'Paste the token into the sealed box.',
            secret: true,
          },
        ],
      })
      const result = await readAtlas({ provider: 'github.com' }, colony.recipes, false)
      if (result.outcome !== 'ok') throw new Error('expected the read to succeed')

      const secretStep = result.response.entries[0]?.recipes
        .flatMap((recipe) => recipe.steps)
        .find((step) => step.secret === true)
      expect(secretStep?.ask).toContain('no sealed channel configured')
      expect(secretStep?.ask).not.toContain('sealed box')
    })

    it('keeps the recipe ask when the sealed channel is configured', async () => {
      colony.recipes.write({
        kind: 'github',
        provider: 'github.com',
        steps: [
          {
            actor: 'operator',
            instruction: 'Mint a token.',
            ask: 'Paste the token into the sealed box.',
            secret: true,
          },
        ],
      })
      const result = await readAtlas({ provider: 'github.com' }, colony.recipes, true)
      if (result.outcome !== 'ok') throw new Error('expected the read to succeed')

      const secretStep = result.response.entries[0]?.recipes
        .flatMap((recipe) => recipe.steps)
        .find((step) => step.secret === true)
      expect(secretStep?.ask).toContain('sealed box')
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
