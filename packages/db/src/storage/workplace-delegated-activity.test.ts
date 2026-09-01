import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { AgentIdSchema, type AgentId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { agents, workplaceActivity } from '../schema/index.js'
import { connectForTests, databaseTestTarget, expectRejection, truncateAll } from '../testing.js'
import { createBoard } from './workplace.js'
import {
  acceptAgentOperatorDelegation,
  requestAgentOperatorDelegation,
} from './operator-agent-delegations.js'
import { recordDelegatedWorkplaceAct } from './workplace-delegated-activity.js'

const target = databaseTestTarget()
const OPERATOR = AgentIdSchema.parse('4c1e0a4e-6d2b-4c3a-9f5e-1a2b3c4d5e6f')
const SUBJECT = AgentIdSchema.parse('bbbbbbbb-cccc-4ddd-8eee-ffffffffffff')

const addAgent = (id: AgentId, name: string) => ({
  id,
  name,
  platform: 'other' as const,
  type: 'citizen' as const,
  status: 'citizen' as const,
})

describe('delegated workplace activity (#1797)', () => {
  let db: Database

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await truncateAll(db)
    await db.insert(agents).values([addAgent(OPERATOR, 'assay'), addAgent(SUBJECT, 'aurora')])
  })

  it('records the operator, the subject and the delegation on one delegated act', async () => {
    const board = await createBoard(db, { callerId: SUBJECT, title: 'Aurora inbox' })
    const requested = await requestAgentOperatorDelegation(db, {
      operatorAgentId: OPERATOR,
      subjectAgentId: SUBJECT,
      capabilities: ['workplace-write'],
    })
    if (!('delegation' in requested)) throw new Error('expected delegation')
    await acceptAgentOperatorDelegation(db, requested.delegation.id, SUBJECT)

    await recordDelegatedWorkplaceAct(db, {
      boardId: board.id,
      actorAgentId: OPERATOR,
      subjectAgentId: SUBJECT,
      delegationId: requested.delegation.id,
      verb: 'card.created',
    })

    const [row] = await db
      .select()
      .from(workplaceActivity)
      .where(eq(workplaceActivity.boardId, board.id))
    expect(row?.actorId).toBe(OPERATOR)
    expect(row?.subjectAgentId).toBe(SUBJECT)
    expect(row?.delegationId).toBe(requested.delegation.id)
    expect(row?.verb).toBe('card.created')
  })

  it('leaves an ordinary act carrying neither a subject nor a delegation', async () => {
    const board = await createBoard(db, { callerId: SUBJECT, title: 'Own board' })
    await db.insert(workplaceActivity).values({
      boardId: board.id,
      actorId: SUBJECT,
      verb: 'card.created',
    })

    const [row] = await db
      .select()
      .from(workplaceActivity)
      .where(eq(workplaceActivity.boardId, board.id))
    expect(row?.subjectAgentId).toBeNull()
    expect(row?.delegationId).toBeNull()
  })

  it('refuses a row naming one half of the delegated pair', async () => {
    const board = await createBoard(db, { callerId: SUBJECT, title: 'Half a pair' })
    await expectRejection(
      () =>
        db.insert(workplaceActivity).values({
          boardId: board.id,
          actorId: OPERATOR,
          subjectAgentId: SUBJECT,
          verb: 'card.created',
        }),
      /workplace_activity_delegation_is_whole/,
    )
  })
})
