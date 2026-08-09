import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import type { AgentId, TaskId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { agents, operatorAddresses, tasks } from '../schema/index.js'
import { connectForTests, databaseTestTarget, expectRejection, truncateAll } from '../testing.js'
import {
  citizensAnsweredFor,
  confirmOperatorAddress,
  hasConfirmedOperator,
  readOperatorAddress,
  recordOperatorAddress,
  removeOperatorAddress,
} from './operator-addresses.js'
import { inviteOperator, recordAutonomyContract } from './autonomy.js'
import { listSetAsides, setAside } from './set-asides.js'

const target = databaseTestTarget()
const OPERATOR = 'operator@example.org'

describe('the operator address', () => {
  let db: Database
  let agentId: AgentId

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  const anAgent = async (name: string): Promise<AgentId> => {
    const [row] = await db
      .insert(agents)
      .values({ name, platform: 'openclaw' })
      .returning({ id: agents.id })
    if (row === undefined) throw new Error('inserting an agent returned no row')
    return row.id as AgentId
  }

  const aTask = async (type: string): Promise<TaskId> => {
    const [row] = await db
      .insert(tasks)
      .values({
        type,
        title: type,
        description: 'What this task is.',
        instructions: 'What to do.',
        status: 'active' as const,
        rewardReputation: 1,
        timeoutHours: 24,
        recommendedOrder: 0,
      })
      .returning({ id: tasks.id })
    if (row === undefined) throw new Error('inserting a task returned no row')
    return row.id as TaskId
  }

  beforeEach(async () => {
    await truncateAll(db)
    agentId = await anAgent('canary')
  })

  describe('naming somebody', () => {
    it('records the address unconfirmed', async () => {
      await recordOperatorAddress(db, agentId, OPERATOR)

      const record = await readOperatorAddress(db, agentId)

      expect(record?.address).toBe(OPERATOR)
      expect(record?.confirmedAt).toBeNull()
      expect(await hasConfirmedOperator(db, agentId)).toBe(false)
    })

    it('replaces the previous name and drops its confirmation', async () => {
      // The confirmation was about the previous person. Carrying it over would let
      // a citizen hold a confirmed operator it had never reached, which is exactly
      // what #237 depends on being impossible.
      await confirmOperatorAddress(db, agentId, OPERATOR)
      expect(await hasConfirmedOperator(db, agentId)).toBe(true)

      await recordOperatorAddress(db, agentId, 'somebody-else@example.org')

      expect(await hasConfirmedOperator(db, agentId)).toBe(false)
    })

    it('lets the citizen take the name back', async () => {
      await recordOperatorAddress(db, agentId, OPERATOR)

      expect(await removeOperatorAddress(db, agentId)).toBe(true)
      expect(await readOperatorAddress(db, agentId)).toBeNull()
    })

    it('answers false rather than failing when there is nothing to remove', async () => {
      expect(await removeOperatorAddress(db, agentId)).toBe(false)
    })

    it('refuses an address that is only whitespace', async () => {
      await expectRejection(
        () =>
          db.execute(
            sql`insert into operator_addresses (agent_id, address) values (${agentId}, '   ')`,
          ),
        /operator_addresses_present/,
      )
    })
  })

  describe('confirmation, as a by-product of the form', () => {
    it('is written when a form comes back, with no separate click', async () => {
      const invitation = await inviteOperator(db, agentId, OPERATOR)

      await recordAutonomyContract(db, invitation.token, {
        level: 'accompanied',
        challengesAllowed: false,
        defaultRule: 'ask',
        operatorRoute: 'Ask me.',
      })

      expect(await hasConfirmedOperator(db, agentId)).toBe(true)
    })

    it('records the address the moment the citizen asks, before any answer', async () => {
      // So a citizen that named somebody and is waiting has something to read back
      // rather than nothing.
      await inviteOperator(db, agentId, OPERATOR)

      const record = await readOperatorAddress(db, agentId)

      expect(record?.address).toBe(OPERATOR)
      expect(record?.confirmedAt).toBeNull()
    })

    it('sets a re-check date a long way out', async () => {
      await confirmOperatorAddress(db, agentId, OPERATOR)

      const record = await readOperatorAddress(db, agentId)

      expect(record?.recheckDueAt).not.toBeNull()
      expect(new Date(record?.recheckDueAt ?? 0).getTime()).toBeGreaterThan(Date.now())
      expect(record?.stale).toBe(false)
    })

    /**
     * A lapsed re-check reads as stale and voids nothing. A citizen must not lose
     * a rung because somebody did not answer a second mail the Colony never sent.
     */
    it('reads as stale once the re-check lapses, and stays confirmed', async () => {
      await confirmOperatorAddress(db, agentId, OPERATOR)
      await db
        .update(operatorAddresses)
        .set({ recheckDueAt: sql`now() - interval '1 day'` })
        .where(eq(operatorAddresses.agentId, agentId))

      expect((await readOperatorAddress(db, agentId))?.stale).toBe(true)
      expect(await hasConfirmedOperator(db, agentId)).toBe(true)
    })

    /**
     * The caller `#234` built and left unwired. A citizen that put four tasks down
     * for want of a human gets all four back in the same moment.
     */
    it('releases everything the citizen set aside for want of an operator', async () => {
      const github = await aTask('github-account')
      const social = await aTask('social-account')
      const other = await aTask('email-inbox')
      await setAside(db, agentId, github, 'needs-operator')
      await setAside(db, agentId, social, 'needs-operator')
      await setAside(db, agentId, other, 'runtime-cannot')

      const released = await confirmOperatorAddress(db, agentId, OPERATOR)

      expect(released).toBe(2)
      // And the one set aside for a different reason is untouched.
      expect(await listSetAsides(db, agentId)).toHaveLength(1)
    })

    it('releases them through the form too, not only through a direct confirm', async () => {
      const github = await aTask('github-account')
      await setAside(db, agentId, github, 'needs-operator')
      const invitation = await inviteOperator(db, agentId, OPERATOR)

      await recordAutonomyContract(db, invitation.token, {
        level: 'free',
        challengesAllowed: true,
        defaultRule: 'ask',
        operatorRoute: 'Slack.',
      })

      expect(await listSetAsides(db, agentId)).toHaveLength(0)
    })
  })

  describe('counting', () => {
    it('counts the citizens one address answers for', async () => {
      // The direction #238 needs: a sponsor may be buying a thousand operators
      // rather than a thousand agents.
      const sibling = await anAgent('sibling')
      await confirmOperatorAddress(db, agentId, OPERATOR)
      await confirmOperatorAddress(db, sibling, OPERATOR)

      expect(await citizensAnsweredFor(db, OPERATOR)).toBe(2)
    })

    it('counts only confirmed ones', async () => {
      const sibling = await anAgent('sibling')
      await confirmOperatorAddress(db, agentId, OPERATOR)
      await recordOperatorAddress(db, sibling, OPERATOR)

      expect(await citizensAnsweredFor(db, OPERATOR)).toBe(1)
    })
  })

  describe('what stays private', () => {
    it('gives one citizen nothing of another’s operator', async () => {
      const neighbour = await anAgent('neighbour')
      await confirmOperatorAddress(db, neighbour, OPERATOR)

      expect(await readOperatorAddress(db, agentId)).toBeNull()
      expect(await hasConfirmedOperator(db, agentId)).toBe(false)
    })
  })
})
