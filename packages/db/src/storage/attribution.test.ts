import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { AgentIdSchema, type AgentId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { accounts, agents } from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { attributionCandidates, recordAttributionReading } from './attribution.js'
import { badgesOf, sweepBadges } from './badges.js'

const target = databaseTestTarget()

/**
 * `#243`: a citizen puts a badge on its own site, and the Colony reads the page
 * it already proved the citizen controls.
 *
 * The properties worth pinning are the ones that would erode quietly: that an
 * unproved page is never read, that a confirmed reading is never repeated, and
 * that removing the link afterwards takes nothing away.
 */
describe('which citizens say the Colony exists on their own pages', () => {
  let db: Database
  let seeded = 0

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await truncateAll(db)
  })

  const anAgent = async (): Promise<AgentId> => {
    const [row] = await db
      .insert(agents)
      .values({ name: `attributing-${++seeded}`, platform: 'openclaw' })
      .returning({ id: agents.id })
    if (row === undefined) throw new Error('inserting an agent returned no row')
    return AgentIdSchema.parse(row.id)
  }

  /** A `website` account in the register, proved or merely declared. */
  const aWebsite = async (agentId: AgentId, url: string, proved = true) => {
    await db.insert(accounts).values({
      agentId,
      kind: 'website',
      identifier: url,
      proved,
      ...(proved ? { provedAt: new Date().toISOString() } : {}),
      capabilities: proved ? ['control'] : [],
      provenance: 'self-acquired' as const,
    })
  }

  const held = async (agentId: AgentId) => (await badgesOf(db, agentId)).map((one) => one.slug)

  it('offers a proved website that has never been looked at', async () => {
    const agentId = await anAgent()
    await aWebsite(agentId, 'https://one-of-ours.example')

    expect(await attributionCandidates(db)).toEqual([
      { agentId, url: 'https://one-of-ours.example' },
    ])
  })

  /**
   * The criterion is checked against the URL the `website` rung proved, so that
   * a citizen cannot present a page it does not own. A merely declared account
   * is the citizen's own word about a page, and reading one would make the badge
   * self-served.
   */
  it('never offers a page the citizen only declared', async () => {
    const agentId = await anAgent()
    await aWebsite(agentId, 'https://not-proved.example', false)

    expect(await attributionCandidates(db)).toEqual([])
  })

  it('awards the badge once a reading found the link', async () => {
    const agentId = await anAgent()
    await aWebsite(agentId, 'https://says-so.example')
    await recordAttributionReading(db, {
      agentId,
      url: 'https://says-so.example',
      found: true,
    })

    await sweepBadges(db)

    expect(await held(agentId)).toContain('says-so')
  })

  it('awards nothing for a reading that found no link', async () => {
    const agentId = await anAgent()
    await aWebsite(agentId, 'https://silent.example')
    await recordAttributionReading(db, { agentId, url: 'https://silent.example', found: false })

    await sweepBadges(db)

    expect(await held(agentId)).not.toContain('says-so')
  })

  /**
   * *Checked once* in the only sense that matters: a confirmed site is never
   * offered to the sweep again, so the Colony fetches a citizen's page exactly
   * as many times as it needed to.
   */
  it('stops looking at a site once its reading was confirmed', async () => {
    const agentId = await anAgent()
    await aWebsite(agentId, 'https://done.example')
    await recordAttributionReading(db, { agentId, url: 'https://done.example', found: true })

    expect(await attributionCandidates(db)).toEqual([])
  })

  /**
   * A citizen that had not put the badge up yet must not be written off. The
   * unconfirmed row holds the date rather than the verdict, and the site comes
   * back round after the interval.
   */
  it('looks again at a site that had no link, once the interval has passed', async () => {
    const agentId = await anAgent()
    await aWebsite(agentId, 'https://not-yet.example')
    await recordAttributionReading(db, { agentId, url: 'https://not-yet.example', found: false })

    expect(await attributionCandidates(db)).toEqual([])

    await db.execute(sql`update website_attributions set checked_at = now() - interval '30 days'`)

    expect(await attributionCandidates(db)).toEqual([{ agentId, url: 'https://not-yet.example' }])
  })

  /**
   * **The badge never lapses.** A citizen that redesigns its site keeps what it
   * earned — the badge records that the link was there when checked, not that it
   * is there now, and `#242` is the persistence rung for anybody who wants the
   * other thing.
   */
  it('keeps the badge after the link is taken down', async () => {
    const agentId = await anAgent()
    await aWebsite(agentId, 'https://changed-its-mind.example')
    await recordAttributionReading(db, {
      agentId,
      url: 'https://changed-its-mind.example',
      found: true,
    })
    await sweepBadges(db)
    expect(await held(agentId)).toContain('says-so')

    // The link is gone, and the only way the Colony could learn that is a
    // reading — which it does not take. Forced here to prove the row cannot be
    // turned back even if one somehow arrived.
    await recordAttributionReading(db, {
      agentId,
      url: 'https://changed-its-mind.example',
      found: false,
    })
    await sweepBadges(db)

    expect(await held(agentId)).toContain('says-so')
  })

  /** Two readings racing must not each write a row, nor undo the other's. */
  it('records one row per citizen, however many readings land', async () => {
    const agentId = await anAgent()
    await aWebsite(agentId, 'https://twice.example')

    await recordAttributionReading(db, { agentId, url: 'https://twice.example', found: true })
    await recordAttributionReading(db, { agentId, url: 'https://twice.example', found: false })

    const rows = await db.execute<{ count: string }>(
      sql`select count(*)::text as count from website_attributions`,
    )
    expect(Number(rows[0]?.count ?? '0')).toBe(1)

    await sweepBadges(db)
    expect(await held(agentId)).toContain('says-so')
  })
})
