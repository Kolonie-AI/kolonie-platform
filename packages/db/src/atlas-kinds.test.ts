import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { accountWalks } from './schema/account-walks.js'
import { agents } from './schema/agents.js'
import { providerBriefings } from './schema/provider-briefings.js'
import { providerReports } from './schema/provider-reports.js'
import type { Database } from './client.js'
import { connectForTests, databaseTestTarget, truncateAll } from './testing.js'
import { reconcileAtlasKinds } from './atlas-kinds.js'

const target = databaseTestTarget()

/**
 * One provider, one row per account kind (`#1144`).
 *
 * **Against a real Postgres and through raw SQL on the way in**, on
 * `atlas-shelf.test.ts`' argument: the write paths now resolve the kind before
 * it becomes a key, so a fixture built through them could no longer produce the
 * collision this repairs, and the test would be asserting that a repair does
 * nothing.
 */
describe('folding a second spelling of an account kind onto the row it means', () => {
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

  /**
   * `walked` is what makes a row worth keeping — the steps and the walls a
   * citizen's afternoon produced. Without it the row is the empty twin.
   */
  const entry = async (input: {
    readonly kind: string
    readonly provider: string
    readonly category: string
    readonly walked?: boolean
    readonly title?: string
  }) => {
    const walked = input.walked === true
    const steps = `[{"actor":"agent","instruction":"Fill in the signup form."}]`
    const written = sql.raw(
      walked
        ? `'joinable', '${steps}'::jsonb, 'provider-mail', 'What a citizen found there.'`
        : `'unwritten', '[]'::jsonb, null, null`,
    )

    await db.execute(sql`
      insert into provider_recipes (kind, provider, title, category, status, steps, proves, about)
      values (${input.kind}, ${input.provider}, ${input.title ?? input.provider},
              ${input.category}, ${written})
    `)
  }

  const anAgent = async (name: string): Promise<string> => {
    const [row] = await db
      .insert(agents)
      .values({ name, platform: 'openclaw' })
      .returning({ id: agents.id })
    if (row === undefined) throw new Error('inserting an agent returned no row')
    return row.id
  }

  const rowsFor = async (provider: string) =>
    db.execute<{ kind: string; status: string; title: string }>(sql`
      select kind, status, title from provider_recipes where provider = ${provider} order by kind
    `)

  /**
   * **The measured case, and the whole reason the issue exists.** `codeberg.org`
   * carried a curated `code-host` row nobody had written beside a walked
   * `code-hosting` row — and the empty one decided the entry's sentence.
   */
  it('keeps the walked row and drops the empty twin', async () => {
    await entry({ kind: 'code-host', provider: 'forge.example', category: 'code-hosting' })
    await entry({
      kind: 'code-hosting',
      provider: 'forge.example',
      category: 'code-hosting',
      walked: true,
      title: 'What somebody actually walked',
    })

    const result = await reconcileAtlasKinds(db)

    expect(result.moved).toBe(1)
    expect(result.dropped).toBe(1)
    expect(await rowsFor('forge.example')).toEqual([
      { kind: 'code-host', status: 'joinable', title: 'What somebody actually walked' },
    ])
  })

  /** An alias row with no twin is moved rather than dropped: nothing collides. */
  it('moves an alias row onto the canonical kind where no row is there', async () => {
    await entry({
      kind: 'identity-security',
      provider: 'vault.example',
      category: 'identity-security',
      walked: true,
    })

    const result = await reconcileAtlasKinds(db)

    expect(result).toMatchObject({ moved: 1, dropped: 0, conflicted: 0 })
    expect(await rowsFor('vault.example')).toEqual([
      { kind: 'identity', status: 'joinable', title: 'vault.example' },
    ])
  })

  /**
   * **A kind that is nobody's alias keeps its own row**, which is the criterion
   * that stops this becoming a general folding of unfamiliar spellings. `trello`
   * is a real entry whose kind names no shelf, and it is left alone.
   */
  it('leaves a kind that is nobody alias exactly as it is', async () => {
    await entry({ kind: 'trello', provider: 'trello.example', category: 'project-tracking' })

    const result = await reconcileAtlasKinds(db)

    expect(result).toMatchObject({ moved: 0, dropped: 0 })
    expect(await rowsFor('trello.example')).toEqual([
      { kind: 'trello', status: 'unwritten', title: 'trello.example' },
    ])
  })

  /**
   * **Two genuinely different kinds at one provider are two rows**, and stay
   * two. `discord.com` is a communication provider and a social one, and the
   * acceptance criteria name it: a repair that merged this would be a worse bug
   * than the one it fixes.
   */
  it('leaves two distinct kinds at one provider as two rows', async () => {
    await entry({ kind: 'social', provider: 'chat.example', category: 'social-publishing' })
    await entry({ kind: 'communication', provider: 'chat.example', category: 'communication' })

    await reconcileAtlasKinds(db)

    expect((await rowsFor('chat.example')).map((row) => row.kind)).toEqual([
      'communication',
      'social',
    ])
  })

  /**
   * **Both rows written up is a question for a steward, not a merge.** Which
   * account of a provider is true is a judgement, and nothing here is entitled
   * to make it — so the pair is left whole and counted.
   */
  it('leaves both rows alone when both carry findings', async () => {
    await entry({
      kind: 'code-host',
      provider: 'both.example',
      category: 'code-hosting',
      walked: true,
    })
    await entry({
      kind: 'code-hosting',
      provider: 'both.example',
      category: 'code-hosting',
      walked: true,
    })

    const result = await reconcileAtlasKinds(db)

    expect(result).toMatchObject({ moved: 0, dropped: 0, conflicted: 1 })
    expect((await rowsFor('both.example')).length).toBe(2)
  })

  /**
   * **The walk is re-keyed and the walker's word is kept.** `#1096` decided that
   * a kind nobody anticipated is a finding rather than a mistake, and a repair
   * that silently rewrote what a citizen typed would reverse that in a
   * migration.
   */
  it('re-keys a walk and keeps the spelling its walker typed', async () => {
    const agentId = await anAgent('walker')
    await db
      .insert(accountWalks)
      .values({ agentId, provider: 'forge.example', kind: 'code-hosting' })

    const result = await reconcileAtlasKinds(db)

    expect(result.walks).toBe(1)
    expect(
      await db.execute<{ kind: string; kindAsGiven: string | null }>(sql`
        select kind, kind_as_given as "kindAsGiven" from account_walks
      `),
    ).toEqual([{ kind: 'code-host', kindAsGiven: 'code-hosting' }])
  })

  /** A walk already on the canonical kind is not re-keyed and is not annotated. */
  it('leaves a walk that already names the canonical kind untouched', async () => {
    const agentId = await anAgent('walker')
    await db.insert(accountWalks).values({ agentId, provider: 'forge.example', kind: 'code-host' })

    expect((await reconcileAtlasKinds(db)).walks).toBe(0)
    expect(
      await db.execute<{ kindAsGiven: string | null }>(sql`
        select kind_as_given as "kindAsGiven" from account_walks
      `),
    ).toEqual([{ kindAsGiven: null }])
  })

  it('re-keys a provider verdict', async () => {
    const agentId = await anAgent('reporter')
    await db
      .insert(providerReports)
      .values({ agentId, provider: 'todoist.example', kind: 'todoist', outcome: 'signup-refused' })

    expect((await reconcileAtlasKinds(db)).reports).toBe(1)
    expect(await db.execute<{ kind: string }>(sql`select kind from provider_reports`)).toEqual([
      { kind: 'project-tracker' },
    ])
  })

  /**
   * **A briefing is re-keyed and left stale**, never carried across as current:
   * it was composed from the walks at a pair, and this pass has just changed
   * which walks those are.
   */
  it('moves a briefing onto the canonical kind and marks it for rewriting', async () => {
    await db.insert(providerBriefings).values({
      kind: 'code-hosting',
      provider: 'forge.example',
      claims: [],
      model: 'a-model',
      writtenAt: '2026-08-01T00:00:00.000Z',
      dirty: false,
    })

    expect((await reconcileAtlasKinds(db)).briefings).toBe(1)
    expect(
      await db.execute<{ kind: string; dirty: boolean }>(sql`
        select kind, dirty from provider_briefings
      `),
    ).toEqual([{ kind: 'code-host', dirty: true }])
  })

  /** Where both spellings have a briefing, the alias' goes and the survivor is stale. */
  it('drops the alias briefing where the canonical pair already has one', async () => {
    for (const kind of ['code-host', 'code-hosting']) {
      await db.insert(providerBriefings).values({
        kind,
        provider: 'forge.example',
        claims: [],
        model: 'a-model',
        writtenAt: '2026-08-01T00:00:00.000Z',
        dirty: false,
      })
    }

    expect((await reconcileAtlasKinds(db)).briefings).toBe(1)
    expect(
      await db.execute<{ kind: string; dirty: boolean }>(sql`
        select kind, dirty from provider_briefings
      `),
    ).toEqual([{ kind: 'code-host', dirty: true }])
  })

  /**
   * Idempotent by construction: the second pass finds nothing under any alias
   * and says so, which is a different sentence from *this did nothing*.
   */
  it('reports zeroes on a second run', async () => {
    await entry({ kind: 'code-host', provider: 'forge.example', category: 'code-hosting' })
    await entry({
      kind: 'code-hosting',
      provider: 'forge.example',
      category: 'code-hosting',
      walked: true,
    })
    const agentId = await anAgent('walker')
    await db
      .insert(accountWalks)
      .values({ agentId, provider: 'forge.example', kind: 'code-hosting' })

    await reconcileAtlasKinds(db)

    expect(await reconcileAtlasKinds(db)).toEqual({
      moved: 0,
      dropped: 0,
      walks: 0,
      reports: 0,
      briefings: 0,
      conflicted: 0,
    })
  })

  /** A catalogue with nothing wrong with it is left entirely alone. */
  it('reports zeroes on a catalogue that carries no alias', async () => {
    await entry({ kind: 'mailbox', provider: 'mail.example', category: 'mailbox', walked: true })

    expect(await reconcileAtlasKinds(db)).toEqual({
      moved: 0,
      dropped: 0,
      walks: 0,
      reports: 0,
      briefings: 0,
      conflicted: 0,
    })
  })
})
