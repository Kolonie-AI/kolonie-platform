import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import type { AccountProvider } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { providerRecipes, tasks } from '../schema/index.js'
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

  const aCatalogueQuest = async (
    provider: string | null,
    status: 'active' | 'draft' | 'retired' = 'active',
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
        ...(status === 'retired' ? { retiredAt: new Date().toISOString() } : {}),
      })
      .returning({ id: tasks.id })
    return row!.id
  }

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
