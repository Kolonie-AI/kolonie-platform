import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { AccountKindSchema } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { providerRenamedTo, renameProvider } from './atlas-renames.js'
import { providerRecipe, providerRecipeList, writeProviderRecipe } from './provider-recipes.js'

const target = databaseTestTarget()

const kind = (value: string) => AccountKindSchema.parse(value)

const entry = async (db: Database, provider: string, kindName = 'social') =>
  writeProviderRecipe(db, {
    kind: kind(kindName),
    provider,
    title: provider,
    status: 'joinable',
    steps: [{ actor: 'agent', instruction: 'sign up' }],
    proves: 'provider-post',
  })

/**
 * Renaming a provider, and remembering where it used to be (`#546`).
 *
 * The Atlas is a surface strangers link to, so the interesting property is not
 * that the rows move — it is that the old path keeps answering afterwards.
 */
describe('renaming a provider', () => {
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

  it('moves every row the provider had', async () => {
    await entry(db, 'twitter', 'social')
    await entry(db, 'twitter', 'website')

    const { moved } = await renameProvider(db, 'twitter', 'x')

    expect(moved).toBe(2)
    expect(await providerRecipe(db, kind('social'), 'twitter')).toBeUndefined()
    expect(await providerRecipe(db, kind('social'), 'x')).toBeDefined()
  })

  it('leaves the old name pointing at the new one', async () => {
    await entry(db, 'twitter')
    await renameProvider(db, 'twitter', 'x')

    expect(await providerRenamedTo(db, 'twitter')).toBe('x')
  })

  /**
   * **A redirect that redirects costs a crawler a second round trip per page**,
   * and a third rename would cost a third. Every earlier hop is repointed at the
   * current name instead, so a chain is never followed at read time.
   */
  it('repoints an older name at the current one, not at the middle hop', async () => {
    await entry(db, 'twitter')
    await renameProvider(db, 'twitter', 'x')
    await renameProvider(db, 'x', 'xcom')

    expect(await providerRenamedTo(db, 'twitter')).toBe('xcom')
    expect(await providerRenamedTo(db, 'x')).toBe('xcom')
  })

  it('says nothing about a provider that was never renamed', async () => {
    expect(await providerRenamedTo(db, 'github')).toBeUndefined()
  })

  /**
   * A rename that moved the rows and lost the redirect is unrecoverable —
   * nothing afterwards knows what the old name was — so both happen together or
   * neither does.
   */
  it('refuses a rename to something that is not a provider, and moves nothing', async () => {
    await entry(db, 'twitter')

    await expect(renameProvider(db, 'twitter', 'not a provider')).rejects.toThrow()

    expect(await providerRecipe(db, kind('social'), 'twitter')).toBeDefined()
    expect(await providerRenamedTo(db, 'twitter')).toBeUndefined()
  })

  it('is a no-op when the name does not change', async () => {
    await entry(db, 'github')

    expect(await renameProvider(db, 'github', 'github')).toEqual({ moved: 0 })
    expect(await providerRenamedTo(db, 'github')).toBeUndefined()
    expect(await providerRecipeList(db)).toHaveLength(1)
  })
})
