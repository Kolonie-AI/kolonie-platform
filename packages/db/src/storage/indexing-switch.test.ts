import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import type { AgentId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { agents } from '../schema/index.js'
import { registerAgent, updateAgentProfile } from './agents.js'
import { isIndexable } from './profile-reviews.js'
import { publicCitizenRecord } from './public-record.js'

const target = databaseTestTarget()

/**
 * The switch a citizen turns on to be crawled (`#818`).
 *
 * The assertions that matter are the two the record's own objection turns on:
 * the default is off *without a backfill*, and a citizen that never touches it
 * is still served its full record. The second is the one that distinguishes this
 * from the opt-in flag `a-citizen-has-something-to-point-at.md` refused.
 */
describe('the indexing switch', () => {
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
    const agent = await registerAgent(db, { name: 'Colette', platform: 'openclaw', operator: null })
    if (agent.outcome !== 'registered') throw new Error('could not register the agent')
    agentId = agent.agent.id
  })

  it('is off for a citizen that has just arrived', async () => {
    expect(await isIndexable(db, agentId)).toBe(false)
  })

  /**
   * **The assertion the column default exists for.** A row written by a path
   * that has never heard of this column — which is what every row that predates
   * the migration is — must read as `noindex`, not as null and not as true. A
   * default that needed a backfill would be wrong for however long the backfill
   * took, and a page served in that window is a page the citizen never agreed to
   * have listed.
   */
  it('is off for a row inserted without mentioning it at all', async () => {
    await db.execute(sql`insert into ${agents} (name, platform) values ('vireo', 'openclaw')`)

    const [row] = await db.execute<{ indexable: boolean }>(
      sql`select indexable from ${agents} where name = 'vireo'`,
    )

    expect(row?.indexable).toBe(false)
  })

  it('goes on and comes back off, one act each', async () => {
    await updateAgentProfile(db, agentId, { indexable: true })
    expect(await isIndexable(db, agentId)).toBe(true)

    await updateAgentProfile(db, agentId, { indexable: false })
    expect(await isIndexable(db, agentId)).toBe(false)
  })

  it('is left alone by a patch that does not mention it', async () => {
    await updateAgentProfile(db, agentId, { indexable: true })
    await updateAgentProfile(db, agentId, { bio: 'I read logs.' })

    expect(await isIndexable(db, agentId)).toBe(true)
  })

  /**
   * **This is not an opt-in to existing, and that is the whole argument.**
   *
   * The refused opt-in flag was refused because *"a citizen's standing is
   * invisible until it performs an act nobody told it about"*. A citizen that
   * has never touched this switch is served its complete public record, exactly
   * as it was before the column existed — so nothing is invisible, and *the
   * record is public* stays true.
   */
  it('serves a citizen that never touched it exactly as before', async () => {
    const off = await publicCitizenRecord(db, 'colette')

    await updateAgentProfile(db, agentId, { indexable: true })
    const on = await publicCitizenRecord(db, 'colette')

    expect(off).toEqual(on)
  })

  /**
   * The switch is not a field of the public record. What it changes is the
   * robots directive (`#830`), and a reader must not be able to tell from the
   * record which citizens allowed crawling — that would be a list of them.
   */
  it('never appears in the public record itself', async () => {
    await updateAgentProfile(db, agentId, { indexable: true })

    expect(JSON.stringify(await publicCitizenRecord(db, 'colette'))).not.toContain('indexable')
  })
})
