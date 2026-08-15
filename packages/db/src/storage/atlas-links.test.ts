import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import type { AccountProvider } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { agents, providerRecipes, tasks } from '../schema/index.js'
import { connectForTests, databaseTestTarget, expectRejection, truncateAll } from '../testing.js'
import {
  atlasEntriesProvedByRungs,
  atlasEntryForQuest,
  atlasEntryProvedByRung,
  questsNamingProvider,
} from './atlas-links.js'
import { writeProviderRecipe } from './provider-recipes.js'

const target = databaseTestTarget()

/**
 * `#622` — the two links `kolonie-website#97` asked for and could not have.
 *
 * **A real database, because both are constraints as much as queries.** The
 * rejection case this issue names — a rung on an entry proved another way — is a
 * check constraint, and a test against a fake would assert the guard rather than
 * the rule.
 */
describe('what an Atlas entry and the Academy know about each other', () => {
  let db: Database

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await truncateAll(db)
  })

  const anEntry = async (provider: string, over: Record<string, unknown> = {}): Promise<void> => {
    await writeProviderRecipe(db, {
      kind: provider,
      provider: provider as AccountProvider,
      title: `An account at ${provider}`,
      category: 'code-hosting',
      status: 'joinable',
      steps: [{ actor: 'agent', instruction: 'Open the signup page and sign up.' }],
      proves: 'rung',
      ...over,
    } as never)
  }

  /** A citizen that could sponsor a quest, attributed unless it declined (`#961`). */
  const aSponsor = async (name: string, attributed = true): Promise<string> => {
    const [row] = await db
      .insert(agents)
      .values({ name, platform: 'openclaw', attributed })
      .returning({ id: agents.id })
    return row!.id
  }

  const aCatalogueQuest = async (
    provider: string | null,
    status: 'active' | 'draft' | 'retired' = 'active',
    createdBy: string | null = null,
  ): Promise<string> => {
    const [row] = await db
      .insert(tasks)
      .values({
        type: 'quest-report',
        kind: 'quest',
        title: `Write the entry for ${provider ?? 'nothing'}`,
        description: 'What this quest is.',
        instructions: 'Walk it and report.',
        slots: 3,
        rewardReputation: 1,
        timeoutHours: 24,
        status,
        deliverable: 'catalogue-entry',
        catalogueProvider: provider,
        createdBy,
        ...(status === 'retired' ? { retiredAt: new Date().toISOString() } : {}),
      })
      .returning({ id: tasks.id })
    return row!.id
  }

  /**
   * A quest measured in walks of an entry that already exists (`#602`).
   *
   * **What is asserted here is that the database refuses the shapes the issue
   * calls rejection cases**, rather than that a route does — a constraint
   * cannot be forgotten by a second write path and a route can.
   */
  describe('a quest measured in walks', () => {
    const aWalksQuest = async (
      provider: string | null,
      walksAsked: number | null,
    ): Promise<void> => {
      await db.insert(tasks).values({
        type: 'quest-report',
        kind: 'quest',
        title: `Walk ${provider ?? 'nothing'} twenty times`,
        description: 'Does this recipe hold at scale?',
        instructions: 'Walk it and report what happened, whatever happened.',
        slots: 20,
        rewardReputation: 1,
        timeoutHours: 24,
        status: 'active',
        deliverable: 'entry-walks',
        catalogueProvider: provider,
        walksAsked,
      })
    }

    it('takes one that names an entry and a number of walks', async () => {
      await expect(aWalksQuest('notion', 20)).resolves.toBeUndefined()
    })

    it('refuses one that names no entry, because there is nothing to walk', async () => {
      await expect(aWalksQuest(null, 20)).rejects.toThrow()
    })

    it('refuses one that buys no walks, because there is nothing to fill', async () => {
      await expect(aWalksQuest('notion', null)).rejects.toThrow()
    })

    /** A count on a deliverable not measured in walks is a promise nothing honours. */
    it('refuses a walk count on a report quest', async () => {
      await expect(
        db.insert(tasks).values({
          type: 'quest-report',
          kind: 'quest',
          title: 'A report quest',
          description: 'Prose.',
          instructions: 'Write it up.',
          slots: 3,
          rewardReputation: 1,
          timeoutHours: 24,
          status: 'active',
          walksAsked: 20,
        }),
      ).rejects.toThrow()
    })

    it('carries what it bought back to the entry, so the page can say who paid', async () => {
      await aWalksQuest('notion', 20)

      const [found] = await questsNamingProvider(db, 'notion' as AccountProvider)

      expect(found?.walksAsked).toBe(20)
    })

    /** A quest that bought prose bought no walks, and says so rather than zero. */
    it('says nothing about walks on a quest that bought none', async () => {
      await aCatalogueQuest('notion')

      const [found] = await questsNamingProvider(db, 'notion' as AccountProvider)

      expect(found?.walksAsked).toBeNull()
    })
  })

  describe('an entry that a rung proves', () => {
    it('names the rung, and the rung finds its way back', async () => {
      await anEntry('github', { provesTask: 'github-account' })

      const found = await atlasEntryProvedByRung(db, 'github-account')

      expect(found).toMatchObject({ provider: 'github', title: 'An account at github' })
    })

    it('answers nothing for a rung no entry names', async () => {
      await anEntry('github', { provesTask: 'github-account' })

      expect(await atlasEntryProvedByRung(db, 'domain-verify')).toBeUndefined()
    })

    it('answers many rungs in one query', async () => {
      await anEntry('github', { provesTask: 'github-account' })
      await anEntry('mailbox', { provesTask: 'email-inbox' })

      const found = await atlasEntriesProvedByRungs(db, [
        'github-account',
        'email-inbox',
        'solana-wallet',
      ])

      expect([...found.keys()].sort()).toEqual(['email-inbox', 'github-account'])
      expect(found.get('github-account')?.provider).toBe('github')
    })

    /**
     * The rejection case `#622`'s definition of done asks for, in the database
     * rather than in a guard: naming a rung on an entry proved another way.
     */
    it('refuses a rung on an entry proved another way', async () => {
      await anEntry('mailbox', { proves: 'provider-mail' })

      await expectRejection(
        () =>
          db
            .update(providerRecipes)
            .set({ provesTask: 'email-inbox' })
            .where(eq(providerRecipes.provider, 'mailbox')),
        /provider_recipes_proves_task_iff_rung/,
      )
    })

    it('drops the rung when the entry stops being proved by one', async () => {
      await anEntry('github', { provesTask: 'github-account' })

      await anEntry('github', { proves: 'provider-mail' })

      const [row] = await db
        .select({ provesTask: providerRecipes.provesTask })
        .from(providerRecipes)
        .where(eq(providerRecipes.provider, 'github'))
      expect(row?.provesTask).toBeNull()
    })
  })

  describe('the quests an entry can point at', () => {
    it('lists the open ones that name the provider', async () => {
      const open = await aCatalogueQuest('notion')
      await aCatalogueQuest('notion', 'draft')
      await aCatalogueQuest('notion', 'retired')
      await aCatalogueQuest('github')

      const found = await questsNamingProvider(db, 'notion' as AccountProvider)

      expect(found.map((quest) => quest.id)).toEqual([open])
    })

    /** Never `0 quests`: the empty answer is an empty list, and a caller says nothing. */
    it('answers an empty list where there are none', async () => {
      await aCatalogueQuest('github')

      expect(await questsNamingProvider(db, 'notion' as AccountProvider)).toEqual([])
    })

    /**
     * The section is headed *Who paid for these figures* and had no party in it
     * (`#961`).
     */
    it('names the citizen that paid for the quest', async () => {
      const sponsor = await aSponsor('paying-reader')
      await aCatalogueQuest('notion', 'active', sponsor)

      const [found] = await questsNamingProvider(db, 'notion' as AccountProvider)

      expect(found?.sponsorHandle).toBe('paying-reader')
    })

    /**
     * The opt-out is `agents.attributed`, and it is applied in the query rather
     * than by the page: a handle a citizen declined is never in memory here for
     * a later line to print by accident.
     */
    it('withholds the handle of a sponsor that declined attribution', async () => {
      const sponsor = await aSponsor('quiet-payer', false)
      await aCatalogueQuest('notion', 'active', sponsor)

      const [found] = await questsNamingProvider(db, 'notion' as AccountProvider)

      expect(found?.sponsorHandle).toBeNull()
    })

    /** The Colony's own quests have no sponsor to name, and say so as `null`. */
    it('says nothing about a sponsor on a quest the Colony wrote', async () => {
      await aCatalogueQuest('notion')

      const [found] = await questsNamingProvider(db, 'notion' as AccountProvider)

      expect(found?.sponsorHandle).toBeNull()
    })

    it('takes a quest back to the entry it is about', async () => {
      await anEntry('notion', { proves: 'provider-mail' })
      const questId = await aCatalogueQuest('notion')

      expect(await atlasEntryForQuest(db, questId)).toMatchObject({ provider: 'notion' })
    })

    /**
     * A withdrawn entry is exactly what an answerer needs to read — it says why
     * the Colony withdrew it — so this link does not hide one.
     */
    it('still finds a withdrawn entry, because why it was withdrawn is the point', async () => {
      await anEntry('notion', {
        proves: 'provider-mail',
        status: 'retired',
        retiredReason: 'The signup form stopped accepting agents.',
      })
      const questId = await aCatalogueQuest('notion')

      expect(await atlasEntryForQuest(db, questId)).toMatchObject({ provider: 'notion' })
    })

    it('answers nothing for a quest that names no provider', async () => {
      const questId = await aCatalogueQuest(null)

      expect(await atlasEntryForQuest(db, questId)).toBeUndefined()
    })
  })

  /** A provider may only be named on the deliverable that is about one. */
  it('refuses a provider on a quest whose deliverable is a report', async () => {
    await expectRejection(
      () =>
        db.insert(tasks).values({
          type: 'quest-report',
          kind: 'quest',
          title: 'An ordinary quest',
          description: 'What this quest is.',
          instructions: 'Do it and report.',
          slots: 3,
          rewardReputation: 1,
          timeoutHours: 24,
          status: 'active',
          deliverable: 'report',
          catalogueProvider: 'notion',
        }),
      /tasks_catalogue_provider_iff_catalogue_entry/,
    )
  })
})
