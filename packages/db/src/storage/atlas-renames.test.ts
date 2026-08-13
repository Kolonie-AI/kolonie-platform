import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { AccountKindSchema } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { accountWalks } from '../schema/account-walks.js'
import { accounts as agentAccounts } from '../schema/accounts.js'
import { agents } from '../schema/agents.js'
import { providerBriefings } from '../schema/provider-briefings.js'
import { providerReports } from '../schema/provider-reports.js'
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
 * The rows a rename has to move besides the recipes (`#845`). Written straight
 * to the tables rather than through their own write paths: what is under test is
 * the update, and each of those paths would drag in a verifier, a moderation
 * verdict or a walk runner that has nothing to do with it.
 */
const anAgent = async (db: Database, name: string): Promise<string> => {
  const [row] = await db.insert(agents).values({ name, platform: 'openclaw' }).returning({
    id: agents.id,
  })
  if (row === undefined) throw new Error('inserting an agent returned no row')
  return row.id
}

const aWalk = async (db: Database, agentId: string, provider: string, kindName: string) => {
  await db.insert(accountWalks).values({ agentId, provider, kind: kindName })
}

const anAccount = async (db: Database, agentId: string, provider: string, kindName: string) => {
  await db
    .insert(agentAccounts)
    .values({ agentId, provider, kind: kindName, identifier: `${agentId}@${provider}` })
}

const aReport = async (db: Database, agentId: string, provider: string, kindName: string) => {
  await db
    .insert(providerReports)
    .values({ agentId, provider, kind: kindName, outcome: 'signup-refused' })
}

/** A briefing that has been written, so that losing it is visible. */
const aBriefing = async (db: Database, provider: string, kindName: string, text: string) => {
  await db.insert(providerBriefings).values({
    kind: kindName,
    provider,
    claims: [
      {
        section: 'wall',
        text,
        walks: 1,
        platforms: { openclaw: 1 },
        lastSupportedAt: '2026-08-01T00:00:00.000Z',
        sources: ['11111111-1111-4111-8111-111111111111'],
      },
    ],
    model: 'a-model',
    writtenAt: '2026-08-01T00:00:00.000Z',
    dirty: false,
  })
}

/** Every provider name a table currently holds, deduplicated. */
const providersOn = async (
  db: Database,
  table: typeof accountWalks | typeof agentAccounts | typeof providerReports,
): Promise<readonly string[]> => {
  const rows = await db.select({ provider: table.provider }).from(table)
  return [...new Set(rows.map((row) => row.provider).filter((one): one is string => one !== null))]
}

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

    expect(await renameProvider(db, 'github', 'github')).toEqual({
      moved: 0,
      walks: 0,
      accounts: 0,
      reports: 0,
      briefings: 0,
    })
    expect(await providerRenamedTo(db, 'github')).toBeUndefined()
    expect(await providerRecipeList(db)).toHaveLength(1)
  })

  /**
   * **Every provider-keyed table, not only the recipes** (`#845`).
   *
   * This moved `provider_recipes` and nothing else, and the rows left behind
   * were not merely mislabelled: every read and every write resolves forward
   * through `canonicalProvider`, so **nothing reached them again.** Walks filed
   * under the old name became unreachable and the Atlas would answer *nobody has
   * walked this* about a provider it had walked; `agent_accounts` and
   * `provider_reports` split into two rows, so a provider audience paying to see
   * its own numbers under `#548` got the part written since the rename with
   * nothing in the answer saying so.
   *
   * No rename has run in production, so what these hold is a correctness fix
   * ahead of the first one rather than a repair.
   */
  describe('the rows that are not recipes', () => {
    it('moves walks, accounts and reports, and says how many of each', async () => {
      await entry(db, 'twitter', 'social')
      const agentId = await anAgent(db, 'walker')
      await aWalk(db, agentId, 'twitter', 'social')
      await anAccount(db, agentId, 'twitter', 'social')
      await aReport(db, agentId, 'twitter', 'social')

      const outcome = await renameProvider(db, 'twitter', 'x')

      expect(outcome).toMatchObject({ moved: 1, walks: 1, accounts: 1, reports: 1 })
      expect(await providersOn(db, accountWalks)).toEqual(['x'])
      expect(await providersOn(db, agentAccounts)).toEqual(['x'])
      expect(await providersOn(db, providerReports)).toEqual(['x'])
    })

    /** A rename touches one provider, and the neighbours keep their rows. */
    it('leaves another provider’s rows where they are', async () => {
      const agentId = await anAgent(db, 'walker')
      await aWalk(db, agentId, 'twitter', 'social')
      await aWalk(db, agentId, 'github', 'social')

      await renameProvider(db, 'twitter', 'x')

      expect([...(await providersOn(db, accountWalks))].sort()).toEqual(['github', 'x'])
    })

    /**
     * **A briefing is recomposed rather than moved.** It is keyed by
     * `(kind, provider)`, so one may already exist at the target — and picking
     * one of two by age would publish a write-up of half the evidence under a
     * name that now covers all of it. A briefing is derived, so it is dropped
     * and queued, and the next synthesis writes it from the merged walks.
     */
    it('empties a colliding briefing and queues it for recomposition', async () => {
      const agentId = await anAgent(db, 'walker')
      await aWalk(db, agentId, 'twitter', 'social')
      await aBriefing(db, 'twitter', 'social', 'what the old name knew')
      await aBriefing(db, 'x', 'social', 'what the new name knew')

      const outcome = await renameProvider(db, 'twitter', 'x')

      expect(outcome.briefings).toBe(2)
      const rows = await db
        .select()
        .from(providerBriefings)
        .where(eq(providerBriefings.kind, 'social'))
      // One row, at the new name, empty and queued — never a survivor of the two.
      expect(rows).toHaveLength(1)
      expect(rows[0]?.provider).toBe('x')
      expect(rows[0]?.claims).toEqual([])
      expect(rows[0]?.writtenAt).toBeNull()
      expect(rows[0]?.dirty).toBe(true)
    })

    /**
     * The target's briefing is stale once walks arrive under it, even where the
     * old name had none of that kind to collide with — which is why the kinds
     * are taken from the walks and not from the briefing rows.
     */
    it('queues the target’s briefing even with nothing to collide with', async () => {
      const agentId = await anAgent(db, 'walker')
      await aWalk(db, agentId, 'twitter', 'social')
      await aBriefing(db, 'x', 'social', 'written before the walks arrived')

      await renameProvider(db, 'twitter', 'x')

      const [row] = await db
        .select()
        .from(providerBriefings)
        .where(eq(providerBriefings.provider, 'x'))
      expect(row?.dirty).toBe(true)
      expect(row?.claims).toEqual([])
    })

    /**
     * A briefing is composed from what citizens walked, so a rename that moves
     * no walks changes nothing about what any write-up would say.
     */
    it('leaves briefings alone when no walk moved', async () => {
      await entry(db, 'twitter', 'social')
      await aBriefing(db, 'x', 'social', 'untouched')

      const outcome = await renameProvider(db, 'twitter', 'x')

      expect(outcome.briefings).toBe(0)
      const [row] = await db.select().from(providerBriefings)
      expect(row?.claims).not.toEqual([])
      expect(row?.dirty).toBe(false)
    })

    /**
     * **Half a rename is worse than none**, and nothing afterwards knows which
     * half. The new tables join the transaction the redirect was already in.
     */
    it('moves nothing at all when the rename is refused', async () => {
      const agentId = await anAgent(db, 'walker')
      await aWalk(db, agentId, 'twitter', 'social')

      await expect(renameProvider(db, 'twitter', 'not a provider')).rejects.toThrow()

      expect(await providersOn(db, accountWalks)).toEqual(['twitter'])
    })
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
