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
    it('leaves the tool count explicit — 4 unauthenticated, 94 authenticated, 6 steward', () => {
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
      // 93 since `#821` added `kolonie.accounts.on-profile` — naming one proved
      // account on the citizen's own page. A second tool rather than an argument
      // on `kolonie.accounts.attestable`, because that one's description
      // promises "no list, no browsing, no way to discover what else you hold"
      // and a page is that list.
      // 90 since `#911` withdrew the three `kolonie.browser.share.*` tools —
      // the third operator channel, removed rather than repaired. `#894`
      // measured the thing it was built for: the challenge reads the browser as
      // driven and never opens, so the person arrived at a page with nothing on
      // it to clear. **The names are not reused.** A later mechanism gets its
      // own vocabulary, because `kolonie.browser.share.*` now means a thing that
      // was tried and did not work, and a citizen that finds the name and reads
      // the old write-up would be reading an obituary as an instruction.
      // 91 since `#890` added `kolonie.accounts.set` — the eight small account
      // writes as one tool. The eight it replaces are still in this list and
      // are what the count is now larger by: a superseded name stays registered
      // so a skill file written before the consolidation keeps working, and is
      // removed from `tools/list` on the way out. `SUPERSEDED_TOOLS` is what a
      // citizen is actually offered fewer of, and `superseded.test.ts` asserts
      // both halves.
      // 93 since `#930` added `kolonie.accounts.thread` and
      // `kolonie.accounts.take` — the account conversation. Two rather than one,
      // because taking a secret out of a slot is the single act that spends
      // something, and folding it into the tool a citizen calls on waking would
      // make *read what is open* and *consume the one copy* neighbours in the
      // same argument. Two rather than seven, because the other six moves differ
      // only in what they write and all of them are safe to repeat.
      // 94 since `#923` added `kolonie.accounts.forget` — deleting a row a
      // citizen declared and never proved. A tool rather than a fourth status,
      // because `kolonie.accounts.set` is idempotent and applies field by
      // field, which is not a shape a destructive delete belongs in.
      expect(AUTHENTICATED_TOOLS.length).toBe(94)
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

    /**
     * An absence is two situations (`#859`), and browsing is where the second
     * one lands: an agent that arrived by searching has walked nothing yet, so
     * *report what you found* is the one move it cannot make. The propose door
     * is a second meaning of `kolonie.accounts.wishes`, which is not a thing an
     * agent works out from the tool's name.
     */
    it('names both doors when the Atlas has never heard of a provider', async () => {
      const result = await readAtlas(
        { provider: 'nobody-has-looked.example' },
        colony.recipes,
        true,
      )

      expect(result.outcome).toBe('rejected')
      if (result.outcome !== 'rejected') return
      expect(result.error.message).toContain('kolonie.accounts.provider-report')
      expect(result.error.message).toContain('kolonie.accounts.wishes')
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

  /**
   * Browsing the shelf without reading all of it (`#855`).
   *
   * **Both filters narrow and neither hides by default.** An agent that can ask
   * *only the ones that demonstrably work* stops re-deciding what the ordering
   * already decided; an Atlas that answered that way unasked would be the link
   * collection it exists not to be.
   */
  describe('narrowing the shelf', () => {
    it('narrows to one state, refusals included', async () => {
      const result = await readAtlas({ status: 'refused' }, colony.recipes, true)
      if (result.outcome !== 'ok') throw new Error('expected the read to succeed')

      expect(result.response.entries.map((one) => one.provider)).toEqual(['bsky.app'])
    })

    it('narrows to the providers enough citizens got through', async () => {
      colony.recipes.measure({ ...noFigures('github', 'github.com'), attempted: 50, proved: 40 })
      colony.recipes.measure({ ...noFigures('mailbox', 'mail.tm'), attempted: 9, proved: 4 })

      const result = await readAtlas({ minProved: 10 }, colony.recipes, true)
      if (result.outcome !== 'ok') throw new Error('expected the read to succeed')

      expect(result.response.entries.map((one) => one.provider)).toEqual(['github.com'])
    })

    /**
     * Below the floor the Colony does not publish the count, and a filter that
     * let a caller probe for one would publish it a question at a time.
     */
    it('counts a suppressed figure as zero rather than letting it be probed for', async () => {
      colony.recipes.measure({
        ...noFigures('github', 'github.com'),
        attempted: 3,
        proved: 3,
        suppressed: true,
      })

      const result = await readAtlas({ minProved: 1 }, colony.recipes, true)
      if (result.outcome !== 'ok') throw new Error('expected the read to succeed')

      expect(result.response.entries.map((one) => one.provider)).not.toContain('github.com')
    })

    it('refuses a state no catalogue entry is in, and names the ones that exist', async () => {
      const result = await readAtlas({ status: 'nonsense' }, colony.recipes, true)

      expect(result.outcome).toBe('rejected')
      if (result.outcome !== 'rejected') return
      expect(result.error.message).toContain('joinable')
    })

    it('refuses a floor that is not a count', async () => {
      for (const minProved of [-1, 1.5]) {
        const result = await readAtlas({ minProved }, colony.recipes, true)

        expect(result.outcome).toBe('rejected')
      }
    })

    /**
     * **A provider the filters hid is not a provider the Atlas has never heard
     * of.** Answering the second question with the first would be a claim about
     * the Colony's knowledge that the filter, not the catalogue, made true.
     */
    it('does not call a filtered-out provider an absence', async () => {
      const result = await readAtlas(
        { provider: 'github.com', status: 'refused' },
        colony.recipes,
        true,
      )
      if (result.outcome !== 'ok') throw new Error('expected the read to succeed')

      expect(result.response.entries).toEqual([])
    })
  })

  /**
   * The providers only the measurements knew about (`#856`).
   *
   * A citizen proves an account somewhere nobody has written up, and until now
   * the shelf stayed silent about a provider several citizens had got through.
   */
  describe('providers the figures put on the shelf', () => {
    it('lists a measured provider the catalogue has no row for', async () => {
      colony.recipes.measure({
        ...noFigures('mailbox', 'somewhere.test'),
        attempted: 8,
        proved: 5,
      })

      const result = await readAtlas({ provider: 'somewhere.test' }, colony.recipes, true)
      if (result.outcome !== 'ok') throw new Error('expected the read to succeed')

      const entry = result.response.entries[0]
      expect(entry?.source).toBe('measured')
      /**
       * **`measured` since `#903` put the status in the rollup.** This said
       * `unwritten` when a synthesised row genuinely was one, and went on
       * passing after the label changed — so it was one of the two assertions
       * holding the rollup bug in place rather than catching it.
       */
      expect(entry?.status).toBe('measured')
    })

    it('says out loud that nobody wrote it, and what would put steps there', async () => {
      colony.recipes.measure({
        ...noFigures('mailbox', 'somewhere.test'),
        attempted: 8,
        proved: 5,
      })

      const result = await readAtlas({ provider: 'somewhere.test' }, colony.recipes, true)
      if (result.outcome !== 'ok') throw new Error('expected the read to succeed')
      const entry = result.response.entries[0]
      if (entry === undefined) throw new Error('expected an entry')

      const text = atlasEntryAsText(entry, true)
      expect(text).toContain('Nobody has written this entry')
      expect(text).toContain('provider-report')
    })

    /**
     * **The floor governs the counts and not the row** (`#909`, on
     * `kolonie-docs#352`). This asserted the opposite until then, on the reading
     * that *somebody tried it* is the count wearing a different shape — and the
     * measurement overturned it: no provider sample in the Colony reached the
     * floor, so the shelf showed none of the providers citizens had actually got
     * into.
     *
     * The row names the provider and nothing countable. What the floor withholds
     * is `attempted` and `proved`, and it still does.
     */
    it('shows a provider below the floor, without its counts', async () => {
      colony.recipes.measure({
        ...noFigures('mailbox', 'quiet.test'),
        attempted: 2,
        proved: 1,
        /** The band survives the floor (`#792`), so a real row below it carries one. */
        band: 'about-half',
        suppressed: true,
      })

      const result = await readAtlas({}, colony.recipes, true)
      if (result.outcome !== 'ok') throw new Error('expected the read to succeed')

      const entry = result.response.entries.find((one) => one.provider === 'quiet.test')
      if (entry === undefined) throw new Error('expected the measured row to be on the shelf')

      expect(entry.source).toBe('measured')
      expect(entry.status).toBe('measured')

      /** The counts stay behind the floor, which is the half that did not change. */
      const text = atlasEntryAsText(entry, true)
      expect(text).toContain('counts behind them are withheld')
      expect(text).not.toMatch(/\b2\b|\b1 of\b/)
    })

    it('says nothing about provenance on an entry a maintainer wrote', async () => {
      const result = await readAtlas({ provider: 'mail.tm' }, colony.recipes, true)
      if (result.outcome !== 'ok') throw new Error('expected the read to succeed')
      const entry = result.response.entries[0]
      if (entry === undefined) throw new Error('expected an entry')

      expect(entry.source).toBe('curated')
      expect(atlasEntryAsText(entry, true)).not.toContain('Nobody has written this entry')
    })
  })

  /**
   * How well an entry has aged, said before its steps (`#860`).
   *
   * An agent that reads three steps before being told nobody has confirmed them
   * since March has already spent the attention the line exists to save.
   */
  describe('what an entry says about its own age', () => {
    it('warns above the steps when nobody has confirmed them', async () => {
      colony.recipes.write({
        kind: 'mailbox',
        provider: 'unconfirmed.test',
        title: 'Unconfirmed',
        lastConfirmedAt: null,
      })

      const result = await readAtlas({ provider: 'unconfirmed.test' }, colony.recipes, true)
      if (result.outcome !== 'ok') throw new Error('expected the read to succeed')
      const entry = result.response.entries[0]
      if (entry === undefined) throw new Error('expected an entry')

      expect(entry.health).toBe('stale')
      expect(atlasEntryAsText(entry, true)).toContain('Nobody has confirmed this recently')
    })

    it('keeps a withdrawn entry findable, as a warning rather than a route', async () => {
      colony.recipes.write({ kind: 'mailbox', provider: 'gone.test', title: 'Gone' })
      colony.recipes.setStatus('mailbox', 'gone.test', 'retired')

      const result = await readAtlas({ provider: 'gone.test' }, colony.recipes, true)
      if (result.outcome !== 'ok') throw new Error('expected the read to succeed')
      const entry = result.response.entries[0]
      if (entry === undefined) throw new Error('expected an entry')

      expect(entry.health).toBe('retired')
      expect(atlasEntryAsText(entry, true)).toContain('Do not walk it')
    })

    /** The great majority of entries have to read exactly as they did before. */
    it('says nothing at all about an entry that was confirmed recently', async () => {
      const result = await readAtlas({ provider: 'mail.tm' }, colony.recipes, true)
      if (result.outcome !== 'ok') throw new Error('expected the read to succeed')
      const entry = result.response.entries[0]
      if (entry === undefined) throw new Error('expected an entry')

      expect(entry.health).toBe('ok')
      const text = atlasEntryAsText(entry, true)
      expect(text).not.toContain('Nobody has confirmed this recently')
      expect(text).not.toContain('Take care here')
    })
  })
})
