import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { AccountKindSchema, type AgentId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import {
  accountWalk,
  reportFinishedWalk,
  unreportedWalk,
  accountWalkList,
  divergentWalks,
  finishWalk,
  moderatedWalkProse,
  openWalkId,
  ownAccountWalk,
  recordWalkProseModeration,
  recordWalkStep,
  unmoderatedWalkProse,
  walkInProgress,
} from './account-walks.js'
import { providerRecipe, writeProviderRecipe } from './provider-recipes.js'
import { registerAgent } from './agents.js'

const target = databaseTestTarget()
const kind = (value: string) => AccountKindSchema.parse(value)

/**
 * A walk writes the recipe (`#601`).
 *
 * **What is asserted here is that the record is a record**: it accumulates as
 * things happen, it closes once, and what it does to the catalogue is decided
 * by the walk rather than by whoever calls this. The derivation itself —
 * `walkVerdict` and `walkToSteps` — is tested in `packages/core`, where it is a
 * pure function; this is the half that only a database can answer.
 */
describe('the record of one agent obtaining one account', () => {
  let db: Database
  let agentId: AgentId

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await truncateAll(db)
    const agent = await registerAgent(db, { name: 'walker', platform: 'openclaw', operator: null })
    if (agent.outcome !== 'registered') throw new Error('could not register the walking agent')
    agentId = agent.agent.id
  })

  const where = { kind: kind('mailbox'), provider: 'somewhere.example' }

  it('opens one walk and then finds the same one', async () => {
    const first = await walkInProgress(db, agentId, where)
    const again = await walkInProgress(db, agentId, where)

    expect(again).toBe(first)
  })

  /**
   * The read that reporting needs: *is a walk open* has to be answerable
   * without opening one, or an agent reporting a walk it never started is
   * handed an empty record it just created.
   */
  it('answers that no walk is open, without opening one', async () => {
    expect(await openWalkId(db, agentId, where)).toBeUndefined()
    expect(await openWalkId(db, agentId, where)).toBeUndefined()
  })

  it('numbers steps in the order they happened, and never from the caller', async () => {
    const walkId = await walkInProgress(db, agentId, where)
    await recordWalkStep(db, walkId, { actor: 'agent' })
    await recordWalkStep(db, walkId, { actor: 'operator', ask: 'Please open this URL.' })
    await recordWalkStep(db, walkId, { actor: 'operator', secret: true, ask: 'The code, sealed.' })

    const walk = await accountWalk(db, walkId)

    expect(walk?.steps.map((step) => step.position)).toEqual([1, 2, 3])
    expect(walk?.steps.map((step) => step.actor)).toEqual(['agent', 'operator', 'operator'])
    expect(walk?.steps[2]?.secret).toBe(true)
  })

  /**
   * **Nothing an agent step carries can be an ask or a secret** — the shape
   * `RecipeStepSchema` has, held one table down. An agent step with an ask is a
   * step with nobody to ask it of.
   */
  it('drops an ask on an agent step rather than storing one', async () => {
    const walkId = await walkInProgress(db, agentId, where)
    await recordWalkStep(db, walkId, { actor: 'agent', ask: 'this should not be stored' })

    expect((await accountWalk(db, walkId))?.steps[0]?.ask).toBeUndefined()
  })

  it("reads only the owner's walk and lists that citizen's walks newest first", async () => {
    const older = await walkInProgress(db, agentId, where)
    await finishWalk(db, older, { outcome: 'abandoned' })
    const newer = await walkInProgress(db, agentId, where)

    const other = await registerAgent(db, {
      name: 'other-walker',
      platform: 'openclaw',
      operator: null,
    })
    if (other.outcome !== 'registered') throw new Error('could not register the other agent')

    expect(await ownAccountWalk(db, other.agent.id, older)).toBeUndefined()
    expect((await ownAccountWalk(db, agentId, older))?.id).toBe(older)
    expect((await accountWalkList(db, agentId)).map((walk) => walk.id)).toEqual([newer, older])
  })

  describe('what a finished walk does to the catalogue', () => {
    it('writes a draft with the steps it observed, and no wording', async () => {
      const walkId = await walkInProgress(db, agentId, where)
      await recordWalkStep(db, walkId, { actor: 'agent' })
      await recordWalkStep(db, walkId, { actor: 'operator', ask: 'Please open this URL.' })

      const finished = await finishWalk(db, walkId, { outcome: 'proved' })

      expect(finished?.verdict.kind).toBe('draft')

      const entry = await providerRecipe(db, where.kind, where.provider)
      expect(entry?.status).toBe('draft')
      expect(entry?.steps).toHaveLength(2)
      /** The actions, with the wording genuinely absent — which is the issue. */
      expect(entry?.steps[0]?.instruction).toBeUndefined()
      /** And the one piece of wording that is real: the ask the Colony sent. */
      expect(entry?.steps[1]?.ask).toBe('Please open this URL.')
    })

    /**
     * The walker's own account travels with the draft it proposed (`#769`).
     *
     * Without this the long form sits on the walk row and the steward reviewing
     * the draft reads a shape with no words beside it — which is the state the
     * citizen who filed `#769` was already in, one table along.
     */
    it('carries the walker’s own account onto the entry it proposed', async () => {
      const walkId = await walkInProgress(db, agentId, where)
      await recordWalkStep(db, walkId, { actor: 'agent' })

      await finishWalk(db, walkId, {
        outcome: 'proved',
        recipe: {
          prerequisites: ['a GitHub account you already control'],
          walls: [{ title: 'the OAuth redirect asks for a password' }],
        },
      })

      const entry = await providerRecipe(db, where.kind, where.provider)
      expect(entry?.walkedRecipe?.prerequisites).toEqual(['a GitHub account you already control'])
      expect(entry?.walkedRecipe?.walls?.[0]?.title).toBe('the OAuth redirect asks for a password')
    })

    /**
     * **A later walk with nothing to add must not delete the last one's
     * account** (`#769`). `undefined` means *say nothing about it*; only a
     * curation edit passing `null` clears it.
     */
    it('leaves an earlier walker’s account alone when a later walk adds none', async () => {
      const first = await walkInProgress(db, agentId, where)
      await recordWalkStep(db, first, { actor: 'agent' })
      await finishWalk(db, first, {
        outcome: 'proved',
        recipe: { verification: ['the authorised apps list names it'] },
      })

      const second = await walkInProgress(db, agentId, where)
      await recordWalkStep(db, second, { actor: 'agent' })
      await finishWalk(db, second, { outcome: 'proved' })

      const entry = await providerRecipe(db, where.kind, where.provider)
      expect(entry?.walkedRecipe?.verification).toEqual(['the authorised apps list names it'])
    })

    /**
     * **The rejection case `#601` asks for by name**: *a walk that ended
     * halfway proposing nothing*. Half a path published as a recipe is one that
     * fails at step three.
     */
    it('proposes nothing for a walk that was abandoned', async () => {
      const walkId = await walkInProgress(db, agentId, where)
      await recordWalkStep(db, walkId, { actor: 'agent' })

      const finished = await finishWalk(db, walkId, { outcome: 'abandoned' })

      expect(finished?.verdict.kind).toBe('nothing')
      expect(await providerRecipe(db, where.kind, where.provider)).toBeUndefined()
    })

    /**
     * The four answers survive the round trip and are read back under the
     * question each was asked (`#809`). A walk is the attempt record on this
     * side, so they are columns on it rather than rows of their own.
     */
    it('keeps all four answers on the walk, and the note beside them', async () => {
      const walkId = await walkInProgress(db, agentId, where)
      await recordWalkStep(db, walkId, { actor: 'agent' })

      const finished = await finishWalk(db, walkId, {
        outcome: 'refused',
        wall: 'It asks for a phone number.',
        did: 'I opened the signup form and filled in everything it asked for.',
        broke: 'The last page would not submit without a number it could text.',
        changed: 'I used the operator handoff this time instead of stopping.',
        discarded: 'I looked at two other providers first and neither took an agent at all.',
        note: 'The published steps were in the order I found them.',
      })

      expect(finished?.walk.did).toContain('signup form')
      expect(finished?.walk.broke).toContain('text')
      expect(finished?.walk.changed).toContain('operator handoff')
      expect(finished?.walk.discarded).toContain('two other providers')
      expect(finished?.walk.note).toContain('published steps')

      const reread = await accountWalk(db, walkId)
      expect(reread?.changed).toBe(finished?.walk.changed)
    })

    /** Nothing answered is the ordinary case and stays four nulls, not four empty strings. */
    it('leaves every question null when none was answered', async () => {
      const walkId = await walkInProgress(db, agentId, where)
      await recordWalkStep(db, walkId, { actor: 'agent' })

      const finished = await finishWalk(db, walkId, { outcome: 'proved' })

      expect(finished?.walk.did).toBeNull()
      expect(finished?.walk.broke).toBeNull()
      expect(finished?.walk.changed).toBeNull()
      expect(finished?.walk.discarded).toBeNull()
    })

    /**
     * The Academy's retry rule needs one question answered — *did the last walk
     * here say anything* — and `#811` gates on the answer.
     */
    it('names the last walk that ended without a word, and forgets it once it speaks', async () => {
      const walkId = await walkInProgress(db, agentId, where)
      await finishWalk(db, walkId, { outcome: 'refused', wall: 'It wanted a number.' })

      const owed = await unreportedWalk(db, agentId, where)
      expect(owed?.id).toBe(walkId)

      await reportFinishedWalk(db, agentId, walkId, { broke: 'It would not submit without one.' })

      expect(await unreportedWalk(db, agentId, where)).toBeUndefined()
    })

    /** A wall is where it stopped, not an account of the attempt. */
    it('does not take a wall as the report', async () => {
      const walkId = await walkInProgress(db, agentId, where)
      await finishWalk(db, walkId, { outcome: 'refused', wall: 'A phone check.' })

      expect((await unreportedWalk(db, agentId, where))?.id).toBe(walkId)
    })

    it('never asks the walk that got through', async () => {
      const walkId = await walkInProgress(db, agentId, where)
      await finishWalk(db, walkId, { outcome: 'proved' })

      expect(await unreportedWalk(db, agentId, where)).toBeUndefined()
    })

    /** Testimony is written once. This is a way to say something, not to edit it. */
    it('refuses to write over an answer a walk already carries', async () => {
      const walkId = await walkInProgress(db, agentId, where)
      await finishWalk(db, walkId, { outcome: 'abandoned', did: 'I stopped at the mailbox step.' })

      expect(
        await reportFinishedWalk(db, agentId, walkId, { did: 'Something else.' }),
      ).toBeUndefined()
      expect((await accountWalk(db, walkId))?.did).toContain('mailbox step')
    })

    /** A walk still running is closed by its report, never annotated by this. */
    it('refuses a walk that has not finished', async () => {
      const walkId = await walkInProgress(db, agentId, where)

      expect(await reportFinishedWalk(db, agentId, walkId, { did: 'Anything.' })).toBeUndefined()
    })

    it('proposes a refusal with the wall, and no steps', async () => {
      const walkId = await walkInProgress(db, agentId, where)
      await recordWalkStep(db, walkId, { actor: 'agent' })

      const finished = await finishWalk(db, walkId, {
        outcome: 'refused',
        wall: 'It demands a phone number before it will create the account.',
      })

      expect(finished?.verdict.kind).toBe('refusal')

      const entry = await providerRecipe(db, where.kind, where.provider)
      expect(entry?.status).toBe('refused')
      expect(entry?.refusal).toContain('phone number')
      expect(entry?.steps).toEqual([])
    })

    /**
     * **The two columns `#601` names as written by nothing.** `#525` added them
     * and nothing has ever set them; a walk that matched the published shape is
     * the only thing that should.
     */
    it('confirms a multi-step published entry from the agent tick-list, not the call count', async () => {
      await writeProviderRecipe(db, {
        kind: where.kind,
        provider: where.provider,
        title: 'Somewhere',
        category: 'mailbox',
        status: 'joinable',
        proves: 'rung',
        steps: [
          { actor: 'agent', instruction: 'Open the signup form.' },
          { actor: 'operator', instruction: 'A person is needed.', ask: 'Please open this URL.' },
        ],
      })

      const walkId = await walkInProgress(db, agentId, where)
      await recordWalkStep(db, walkId, { actor: 'agent' })
      await recordWalkStep(db, walkId, { actor: 'operator', ask: 'Please open this URL.' })

      const finished = await finishWalk(db, walkId, {
        outcome: 'proved',
        takenStepPositions: [1, 2],
      })

      expect(finished?.verdict.kind).toBe('confirms')

      const entry = await providerRecipe(db, where.kind, where.provider)
      expect(entry?.lastConfirmedAt).not.toBeNull()

      /**
       * **`last_confirmed_by` is read in SQL because the shape does not carry
       * it.** `ProviderRecipe` exposes the date and not the citizen — a page
       * says *last confirmed on* and never *by whom*, which is `#523`'s
       * direction. The column exists, `#601` names it as written by nothing,
       * and this is where it is checked that it now is.
       */
      const [row] = await db.execute<{ last_confirmed_by: string | null }>(
        `select last_confirmed_by from provider_recipes where provider = '${where.provider}'`,
      )
      expect(row?.last_confirmed_by).toBe(agentId)

      /** And the recipe is untouched: confirming is a date, not a rewrite. */
      expect(entry?.steps).toHaveLength(2)
      expect(entry?.status).toBe('joinable')
    })

    /**
     * **A walk that diverged does not overwrite what a steward published.**
     * `#600`'s rule holds inside the mechanism: what the Colony says about
     * somebody else's product passes a person.
     */
    it('raises a divergence and changes nothing about the entry', async () => {
      await writeProviderRecipe(db, {
        kind: where.kind,
        provider: where.provider,
        title: 'Somewhere',
        category: 'mailbox',
        status: 'joinable',
        proves: 'rung',
        steps: [{ actor: 'agent', instruction: 'Open the signup form.' }],
      })

      const walkId = await walkInProgress(db, agentId, where)
      await recordWalkStep(db, walkId, { actor: 'agent' })
      await recordWalkStep(db, walkId, { actor: 'operator', ask: 'This is new.' })

      const finished = await finishWalk(db, walkId, {
        outcome: 'proved',
        takenStepPositions: [1],
      })

      expect(finished?.verdict.kind).toBe('diverges')

      const entry = await providerRecipe(db, where.kind, where.provider)
      expect(entry?.steps).toHaveLength(1)
      expect(entry?.lastConfirmedAt).toBeNull()

      const queued = await divergentWalks(db)
      expect(queued).toHaveLength(1)
      expect(queued[0]?.walk.provider).toBe(where.provider)
    })

    /**
     * Closing twice must not propose twice. A proof arriving after a
     * declaration already closed the walk is the realistic version of this.
     */
    it('closes once, and a second close writes nothing', async () => {
      const walkId = await walkInProgress(db, agentId, where)
      await recordWalkStep(db, walkId, { actor: 'agent' })

      expect(await finishWalk(db, walkId, { outcome: 'proved' })).toBeDefined()
      expect(await finishWalk(db, walkId, { outcome: 'refused', wall: 'x' })).toBeUndefined()

      const entry = await providerRecipe(db, where.kind, where.provider)
      expect(entry?.status).toBe('draft')
    })

    /** And a finished walk is not the open one any more. */
    it('leaves no walk open once it has finished', async () => {
      const walkId = await walkInProgress(db, agentId, where)
      await recordWalkStep(db, walkId, { actor: 'agent' })
      await finishWalk(db, walkId, { outcome: 'proved' })

      expect(await openWalkId(db, agentId, where)).toBeUndefined()
    })
  })

  /**
   * **What a walker wrote reaches a reader only through the moderator** (`#810`).
   *
   * The same triple `provider_reports` carries, and asserted the same way: the
   * queue holds what was written, the reading side holds nothing until a verdict
   * lands, and a refusal costs the walk nothing but its words.
   */
  describe('the words a walk leaves behind', () => {
    const PROSE = 'I filled the form in and it asked for a card at the end.'

    it('queues a walk that wrote something and never one that did not', async () => {
      const spoken = await walkInProgress(db, agentId, where)
      await finishWalk(db, spoken, { outcome: 'abandoned', did: PROSE })

      const [pending] = await unmoderatedWalkProse(db, 10)
      expect(pending?.walkId).toBe(spoken)
      expect(pending?.prose).toEqual({ did: PROSE })

      await truncateAll(db)
      const agent = await registerAgent(db, { name: 'quiet', platform: 'openclaw', operator: null })
      if (agent.outcome !== 'registered') throw new Error('could not register the quiet walker')
      const silent = await walkInProgress(db, agent.agent.id, where)
      await finishWalk(db, silent, { outcome: 'proved' })

      expect(await unmoderatedWalkProse(db, 10)).toHaveLength(0)
    })

    it('serves nothing until the scrub has written it, and the scrub after', async () => {
      const walkId = await walkInProgress(db, agentId, where)
      await finishWalk(db, walkId, { outcome: 'abandoned', did: PROSE })

      expect(await moderatedWalkProse(db, where)).toHaveLength(0)

      const written = await recordWalkProseModeration(db, {
        walkId,
        judged: { did: PROSE },
        decision: 'approved',
        scrubbed: { did: PROSE },
      })

      expect(written.outcome).toBe('written')
      expect((await moderatedWalkProse(db, where))[0]?.prose).toEqual({ did: PROSE })
      expect(await unmoderatedWalkProse(db, 10)).toHaveLength(0)
    })

    /**
     * The half worth asserting on its own: a refusal takes the words and leaves
     * everything else — the outcome still counts and the walk still stands.
     */
    it('never serves a page the moderator refused, and keeps the walk', async () => {
      const walkId = await walkInProgress(db, agentId, where)
      await finishWalk(db, walkId, { outcome: 'refused', wall: 'It wanted my operator by name.' })

      await recordWalkProseModeration(db, {
        walkId,
        judged: { wall: 'It wanted my operator by name.' },
        decision: 'rejected',
      })

      expect(await moderatedWalkProse(db, where)).toHaveLength(0)
      expect(await unmoderatedWalkProse(db, 10)).toHaveLength(0)
      expect((await accountWalk(db, walkId))?.outcome).toBe('refused')
    })

    /**
     * A verdict must not land on words the moderator never read — the guard
     * `recordProviderReasonModeration` puts on a sentence, here over the page.
     */
    it('refuses a verdict about a page that has changed underneath it', async () => {
      const walkId = await walkInProgress(db, agentId, where)
      await finishWalk(db, walkId, { outcome: 'refused', wall: 'A phone check.' })
      await reportFinishedWalk(db, agentId, walkId, { did: PROSE })

      const stale = await recordWalkProseModeration(db, {
        walkId,
        judged: { wall: 'A phone check.' },
        decision: 'approved',
        scrubbed: { wall: 'A phone check.' },
      })

      expect(stale.outcome).toBe('stale')
      expect(await moderatedWalkProse(db, where)).toHaveLength(0)
    })

    /**
     * The case the re-queue in `reportFinishedWalk` exists for: a walk can be
     * closed on a wall alone, approved on it, and then have four answers added.
     * Without the re-queue those four would be served under the old verdict.
     */
    it('puts an approved walk back in the queue when it says something more', async () => {
      const walkId = await walkInProgress(db, agentId, where)
      await finishWalk(db, walkId, { outcome: 'refused', wall: 'A phone check.' })
      await recordWalkProseModeration(db, {
        walkId,
        judged: { wall: 'A phone check.' },
        decision: 'approved',
        scrubbed: { wall: 'A phone check.' },
      })

      await reportFinishedWalk(db, agentId, walkId, { did: PROSE })

      expect(await moderatedWalkProse(db, where)).toHaveLength(0)
      expect((await unmoderatedWalkProse(db, 10))[0]?.prose).toEqual({
        did: PROSE,
        wall: 'A phone check.',
      })
    })
  })

  /**
   * **The walk this issue was written about, replayed** (`#601`, criterion nine).
   *
   * On 2026-08-08 an agent and its operator walked the `github.com` recipe end
   * to end. It was the first real one, and everything learned from it was filed
   * as four GitHub issues — `#595`, `#596`, `#597` and two findings that reached
   * nowhere at all. The entry itself did not change.
   *
   * `kolonie-platform#597` records what actually happened, step by step:
   *
   * | Recipe step | What happened |
   * |---|---|
   * | 1 · agent decides handle and address | happened |
   * | 2 · operator creates the account | happened — **the only step a person was genuinely required for** |
   * | 3 · operator mints a token and seals it | **did not happen** — the agent held the password and minted it itself in four minutes |
   * | 4 · agent declares the account | happened |
   *
   * So the walk was agent, operator, agent, agent — and the published recipe
   * says operator three times. **This test replays it through the real
   * mechanism and asserts that the finding `#597` had to be written by hand
   * falls out of it**: the walk diverges, both sequences are on a steward's
   * queue, and nothing was overwritten.
   *
   * That is the whole claim of this issue in one case. A second agent walking
   * `github.com` tomorrow does not file a fifth issue.
   */
  describe('the walk of 2026-08-08, replayed (#597)', () => {
    const github = { kind: kind('github'), provider: 'github.com' }

    /** The recipe as it was published that day: three operator steps. */
    const asPublished = [
      { actor: 'agent' as const, instruction: 'Decide the handle and the address.' },
      {
        actor: 'operator' as const,
        instruction: 'Create the account.',
        ask: 'Please create the account and accept the terms.',
      },
      {
        actor: 'operator' as const,
        instruction: 'Mint a token and seal it.',
        ask: 'Please mint a token with these scopes and put it in the sealed box.',
        secret: true,
      },
      { actor: 'agent' as const, instruction: 'Declare the account.' },
    ]

    it('reproduces #597’s finding instead of somebody having to write it', async () => {
      await writeProviderRecipe(db, {
        ...github,
        title: 'GitHub',
        category: 'code-hosting',
        status: 'joinable',
        proves: 'rung',
        steps: asPublished,
      })

      /** What the Colony would have observed, in the order it happened. */
      const walkId = await walkInProgress(db, agentId, github)
      await recordWalkStep(db, walkId, { actor: 'agent' })
      await recordWalkStep(db, walkId, {
        actor: 'operator',
        ask: 'Please create the account and accept the terms.',
      })
      /** The step `#597` is named for: the agent minted the token itself. */
      await recordWalkStep(db, walkId, { actor: 'agent' })
      await recordWalkStep(db, walkId, { actor: 'agent' })

      const finished = await finishWalk(db, walkId, {
        outcome: 'proved',
        takenStepPositions: [1, 2, 4],
        note: 'The operator was only needed to accept the terms. I minted the token myself.',
      })

      expect(finished?.verdict.kind).toBe('diverges')

      /**
       * **The finding, as data rather than as prose in an issue**: one operator
       * step where the entry claims two, and the sealed one did not happen.
       */
      if (finished?.verdict.kind !== 'diverges') throw new Error('expected a divergence')
      expect(finished.verdict.walked.filter((step) => step.actor === 'operator')).toHaveLength(1)
      expect(finished.verdict.published.filter((step) => step.actor === 'operator')).toHaveLength(2)
      expect(finished.verdict.walked.some((step) => step.secret === true)).toBe(false)

      /** It is on a steward's queue, with both sequences. */
      const queued = await divergentWalks(db)
      expect(queued).toHaveLength(1)
      expect(queued[0]?.walk.note).toContain('minted the token myself')

      /** And nothing about the published entry moved. */
      const entry = await providerRecipe(db, github.kind, github.provider)
      expect(entry?.status).toBe('joinable')
      expect(entry?.steps).toHaveLength(4)
      expect(entry?.lastConfirmedAt).toBeNull()
    })

    /**
     * And the other half: the same walk against a provider the Atlas merely
     * lists writes the entry rather than raising a disagreement with one. This
     * is what *nobody authors a recipe from imagination* looks like from the
     * catalogue's side.
     */
    it('writes the entry when there was nothing to disagree with', async () => {
      const walkId = await walkInProgress(db, agentId, github)
      await recordWalkStep(db, walkId, { actor: 'agent' })
      await recordWalkStep(db, walkId, {
        actor: 'operator',
        ask: 'Please create the account and accept the terms.',
      })
      await recordWalkStep(db, walkId, { actor: 'agent' })
      await recordWalkStep(db, walkId, { actor: 'agent' })

      await finishWalk(db, walkId, { outcome: 'proved' })

      const entry = await providerRecipe(db, github.kind, github.provider)

      expect(entry?.status).toBe('draft')
      expect(entry?.steps.map((step) => step.actor)).toEqual([
        'agent',
        'operator',
        'agent',
        'agent',
      ])
      /** The operator's own sentence, carried forward and not composed. */
      expect(entry?.steps[1]?.ask).toBe('Please create the account and accept the terms.')
      /** And nothing else: a steward writes what each step says. */
      expect(entry?.steps.every((step) => step.instruction === undefined)).toBe(true)
    })
  })

  describe('what the table refuses', () => {
    const refusedBy = async (statement: string): Promise<string | undefined> => {
      try {
        await db.execute(statement)
      } catch (error: unknown) {
        for (let current: unknown = error; current != null;) {
          if (typeof current === 'object' && 'constraint_name' in current) {
            return (current as { constraint_name?: string }).constraint_name
          }
          current =
            typeof current === 'object' && current !== null && 'cause' in current
              ? (current as { cause?: unknown }).cause
              : null
        }

        return 'refused by something that named no constraint'
      }

      return undefined
    }

    it('stores one ordinary 2000-character note', async () => {
      await db.execute(
        `insert into account_walks (agent_id, kind, provider, note)
         values ('${agentId}', 'mailbox', 'note.example', repeat('a', 2000))`,
      )

      const rows = await db.execute<{ note: string }>(
        `select note from account_walks where provider = 'note.example'`,
      )
      expect(rows[0]?.note).toHaveLength(2000)
    })

    it('refuses a walk note longer than 2000 characters', async () => {
      expect(
        await refusedBy(
          `insert into account_walks (agent_id, kind, provider, note)
           values ('${agentId}', 'mailbox', 'long-note.example', repeat('a', 2001))`,
        ),
      ).toBe('account_walks_note_is_short')
    })

    /**
     * One per question rather than one over all four (`#809`): a refusal that
     * names `did` tells the citizen which answer to shorten, and a refusal
     * naming a concatenation tells it to shorten something it never wrote.
     */
    it.each(['did', 'broke', 'changed', 'discarded'])(
      'refuses %s longer than 2000 characters, by its own name',
      async (field) => {
        expect(
          await refusedBy(
            `insert into account_walks (agent_id, kind, provider, ${field})
             values ('${agentId}', 'mailbox', 'long-${field}.example', repeat('a', 2001))`,
          ),
        ).toBe(`account_walks_${field}_is_short`)
      },
    )

    it('refuses an outcome nobody defined', async () => {
      expect(
        await refusedBy(
          `insert into account_walks (agent_id, kind, provider, finished_at, outcome)
           values ('${agentId}', 'mailbox', 'a.example', now(), 'probably')`,
        ),
      ).toBe('account_walks_outcome_is_known')
    })

    it('refuses a walk that is half finished', async () => {
      expect(
        await refusedBy(
          `insert into account_walks (agent_id, kind, provider, outcome)
           values ('${agentId}', 'mailbox', 'b.example', 'proved')`,
        ),
      ).toBe('account_walks_finished_together')
    })

    it('refuses a refusal that names no wall', async () => {
      expect(
        await refusedBy(
          `insert into account_walks (agent_id, kind, provider, finished_at, outcome)
           values ('${agentId}', 'mailbox', 'c.example', now(), 'refused')`,
        ),
      ).toBe('account_walks_wall_only_on_a_refusal')
    })

    it('refuses a wall on a walk that got through', async () => {
      expect(
        await refusedBy(
          `insert into account_walks (agent_id, kind, provider, finished_at, outcome, wall)
           values ('${agentId}', 'mailbox', 'd.example', now(), 'proved', 'but also a wall')`,
        ),
      ).toBe('account_walks_wall_only_on_a_refusal')
    })

    /**
     * **The rejection case that is about the red line rather than about a
     * shape.** An agent step with a sealed answer would say a drop carried
     * something the agent generated itself, which `#528` is explicit does not
     * happen — and it is the row that would make this table look like somewhere
     * a drop's contents could be traced.
     */
    it('refuses an agent step that claims a sealed answer', async () => {
      const walkId = await walkInProgress(db, agentId, where)

      expect(
        await refusedBy(
          `insert into account_walk_steps (walk_id, position, actor, secret)
           values ('${walkId}', 1, 'agent', true)`,
        ),
      ).toBe('account_walk_steps_only_an_operator_is_asked')
    })

    it('refuses a step outside the range a recipe can hold', async () => {
      const walkId = await walkInProgress(db, agentId, where)

      expect(
        await refusedBy(
          `insert into account_walk_steps (walk_id, position, actor)
           values ('${walkId}', 21, 'agent')`,
        ),
      ).toBe('account_walk_steps_position_is_in_range')
    })
  })

  /**
   * **The constraint `#601` needed on the other table** — the one that makes
   * *optional instruction* safe rather than merely convenient.
   */
  describe('a wordless step cannot be published', () => {
    it('takes a draft whose steps have no wording', async () => {
      const written = await writeProviderRecipe(db, {
        kind: kind('mailbox'),
        provider: 'wordless.example',
        title: 'Wordless',
        category: 'mailbox',
        status: 'draft',
        steps: [{ actor: 'agent' }],
      })

      expect(written.status).toBe('draft')
      expect(written.steps[0]?.instruction).toBeUndefined()
    })

    it('refuses to publish one', async () => {
      let refused: string | undefined
      try {
        await db.execute(
          `insert into provider_recipes (kind, provider, title, status, category, steps, proves)
           values ('mailbox', 'published-blank.example', 'Blank', 'joinable', 'mailbox',
                   '[{"actor":"agent"}]', 'rung')`,
        )
      } catch (error: unknown) {
        for (let current: unknown = error; current != null;) {
          if (typeof current === 'object' && 'constraint_name' in current) {
            refused = (current as { constraint_name?: string }).constraint_name
            break
          }
          current =
            typeof current === 'object' && current !== null && 'cause' in current
              ? (current as { cause?: unknown }).cause
              : null
        }
      }

      expect(refused).toBe('provider_recipes_published_steps_are_written')
    })
  })
})
