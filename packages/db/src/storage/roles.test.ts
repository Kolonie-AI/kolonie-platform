import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { AgentIdSchema, type AgentId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { agents, tasks } from '../schema/index.js'
import { authorityEventsFor, changeRoleAsSteward, grantRoles, setRole } from './roles.js'
import { connectForTests, databaseTestTarget, expectRejection, truncateAll } from '../testing.js'

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

describe.skipIf(!target.available)('a steward changing a role', () => {
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

  const anAgent = async (name: string, roles: readonly string[] = []): Promise<AgentId> => {
    const [row] = await db
      .insert(agents)
      .values({ name, platform: 'openclaw', roles: roles as never })
      .returning({ id: agents.id })
    return AgentIdSchema.parse(row!.id)
  }

  const now = () => new Date().toISOString() as never

  it('grants the role and records who did it', async () => {
    const steward = await anAgent('root-steward', ['steward'])
    const subject = await anAgent('newcomer')

    const outcome = await changeRoleAsSteward(db, {
      actorId: steward,
      subjectId: subject,
      role: 'steward',
      hold: true,
      at: now(),
    })

    expect(outcome).toEqual({ outcome: 'changed' })

    const events = await authorityEventsFor(db, subject)
    expect(events).toHaveLength(1)
    expect(events[0]?.actorId).toBe(steward)
    expect(events[0]?.action).toBe('role-granted')
    expect(events[0]?.role).toBe('steward')
  })

  it('revokes it and records that too', async () => {
    const steward = await anAgent('root-steward', ['steward'])
    const subject = await anAgent('deposed', ['steward'])

    await changeRoleAsSteward(db, {
      actorId: steward,
      subjectId: subject,
      role: 'steward',
      hold: false,
      at: now(),
    })

    const [row] = await db
      .select({ roles: agents.roles })
      .from(agents)
      .where(eq(agents.id, subject))
    expect(row?.roles).toEqual([])

    const events = await authorityEventsFor(db, subject)
    expect(events[0]?.action).toBe('role-revoked')
  })

  /**
   * An audit of who granted what should not fill with rows where nothing was
   * granted. A record that logs non-events is a record nobody reads.
   */
  it('writes nothing at all when the subject already held the role', async () => {
    const steward = await anAgent('root-steward', ['steward'])
    const subject = await anAgent('already', ['steward'])

    const outcome = await changeRoleAsSteward(db, {
      actorId: steward,
      subjectId: subject,
      role: 'steward',
      hold: true,
      at: now(),
    })

    expect(outcome).toEqual({ outcome: 'unchanged' })
    expect(await authorityEventsFor(db, subject)).toHaveLength(0)
  })

  it('answers `unknown-agent` rather than writing a record about nobody', async () => {
    const steward = await anAgent('root-steward', ['steward'])

    const outcome = await changeRoleAsSteward(db, {
      actorId: steward,
      subjectId: AgentIdSchema.parse('00000000-0000-4000-8000-000000000000'),
      role: 'steward',
      hold: true,
      at: now(),
    })

    expect(outcome).toEqual({ outcome: 'unknown-agent' })
    expect(await authorityEventsFor(db, steward)).toHaveLength(0)
  })

  /**
   * `tasks_only_colony_grants_roles` is exercised rather than trusted (`#173`).
   * The constraint names the roles a task may award at all, and `steward` is not
   * one of them — so no verdict, no matter who wrote the task, can produce one.
   */
  it('cannot be produced by a task, not even one the Colony authored', async () => {
    await expectRejection(
      () =>
        db.insert(tasks).values({
          slug: 'a-task-that-would-mint-a-steward',
          title: 'no',
          description: 'no',
          instructions: 'no',
          type: 'api-call',
          rewardCoins: 0,
          rewardReputation: 0,
          timeoutHours: 24,
          recommendedOrder: 1,
          grantsRoles: ['steward'],
        } as never),
      /tasks_only_colony_grants_roles/,
    )
  })
})
