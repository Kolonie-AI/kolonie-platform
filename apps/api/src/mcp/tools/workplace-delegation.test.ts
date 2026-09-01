import { randomUUID } from 'node:crypto'
import {
  AgentOperatorDelegationIdSchema,
  WorkplaceBoardIdSchema,
  type AgentId,
  type WorkplaceBoard,
  type WorkplaceMembership,
} from '@kolonie-ai/core'
import { describe, expect, it } from 'vitest'
import { FAKE_CALLER_IP } from '../../__fixtures__/colony/index.js'
import { connectedClient, registeredCitizen } from '../../__fixtures__/mcp.js'

/**
 * Delegated Workplace access through the existing tool (`#1797`).
 *
 * `delegationId` is the one new optional argument: no `actingAgentId`, no
 * `subjectAgentId`, and no second Workplace tool. Omitting it must leave the
 * existing behaviour untouched.
 */
const workplace = (args: Record<string, unknown>) => ({
  name: 'kolonie.workplace',
  arguments: args,
})

const errorOf = (result: unknown) =>
  (result as { structuredContent: { error: { code: string; message: string } } }).structuredContent
    .error

const aBoard = (ownerId: AgentId): WorkplaceBoard => {
  const now = new Date().toISOString()
  return {
    id: WorkplaceBoardIdSchema.parse(randomUUID()),
    ownerId,
    title: 'Aurora inbox',
    kind: 'additional',
    archivedAt: null,
    version: 1,
    createdAt: now,
    updatedAt: now,
  }
}

const seat = (board: WorkplaceBoard, citizenId: AgentId): WorkplaceMembership => ({
  boardId: board.id,
  citizenId,
  role: 'owner',
})

/** Operator, subject, the subject's board, and both keyed MCP clients. */
const aPilot = async (capabilities: readonly string[]) => {
  const { colony, apiKey, agent: operator } = await registeredCitizen({ name: 'assay' })
  const registered = await colony.registry.register(
    { name: 'aurora', platform: 'openclaw' },
    { ip: FAKE_CALLER_IP },
  )
  if (registered.outcome !== 'registered') throw new Error('fixture failed to register')
  const subject = registered.response.agent

  colony.agentOperatorDelegations.citizen(operator.profile.name, operator.id)
  colony.agentOperatorDelegations.citizen(subject.profile.name, subject.id)
  const requested = await colony.agentOperatorDelegations.request({
    operatorAgentId: operator.id,
    subjectHandle: subject.profile.name,
    capabilities: capabilities as never,
  })
  if (!('delegation' in requested)) throw new Error('fixture failed to request delegation')
  const delegationId = requested.delegation.id

  const board = aBoard(subject.id)
  const membership = [seat(board, subject.id)]
  colony.boards.plant(board, membership)
  colony.cards.plantBoard(board.id, membership)

  const operatorClient = await connectedClient(colony, `Bearer ${apiKey}`)

  return {
    colony,
    operator,
    subject,
    board,
    delegationId,
    client: operatorClient.client,
    accept: () => colony.agentOperatorDelegations.accept(delegationId, subject.id),
    revoke: () => colony.agentOperatorDelegations.revoke(delegationId, subject.id),
    close: operatorClient.close,
  }
}

describe('delegated kolonie.workplace (#1797)', () => {
  it('lets an accepted operator read the subject board it could not see alone', async () => {
    const pilot = await aPilot(['workplace-read'])
    try {
      const alone = await pilot.client.callTool(
        workplace({ act: 'get', subject: 'board', id: pilot.board.id }),
      )
      expect(alone.isError).toBe(true)

      await pilot.accept()
      const delegated = await pilot.client.callTool(
        workplace({
          act: 'get',
          subject: 'board',
          id: pilot.board.id,
          delegationId: pilot.delegationId,
        }),
      )
      expect(delegated.isError).toBeFalsy()
      const structured = delegated.structuredContent as {
        board: { id: string; ownerId: string }
        delegation: { actorAgentId: string; subjectAgentId: string; delegationId: string }
      }
      expect(structured.board.ownerId).toBe(pilot.subject.id)
      expect(structured.delegation).toEqual({
        actorAgentId: pilot.operator.id,
        subjectAgentId: pilot.subject.id,
        delegationId: pilot.delegationId,
      })
    } finally {
      await pilot.close()
    }
  })

  it('refuses a write when only workplace-read was granted', async () => {
    const pilot = await aPilot(['workplace-read'])
    try {
      await pilot.accept()
      const refused = await pilot.client.callTool(
        workplace({
          act: 'create',
          subject: 'card',
          boardId: pilot.board.id,
          fields: { title: 'Delegated card' },
          delegationId: pilot.delegationId,
        }),
      )
      expect(refused.isError).toBe(true)
      expect(errorOf(refused).code).toBe('delegation_missing_capability')
    } finally {
      await pilot.close()
    }
  })

  it('permits a delegated write and records actor, subject and delegation', async () => {
    const pilot = await aPilot(['workplace-read', 'workplace-write'])
    try {
      await pilot.accept()
      const created = await pilot.client.callTool(
        workplace({
          act: 'create',
          subject: 'card',
          boardId: pilot.board.id,
          fields: { title: 'Delegated card' },
          delegationId: pilot.delegationId,
        }),
      )
      expect(created.isError).toBeFalsy()
      const structured = created.structuredContent as {
        card: { boardId: string }
        delegation: { actorAgentId: string; subjectAgentId: string; delegationId: string }
      }
      expect(structured.card.boardId).toBe(pilot.board.id)
      expect(structured.delegation).toEqual({
        actorAgentId: pilot.operator.id,
        subjectAgentId: pilot.subject.id,
        delegationId: pilot.delegationId,
      })
    } finally {
      await pilot.close()
    }
  })

  it('needs handover on top of workplace-write for an ownership move', async () => {
    const pilot = await aPilot(['workplace-read', 'workplace-write'])
    try {
      await pilot.accept()
      const refused = await pilot.client.callTool(
        workplace({
          act: 'handover',
          subject: 'card',
          id: randomUUID(),
          expectedVersion: 1,
          fields: {
            toCitizenId: pilot.subject.id,
            done: 'work done',
            learned: 'a lesson',
            next: 'next step',
          },
          delegationId: pilot.delegationId,
        }),
      )
      expect(refused.isError).toBe(true)
      expect(errorOf(refused).code).toBe('delegation_missing_capability')
    } finally {
      await pilot.close()
    }
  })

  it('blocks new work the moment the subject revokes, and refuses pending and unknown ids', async () => {
    const pilot = await aPilot(['workplace-read'])
    try {
      const pending = await pilot.client.callTool(
        workplace({
          act: 'get',
          subject: 'board',
          id: pilot.board.id,
          delegationId: pilot.delegationId,
        }),
      )
      expect(errorOf(pending).code).toBe('delegation_pending')

      await pilot.accept()
      await pilot.revoke()
      const revoked = await pilot.client.callTool(
        workplace({
          act: 'get',
          subject: 'board',
          id: pilot.board.id,
          delegationId: pilot.delegationId,
        }),
      )
      expect(errorOf(revoked).code).toBe('delegation_revoked')

      const unknown = await pilot.client.callTool(
        workplace({
          act: 'get',
          subject: 'board',
          id: pilot.board.id,
          delegationId: AgentOperatorDelegationIdSchema.parse(randomUUID()),
        }),
      )
      expect(errorOf(unknown).code).toBe('delegation_not_found')
    } finally {
      await pilot.close()
    }
  })

  it('leaves an undelegated call byte-compatible, carrying no delegation block', async () => {
    const { colony, apiKey, agent } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)
    try {
      const board = aBoard(agent.id)
      colony.boards.plant(board, [seat(board, agent.id)])
      const own = await client.callTool(workplace({ act: 'get', subject: 'board', id: board.id }))
      expect(own.isError).toBeFalsy()
      expect(own.structuredContent).not.toHaveProperty('delegation')
    } finally {
      await close()
    }
  })
})
