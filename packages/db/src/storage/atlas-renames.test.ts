import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { AccountKindSchema } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import {
  aliasProvider,
  canonicalProvider,
  providerRenamedTo,
  renameProvider,
} from './atlas-renames.js'
import { providerRecipe, providerRecipeList, writeProviderRecipe } from './provider-recipes.js'

const target = databaseTestTarget()

const kind = (value: string) => AccountKindSchema.parse(value)

const entry = async (db: Database, provider: string, kindName = 'social') =>
  writeProviderRecipe(db, {
    kind: kind(kindName),
    provider,
    title: provider,
    status: 'joinable',
    category: 'code-hosting',
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

/**
 * Two live names for one provider (`#772`).
 *
 * A citizen queried `clawhub.ai` and `clawhub.com` and was told twice that
 * nothing was known, because the two are one service and the catalogue is keyed
 * by whichever spelling reached it first. What is interesting here is not that
 * the lookup answers — it is that nothing moves, and that an alias which would
 * hide an entry is refused rather than recorded.
 */
describe('aliasing a provider', () => {
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

  it('resolves the alias to the entry, and moves nothing', async () => {
    await entry(db, 'clawhub.ai')

    const recorded = await aliasProvider(db, 'clawhub.com', 'clawhub.ai')

    expect(recorded).toEqual({
      outcome: 'recorded',
      alias: 'clawhub.com',
      provider: 'clawhub.ai',
    })
    expect(await canonicalProvider(db, 'clawhub.com')).toBe('clawhub.ai')
    expect(await providerRecipe(db, kind('social'), 'clawhub.ai')).toBeDefined()
    expect(await providerRecipeList(db)).toHaveLength(1)
  })

  /**
   * **The one failure worse than the fragmentation it fixes.** An alias over a
   * name that carries its own entry would make those rows unreachable through
   * every read that resolves — the entry would sit in the table and nothing
   * would ever return it. Merging two walked entries is a curation decision with
   * a person's judgement in it, so it is refused here rather than guessed at.
   */
  it('refuses an alias that would hide an entry of its own', async () => {
    await entry(db, 'clawhub.com')
    await entry(db, 'clawhub.ai')

    expect(await aliasProvider(db, 'clawhub.com', 'clawhub.ai')).toEqual({
      outcome: 'shadows-an-entry',
      kinds: ['social'],
    })
    expect(await canonicalProvider(db, 'clawhub.com')).toBe('clawhub.com')
  })

  it('refuses to make a name mean itself', async () => {
    expect(await aliasProvider(db, 'clawhub.ai', 'clawhub.ai')).toEqual({
      outcome: 'points-at-itself',
    })
  })

  /** One hop, always — the reason `renameProvider` repoints earlier hops. */
  it('flattens an alias of an alias', async () => {
    await entry(db, 'clawhub.ai')
    await aliasProvider(db, 'clawhub.com', 'clawhub.ai')
    await aliasProvider(db, 'clawhub.io', 'clawhub.com')

    expect(await canonicalProvider(db, 'clawhub.io')).toBe('clawhub.ai')
    expect(await canonicalProvider(db, 'clawhub.com')).toBe('clawhub.ai')
  })

  /**
   * **A name nobody has aliased means itself**, and that is the whole reason
   * this answers a string rather than `string | undefined`: a caller that has to
   * decide what an empty answer means is one that will forget once, and the
   * forgotten call is a write.
   */
  it('answers with the name it was given when nothing is recorded', async () => {
    expect(await canonicalProvider(db, 'github.com')).toBe('github.com')
    expect(await canonicalProvider(db, 'GitHub.com')).toBe('github.com')
  })

  /** A rename and an alias resolve identically, which is why they are one table. */
  it('resolves a renamed name through the same lookup', async () => {
    await entry(db, 'twitter')
    await renameProvider(db, 'twitter', 'x')

    expect(await canonicalProvider(db, 'twitter')).toBe('x')
  })
})
