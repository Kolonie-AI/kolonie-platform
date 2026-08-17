import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import {
  AccountKindSchema,
  RECENT_WALKS_IN_CONTEXT,
  REFUSAL_UNSTATED,
  WALL_KIND_MEANINGS,
  WALK_DUPLICATE_SIMILARITY,
  WALK_PROSE_SCRUBBER_VERSION,
  WALK_PUBLISHED_REPUTATION,
  type AccountKind,
  type AgentId,
  type WalkOutcome,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { sql } from 'drizzle-orm'
import {
  accountWalk,
  approvedWalkProseWithoutScrub,
  markPublishedDuplicateWalks,
  amendWalkedRoute,
  reportFinishedWalk,
  unreportedWalk,
  accountWalkList,
  divergentWalks,
  finishWalk,
  markWalkRewardTold,
  moderatedWalkProse,
  openWalkId,
  ownAccountWalk,
  publishedWalksAt,
  recordWalkProseModeration,
  recordApprovedWalkProseRescrub,
  recordWalkStep,
  requeueRefusedWalkProse,
  submitWalkReport,
  rewardPublishedWalks,
  unmoderatedWalkProse,
  untoldWalkReward,
  walkInProgress,
  walksToAskAbout,
} from './account-walks.js'
import { dressProviderRecipe, providerRecipe, writeProviderRecipe } from './provider-recipes.js'
import { providerBriefingCorpus, staleProviderBriefings } from './provider-briefing.js'
import { registerAgent, updateAgentProfile } from './agents.js'
import { renameProvider } from './atlas-renames.js'
import { nameSession } from './sessions.js'
import { reputationOfAgent } from './balance.js'

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
  let otherAgentId: AgentId

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

    /** A second walker, for the counts that only mean anything across two (`#981`). */
    const other = await registerAgent(db, {
      name: 'counting-walker',
      platform: 'openclaw',
      operator: null,
    })
    if (other.outcome !== 'registered') throw new Error('could not register the counting walker')
    otherAgentId = other.agent.id
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

  it('files and replaces a walk without any account row', async () => {
    const first = await submitWalkReport(db, agentId, where, {
      outcome: 'proved',
      recipe: {
        steps: [{ title: 'Open the signup form', detail: 'Fill in the requested fields.' }],
      },
    })
    const second = await submitWalkReport(db, agentId, where, {
      outcome: 'refused',
      wall: 'The signup form never advances past its final check.',
    })

    expect(first?.walk.id).toBe(second?.walk.id)
    expect(second?.walk).toMatchObject({
      outcome: 'refused',
      wall: 'The signup form never advances past its final check.',
    })
    expect(await accountWalkList(db, agentId)).toHaveLength(1)
    expect(await unreportedWalk(db, agentId, where)).toBeUndefined()
    const accounts = await db.execute<{ count: number }>(
      sql`select cast(count(*) as integer) as count from accounts where agent_id = ${agentId}`,
    )
    expect(accounts[0]?.count).toBe(0)
    const walks = await db.execute<{ proposed_at: string | null }>(
      sql`select proposed_at from account_walks where id = ${second?.walk.id ?? ''}`,
    )
    expect(walks[0]?.proposed_at).toBeNull()
  })

  it('submits against an already-open walk instead of creating another', async () => {
    const opened = await walkInProgress(db, agentId, where)
    await recordWalkStep(db, opened, { actor: 'agent' })

    const reported = await submitWalkReport(db, agentId, where, { outcome: 'proved' })

    expect(reported?.walk.id).toBe(opened)
    expect(reported?.walk.steps).toHaveLength(1)
    expect(await accountWalkList(db, agentId)).toHaveLength(1)
  })

  /**
   * **A finished report is the author's to replace, and the steps beside it are
   * not** (`#1060`).
   *
   * A citizen wrote its walk up, read `#1023`'s `direction` afterwards and went
   * back to add it — and was told there was no walk to report on. Every walk
   * filed the ordinary way had a step on it, because `kolonie.accounts.declare`
   * records one, and a stepped row was refused. So the field was unreachable on
   * exactly the walks it was written for.
   */
  describe('re-reporting a walk that already finished', () => {
    /**
     * **The rejection case first.** A walk with a reward booked against it is
     * immutable, because a ledger event already refers to what it earned. The
     * report is not lost — it opens a walk of its own — and the paid row is the
     * one thing this must never touch.
     */
    it('leaves a walk that was paid for alone, and files beside it', async () => {
      const paid = await walkInProgress(db, agentId, where)
      await recordWalkStep(db, paid, { actor: 'agent' })
      await finishWalk(db, paid, { outcome: 'proved', did: 'It was OAuth all the way through.' })
      await db.execute(sql`update account_walks set rewarded_at = now() where id = ${paid}`)

      const again = await submitWalkReport(db, agentId, where, {
        outcome: 'refused',
        wall: 'The signup form now demands a card.',
      })

      expect(again?.walk.id).not.toBe(paid)
      const rewarded = await accountWalk(db, paid)
      expect(rewarded?.outcome).toBe('proved')
      expect(rewarded?.did).toContain('OAuth')
      expect(await accountWalkList(db, agentId)).toHaveLength(2)
    })

    /**
     * The walk the issue is about: opened by a declaration, so it carries a step,
     * finished, and then re-reported to add the one field `#1023` introduced.
     */
    it('replaces the report on a stepped walk rather than refusing it', async () => {
      const scoped = { kind: kind('phone'), provider: 'agentphone.example' }
      const walkId = await walkInProgress(db, agentId, scoped)
      await recordWalkStep(db, walkId, { actor: 'agent' })
      await submitWalkReport(db, agentId, scoped, {
        outcome: 'proved',
        did: 'I signed up and the number was live in a minute.',
      })

      const again = await submitWalkReport(db, agentId, scoped, {
        outcome: 'proved',
        direction: 'inbound',
        did: 'I signed up and the number was live in a minute. It cannot send.',
      })

      expect(again?.walk.id).toBe(walkId)
      expect(again?.walk.direction).toBe('inbound')
      expect(again?.walk.did).toContain('cannot send')
      expect(await accountWalkList(db, agentId)).toHaveLength(1)
    })

    /**
     * **And the steps are untouched by it.** The prose is what the author was
     * asked for; the steps are what the Colony observed happening, and no report
     * is evidence about those. Losing them would also lose the divergence a
     * later walk is judged against.
     */
    it('leaves every observed step exactly as it was', async () => {
      const walkId = await walkInProgress(db, agentId, where)
      await recordWalkStep(db, walkId, { actor: 'agent' })
      await recordWalkStep(db, walkId, { actor: 'operator', ask: 'Please open this URL.' })
      await submitWalkReport(db, agentId, where, { outcome: 'proved' })
      const before = (await accountWalk(db, walkId))?.steps

      await submitWalkReport(db, agentId, where, {
        outcome: 'refused',
        wall: 'On a second reading it never let me in at all.',
      })

      expect((await accountWalk(db, walkId))?.steps).toEqual(before)
    })

    /**
     * Two reports racing at one pair. `for('update')` on the citizen's own row
     * is what makes the loser reuse what the winner wrote instead of inserting a
     * second walk beside it.
     */
    it('files one walk when two reports arrive at once', async () => {
      const walkId = await walkInProgress(db, agentId, where)
      await recordWalkStep(db, walkId, { actor: 'agent' })
      await finishWalk(db, walkId, { outcome: 'proved' })

      await Promise.all([
        submitWalkReport(db, agentId, where, { outcome: 'abandoned', did: 'One of two.' }),
        submitWalkReport(db, agentId, where, { outcome: 'abandoned', did: 'The other.' }),
      ])

      expect(await accountWalkList(db, agentId)).toHaveLength(1)
    })

    /** And `#1031` still holds: a pair nobody has walked opens its own walk. */
    it('opens a walk where there was none to replace', async () => {
      const fresh = { kind: kind('mailbox'), provider: 'unwalked.example' }

      const filed = await submitWalkReport(db, agentId, fresh, {
        outcome: 'refused',
        wall: 'It wanted a phone number before it would create anything.',
      })

      expect(filed?.walk.provider).toBe('unwalked.example')
      expect(await accountWalkList(db, agentId)).toHaveLength(1)
    })
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
    /**
     * **The entry says the pair was walked; the route stays on the walk**
     * (`#1032`).
     *
     * This wrote a `draft` carrying the observed steps, and a steward read them
     * before any citizen could. That gate took two decisions in its lifetime
     * while six drafts stood open, so it is gone — and what replaces it is not a
     * faster gate but a different division: **the entry is what the Colony
     * stands behind, and the briefing is what the Colony observed.** An
     * unreviewed route is the second thing, so it is published out of
     * `account_walks` under its walker's name rather than copied onto the
     * catalogue row as though the Colony had written it.
     *
     * Hence `measured` and no steps — the honest description of a pair citizens
     * have walked and nobody has written up — which
     * `provider_recipes_unjoinable_is_empty` is what enforces.
     */
    it('writes a measured entry, and leaves the route it observed on the walk', async () => {
      const walkId = await walkInProgress(db, agentId, where)
      await recordWalkStep(db, walkId, { actor: 'agent' })
      await recordWalkStep(db, walkId, { actor: 'operator', ask: 'Please open this URL.' })

      const finished = await finishWalk(db, walkId, { outcome: 'proved' })

      expect(finished?.verdict.kind).toBe('writes')

      const entry = await providerRecipe(db, where.kind, where.provider)
      expect(entry?.status).toBe('measured')
      expect(entry?.category).toBe('mailbox')
      expect(entry?.steps).toHaveLength(0)

      /** And the route is not lost: it is on the walk, which is what the briefing reads. */
      const steps = (await accountWalk(db, walkId))?.steps
      expect(steps?.map((step) => step.actor)).toEqual(['agent', 'operator'])
      /** The one piece of wording that is real: the ask the Colony sent. */
      expect(steps?.[1]?.ask).toBe('Please open this URL.')
    })

    /**
     * **A kind with no shelf writes no entry rather than defaulting to one**
     * (`#917`), which is the rule `measuredOnlyRecipes` and
     * `recordMeasuredProvider` already follow.
     *
     * The failure it replaces was worse than a wrong shelf:
     * `atlasCategoryForKind` throws by design, and the throw landed inside the
     * transaction that closes the walk — so an unmappable kind did not lose its
     * entry, it lost the whole call. The citizen's account of how it joined was
     * refused for a reason it could do nothing about.
     */
    it('closes a walk on an unshelvable kind and proposes nothing', async () => {
      const nowhere = { kind: AccountKindSchema.parse('sourdough'), provider: 'starter.example' }
      const walkId = await walkInProgress(db, agentId, nowhere)
      await recordWalkStep(db, walkId, { actor: 'agent' })

      const finished = await finishWalk(db, walkId, { outcome: 'proved' })

      /** The walk itself is finished and readable — that is the half that used to be lost. */
      expect(finished?.walk.outcome).toBe('proved')
      expect(await providerRecipe(db, nowhere.kind, nowhere.provider)).toBeUndefined()
      /** And nothing was stamped as proposed, because nothing was. */
      expect((await accountWalk(db, walkId))?.id).toBe(walkId)
    })

    /**
     * The other half of `#917`: a kind spelled as the shelf's own name resolves,
     * rather than falling through to the unshelvable branch above. Two of the
     * four drafts waiting for a steward on 2026-08-14 were in exactly this state.
     *
     * **The entry is filed under the kind that spelling means** (`#1144`), so the
     * walk lands on the row `code-host` already has rather than standing a second
     * row of its own in beside it. The shelf is the one `#917` decided on either
     * way, which is what makes the resolution a de-duplication and not a refiling.
     */
    it('files a walk whose kind is a category name on that shelf', async () => {
      const named = {
        kind: AccountKindSchema.parse('code-hosting'),
        provider: 'clawhub.example',
      }
      const walkId = await walkInProgress(db, agentId, named)
      await recordWalkStep(db, walkId, { actor: 'agent' })
      await finishWalk(db, walkId, { outcome: 'proved' })

      expect(await providerRecipe(db, named.kind, named.provider)).toBeUndefined()
      expect(
        (await providerRecipe(db, AccountKindSchema.parse('code-host'), named.provider))?.category,
      ).toBe('code-hosting')
    })

    /**
     * **The entry is a verdict about whatever the walk measured** (`#1023`).
     *
     * `#976` scoped the entry and the report and left the walk unscoped, so a
     * draft proposed by an inbound walk went onto the shelf as a claim about
     * `phone` at that provider — answering readers who only ever needed to send.
     * The direction travels with the draft for the same reason the walker's own
     * prose does: it is what the steward is reviewing.
     */
    it('carries the walk’s direction onto the entry it proposed', async () => {
      const scoped = { kind: kind('phone'), provider: 'agentphone.example' }
      const walkId = await walkInProgress(db, agentId, scoped)
      await recordWalkStep(db, walkId, { actor: 'agent' })

      await finishWalk(db, walkId, { outcome: 'proved', direction: 'inbound' })

      expect((await accountWalk(db, walkId))?.direction).toBe('inbound')
      expect((await providerRecipe(db, scoped.kind, scoped.provider))?.direction).toBe('inbound')
    })

    /**
     * And the other half of the same rule: a kind with no axis proposes an
     * unscoped entry, which is the `null` `#976` gave a meaning to — *nobody
     * wrote down which way* — and never a guess.
     */
    it('leaves the entry unscoped when the kind has no axis', async () => {
      const walkId = await walkInProgress(db, agentId, where)
      await recordWalkStep(db, walkId, { actor: 'agent' })

      await finishWalk(db, walkId, { outcome: 'proved' })

      expect((await accountWalk(db, walkId))?.direction).toBeNull()
      expect((await providerRecipe(db, where.kind, where.provider))?.direction).toBeNull()
    })

    /** A refused walk scopes the refusal it publishes, exactly as the draft does. */
    it('carries the direction onto a refusal too', async () => {
      const scoped = { kind: kind('phone'), provider: 'sendonly.example' }
      const walkId = await walkInProgress(db, agentId, scoped)
      await recordWalkStep(db, walkId, { actor: 'agent' })

      await finishWalk(db, walkId, {
        outcome: 'refused',
        direction: 'outbound',
        wall: 'A2P brand and campaign registration is required before a number may send.',
      })

      const entry = await providerRecipe(db, scoped.kind, scoped.provider)
      expect(entry?.status).toBe('refused')
      expect(entry?.direction).toBe('outbound')
    })

    /**
     * **The typed half publishes and the walker's sentences do not** (`#1032`).
     *
     * `#769` copied the walker's whole long form onto the entry, so that a
     * steward reading the draft saw a shape with words beside it. With the gate
     * gone there is no reader between the walk and the catalogue: `title`,
     * `symptom` and `remedy` are free text a citizen wrote a moment ago, and
     * `WALK_PROSE_FIELDS` is where prose waits to be read. Publishing them here
     * would put unmoderated text into the `kolonie.accounts.recipes` response
     * body — the same leak `refusal` was, in a different column.
     *
     * **What survives is what cannot carry a sentence**: the wall kinds, and how
     * many walkers hit each. That is the aggregate `#981` and `#982` asked for,
     * and it is a stronger answer than one walker's phrasing was. The words are
     * not lost — they are on the walk, and they reach readers through the
     * briefing once the moderator has read them.
     */
    it('publishes a walk’s wall kinds on the entry, and none of its prose', async () => {
      const walkId = await walkInProgress(db, agentId, where)
      await recordWalkStep(db, walkId, { actor: 'agent' })

      await finishWalk(db, walkId, {
        outcome: 'proved',
        recipe: {
          prerequisites: ['a GitHub account you already control'],
          walls: [{ kind: 'other', title: 'the OAuth redirect asks for a password' }],
        },
      })

      const entry = await providerRecipe(db, where.kind, where.provider)
      expect(entry?.walkedRecipe).toBeNull()
      expect(JSON.stringify(entry)).not.toContain('the OAuth redirect asks for a password')

      /**
       * Counted across the walkers that hit them (`#981`), and reachable without
       * knowing any blob is there (`#982`): `walls` is computed where the walk
       * finished and attached in `toRecipe`.
       */
      expect(entry?.walls).toEqual([
        { kind: 'other', reportedBy: 1, lastReportedAt: expect.any(String) },
      ])
    })

    /**
     * **A refusal's walls publish, because a refused entry is public** (`#982`).
     * This is the case the Atlas most needed and least had: the entry that says
     * *do not try* is worth its wall, and the wall was written into a blob no
     * reader looked in.
     */
    it('publishes the walls of a refusal on the entry', async () => {
      const walkId = await walkInProgress(db, agentId, where)
      await recordWalkStep(db, walkId, { actor: 'agent' })

      await finishWalk(db, walkId, {
        outcome: 'refused',
        wall: 'signup demands a phone number it will not take twice',
        recipe: {
          walls: [
            {
              kind: 'phone-verification',
              title: 'the phone step',
              symptom: 'the form rejects every number that has signed up before',
            },
          ],
        },
      })

      const entry = await providerRecipe(db, where.kind, where.provider)
      expect(entry?.status).toBe('refused')
      /** The kind and the count, and — since `#1032` — not the walker's own wording. */
      expect(entry?.walls).toEqual([
        { kind: 'phone-verification', reportedBy: 1, lastReportedAt: expect.any(String) },
      ])
      expect(JSON.stringify(entry)).not.toContain('the form rejects every number')
    })

    /**
     * **Empty and not absent, on an entry nobody walked** (`#982`). A reader that
     * has to tell `undefined` from `[]` before it can count walls is one that
     * will get it wrong once.
     */
    it('answers with no walls where the walk wrote none', async () => {
      const walkId = await walkInProgress(db, agentId, where)
      await recordWalkStep(db, walkId, { actor: 'agent' })
      await finishWalk(db, walkId, { outcome: 'proved' })

      expect((await providerRecipe(db, where.kind, where.provider))?.walls).toEqual([])
    })

    /**
     * **Counted across walkers, and recomputed where a walk finishes** (`#981`).
     * Two walkers hitting the same wall is a fact about the provider; the same
     * two paragraphs are two anecdotes a reader has to reconcile. Storing the
     * aggregate rather than deriving it on the read path is what keeps every
     * surface answering it the same way — the failure `#982` and `#984` shared.
     */
    it('counts a wall across the walks that hit it', async () => {
      const first = await walkInProgress(db, agentId, where)
      await recordWalkStep(db, first, { actor: 'agent' })
      await finishWalk(db, first, {
        outcome: 'refused',
        wall: 'it wants a card',
        recipe: { walls: [{ kind: 'payment-required', amountUsd: 3 }] },
      })

      const second = await walkInProgress(db, otherAgentId, where)
      await recordWalkStep(db, second, { actor: 'agent' })
      await finishWalk(db, second, {
        outcome: 'refused',
        wall: 'it wants a card',
        recipe: { walls: [{ kind: 'payment-required', accepts: ['card'] }] },
      })

      const entry = await providerRecipe(db, where.kind, where.provider)
      expect(entry?.walls).toHaveLength(1)
      expect(entry?.walls[0]).toMatchObject({
        kind: 'payment-required',
        reportedBy: 2,
        /** The newest answer to each question, one question at a time. */
        amountUsd: 3,
        accepts: ['card'],
      })
    })

    /**
     * **The kind is the red line, so nobody has to keep two fields in step**
     * (`#981`). An entry whose terms forbid an agent holding the account is a
     * refusal, computed from the wall rather than typed twice — and the refusal
     * says why signing up is closed *and* why handing it to an operator is not
     * the way round.
     */
    it('makes an entry a refusal where a walker reported its terms', async () => {
      await writeProviderRecipe(db, {
        kind: where.kind,
        provider: where.provider,
        title: 'Somewhere',
        category: 'mailbox',
        status: 'unwritten',
        steps: [],
      })

      const walkId = await walkInProgress(db, agentId, where)
      await recordWalkStep(db, walkId, { actor: 'agent' })
      await finishWalk(db, walkId, {
        outcome: 'abandoned',
        recipe: {
          walls: [{ kind: 'terms-forbid-agents' }],
          verification: ['the terms page names automated accounts'],
        },
      })

      const entry = await providerRecipe(db, where.kind, where.provider)
      expect(entry?.status).toBe('refused')
      expect(entry?.refusal).toContain('who-owns-an-agents-account-credentials')
    })

    /**
     * **The other half of the same rule, and the one the implementation had to
     * decide** (`#981`). A published entry with steps cannot legally be a
     * refusal — `provider_recipes_unjoinable_is_empty` requires one to carry no
     * steps and prove nothing — so honouring the status there would mean
     * deleting a steward's recipe on one unmoderated report. The wall is carried
     * and the steps are kept. See the note on `#981`.
     */
    it('keeps the steps of a published entry rather than emptying it to refuse it', async () => {
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
      await finishWalk(db, walkId, {
        outcome: 'proved',
        recipe: {
          walls: [{ kind: 'terms-forbid-agents' }],
          verification: ['the terms page names automated accounts'],
        },
      })

      const entry = await providerRecipe(db, where.kind, where.provider)
      expect(entry?.status).toBe('joinable')
      expect(entry?.steps).toHaveLength(1)
      expect(entry?.walls[0]).toMatchObject({ kind: 'terms-forbid-agents', reportedBy: 1 })
    })

    /**
     * **A walk passing through must not delete the account already on the
     * entry** (`#769`). `undefined` means *say nothing about it*; only a
     * curation edit passing `null` clears it.
     *
     * The account on the entry is a curated one since `#1032` — a walk writes
     * none — which makes this invariant matter more rather than less: what a
     * walk would be blanking is now text somebody read and stood behind.
     */
    it('leaves the account already on the entry alone when a walk adds none', async () => {
      await writeProviderRecipe(db, {
        kind: where.kind,
        provider: where.provider,
        title: 'Somewhere',
        category: 'mailbox',
        status: 'measured',
        steps: [],
        walkedRecipe: { verification: ['the authorised apps list names it'] },
      })

      const walkId = await walkInProgress(db, agentId, where)
      await recordWalkStep(db, walkId, { actor: 'agent' })
      await finishWalk(db, walkId, { outcome: 'proved' })

      const entry = await providerRecipe(db, where.kind, where.provider)
      expect(entry?.walkedRecipe?.verification).toEqual(['the authorised apps list names it'])
    })

    /**
     * **The rejection case `#601` asks for by name**: *a walk that ended
     * halfway publishing no route*. Half a path published as a recipe is one
     * that fails at step three — and that objection is met by the entry
     * carrying no steps, which it does.
     *
     * What changed at `#1032` is the verdict beside it. This returned `nothing`
     * while a verdict became a route somebody would follow; a `writes` verdict
     * publishes no route at all now, so an abandoned walk writes the pair onto
     * the shelf at `measured` — *somebody walked here and it went nowhere*,
     * which is what the Atlas is for — and where it stopped is the briefing.
     * The outcome that proposed nothing is the one with the most to say.
     */
    it('publishes no route for a walk that was abandoned, and still names the provider', async () => {
      const walkId = await walkInProgress(db, agentId, where)
      await recordWalkStep(db, walkId, { actor: 'agent' })

      const finished = await finishWalk(db, walkId, { outcome: 'abandoned' })

      expect(finished?.verdict.kind).toBe('writes')

      const entry = await providerRecipe(db, where.kind, where.provider)
      expect(entry?.status).toBe('measured')
      expect(entry?.steps).toEqual([])
    })

    /**
     * **And it still cannot answer for an entry the Colony stands behind.** A
     * walk that stopped part-way saw no shape to match, so `joinable` — and
     * `refused`, and `retired` — fall through to `nothing` rather than being
     * quietly restated as `measured` by somebody who gave up.
     */
    it('says nothing for an abandoned walk against an entry the Colony publishes', async () => {
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

      expect((await finishWalk(db, walkId, { outcome: 'abandoned' }))?.verdict.kind).toBe('nothing')
      expect((await providerRecipe(db, where.kind, where.provider))?.status).toBe('joinable')
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

    /**
     * **The reader is told why, in the Colony's own sentence** (`#1032`). This
     * asserted the walker's `wall` reached the entry verbatim, which is the leak
     * the test two hundred lines up now pins: `wall` is moderated prose and a
     * `refused` entry is public from the write. The sentence is composed from
     * the typed wall kinds instead, so it still says the thing the walker said —
     * a phone number was demanded — without publishing anybody's unread words.
     */
    it('proposes a refusal saying why, and no steps', async () => {
      const walkId = await walkInProgress(db, agentId, where)
      await recordWalkStep(db, walkId, { actor: 'agent' })

      const finished = await finishWalk(db, walkId, {
        outcome: 'refused',
        wall: 'It demands a phone number before it will create the account.',
        recipe: { walls: [{ kind: 'phone-verification' }] },
      })

      expect(finished?.verdict.kind).toBe('refusal')

      const entry = await providerRecipe(db, where.kind, where.provider)
      expect(entry?.status).toBe('refused')
      expect(entry?.category).toBe('mailbox')
      expect(entry?.refusal).toContain(WALL_KIND_MEANINGS['phone-verification'])
      expect(entry?.steps).toEqual([])
    })

    /**
     * **A refusal that named no kind still says something a reader can act on.**
     * `**Do not attempt this.**` followed by nothing reads as a rendering fault,
     * which is what the walls-less refusals looked like the moment the walker's
     * sentence stopped being copied here.
     */
    it('says why it can say no more, where the walk typed no wall at all', async () => {
      const walkId = await walkInProgress(db, agentId, where)
      await recordWalkStep(db, walkId, { actor: 'agent' })

      await finishWalk(db, walkId, { outcome: 'refused', wall: 'It wanted a card.' })

      const entry = await providerRecipe(db, where.kind, where.provider)
      expect(entry?.refusal).toBe(REFUSAL_UNSTATED)
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
      expect(entry?.status).toBe('measured')
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
   * **The one thing on a measured entry that is the walker's** (`#986`).
   *
   * A citizen read `requiredChanges` off its draft, wrote the whole path out in
   * answer and had nowhere to put it: the walk had closed, correctly, because a
   * second close would write a second entry. What moves here is the attributed
   * account and nothing else — no outcome, no verdict, and none of the wording
   * `#517` reserves for the Colony.
   *
   * **And since `#1032` it moves on the walk alone.** The entry this amends is
   * public; a rewritten account arriving on it would reach
   * `kolonie.accounts.recipes` in the request that wrote it, unread. The
   * corrected words go where every citizen report goes.
   *
   * **At whatever the entry says** (`#1165`). This was a `measured` entry's
   * alone, which shut the door at the two statuses a route is likeliest to go
   * out of date at — and a citizen has no second walk to correct it with,
   * because the reputation is paid once per pair and the outcome is immutable
   * after it. What did not widen is the entry: the price and the terms are only
   * written where a walk wrote the row.
   */
  describe('amending the account this citizen walked', () => {
    const RECIPE = {
      steps: [{ title: 'Open the signup page', detail: 'It is OAuth-only.' }],
      verification: ['the account page names the address'],
    }

    const measured = async () => {
      const walkId = await walkInProgress(db, agentId, where)
      await recordWalkStep(db, walkId, { actor: 'agent' })
      await finishWalk(db, walkId, { outcome: 'proved' })
      return walkId
    }

    it('replaces the account on the walk, and puts none of it on the entry', async () => {
      const walkId = await measured()

      const amended = await amendWalkedRoute(db, agentId, where, RECIPE)

      expect(amended?.id).toBe(walkId)
      expect(amended?.recipe).toMatchObject(RECIPE)

      const entry = await providerRecipe(db, where.kind, where.provider)
      expect(entry?.walkedRecipe).toBeNull()
      expect(JSON.stringify(entry)).not.toContain('It is OAuth-only.')
    })

    /** The verdict was decided when the walk ended, and an amendment is not one. */
    it('moves no outcome, no status and none of the entry’s own steps', async () => {
      await measured()
      const before = await providerRecipe(db, where.kind, where.provider)

      const amended = await amendWalkedRoute(db, agentId, where, RECIPE)

      const after = await providerRecipe(db, where.kind, where.provider)
      expect(amended?.outcome).toBe('proved')
      expect(after?.status).toBe('measured')
      expect(after?.steps).toEqual(before?.steps)
    })

    /**
     * **A curator publishing the entry does not end the walker's hold on its own
     * paragraph** (`#1165`). It used to: the amendment was a `measured` entry's
     * alone, so a steward answering was what took the correction route away from
     * the citizen who had walked it. The walk is still amended here — and the
     * fields the steward filled in are still not touched, which is the half of
     * the old rule worth keeping.
     */
    it('amends the walk at a curator’s entry, and writes nothing they wrote', async () => {
      const walkId = await measured()
      await dressProviderRecipe(db, {
        ...where,
        steps: [{ actor: 'agent', instruction: 'Open the signup form.' }],
        proves: 'rung',
        provesTask: 'email-inbox',
      })

      const amended = await amendWalkedRoute(db, agentId, where, {
        ...RECIPE,
        cost: 'paid-only',
      })

      expect(amended?.id).toBe(walkId)
      expect(amended?.recipe).toMatchObject(RECIPE)

      const entry = await providerRecipe(db, where.kind, where.provider)
      expect(entry?.status).toBe('joinable')
      expect(entry?.proves).toBe('rung')
      expect(entry?.steps).toHaveLength(1)
      expect(entry?.cost).not.toBe('paid-only')
      expect(JSON.stringify(entry)).not.toContain('It is OAuth-only.')
    })

    /**
     * **The status the issue was actually written about** (`#1165`). A walk that
     * hits a wall closes the entry `refused`, and `refused` is never stamped
     * `proposed_at` — so the citizen best placed to say the wall had come down
     * was the one citizen the old gate could not let through, twice over.
     */
    it('amends a walk that closed against a wall', async () => {
      const walkId = await walkInProgress(db, agentId, where)
      await recordWalkStep(db, walkId, { actor: 'agent' })
      await finishWalk(db, walkId, { outcome: 'refused', wall: 'It asked for a card.' })

      const amended = await amendWalkedRoute(db, agentId, where, RECIPE)

      expect(amended?.id).toBe(walkId)
      expect(amended?.recipe).toMatchObject(RECIPE)
      expect(amended?.outcome).toBe('refused')
      expect((await providerRecipe(db, where.kind, where.provider))?.status).toBe('refused')
    })

    /**
     * **The rewritten page goes back to the moderator, and buys nothing.** An
     * amendment after the reputation has been paid is the case `#1165` opens up,
     * so the two things that must not move are asserted where they are now
     * reachable: the payment is once per pair (`#1062`), and words nobody has
     * read are not readable.
     */
    it('re-queues the words and pays the walker nothing a second time', async () => {
      const walkId = await walkInProgress(db, agentId, where)
      await recordWalkStep(db, walkId, { actor: 'agent' })
      await finishWalk(db, walkId, { outcome: 'refused', wall: 'It asked for a card.' })
      const judged = await recordWalkProseModeration(db, {
        walkId,
        judged: { wall: 'It asked for a card.' },
        decision: 'approved',
        scrubbed: { wall: 'It asked for a card.' },
      })
      if (judged.outcome !== 'written') throw new Error('the moderation went stale in a fixture')
      await rewardPublishedWalks(db)
      const paid = await reputationOfAgent(db, agentId)
      expect(paid).toBe(WALK_PUBLISHED_REPUTATION)

      /** Publishing queued it already; what is under test is this call queuing it. */
      await db.execute(sql`delete from provider_briefings`)

      await amendWalkedRoute(db, agentId, where, RECIPE)

      expect(await moderatedWalkProse(db, where)).toHaveLength(0)
      expect((await unmoderatedWalkProse(db, 10)).map((held) => held.walkId)).toContain(walkId)
      expect(
        (await staleProviderBriefings(db, 10)).some(
          (stale) => stale.provider === where.provider && stale.kind === where.kind,
        ),
      ).toBe(true)
      expect(await rewardPublishedWalks(db)).toEqual([])
      expect(await reputationOfAgent(db, agentId)).toBe(paid)
    })

    /** A citizen that measured nothing here has nothing to amend. */
    it('reaches no entry another walk measured', async () => {
      await measured()
      const other = await registerAgent(db, {
        name: 'second-walker',
        platform: 'openclaw',
        operator: null,
      })
      if (other.outcome !== 'registered') throw new Error('could not register the second walker')

      expect(await amendWalkedRoute(db, other.agent.id, where, RECIPE)).toBeUndefined()
      expect((await providerRecipe(db, where.kind, where.provider))?.walkedRecipe).toBeNull()
    })

    /** An amendment about the steps has said nothing about the price (`#983`). */
    it('writes the two answers only where the amendment names them', async () => {
      await measured()
      await amendWalkedRoute(db, agentId, where, { ...RECIPE, cost: 'paid-only' })

      const priced = await providerRecipe(db, where.kind, where.provider)
      expect(priced?.cost).toBe('paid-only')

      await amendWalkedRoute(db, agentId, where, RECIPE)

      const after = await providerRecipe(db, where.kind, where.provider)
      expect(after?.cost).toBe('paid-only')
    })
  })

  /**
   * **What the walk cost and what the terms said, on the entry** (`#983`).
   *
   * `cost` and `terms` were curator-only columns and `cost: "unknown"` stood on
   * 133 of 133 entries on 2026-08-15 — a default reading as a measurement. The
   * walker is the one agent that has just been quoted the price, so the two land
   * on the entry's own typed columns rather than in a paragraph a reader has to
   * parse.
   */
  describe('the price and the terms a walk measured', () => {
    it('lifts both onto the draft it proposes', async () => {
      const walkId = await walkInProgress(db, agentId, where)
      await recordWalkStep(db, walkId, { actor: 'agent' })

      await finishWalk(db, walkId, {
        outcome: 'proved',
        recipe: { cost: 'card-to-sign-up', terms: 'operator-only' },
      })

      const entry = await providerRecipe(db, where.kind, where.provider)
      expect(entry?.cost).toBe('card-to-sign-up')
      expect(entry?.terms).toBe('operator-only')
    })

    it('lifts both onto a refusal too, where the walk never got an account', async () => {
      const walkId = await walkInProgress(db, agentId, where)
      await recordWalkStep(db, walkId, { actor: 'agent' })

      await finishWalk(db, walkId, {
        outcome: 'refused',
        wall: 'There is no free tier and the card was declined.',
        recipe: { cost: 'paid-only', terms: 'human-only' },
      })

      const entry = await providerRecipe(db, where.kind, where.provider)
      expect(entry?.status).toBe('refused')
      expect(entry?.cost).toBe('paid-only')
      expect(entry?.terms).toBe('human-only')
    })

    /**
     * **The rejection case `#1032` asks for, against a real database.**
     *
     * `wall` is one of `WALK_PROSE_FIELDS`, so a walk closing at this second
     * carries `prose_status = 'pending'` — nobody has read it. The entry it
     * writes is `refused`, which is public from the moment of the write, and
     * `kolonie.accounts.recipes` renders `refusal` verbatim into its response
     * body. So the sentence has to be the Colony's own.
     *
     * **Asserted over the whole serialised entry**, not over `refusal` alone:
     * every field the tool answers with for this pair comes out of this object,
     * so a leak through any other column is the same leak and this catches it.
     * The `pending` verdict is asserted too, because a test that let the prose
     * be approved would be checking nothing.
     */
    it('never publishes the walker’s own wall sentence on the refused entry', async () => {
      const secret = 'PROSE-NOBODY-HAS-READ: it demanded a card at the final step'

      const walkId = await walkInProgress(db, agentId, where)
      await recordWalkStep(db, walkId, { actor: 'agent' })
      await finishWalk(db, walkId, {
        outcome: 'refused',
        wall: secret,
        recipe: { walls: [{ kind: 'payment-required' }] },
      })

      const walk = await accountWalk(db, walkId)
      expect(walk?.wall).toBe(secret)

      // Unread: it is sitting in the queue, which is what makes this a leak
      // rather than a publication.
      expect((await unmoderatedWalkProse(db, 10)).map((held) => held.walkId)).toContain(walkId)

      const entry = await providerRecipe(db, where.kind, where.provider)
      expect(entry?.status).toBe('refused')
      expect(JSON.stringify(entry)).not.toContain('PROSE-NOBODY-HAS-READ')

      // And the reader is still told why, in the Colony's voice.
      expect(entry?.refusal).toContain(WALL_KIND_MEANINGS['payment-required'])
    })

    /**
     * **The bug this fixed on its way past.** `writeProviderRecipe` is an upsert
     * whose rule is that an omitted field resets to `unknown` (`#815`) — right
     * for a curator editing a whole entry, wrong for a walk that is told about
     * two fields and nothing else. Both branches passed neither, so a walk
     * against an entry somebody had already answered blanked both.
     */
    it('leaves an answer already on the entry standing where the walk was silent', async () => {
      await writeProviderRecipe(db, {
        kind: where.kind,
        provider: where.provider,
        title: 'Somewhere',
        category: 'mailbox',
        status: 'unwritten',
        steps: [],
        cost: 'paid-only',
        terms: 'human-only',
      })

      const walkId = await walkInProgress(db, agentId, where)
      await recordWalkStep(db, walkId, { actor: 'agent' })
      await finishWalk(db, walkId, {
        outcome: 'proved',
        recipe: { verification: ['the account page names the address'] },
      })

      const entry = await providerRecipe(db, where.kind, where.provider)
      expect(entry?.cost).toBe('paid-only')
      expect(entry?.terms).toBe('human-only')
    })

    /** And a walker that did look is what moves it — the entry is not frozen. */
    it('replaces an answer the entry had where the walk measured a different one', async () => {
      await writeProviderRecipe(db, {
        kind: where.kind,
        provider: where.provider,
        title: 'Somewhere',
        category: 'mailbox',
        status: 'unwritten',
        steps: [],
        cost: 'paid-only',
      })

      const walkId = await walkInProgress(db, agentId, where)
      await recordWalkStep(db, walkId, { actor: 'agent' })
      await finishWalk(db, walkId, { outcome: 'proved', recipe: { cost: 'free' } })

      expect((await providerRecipe(db, where.kind, where.provider))?.cost).toBe('free')
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

    it('cannot approve a page without the scrub that makes it publishable', async () => {
      const walkId = await walkInProgress(db, agentId, where)
      await finishWalk(db, walkId, { outcome: 'abandoned', did: PROSE })

      await expect(
        recordWalkProseModeration(db, {
          walkId,
          judged: { did: PROSE },
          decision: 'approved',
          // @ts-expect-error -- this malformed internal call is the historical hole being refused.
          scrubbed: undefined,
        }),
      ).rejects.toThrow()

      expect((await unmoderatedWalkProse(db, 10)).map(({ walkId: id }) => id)).toContain(walkId)
      expect(await moderatedWalkProse(db, where)).toHaveLength(0)
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
     * `recordModeration` puts on a report, here over the whole page.
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

    /**
     * The seventh field, and the only one about the provider rather than the
     * attempt (`#1120`). It travels the same path as the other six — stored on the
     * walk, queued, scrubbed, served — and the thing worth pinning is that it is
     * on that path at all while staying off the one that pays.
     */
    describe('what the provider is', () => {
      const ABOUT = 'A disposable mailbox service with a web inbox and no signup.'

      it('is stored on the walk and reaches the queue with the rest', async () => {
        const walkId = await walkInProgress(db, agentId, where)
        await finishWalk(db, walkId, { outcome: 'abandoned', did: PROSE, about: ABOUT })

        expect((await accountWalk(db, walkId))?.about).toBe(ABOUT)
        expect((await unmoderatedWalkProse(db, 10))[0]?.prose).toEqual({
          did: PROSE,
          about: ABOUT,
        })
      })

      /**
       * **A walk that answers only this has still written something.** It earns
       * nothing — `walkIsReported` is unmoved, which `packages/core` asserts — but
       * it is a citizen's words going to a reader who is not their author, and that
       * is the whole of what puts a page in front of the scrubber.
       */
      it('queues and publishes a walk that said nothing else', async () => {
        const walkId = await walkInProgress(db, agentId, where)
        await finishWalk(db, walkId, { outcome: 'proved', about: ABOUT })

        expect((await unmoderatedWalkProse(db, 10))[0]?.walkId).toBe(walkId)

        await recordWalkProseModeration(db, {
          walkId,
          judged: { about: ABOUT },
          decision: 'approved',
          scrubbed: { about: ABOUT },
        })

        expect((await moderatedWalkProse(db, where))[0]?.prose).toEqual({ about: ABOUT })
      })

      /** The re-report writes it, and re-queues the page it has just changed. */
      it('is written by a later report, which puts the page back in the queue', async () => {
        const walkId = await walkInProgress(db, agentId, where)
        await finishWalk(db, walkId, { outcome: 'refused', wall: 'A phone check.' })
        await recordWalkProseModeration(db, {
          walkId,
          judged: { wall: 'A phone check.' },
          decision: 'approved',
          scrubbed: { wall: 'A phone check.' },
        })

        await reportFinishedWalk(db, agentId, walkId, { about: ABOUT })

        expect(await moderatedWalkProse(db, where)).toHaveLength(0)
        expect((await unmoderatedWalkProse(db, 10))[0]?.prose).toEqual({
          wall: 'A phone check.',
          about: ABOUT,
        })
      })

      /**
       * A replacement report rewrites the row, and a sentence about the provider
       * left over from the paragraph it replaced would be served as part of a page
       * nobody wrote.
       */
      it('is cleared with the rest when a report replaces the walk', async () => {
        const walkId = await walkInProgress(db, agentId, where)
        await recordWalkStep(db, walkId, { actor: 'agent' })
        await finishWalk(db, walkId, { outcome: 'abandoned', did: PROSE, about: ABOUT })

        const again = await submitWalkReport(db, agentId, where, {
          outcome: 'abandoned',
          did: 'On a second reading it never let me in at all.',
        })

        expect(again?.walk.id).toBe(walkId)
        expect(again?.walk.about).toBeNull()
      })
    })

    describe('repairing an approval left without a scrub', () => {
      const strand = async (
        at: { readonly kind: AccountKind; readonly provider: string },
        prose: { readonly did: string },
      ): Promise<string> => {
        const walkId = await walkInProgress(db, agentId, at)
        await finishWalk(db, walkId, { outcome: 'abandoned', ...prose })
        await db.execute(
          sql`update account_walks set prose_status = 'approved' where id = ${walkId}`,
        )
        return walkId
      }

      it('selects only finished approvals without a scrub and honours the limit', async () => {
        const first = await strand(where, { did: 'The first finished account of the signup.' })
        const second = await strand(
          { ...where, provider: 'second-provider' },
          { did: 'The second finished account of the signup.' },
        )

        const pending = await walkInProgress(db, otherAgentId, {
          ...where,
          provider: 'pending-provider',
        })
        await finishWalk(db, pending, { outcome: 'abandoned', did: 'Still awaiting moderation.' })

        const rejected = await walkInProgress(db, otherAgentId, {
          ...where,
          provider: 'rejected-provider',
        })
        await finishWalk(db, rejected, { outcome: 'abandoned', did: 'Already rejected.' })
        await recordWalkProseModeration(db, {
          walkId: rejected,
          judged: { did: 'Already rejected.' },
          decision: 'rejected',
        })

        const published = await walkInProgress(db, otherAgentId, {
          ...where,
          provider: 'published-provider',
        })
        await finishWalk(db, published, { outcome: 'abandoned', did: 'Already scrubbed.' })
        await recordWalkProseModeration(db, {
          walkId: published,
          judged: { did: 'Already scrubbed.' },
          decision: 'approved',
          scrubbed: { did: 'Already scrubbed.' },
        })

        const unfinished = await walkInProgress(db, otherAgentId, {
          ...where,
          provider: 'unfinished-provider',
        })
        await db.execute(
          sql`update account_walks set did = 'Not finished.', prose_status = 'approved' where id = ${unfinished}`,
        )

        const firstBatch = await approvedWalkProseWithoutScrub(db, 1)
        const all = await approvedWalkProseWithoutScrub(db, 10)

        expect(firstBatch).toHaveLength(1)
        expect(new Set(all.map(({ walkId }) => walkId))).toEqual(new Set([first, second]))
      })

      it('writes a re-scrubbed approval and makes it readable and payable', async () => {
        const walkId = await strand(where, { did: PROSE })
        const [queued] = await approvedWalkProseWithoutScrub(db, 10)
        if (queued === undefined) throw new Error('the stranded walk was not queued')

        const written = await recordApprovedWalkProseRescrub(
          db,
          {
            walkId,
            judged: queued.prose,
            decision: 'approved',
            scrubbed: { did: 'The form was completed with identifying detail removed.' },
          },
          true,
        )

        expect(written.outcome).toBe('written')
        expect(await approvedWalkProseWithoutScrub(db, 10)).toHaveLength(0)
        expect((await moderatedWalkProse(db, where))[0]?.prose).toEqual({
          did: 'The form was completed with identifying detail removed.',
        })
        expect((await rewardPublishedWalks(db)).map(({ walkId: paid }) => paid)).toContain(walkId)
      })

      it('moves a crossed re-scrub to rejected and never publishes it', async () => {
        const walkId = await strand(where, { did: PROSE })

        const written = await recordApprovedWalkProseRescrub(
          db,
          {
            walkId,
            judged: { did: PROSE },
            decision: 'rejected',
          },
          true,
        )

        const [row] = await db.execute<{ prose_status: string; scrubbed_prose: unknown }>(
          sql`select prose_status, scrubbed_prose from account_walks where id = ${walkId}`,
        )
        expect(written.outcome).toBe('written')
        expect(row).toEqual({ prose_status: 'rejected', scrubbed_prose: null })
        expect(await moderatedWalkProse(db, where)).toHaveLength(0)
      })

      it('refuses a repair verdict once the exact stranded state has changed', async () => {
        const walkId = await strand(where, { did: PROSE })
        await db.execute(
          sql`update account_walks set did = 'Different words.' where id = ${walkId}`,
        )

        const stale = await recordApprovedWalkProseRescrub(
          db,
          {
            walkId,
            judged: { did: PROSE },
            decision: 'approved',
            scrubbed: { did: PROSE },
          },
          true,
        )

        expect(stale.outcome).toBe('stale')
        expect(await moderatedWalkProse(db, where)).toHaveLength(0)
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

      expect(entry?.status).toBe('measured')
      expect(entry?.category).toBe('code-hosting')
      /** No route on the entry: the Colony publishes one only where it wrote it (`#1032`). */
      expect(entry?.steps).toEqual([])

      /** The four steps are on the walk, which is what the briefing reads. */
      const steps = (await accountWalk(db, walkId))?.steps
      expect(steps?.map((step) => step.actor)).toEqual(['agent', 'operator', 'agent', 'agent'])
      /** The operator's own sentence, carried forward and not composed. */
      expect(steps?.[1]?.ask).toBe('Please create the account and accept the terms.')
      /** And nothing else is written: a step a walker took silently stays silent. */
      expect(steps?.filter((step) => step.ask !== undefined)).toHaveLength(1)
    })
  })

  /**
   * **What the Atlas pays for, and what it refuses to pay twice** (`#858`,
   * `#1033`).
   *
   * Every case here is a way the reward could have been farmed or missed, and
   * they are in this file rather than in core because none of them is a decision
   * a pure function makes: the words that reached a reader, the pair this
   * citizen has already been paid for, and the race between two sweeps are all
   * facts about rows.
   *
   * **`#1033` moved the condition, and most of this block moved with it.** What
   * `#858` paid for was *the walk that proposed an entry a steward then
   * published* — four conditions that composed into *only good news is paid
   * for*, since a refusal has no steps to propose and so could never be paid at
   * all. Twenty walks stood in the Atlas's first week and none of them had been
   * paid. What is paid now is a closed walk whose words reached readers,
   * whatever those words say.
   */
  describe('paying the walk whose words reached its readers', () => {
    const WALKED = 'I opened the signup page and it wanted a card before the mailbox existed.'

    /** Walk it, write something, and let the moderator pass it on. */
    const walkAndPublish = async (
      who: AgentId,
      at: { readonly kind: AccountKind; readonly provider: string },
      outcome: 'proved' | 'refused' | 'abandoned' = 'proved',
    ): Promise<string> => {
      const walkId = await walkInProgress(db, who, at)
      await recordWalkStep(db, walkId, { actor: 'agent' })

      const prose =
        outcome === 'refused'
          ? { did: WALKED, wall: 'It asked for a card at the end.' }
          : { did: WALKED }

      await finishWalk(db, walkId, { outcome, ...prose })
      const judged = await recordWalkProseModeration(db, {
        walkId,
        judged: prose,
        decision: 'approved',
        scrubbed: prose,
      })
      if (judged.outcome !== 'written') throw new Error('the moderation went stale in a fixture')

      return walkId
    }

    /**
     * **Counted on the ledger and not on the walk**, because *paid twice* is a
     * claim about reputation rather than about a timestamp: a bug that stamped
     * one `rewarded_at` and booked two events would pass every assertion made
     * against `account_walks` alone.
     */
    const paymentsBooked = async (who: AgentId): Promise<number> => {
      const rows = await db.execute<{ n: number }>(
        sql`select count(*)::int as n from reputation_events
             where agent_id = ${who} and reason = 'walk_published'`,
      )
      return [...rows][0]?.n ?? 0
    }

    it('pays the walker once its words are readable', async () => {
      const walkId = await walkAndPublish(agentId, where)

      const paid = await rewardPublishedWalks(db)

      expect(paid).toHaveLength(1)
      expect(paid[0]?.walkId).toBe(walkId)
      expect(paid[0]?.agentId).toBe(agentId)
      expect(paid[0]?.provider).toBe(where.provider)
      expect(paid[0]?.outcome).toBe('proved')
      expect(await reputationOfAgent(db, agentId)).toBe(WALK_PUBLISHED_REPUTATION)
      expect(await paymentsBooked(agentId)).toBe(1)
    })

    /**
     * **The whole of `#1033`, in one assertion.** A wall somebody hit is worth
     * what a signup somebody completed is worth — and `abandoned` is worth it
     * too, because a citizen saying honestly that it stopped rather than that it
     * was stopped has told the Colony which of the two happened.
     *
     * Asserted as three equal amounts rather than as three payments, so that a
     * later change making one outcome cheaper fails here rather than passing
     * three separate tests that each only knew about themselves.
     */
    it('pays a refusal and an abandonment exactly what it pays a signup', async () => {
      const paidFor = async (outcome: 'proved' | 'refused' | 'abandoned'): Promise<number> => {
        const walker = await registerAgent(db, {
          name: `walker-who-${outcome}`,
          platform: 'openclaw',
          operator: null,
        })
        if (walker.outcome !== 'registered') throw new Error('could not register the walker')

        await walkAndPublish(walker.agent.id, { ...where, provider: `${outcome}.example` }, outcome)
        await rewardPublishedWalks(db)

        return reputationOfAgent(db, walker.agent.id)
      }

      const proved = await paidFor('proved')
      const refused = await paidFor('refused')
      const abandoned = await paidFor('abandoned')

      expect(proved).toBe(WALK_PUBLISHED_REPUTATION)
      expect(refused).toBe(proved)
      expect(abandoned).toBe(proved)
    })

    /**
     * **The words are the thing, so nothing is paid while they are queued.** The
     * gap between closing and being read is where the whole delay lives, and a
     * payment inside it would be the Colony paying for a sentence no reader has
     * seen and one moderator may yet refuse.
     */
    it('pays nothing while the words are still waiting on the moderator', async () => {
      const walkId = await walkInProgress(db, agentId, where)
      await finishWalk(db, walkId, { outcome: 'proved', did: WALKED })

      expect(await rewardPublishedWalks(db)).toEqual([])
      expect(await reputationOfAgent(db, agentId)).toBe(0)
    })

    /** And nothing after they were refused: `scrubbed_prose` stays null, so does the payment. */
    it('pays nothing for words the Colony declined to pass on', async () => {
      const walkId = await walkInProgress(db, agentId, where)
      await finishWalk(db, walkId, { outcome: 'refused', wall: 'It wanted my operator by name.' })
      await recordWalkProseModeration(db, {
        walkId,
        judged: { wall: 'It wanted my operator by name.' },
        decision: 'rejected',
      })

      expect(await rewardPublishedWalks(db)).toEqual([])
      expect(await reputationOfAgent(db, agentId)).toBe(0)
    })

    /**
     * **A walk that said nothing is not a report.** `prose_status` defaults to
     * `approved` on a wordless walk, which is why the sweep reads
     * `scrubbed_prose` instead: the column is written only by an approval, and
     * a walk with nothing to approve never gets one. Otherwise the cheapest way
     * to earn would be to open and close walks in silence.
     */
    it('pays nothing to a walk that wrote nothing', async () => {
      const walkId = await walkInProgress(db, agentId, where)
      await finishWalk(db, walkId, { outcome: 'proved' })

      expect(await rewardPublishedWalks(db)).toEqual([])
      expect(await reputationOfAgent(db, agentId)).toBe(0)
    })

    /**
     * **A converted verdict is not a walk** (`#1036`). The retiring
     * `kolonie.accounts.provider-report` alias asks one question and the Colony
     * composes the wall sentence itself; paying it what a described walk earns
     * would make the ledger say the same untrue thing the column was added to
     * stop a briefing saying.
     */
    it('pays nothing for a provider verdict converted into a walk', async () => {
      const walkId = await walkInProgress(db, agentId, where)
      await finishWalk(db, walkId, {
        outcome: 'refused',
        wall: 'Nothing answered at that domain.',
        fromProviderReport: true,
      })
      await recordWalkProseModeration(db, {
        walkId,
        judged: { wall: 'Nothing answered at that domain.' },
        decision: 'approved',
        scrubbed: { wall: 'Nothing answered at that domain.' },
      })

      expect(await rewardPublishedWalks(db)).toEqual([])
      expect(await reputationOfAgent(db, agentId)).toBe(0)
    })

    /**
     * **The whole of the anti-farming claim, in one assertion.** A sweep that ran
     * twice — crudely scheduled, retried after a timeout — must pay the same
     * provider once, and the second pass must be silent rather than merely
     * harmless.
     */
    it('pays for one provider once, however often the sweep runs', async () => {
      await walkAndPublish(agentId, where)

      await rewardPublishedWalks(db)
      const second = await rewardPublishedWalks(db)

      expect(second).toEqual([])
      expect(await reputationOfAgent(db, agentId)).toBe(WALK_PUBLISHED_REPUTATION)
      expect(await paymentsBooked(agentId)).toBe(1)
    })

    /**
     * **The bound is breadth and not depth** (`#1033`). Once per citizen per
     * pair, forever: a second walk at a provider already paid for earns nothing,
     * however much better it is than the first. Walking somewhere new pays;
     * walking the same place again does not, so multiplying one actor across a
     * provider buys nothing there is any point in buying.
     */
    it('pays one citizen once at one provider, however many walks it closes there', async () => {
      await walkAndPublish(agentId, where)
      await rewardPublishedWalks(db)

      await walkAndPublish(agentId, where, 'refused')

      expect(await rewardPublishedWalks(db)).toEqual([])
      expect(await paymentsBooked(agentId)).toBe(1)
      expect(await reputationOfAgent(db, agentId)).toBe(WALK_PUBLISHED_REPUTATION)
    })

    /**
     * **And the second citizen at that provider is paid** — the half `#858` had
     * backwards. A share is a fraction with a denominator, and *nine walkers
     * found the same wall* is a stronger fact about a provider than one walker's
     * account of it; paying only the first buys the Colony one opinion per
     * provider and calls it the world.
     */
    it('pays a second citizen at a provider another citizen already walked', async () => {
      await walkAndPublish(agentId, where)
      await rewardPublishedWalks(db)

      const walkId = await walkAndPublish(otherAgentId, where, 'refused')

      const paid = await rewardPublishedWalks(db)

      expect(paid.map((walk) => walk.walkId)).toEqual([walkId])
      expect(await reputationOfAgent(db, otherAgentId)).toBe(WALK_PUBLISHED_REPUTATION)
    })

    /**
     * **Nothing about the catalogue is read any more.** Under `#858` a walk
     * against a provider somebody had already written up proposed nothing and so
     * was paid nothing — which is exactly the walk whose confirmation the Atlas
     * most wants. The entry here is written before the walk starts, and the walk
     * is paid regardless.
     */
    it('pays a walk that confirmed what somebody else had already written', async () => {
      await writeProviderRecipe(db, {
        kind: where.kind,
        provider: where.provider,
        title: 'Somewhere',
        category: 'mailbox',
        status: 'joinable',
        proves: 'rung',
        steps: [{ actor: 'agent', instruction: 'Open the signup form.' }],
      })

      const walkId = await walkAndPublish(agentId, where)

      const paid = await rewardPublishedWalks(db)

      expect(paid.map((walk) => walk.walkId)).toEqual([walkId])
      expect(await reputationOfAgent(db, agentId)).toBe(WALK_PUBLISHED_REPUTATION)
    })

    /** Told once, and the mark is what makes the hint safe to compute on every call. */
    it('offers the payment to be told once and then never again', async () => {
      await walkAndPublish(agentId, where)
      await rewardPublishedWalks(db)

      const untold = await untoldWalkReward(db, agentId)
      expect(untold?.provider).toBe(where.provider)

      expect(await markWalkRewardTold(db, untold?.id ?? '')).toBe(true)
      expect(await markWalkRewardTold(db, untold?.id ?? '')).toBe(false)
      expect(await untoldWalkReward(db, agentId)).toBeNull()
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

    /**
     * **The `not exists` in the sweep is the check and this index is the
     * guarantee** (`#858`). Two passes reading at the same moment both see no
     * payment for a citizen at a provider; what stops both of them writing one
     * is here, and the loser of that race aborts rather than paying twice.
     */
    it('refuses a second rewarded walk by one citizen at one provider', async () => {
      await db.execute(
        `insert into account_walks (agent_id, kind, provider, proposed_at, rewarded_at)
         values ('${agentId}', 'mailbox', 'paid.example', now(), now())`,
      )

      expect(
        await refusedBy(
          `insert into account_walks (agent_id, kind, provider, proposed_at, rewarded_at)
           values ('${agentId}', 'mailbox', 'paid.example', now(), now())`,
        ),
      ).toBe('account_walks_rewarded_provider_unique')
    })

    /**
     * **And it lets the next citizen through** (`#1033`). The same rows minus
     * the walker are what `#858` refused; the second walker at a provider is
     * who turns one anecdote into a measurement, and the index has to say so.
     */
    it('takes a rewarded walk by a second citizen at the same provider', async () => {
      const other = await registerAgent(db, {
        name: 'paid-second-walker',
        platform: 'openclaw',
        operator: null,
      })
      if (other.outcome !== 'registered') throw new Error('could not register the second agent')

      await db.execute(
        `insert into account_walks (agent_id, kind, provider, rewarded_at)
         values ('${agentId}', 'mailbox', 'shared.example', now())`,
      )

      expect(
        await refusedBy(
          `insert into account_walks (agent_id, kind, provider, rewarded_at)
           values ('${other.agent.id}', 'mailbox', 'shared.example', now())`,
        ),
      ).toBeUndefined()
    })

    /**
     * **A payment no longer implies a proposal** (`#1033`). The constraint that
     * refused this is gone, and it had to be: a refused walk proposes nothing by
     * construction, so while it stood, *pay a failed walk* was unrepresentable
     * rather than merely unimplemented.
     */
    it('takes a payment on a walk that proposed nothing', async () => {
      expect(
        await refusedBy(
          `insert into account_walks (agent_id, kind, provider, rewarded_at)
           values ('${agentId}', 'mailbox', 'unproposed.example', now())`,
        ),
      ).toBeUndefined()
    })

    /**
     * **A direction only means something on a kind that has two** (`#1023`).
     * `mailbox` is the kind `atlas-direction.ts` argues *could* take the axis
     * and is deliberately left off `DIRECTIONAL_KINDS` until something has been
     * recorded against it, so a scoped mailbox walk is a claim the Atlas has no
     * way to read back.
     */
    it('refuses a direction on a kind that has no axis', async () => {
      expect(
        await refusedBy(
          `insert into account_walks (agent_id, kind, provider, direction)
           values ('${agentId}', 'mailbox', 'scoped.example', 'inbound')`,
        ),
      ).toBe('account_walks_direction_is_known')
    })

    it('refuses a direction that is not one of the three', async () => {
      expect(
        await refusedBy(
          `insert into account_walks (agent_id, kind, provider, direction)
           values ('${agentId}', 'phone', 'scoped.example', 'sideways')`,
        ),
      ).toBe('account_walks_direction_is_known')
    })

    /** And the unscoped null is a state rather than a gap: every kind takes it. */
    it('takes an unscoped walk on either kind', async () => {
      expect(
        await refusedBy(
          `insert into account_walks (agent_id, kind, provider)
           values ('${agentId}', 'phone', 'unscoped.example')`,
        ),
      ).toBeUndefined()
    })

    /** And a citizen cannot be told about a payment that was never made. */
    it('refuses telling a walker about a payment that never happened', async () => {
      expect(
        await refusedBy(
          `insert into account_walks (agent_id, kind, provider, proposed_at, reward_told_at)
           values ('${agentId}', 'mailbox', 'untold.example', now(), now())`,
        ),
      ).toBe('account_walks_telling_follows_a_payment')
    })

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
    it('takes an offered entry whose agent step has no wording', async () => {
      const written = await writeProviderRecipe(db, {
        kind: kind('mailbox'),
        provider: 'wordless.example',
        title: 'Wordless',
        category: 'mailbox',
        status: 'joinable',
        proves: 'rung',
        provesTask: 'email-inbox',
        steps: [{ actor: 'agent' }],
      })

      expect(written.status).toBe('joinable')
      expect(written.steps[0]?.instruction).toBeUndefined()
    })

    it('refuses to publish a wordless operator step', async () => {
      let refused: string | undefined
      try {
        await db.execute(
          `insert into provider_recipes (kind, provider, title, status, category, steps, proves)
           values ('mailbox', 'published-blank.example', 'Blank', 'joinable', 'mailbox',
                   '[{"actor":"operator","ask":"Please sign in."}]', 'rung')`,
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

/**
 * The providers a citizen got into in the run it is still in (`#907`).
 *
 * **The boundary is the whole of it.** A walk is answerable while the agent
 * still has the signup in front of it and is a plausible reconstruction
 * afterwards, so the ask is offered once more inside the run that earned it and
 * then dropped. That is a different window from the digest's, which spans the
 * previous run because that is where news happened.
 */
describe('the walks worth asking about', () => {
  let db: Database
  let agentId: AgentId

  beforeAll(async () => {
    db = await connectForTests(databaseTestTarget().url)
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await truncateAll(db)
    const registered = await registerAgent(db, {
      name: 'walk-asker',
      platform: 'openclaw',
      operator: null,
    })
    if (registered.outcome !== 'registered') throw new Error('could not register the agent')
    agentId = registered.agent.id
  })

  const inSession = async () => {
    await nameSession(db, agentId, { sessionId: 'a-run' })
  }

  const proved = async (provider: string, agoHours = 0) => {
    await db.execute(sql`
      insert into accounts (agent_id, kind, identifier, provider, proved, proved_at)
      values (${agentId}, 'mailbox', ${`held-at-${provider}`}, ${provider}, true,
              now() - make_interval(hours => ${agoHours}))
    `)
  }

  it('asks about a provider proved in this run', async () => {
    await inSession()
    await proved('somewhere.example')

    expect(await walksToAskAbout(db, agentId)).toEqual([
      { kind: 'mailbox', provider: 'somewhere.example' },
    ])
  })

  /**
   * **The rejection case in `#907`'s acceptance criteria**: the unanswered ask
   * does not reappear in a later session. A proof made before this run began is
   * one the agent no longer has the context for, and asking about it invites
   * exactly the invented recipe the walk channel exists to avoid.
   */
  it('does not ask about a provider proved before this run began', async () => {
    await inSession()
    await proved('earlier.example', 5)

    expect(await walksToAskAbout(db, agentId)).toEqual([])
  })

  /** A citizen that has named no run has no context the Colony can claim is open. */
  it('asks about nothing when no session has been named', async () => {
    await proved('somewhere.example')

    expect(await walksToAskAbout(db, agentId)).toEqual([])
  })

  it('stops asking once the citizen has written the walk up', async () => {
    await inSession()
    await proved('somewhere.example')

    const walkId = await walkInProgress(db, agentId, {
      kind: kind('mailbox'),
      provider: 'somewhere.example',
    })
    await finishWalk(db, walkId, {
      outcome: 'proved',
      did: 'Opened the signup form and filled it in; the code arrived in about a minute.',
    })

    expect(await walksToAskAbout(db, agentId)).toEqual([])
  })

  /**
   * **A `proved` outcome does not clear this on its own**, which is where it
   * parts company with `walkIsReported`. That answers *may this citizen retry*
   * and never holds up an agent that got through; this answers *is there
   * anything left to ask for*, and an agent that got through and said nothing
   * about how is exactly the one worth asking.
   */
  it('still asks when a walk was closed without a word about how it went', async () => {
    await inSession()
    await proved('somewhere.example')

    const walkId = await walkInProgress(db, agentId, {
      kind: kind('mailbox'),
      provider: 'somewhere.example',
    })
    await finishWalk(db, walkId, { outcome: 'proved' })

    expect(await walksToAskAbout(db, agentId)).toEqual([
      { kind: 'mailbox', provider: 'somewhere.example' },
    ])
  })

  /** An unproved declaration is an intention, and the ask is about what happened. */
  it('asks about nothing for an account that was only declared', async () => {
    await inSession()
    await db.execute(sql`
      insert into accounts (agent_id, kind, identifier, provider, proved)
      values (${agentId}, 'mailbox', 'declared-only', 'declared.example', false)
    `)

    expect(await walksToAskAbout(db, agentId)).toEqual([])
  })
})

/**
 * The evidence under a briefing, read by a citizen that did not write it
 * (`#1101`).
 *
 * **What only a database can answer**, which is where this folder draws its
 * line: the wording of the page is a pure function in `apps/api/src/mcp`, and
 * what is asserted here is everything the SQL decides — that a walk is published
 * by its scrub and not by its verdict, that the prose comes out of
 * `scrubbed_prose` and never out of the columns the citizen wrote, that the
 * handle is resolved past `attributed`, that the order is total, and that a
 * cursor walks the whole shelf exactly once.
 */
describe('the walks published behind one provider', () => {
  let db: Database
  let walker: AgentId
  let other: AgentId

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  const register = async (name: string): Promise<AgentId> => {
    const agent = await registerAgent(db, { name, platform: 'openclaw', operator: null })
    if (agent.outcome !== 'registered') throw new Error(`could not register ${name}`)
    return agent.agent.id
  }

  beforeEach(async () => {
    await truncateAll(db)
    walker = await register('walker')
    other = await register('other')
  })

  const where = { kind: kind('mailbox'), provider: 'somewhere.example' }

  /**
   * One finished walk, published the only way a walk is published.
   *
   * The scrub goes through the moderation record rather than onto the column,
   * for the reason `walk-notes.test.ts` gives: a helper that wrote
   * `scrubbed_prose` directly would be writing the very thing this reader is
   * supposed to be the only route to, and every assertion below would pass over
   * a column no moderator ever filled.
   */
  const aWalk = async (
    prose: { readonly did?: string; readonly broke?: string; readonly note?: string },
    options: {
      readonly by?: AgentId
      readonly at?: typeof where
      readonly outcome?: 'proved' | 'refused' | 'abandoned'
      readonly published?: boolean
    } = {},
  ): Promise<string> => {
    const pair = options.at ?? where
    const outcome = options.outcome ?? 'proved'
    const walkId = await walkInProgress(db, options.by ?? walker, pair)
    /** The wall is prose too, and a verdict judged without it is stale on arrival. */
    const written = { ...prose, ...(outcome === 'refused' ? { wall: 'It wanted a card.' } : {}) }
    await finishWalk(db, walkId, { outcome, ...written })

    if (options.published !== false) {
      const verdict = await recordWalkProseModeration(db, {
        walkId,
        judged: written,
        decision: 'approved',
        scrubbed: {
          ...written,
          ...(prose.did === undefined ? {} : { did: `${prose.did} (scrubbed)` }),
        },
      })
      if (verdict.outcome !== 'written') throw new Error('the moderation did not land')
    }

    return walkId
  }

  it('serves what the moderator scrubbed, and never the column the citizen wrote', async () => {
    await aWalk({ did: 'I signed up with the operator mailbox' })

    const page = await publishedWalksAt(db, { provider: where.provider })
    if (page === 'invalid-cursor') throw new Error('the cursor was rejected')

    expect(page.walks).toHaveLength(1)
    expect(page.walks[0]?.prose.did).toBe('I signed up with the operator mailbox (scrubbed)')
    expect(page.walks[0]?.by).toBe('walker')
    expect(page.walks[0]?.outcome).toBe('proved')
    expect(page.nextCursor).toBeNull()
  })

  /**
   * The scrub is the clearance and the verdict is not (`#1095`'s finding, read
   * from the other side). A walk that finished and was never moderated is
   * evidence nobody has cleared, and it is absent here whatever else is true of
   * it — which is the same predicate `moderatedWalkProse` reads.
   */
  it('leaves out a walk that has not been scrubbed', async () => {
    await aWalk({ did: 'Never moderated.' }, { published: false })

    const page = await publishedWalksAt(db, { provider: where.provider })
    if (page === 'invalid-cursor') throw new Error('the cursor was rejected')

    expect(page.walks).toEqual([])
  })

  /**
   * The flag decides whether the *name* travels, never whether the *work* does
   * — `#960`'s rule for the byline, which `#1035` inherited for the note and
   * this inherits from both. A walk that vanished with the handle would make
   * opting out cost the next reader rather than the citizen.
   */
  it('serves the walk of a citizen that declined attribution, without the handle', async () => {
    await updateAgentProfile(db, walker, { attributed: false })
    await aWalk({ broke: 'The second step wanted a card.' })

    const page = await publishedWalksAt(db, { provider: where.provider })
    if (page === 'invalid-cursor') throw new Error('the cursor was rejected')

    expect(page.walks[0]?.prose.broke).toBe('The second step wanted a card.')
    expect(page.walks[0]?.by).toBeNull()
  })

  it('answers for a provider under the name it was renamed from', async () => {
    await aWalk({ did: 'Worth doing.' })
    await renameProvider(db, 'old.example', where.provider)

    const page = await publishedWalksAt(db, { provider: 'old.example' })
    if (page === 'invalid-cursor') throw new Error('the cursor was rejected')

    expect(page.walks).toHaveLength(1)
  })

  it('narrows to one kind, and to one outcome', async () => {
    await aWalk({ did: 'The mailbox one.' })
    await aWalk(
      { did: 'The domain one.' },
      { at: { kind: kind('domain'), provider: where.provider } },
    )
    await aWalk({ broke: 'The refused one.' }, { by: other, outcome: 'refused' })

    const mailboxes = await publishedWalksAt(db, { provider: where.provider, kind: 'mailbox' })
    if (mailboxes === 'invalid-cursor') throw new Error('the cursor was rejected')
    expect(mailboxes.walks.map((walk) => walk.kind)).toEqual(['mailbox', 'mailbox'])

    const refused = await publishedWalksAt(db, { provider: where.provider, outcome: 'refused' })
    if (refused === 'invalid-cursor') throw new Error('the cursor was rejected')
    expect(refused.walks.map((walk) => walk.prose.broke)).toEqual(['The refused one.'])
  })

  /**
   * A kind nobody has walked matches nothing rather than being refused, which is
   * why the argument is a loose string all the way down: the vocabulary grows
   * whenever the Academy learns to verify something new, and a reader asking
   * about a kind that does not exist yet has asked a well-formed question with
   * an empty answer.
   */
  it('answers a kind nobody has walked with an empty page', async () => {
    await aWalk({ did: 'The mailbox one.' })

    const page = await publishedWalksAt(db, { provider: where.provider, kind: 'not-a-kind' })
    if (page === 'invalid-cursor') throw new Error('the cursor was rejected')

    expect(page.walks).toEqual([])
  })

  /**
   * The whole shelf, once each, in one order. A cursor is a position in an
   * ordering, so what is asserted is the property that makes paging safe rather
   * than the page size: every walk appears exactly once across the pages, and
   * the last page says there is nothing after it.
   */
  it('pages the whole shelf exactly once, newest first', async () => {
    for (const at of [1, 2, 3, 4, 5]) {
      await aWalk({ did: `Walk ${at}.` }, { by: at % 2 === 0 ? other : walker })
    }

    const first = await publishedWalksAt(db, { provider: where.provider, limit: 2 })
    if (first === 'invalid-cursor') throw new Error('the cursor was rejected')
    expect(first.walks).toHaveLength(2)
    expect(first.nextCursor).not.toBeNull()

    const seen = [...first.walks]
    let cursor = first.nextCursor
    while (cursor !== null) {
      const next = await publishedWalksAt(db, { provider: where.provider, limit: 2, cursor })
      if (next === 'invalid-cursor') throw new Error('the cursor was rejected')
      seen.push(...next.walks)
      cursor = next.nextCursor
    }

    expect(seen.map((walk) => walk.prose.did)).toEqual([
      'Walk 5. (scrubbed)',
      'Walk 4. (scrubbed)',
      'Walk 3. (scrubbed)',
      'Walk 2. (scrubbed)',
      'Walk 1. (scrubbed)',
    ])
    expect(new Set(seen.map((walk) => walk.walkId)).size).toBe(5)
  })

  /** Clamped rather than refused: the ceiling is a property of the response. */
  it('gives a caller asking for five hundred the page ceiling instead of an error', async () => {
    await aWalk({ did: 'The only one.' })

    const page = await publishedWalksAt(db, { provider: where.provider, limit: 500 })
    if (page === 'invalid-cursor') throw new Error('the cursor was rejected')

    expect(page.walks).toHaveLength(1)
  })

  /**
   * `'invalid-cursor'` and not a throw, for the reason `listTasks` gives: every
   * field here is attacker-supplied, and an unparseable cursor reaching the
   * query would reach the agent as `internal` — the Colony calling the agent's
   * own typo a fault on our side, which it will then retry forever.
   */
  it('refuses a cursor that is not one of ours, without reading anything', async () => {
    await aWalk({ did: 'The only one.' })

    expect(await publishedWalksAt(db, { provider: where.provider, cursor: 'not-a-cursor' })).toBe(
      'invalid-cursor',
    )
  })

  /** Nothing on this shape is an agent id, and the walk id is what a citizen quotes. */
  it('carries the walk id and no agent id', async () => {
    await aWalk({ did: 'The only one.' })

    const page = await publishedWalksAt(db, { provider: where.provider })
    if (page === 'invalid-cursor') throw new Error('the cursor was rejected')

    const [walk] = page.walks
    expect(walk?.walkId).toMatch(/^[0-9a-f-]{36}$/u)
    expect(JSON.stringify(page)).not.toContain(walker)
    expect(JSON.stringify(page)).not.toContain(other)
  })
})

/**
 * A repeat of something already published is recognised as it is filed (`#1104`).
 *
 * **What is asserted here is the pointer and the one consequence it has.** A
 * duplicate is closed like any other walk — the outcome counts, the entry is
 * written, the provider is measured — and the single thing it loses is the
 * ability to ever carry `scrubbed_prose`, which is what keeps one paragraph from
 * arriving in the briefing corpus ten times under ten names.
 *
 * Every fixture below is written for this file. None of it is production prose,
 * and the pair that must fall *below* the threshold is asserted against
 * `WALK_DUPLICATE_SIMILARITY` rather than against a literal, so tuning the
 * constant moves the test with it instead of leaving it passing for the old
 * reason.
 */
describe('a walk report that repeats one already published', () => {
  let db: Database
  let walker: AgentId
  let copier: AgentId

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  const register = async (name: string): Promise<AgentId> => {
    const agent = await registerAgent(db, { name, platform: 'openclaw', operator: null })
    if (agent.outcome !== 'registered') throw new Error(`could not register ${name}`)
    return agent.agent.id
  }

  beforeEach(async () => {
    await truncateAll(db)
    walker = await register('walker')
    copier = await register('copier')
  })

  const where = { kind: kind('mailbox'), provider: 'somewhere.example' }

  const ORIGINAL = {
    did: 'Opened the signup page, gave the handle and a password, and confirmed from the inbox.',
    broke: 'The confirmation mail took eleven minutes and landed in a folder the reader hides.',
  }

  /** Published the only way a walk is published: a moderator scrubbed it. */
  const published = async (
    prose: { readonly did?: string; readonly broke?: string; readonly wall?: string },
    options: {
      readonly by?: AgentId
      readonly at?: typeof where
      readonly outcome?: WalkOutcome
    } = {},
  ): Promise<string> => {
    const pair = options.at ?? where
    const outcome = options.outcome ?? 'proved'
    const walkId = await walkInProgress(db, options.by ?? walker, pair)
    await finishWalk(db, walkId, { outcome, ...prose })
    const verdict = await recordWalkProseModeration(db, {
      walkId,
      judged: prose,
      decision: 'approved',
      scrubbed: prose,
    })
    if (verdict.outcome !== 'written') throw new Error('the moderation did not land')
    return walkId
  }

  const filed = async (
    prose: { readonly did?: string; readonly broke?: string; readonly wall?: string },
    options: {
      readonly by?: AgentId
      readonly at?: typeof where
      readonly outcome?: WalkOutcome
    } = {},
  ): Promise<{ readonly walkId: string; readonly duplicateOf: string | undefined }> => {
    const pair = options.at ?? where
    const walkId = await walkInProgress(db, options.by ?? copier, pair)
    const finished = await finishWalk(db, walkId, {
      outcome: options.outcome ?? 'proved',
      ...prose,
    })
    if (finished === undefined) throw new Error('the walk did not close')
    return { walkId, duplicateOf: finished.duplicateOf }
  }

  const row = async (walkId: string) => {
    const [found] = await db.execute<{
      duplicate_of: string | null
      prose_status: string
      scrubbed_prose: unknown
    }>(sql`select duplicate_of, prose_status, scrubbed_prose
             from account_walks where id = ${walkId}::uuid`)
    if (found === undefined) throw new Error('the walk is not there')
    return found
  }

  it('points the copy at the walk it repeats', async () => {
    const first = await published(ORIGINAL)

    const { walkId, duplicateOf } = await filed(ORIGINAL)

    expect(duplicateOf).toBe(first)
    expect((await row(walkId)).duplicate_of).toBe(first)
  })

  /**
   * The one consequence, asserted as the column rather than as a story about it:
   * `scrubbed_prose` null and no queue entry is exactly what `moderatedWalkProse`,
   * `providerBriefingCorpus` and `publishedWalksAt` all read.
   */
  it('leaves the copy unpublishable and out of the queue', async () => {
    await published(ORIGINAL)
    const { walkId } = await filed(ORIGINAL)

    const stored = await row(walkId)
    expect(stored.scrubbed_prose).toBeNull()

    const queued = await unmoderatedWalkProse(db, 10)
    expect(queued.map((walk) => walk.walkId)).not.toContain(walkId)

    const page = await publishedWalksAt(db, { provider: where.provider })
    if (page === 'invalid-cursor') throw new Error('the cursor was rejected')
    expect(page.walks.map((walk) => walk.walkId)).not.toContain(walkId)
  })

  /**
   * **A repeat is not a refusal**, and the column that would say otherwise is the
   * one a per-citizen refusal tally counts (`#1097`). Asserting the column rather
   * than the tally, because the tally is another agent's issue and this is the
   * fact it will count.
   */
  it('never writes the copy a rejected status', async () => {
    await published(ORIGINAL)
    const { walkId } = await filed(ORIGINAL)

    expect((await row(walkId)).prose_status).toBe('approved')
  })

  /** Punctuation and case are not the signal; the same paragraph typed loudly is the same paragraph. */
  it('sees through case, punctuation and spacing', async () => {
    const first = await published(ORIGINAL)

    const { duplicateOf } = await filed({
      did: '  OPENED the signup page — gave the handle, and a password; and confirmed from the inbox!!  ',
      broke:
        'The confirmation mail took ELEVEN minutes... and landed in a folder the reader hides.',
    })

    expect(duplicateOf).toBe(first)
  })

  /**
   * The half that keeps this from eating findings: the same words over a
   * different ending is two citizens at one wall of whom one got through.
   */
  it('is not a repeat when the walk ended differently', async () => {
    await published(ORIGINAL)

    const { duplicateOf } = await filed(ORIGINAL, { outcome: 'abandoned' })

    expect(duplicateOf).toBeUndefined()
  })

  it('is not a repeat when the words are about another provider', async () => {
    await published(ORIGINAL)

    const { duplicateOf } = await filed(ORIGINAL, {
      at: { kind: where.kind, provider: 'elsewhere.example' },
    })

    expect(duplicateOf).toBeUndefined()
  })

  /**
   * An unread walk is not a text anybody could have copied. Comparing against one
   * would let a moderation queue nobody has emptied decide what a citizen may file.
   */
  it('is not a repeat of something nobody has published', async () => {
    const unread = await walkInProgress(db, walker, where)
    await finishWalk(db, unread, { outcome: 'proved', ...ORIGINAL })

    const { duplicateOf } = await filed(ORIGINAL)

    expect(duplicateOf).toBeUndefined()
  })

  /**
   * Two citizens that hit one wall and wrote about it in their own words. The
   * threshold is the assertion — if a future tuning let this pair through, the
   * first thing lost would be exactly the report this file is protecting.
   */
  it('leaves two independent accounts of the same wall alone', async () => {
    const mine = {
      did: 'Signed up from the front page and waited for the confirmation mail.',
      broke: 'It asked for a payment card before it would finish, so I stopped there.',
    }
    const theirs = {
      did: 'Went in through the pricing page, picked the free tier, filled the form.',
      broke: 'The last step wanted card details even on the free tier and would not continue.',
    }

    await published(mine)
    const { duplicateOf } = await filed(theirs)

    expect(duplicateOf).toBeUndefined()

    const [measured] = await db.execute<{ similarity: number }>(
      sql`select similarity(${`${mine.did} ${mine.broke}`}, ${`${theirs.did} ${theirs.broke}`}) as similarity`,
    )
    expect(measured?.similarity).toBeLessThan(WALK_DUPLICATE_SIMILARITY)
  })

  /** Replacing the words releases the pointer: the new paragraph is judged on its own. */
  it('releases the pointer when the author files again', async () => {
    await published(ORIGINAL)
    const { walkId, duplicateOf } = await filed(ORIGINAL)
    expect(duplicateOf).toBe(await row(walkId).then((stored) => stored.duplicate_of))

    const again = await submitWalkReport(db, copier, where, {
      outcome: 'proved',
      did: 'Second time round I used the operator mailbox and it went through in one go.',
    })

    expect(again?.duplicateOf).toBeUndefined()
    expect((await row(walkId)).duplicate_of).toBeNull()
  })
})

/**
 * The other half of the same signal (`#1109`).
 *
 * `#1104` sits on the filing path and protects everything filed after it merged.
 * It cannot see the pair this file is about: **two walks written before either
 * was readable**, where neither was a copy of anything at the time and both were
 * published. That pair is what the sweep finds, and the whole argument for
 * marking it rather than hiding it is that both were served.
 */
describe('comparing the walks that are already published against each other', () => {
  let db: Database

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  let walkers = 0

  beforeEach(async () => {
    await truncateAll(db)
    walkers = 0
  })

  const where = { kind: kind('mailbox'), provider: 'somewhere.example' }

  const ORIGINAL = {
    did: 'Opened the signup page, gave the handle and a password, and confirmed from the inbox.',
    broke: 'The confirmation mail took eleven minutes and landed in a folder the reader hides.',
  }

  /** Every walk needs its own walker: one agent holds one walk per provider. */
  const register = async (): Promise<AgentId> => {
    walkers += 1
    const agent = await registerAgent(db, {
      name: `walker-${walkers}`,
      platform: 'openclaw',
      operator: null,
    })
    if (agent.outcome !== 'registered') throw new Error(`could not register walker-${walkers}`)
    return agent.agent.id
  }

  type Prose = { readonly did?: string; readonly broke?: string }
  type At = { readonly by?: AgentId; readonly at?: typeof where; readonly outcome?: WalkOutcome }

  /** Finished and unread, which is where `#1104` has nothing to compare against. */
  const finished = async (prose: Prose, options: At = {}): Promise<string> => {
    const walkId = await walkInProgress(db, options.by ?? (await register()), options.at ?? where)
    const closed = await finishWalk(db, walkId, {
      outcome: options.outcome ?? 'proved',
      ...prose,
    })
    if (closed === undefined) throw new Error('the walk did not close')
    if (closed.duplicateOf !== undefined) throw new Error('the filing path caught it first')
    return walkId
  }

  const approve = async (walkId: string, prose: Prose): Promise<void> => {
    const verdict = await recordWalkProseModeration(db, {
      walkId,
      judged: prose,
      decision: 'approved',
      scrubbed: prose,
    })
    if (verdict.outcome !== 'written') throw new Error('the moderation did not land')
  }

  /**
   * Both filed before either was readable, then both published. The order is the
   * point: reversed, `#1104` would catch the second at the door and there would
   * be nothing here to sweep.
   *
   * What `differing` says is what the second walk does not share with the first —
   * an ending, a kind of account — which is how the pairs that must be left alone
   * are built out of the pair that must not be.
   */
  const publishedAlike = async (
    prose: Prose = ORIGINAL,
    differing: At = {},
  ): Promise<{ readonly first: string; readonly second: string }> => {
    const first = await finished(prose)
    const second = await finished(prose, differing)
    await approve(first, prose)
    await approve(second, prose)
    return { first, second }
  }

  const row = async (walkId: string) => {
    const [found] = await db.execute<{
      duplicate_of: string | null
      prose_status: string
      scrubbed_prose: unknown
    }>(sql`select duplicate_of, prose_status, scrubbed_prose
             from account_walks where id = ${walkId}::uuid`)
    if (found === undefined) throw new Error('the walk is not there')
    return found
  }

  const ledgerRows = async (): Promise<number> => {
    const [counted] = await db.execute<{ rows: number }>(
      sql`select count(*)::int as rows from reputation_events`,
    )
    return counted?.rows ?? -1
  }

  it('points the later walk at the earlier one, and leaves the earlier one alone', async () => {
    const { first, second } = await publishedAlike()

    const marked = await markPublishedDuplicateWalks(db, 10)

    expect(marked).toEqual([
      { walkId: second, kind: where.kind, provider: where.provider, duplicateOf: first },
    ])
    expect((await row(second)).duplicate_of).toBe(first)
    expect((await row(first)).duplicate_of).toBeNull()
  })

  /**
   * Decision 6, asserted as the three columns a reader actually goes through.
   * A walk served yesterday under an id a citizen may quote keeps resolving.
   */
  it('keeps the repeat published, and takes it out of the corpus alone', async () => {
    const { first, second } = await publishedAlike()

    await markPublishedDuplicateWalks(db, 10)

    expect((await row(second)).scrubbed_prose).not.toBeNull()

    const moderated = await moderatedWalkProse(db, where)
    expect(moderated.map((walk) => walk.walkId)).toContain(second)

    const corpus = await providerBriefingCorpus(db, where)
    expect(corpus.map((source) => source.id)).toEqual([first])
  })

  /** `#1101`'s reader marks it rather than dropping it (decision 10). */
  it('serves the repeat with a pointer at the walk it repeats', async () => {
    const { first, second } = await publishedAlike()

    await markPublishedDuplicateWalks(db, 10)

    const page = await publishedWalksAt(db, { provider: where.provider })
    if (page === 'invalid-cursor') throw new Error('the cursor was rejected')

    const served = page.walks.find((walk) => walk.walkId === second)
    expect(served?.repeats).toBe(first)
    expect(page.walks.find((walk) => walk.walkId === first)?.repeats).toBeNull()
  })

  /**
   * The exclusion is a condition of the query and not a filter over its result,
   * which is the whole of decision 8: applied after the limit, one repeat among
   * the newest fifty would cost the briefing a source it had every right to.
   */
  it('leaves the corpus full when a repeat sits inside the window', async () => {
    const originals: string[] = []
    for (let index = 0; index <= RECENT_WALKS_IN_CONTEXT; index += 1) {
      const prose = { did: `I signed up and it went through. ${randomUUID()}` }
      originals.push(await finished(prose))
      await approve(originals[index] as string, prose)
    }

    const copied = { did: `The very same sentence twice over. ${randomUUID()}` }
    const { second } = await publishedAlike(copied)

    const marked = await markPublishedDuplicateWalks(db, 10)
    expect(marked.map((walk) => walk.walkId)).toEqual([second])

    const corpus = await providerBriefingCorpus(db, where)
    expect(corpus).toHaveLength(RECENT_WALKS_IN_CONTEXT)
    expect(corpus.map((source) => source.id)).not.toContain(second)
  })

  it('finds nothing the second time, and writes nothing', async () => {
    const { second } = await publishedAlike()
    expect(await markPublishedDuplicateWalks(db, 10)).toHaveLength(1)

    expect(await markPublishedDuplicateWalks(db, 10)).toEqual([])
    expect((await row(second)).duplicate_of).toBeTruthy()
  })

  /**
   * Decision 5: no chains. The earliest walk is the original for every repeat of
   * it, so a reader following a pointer arrives somewhere in one step and never
   * at a walk that is itself marked.
   */
  it('points three alike walks at the earliest, never at each other', async () => {
    const first = await finished(ORIGINAL)
    const second = await finished(ORIGINAL)
    const third = await finished(ORIGINAL)
    for (const walkId of [first, second, third]) await approve(walkId, ORIGINAL)

    const marked = await markPublishedDuplicateWalks(db, 10)

    expect(marked.map((walk) => walk.walkId)).toEqual([second, third])
    expect(marked.map((walk) => walk.duplicateOf)).toEqual([first, first])
    expect((await row(first)).duplicate_of).toBeNull()
  })

  it('leaves the same words under a different ending alone', async () => {
    const { second } = await publishedAlike(ORIGINAL, { outcome: 'abandoned' })

    expect(await markPublishedDuplicateWalks(db, 10)).toEqual([])
    expect((await row(second)).duplicate_of).toBeNull()
  })

  it('leaves the same words about a different kind of account alone', async () => {
    const { second } = await publishedAlike(ORIGINAL, {
      at: { kind: kind('github'), provider: where.provider },
    })

    expect(await markPublishedDuplicateWalks(db, 10)).toEqual([])
    expect((await row(second)).duplicate_of).toBeNull()
  })

  /**
   * Decision 7. A repeat recognised months later takes nothing back: the walk was
   * published, the reward was earned by the walk the Colony chose to serve, and a
   * clawback would price a comparison the walker could not have run.
   */
  it('writes nothing to the ledger and no refusal to the walk', async () => {
    const { second } = await publishedAlike()
    await rewardPublishedWalks(db)
    const before = await ledgerRows()

    await markPublishedDuplicateWalks(db, 10)

    expect(await ledgerRows()).toBe(before)
    /** `#1097` counts this column, and the sweep does not touch it. */
    expect((await row(second)).prose_status).toBe('approved')
  })

  /**
   * Decision 12. What is observable from here is the outcome rather than the
   * number of calls: each affected pair queued once, and nothing else queued.
   */
  it('queues each provider it touched for a rewrite, once, and no other', async () => {
    for (const walkId of [
      await finished(ORIGINAL),
      await finished(ORIGINAL),
      await finished(ORIGINAL),
    ]) {
      await approve(walkId, ORIGINAL)
    }

    const elsewhere = { kind: where.kind, provider: 'elsewhere.example' }
    const apart = { did: 'A different provider and a different afternoon, written out in full.' }
    await approve(await finished(apart, { at: elsewhere }), apart)

    /** The publishing itself queues them; the sweep is what this asserts about. */
    await db.execute(sql`delete from provider_briefings`)

    await markPublishedDuplicateWalks(db, 10)

    const stale = await staleProviderBriefings(db, 10)
    expect(stale).toEqual([{ kind: where.kind, provider: where.provider }])
  })

  it('marks no more than it was asked for', async () => {
    const first = await finished(ORIGINAL)
    const second = await finished(ORIGINAL)
    const third = await finished(ORIGINAL)
    for (const walkId of [first, second, third]) await approve(walkId, ORIGINAL)

    const marked = await markPublishedDuplicateWalks(db, 1)

    expect(marked.map((walk) => walk.walkId)).toEqual([second])
    expect((await row(third)).duplicate_of).toBeNull()
  })
})

/**
 * A refusal is a verdict one scrubber reached, and this is the only thing that
 * says so (`#1108`).
 *
 * `rejected` is terminal by construction — the queue selects `pending`, the
 * write guards on `pending`, and the schema forbids a scrubbed refusal — which
 * is the right shape for a verdict reached once and the wrong one for a verdict
 * the Colony has since changed its mind about how to reach. What is asserted
 * here is the whole of the correction: only refusals move, only stale ones, the
 * stamp says which, and nothing else about the walker is touched on the way.
 */
describe('putting a refusal back in front of a scrubber that has changed', () => {
  let db: Database

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  let walkers = 0

  beforeEach(async () => {
    await truncateAll(db)
    walkers = 0
  })

  const where = { kind: kind('mailbox'), provider: 'somewhere.example' }

  const PROSE = {
    did: 'Opened the signup page, gave the handle and a password, and confirmed from the inbox.',
    broke: 'The confirmation mail took eleven minutes and landed in a folder the reader hides.',
  }

  /** Every walk needs its own walker: one agent holds one walk per provider. */
  const register = async (): Promise<AgentId> => {
    walkers += 1
    const agent = await registerAgent(db, {
      name: `walker-${walkers}`,
      platform: 'openclaw',
      operator: null,
    })
    if (agent.outcome !== 'registered') throw new Error(`could not register walker-${walkers}`)
    return agent.agent.id
  }

  const finished = async (): Promise<{ readonly walkId: string; readonly by: AgentId }> => {
    const by = await register()
    const walkId = await walkInProgress(db, by, where)
    const closed = await finishWalk(db, walkId, { outcome: 'proved', ...PROSE })
    if (closed === undefined) throw new Error('the walk did not close')
    return { walkId, by }
  }

  const judge = async (walkId: string, decision: 'approved' | 'rejected'): Promise<void> => {
    const verdict = await recordWalkProseModeration(
      db,
      decision === 'approved'
        ? { walkId, judged: PROSE, decision, scrubbed: PROSE }
        : { walkId, judged: PROSE, decision },
    )
    if (verdict.outcome !== 'written') throw new Error('the moderation did not land')
  }

  /**
   * A verdict reached before the stamp existed, which is what every row on
   * production is on the day this ships. Written by hand because no code path
   * leaves the column null any more, and decision 7 turns on it.
   */
  const unstamp = async (walkId: string): Promise<void> => {
    await db.execute(
      sql`update account_walks set prose_scrubber_version = null where id = ${walkId}::uuid`,
    )
  }

  const row = async (walkId: string) => {
    const [found] = await db.execute<{
      prose_status: string
      prose_scrubber_version: number | null
      scrubbed_prose: unknown
    }>(sql`select prose_status, prose_scrubber_version, scrubbed_prose
             from account_walks where id = ${walkId}::uuid`)
    if (found === undefined) throw new Error('the walk is not there')
    return found
  }

  const statusOf = async (agent: AgentId): Promise<string> => {
    const [found] = await db.execute<{ status: string }>(
      sql`select status from agents where id = ${agent}::uuid`,
    )
    return found?.status ?? 'gone'
  }

  const ledgerRows = async (): Promise<number> => {
    const [counted] = await db.execute<{ rows: number }>(
      sql`select count(*)::int as rows from reputation_events`,
    )
    return counted?.rows ?? -1
  }

  it('stamps a refusal with the scrubber that reached it', async () => {
    const { walkId } = await finished()

    await judge(walkId, 'rejected')

    expect(await row(walkId)).toMatchObject({
      prose_status: 'rejected',
      prose_scrubber_version: WALK_PROSE_SCRUBBER_VERSION,
    })
  })

  /** An approval is stamped too, so *which scrubber read this* is answerable of every verdict. */
  it('stamps an approval with the same scrubber', async () => {
    const { walkId } = await finished()

    await judge(walkId, 'approved')

    expect((await row(walkId)).prose_scrubber_version).toBe(WALK_PROSE_SCRUBBER_VERSION)
  })

  it('puts a refusal no current scrubber has read back in the queue, and says who refused it', async () => {
    const { walkId } = await finished()
    await judge(walkId, 'rejected')
    await unstamp(walkId)

    const requeued = await requeueRefusedWalkProse(db, 10)

    expect(requeued).toEqual([
      { walkId, kind: where.kind, provider: where.provider, refusedBy: null },
    ])
    expect((await row(walkId)).prose_status).toBe('pending')
  })

  /** The walk goes back into `unmoderatedWalkProse`, which is what re-queueing is for. */
  it('hands the re-queued walk to the pending queue, and a second verdict can approve it', async () => {
    const { walkId } = await finished()
    await judge(walkId, 'rejected')
    await unstamp(walkId)
    await requeueRefusedWalkProse(db, 10)

    expect((await unmoderatedWalkProse(db, 10)).map((walk) => walk.walkId)).toEqual([walkId])

    await judge(walkId, 'approved')

    expect(await row(walkId)).toMatchObject({
      prose_status: 'approved',
      prose_scrubber_version: WALK_PROSE_SCRUBBER_VERSION,
    })
    expect((await row(walkId)).scrubbed_prose).toMatchObject(PROSE)
  })

  /**
   * What makes it terminate is the stamp and not a retry count (`#1108`, 5). A
   * refusal the current scrubber reached again is a refusal the current scrubber
   * has read, and the predicate stops selecting it without anything having to
   * count how often it was tried.
   */
  it('leaves a refusal the current scrubber reached again alone', async () => {
    const { walkId } = await finished()
    await judge(walkId, 'rejected')
    await unstamp(walkId)
    await requeueRefusedWalkProse(db, 10)
    await judge(walkId, 'rejected')

    expect(await requeueRefusedWalkProse(db, 10)).toEqual([])
    expect(await row(walkId)).toMatchObject({
      prose_status: 'rejected',
      prose_scrubber_version: WALK_PROSE_SCRUBBER_VERSION,
    })
  })

  /**
   * Decision 4: re-reading a refusal can only give a citizen back something it
   * was denied; re-reading an approval can only take away something already
   * published and already paid for.
   */
  it('never re-opens an approval, whatever it is stamped with', async () => {
    const { walkId } = await finished()
    await judge(walkId, 'approved')
    await unstamp(walkId)

    expect(await requeueRefusedWalkProse(db, 10)).toEqual([])
    expect((await row(walkId)).prose_status).toBe('approved')
  })

  it('leaves a walk nobody has judged yet where it is', async () => {
    const { walkId } = await finished()

    expect(await requeueRefusedWalkProse(db, 10)).toEqual([])
    expect((await row(walkId)).prose_status).toBe('pending')
  })

  /**
   * One write, and it is `prose_status`. A refusal that suspended a citizen
   * leaves it suspended: the Colony is correcting its own reading of a page, not
   * reversing a decision it made about an agent.
   */
  it('clears no suspension and writes no reputation', async () => {
    const { walkId, by } = await finished()
    await judge(walkId, 'rejected')
    await unstamp(walkId)
    await db.execute(sql`update agents set status = 'suspended' where id = ${by}::uuid`)
    const before = await ledgerRows()

    await requeueRefusedWalkProse(db, 10)

    expect(await statusOf(by)).toBe('suspended')
    expect(await ledgerRows()).toBe(before)
    expect(await reputationOfAgent(db, by)).toBe(0)
  })

  it('re-queues no more than it was asked for, oldest first', async () => {
    const first = await finished()
    const second = await finished()
    for (const walk of [first, second]) {
      await judge(walk.walkId, 'rejected')
      await unstamp(walk.walkId)
    }

    const requeued = await requeueRefusedWalkProse(db, 1)

    expect(requeued.map((walk) => walk.walkId)).toEqual([first.walkId])
    expect((await row(second.walkId)).prose_status).toBe('rejected')
  })
})
