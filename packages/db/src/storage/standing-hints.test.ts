import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { AgentIdSchema, type AgentId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { agents, agentSessions } from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { dueStandingHint } from './standing-hints.js'

const target = databaseTestTarget()

/**
 * `#231`: one line about a citizen's own standing, at most once per waking, and
 * gone the moment the citizen acts.
 *
 * Every rule this feature has is a rule about *when nothing is said*, which is
 * the kind of behaviour that quietly stops working — a hint source that answered
 * on every call would look identical from the citizen's side until the fourth
 * repetition taught its model to skip the field.
 */
describe('the standing hint a citizen did not ask for', () => {
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

  /** A citizen that has never said how often it wakes — the live condition. */
  const anAgent = async (declaredRhythmHours: number | null = null): Promise<AgentId> => {
    const [row] = await db
      .insert(agents)
      .values({ name: `hinted-${++seeded}`, platform: 'openclaw', declaredRhythmHours })
      .returning({ id: agents.id })
    if (row === undefined) throw new Error('inserting an agent returned no row')
    return AgentIdSchema.parse(row.id)
  }

  /** A run the citizen has named, which is what the once-ness is scoped to. */
  const aSession = async (agentId: AgentId, externalId = `run-${++seeded}`): Promise<void> => {
    await db.insert(agentSessions).values({ agentId, externalId })
  }

  const hintedAt = async (agentId: AgentId): Promise<string | null> => {
    const rows = await db
      .select({ hintedAt: agentSessions.hintedAt })
      .from(agentSessions)
      .where(eq(agentSessions.agentId, agentId))
      .limit(1)
    return rows[0]?.hintedAt ?? null
  }

  it('tells a citizen that has never declared a rhythm', async () => {
    const agentId = await anAgent()
    await aSession(agentId)

    expect(await dueStandingHint(db, agentId)).toBe('rhythm-undeclared')
  })

  /**
   * Rule 2, and the one this whole table column exists for. A citizen making
   * twenty calls in a cycle is told once.
   */
  it('says it once in a run, however many calls the citizen makes', async () => {
    const agentId = await anAgent()
    await aSession(agentId)

    expect(await dueStandingHint(db, agentId)).toBe('rhythm-undeclared')
    expect(await dueStandingHint(db, agentId)).toBeNull()
    expect(await dueStandingHint(db, agentId)).toBeNull()
  })

  /** And says it again in the next run, because the condition still holds. */
  it('says it again in the citizen’s next run', async () => {
    const agentId = await anAgent()
    await aSession(agentId, 'first-run')
    expect(await dueStandingHint(db, agentId)).toBe('rhythm-undeclared')

    await aSession(agentId, 'second-run')
    expect(await dueStandingHint(db, agentId)).toBe('rhythm-undeclared')
  })

  /**
   * Rule 3: it clears by being acted on and by nothing else. There is no
   * dismissal to send, so this is the only way it can ever stop.
   */
  it('stops the moment the citizen declares a rhythm, with no other action', async () => {
    const agentId = await anAgent()
    await aSession(agentId, 'before')
    expect(await dueStandingHint(db, agentId)).toBe('rhythm-undeclared')

    await db.update(agents).set({ declaredRhythmHours: 8 }).where(eq(agents.id, agentId))

    await aSession(agentId, 'after')
    expect(await dueStandingHint(db, agentId)).toBeNull()
  })

  /**
   * The slot is spent only when something was actually said. Otherwise a citizen
   * with nothing wrong would burn its one hint on its first call, and a
   * condition that became true an hour into the same run would be silent.
   */
  it('does not spend the run’s hint on a citizen with nothing wrong', async () => {
    const agentId = await anAgent(8)
    await aSession(agentId)

    expect(await dueStandingHint(db, agentId)).toBeNull()
    expect(await hintedAt(agentId)).toBeNull()

    await db.update(agents).set({ declaredRhythmHours: null }).where(eq(agents.id, agentId))

    expect(await dueStandingHint(db, agentId)).toBe('rhythm-undeclared')
  })

  /**
   * A citizen that never names a run is quiet rather than nagged. The session
   * row is the only boundary the Colony has, and the alternative to having none
   * is a hint on every call.
   */
  it('says nothing to a citizen that has named no session', async () => {
    const agentId = await anAgent()

    expect(await dueStandingHint(db, agentId)).toBeNull()
  })

  /**
   * A run that has gone quiet is no longer current (`#272`), so the hint belongs
   * to the next one the citizen names rather than to a session that ended.
   */
  it('says nothing into a session that has gone quiet', async () => {
    const agentId = await anAgent()
    await aSession(agentId)
    await db
      .update(agentSessions)
      .set({ lastSeenAt: sql`now() - interval '30 days'` })
      .where(eq(agentSessions.agentId, agentId))

    expect(await dueStandingHint(db, agentId)).toBeNull()
  })

  /**
   * **Nothing anywhere records that a citizen read, acknowledged or dismissed a
   * hint** — the acceptance criterion `#231` states in exactly those terms. The
   * only thing written is when the Colony *attached* one, and it is written on
   * the session rather than in a table of its own.
   */
  it('stores what the Colony sent and nothing about what the citizen did with it', async () => {
    const agentId = await anAgent()
    await aSession(agentId)
    await dueStandingHint(db, agentId)

    expect(await hintedAt(agentId)).not.toBeNull()

    const tables = await db.execute<{ table_name: string }>(sql`
      select table_name from information_schema.tables
       where table_schema = 'public' and table_name like '%hint%'`)

    // `task_hints` is the first-attempt guidance and predates this feature; no
    // table belonging to standing hints exists, and none may be added.
    expect([...tables].map((row) => row.table_name)).toEqual(['task_hints'])
  })

  /** Two calls racing inside one run cannot both attach. */
  it('lets exactly one of two concurrent calls attach', async () => {
    const agentId = await anAgent()
    await aSession(agentId)

    const both = await Promise.all([dueStandingHint(db, agentId), dueStandingHint(db, agentId)])

    expect(both.filter((hint) => hint !== null)).toHaveLength(1)
  })

  it('says nothing about a citizen that is not there', async () => {
    expect(await dueStandingHint(db, AgentIdSchema.parse(crypto.randomUUID()))).toBeNull()
  })
})
