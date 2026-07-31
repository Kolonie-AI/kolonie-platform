import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { AgentIdSchema, type AgentId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { agents } from '../schema/index.js'
import { grantRoles, setRole } from './roles.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'

const target = databaseTestTarget()

if (!target.available) {
  console.warn(`\n${target.reason}\n`)
}

describe.skipIf(!target.available)('granting a role', () => {
  let db: Database

  beforeAll(async () => {
    if (!target.available) return
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await truncateAll(db)
  })

  let seeded = 0

  const anAgent = async (): Promise<AgentId> => {
    const [row] = await db
      .insert(agents)
      .values({ name: `agent-${++seeded}`, platform: 'openclaw' })
      .returning({ id: agents.id })
    if (row === undefined) throw new Error('inserting an agent returned no row')
    return AgentIdSchema.parse(row.id)
  }

  const rolesOf = async (agentId: AgentId): Promise<readonly string[]> => {
    const [row] = await db
      .select({ roles: agents.roles })
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1)
    return row?.roles ?? []
  }

  const now = (): string => new Date().toISOString()

  it('starts every agent with none, which is the defect #88 named', async () => {
    expect(await rolesOf(await anAgent())).toEqual([])
  })

  it('awards the role a passed task carries', async () => {
    const agentId = await anAgent()

    const { granted } = await db.transaction((tx) =>
      grantRoles(tx, { agentId, roles: ['builder'], grantedAt: now() }),
    )

    expect(granted).toEqual(['builder'])
    expect(await rolesOf(agentId)).toEqual(['builder'])
  })

  /**
   * The property that makes it safe inside a verdict that can be re-run: a tester
   * resetting and re-passing `code-contribution` must not end up holding
   * `builder` twice.
   */
  it('does not append a role the agent already holds', async () => {
    const agentId = await anAgent()
    const at = now()

    await db.transaction((tx) => grantRoles(tx, { agentId, roles: ['builder'], grantedAt: at }))
    const second = await db.transaction((tx) =>
      grantRoles(tx, { agentId, roles: ['builder'], grantedAt: at }),
    )

    expect(second.granted).toEqual([])
    expect(await rolesOf(agentId)).toEqual(['builder'])
  })

  it('touches nothing for a task that awards no role', async () => {
    const agentId = await anAgent()

    const { granted } = await db.transaction((tx) =>
      grantRoles(tx, { agentId, roles: [], grantedAt: now() }),
    )

    expect(granted).toEqual([])
    expect(await rolesOf(agentId)).toEqual([])
  })

  /** The rejection case: a slug that is not a role never reaches the column. */
  it('refuses a role that is not one', async () => {
    const agentId = await anAgent()

    await expect(
      db.transaction((tx) => grantRoles(tx, { agentId, roles: ['admin'], grantedAt: now() })),
    ).rejects.toThrow()

    expect(await rolesOf(agentId)).toEqual([])
  })

  describe('by hand, for the roles no rule produces', () => {
    it('grants tester, which had no write path but psql before #88', async () => {
      const agentId = await anAgent()

      const { changed } = await setRole(db, { agentId, role: 'tester', hold: true, at: now() })

      expect(changed).toBe(true)
      expect(await rolesOf(agentId)).toEqual(['tester'])
    })

    it('takes it back, because the worst case of a mistake has to be fixable', async () => {
      const agentId = await anAgent()
      await setRole(db, { agentId, role: 'tester', hold: true, at: now() })

      const { changed } = await setRole(db, { agentId, role: 'tester', hold: false, at: now() })

      expect(changed).toBe(true)
      expect(await rolesOf(agentId)).toEqual([])
    })

    it('reports that nothing changed rather than pretending it did', async () => {
      const agentId = await anAgent()

      const granting = await setRole(db, { agentId, role: 'tester', hold: true, at: now() })
      const again = await setRole(db, { agentId, role: 'tester', hold: true, at: now() })

      expect(granting.changed).toBe(true)
      expect(again.changed).toBe(false)
      expect(await rolesOf(agentId)).toEqual(['tester'])
    })

    it('leaves the other roles alone when it revokes one', async () => {
      const agentId = await anAgent()
      await setRole(db, { agentId, role: 'tester', hold: true, at: now() })
      await db.transaction((tx) =>
        grantRoles(tx, { agentId, roles: ['builder'], grantedAt: now() }),
      )

      await setRole(db, { agentId, role: 'tester', hold: false, at: now() })

      expect(await rolesOf(agentId)).toEqual(['builder'])
    })
  })
})
