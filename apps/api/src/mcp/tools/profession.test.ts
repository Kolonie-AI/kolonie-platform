import type { Agent } from '@kolonie-ai/core'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { describe, expect, it } from 'vitest'
import { fakeProfessions } from '../../__fixtures__/professions.js'
import { connectedClient, registeredCitizen } from '../../__fixtures__/mcp.js'
import { AUTHENTICATED_TOOLS, UNAUTHENTICATED_TOOLS } from '../tool-list.js'

const TOOL = 'kolonie.profession'

const definition = (key: string, version = 1) => ({
  key,
  version,
  title:
    key === 'citizen-mentor'
      ? 'Citizen Mentor'
      : key === 'operations-steward'
        ? 'Operations Steward'
        : 'Software Producer',
  summary: `Summary for ${key}.`,
  vision: `Vision for ${key}.`,
  mission: `Mission for ${key}.`,
  intendedImpact: `Impact for ${key}.`,
  audience: `Audience for ${key}.`,
  successSignals: [`Signal for ${key}.`],
  principles: [`Principle for ${key}.`],
  failureModes: [`Failure for ${key}.`],
  boundaries: [`Boundary for ${key}.`],
  workplaceOrientation: `Workplace orientation for ${key}.`,
})

const errorOf = (result: Awaited<ReturnType<Client['callTool']>>) =>
  (result.structuredContent as { error: { code: string; details?: Record<string, string> } }).error

const withAuthenticatedAgent = (
  colony: Awaited<ReturnType<typeof registeredCitizen>>['colony'],
  mutate: (current: Agent) => Agent,
) => {
  const original = colony.store.authenticate.bind(colony.store)
  colony.store.authenticate = async (presented) => {
    const result = await original(presented)
    return result.outcome === 'authenticated' ? { ...result, agent: mutate(result.agent) } : result
  }
}

const publish = async (
  professions: ReturnType<typeof fakeProfessions>,
  key: string,
  version = 1,
) => {
  const result = await professions.publish({
    expectedVersion: version === 1 ? null : version - 1,
    definition: definition(key, version),
    publisherId: '00000000-0000-4000-8000-000000000001',
  })
  if (result.outcome !== 'published') throw new Error('fixture failed to publish profession')
}

const call = (client: Client, arguments_: Record<string, unknown>) =>
  client.callTool({ name: TOOL, arguments: arguments_ })

describe('kolonie.profession (#1936)', () => {
  it('is one authenticated tool and publishes fixed grammar rather than profession data', async () => {
    const professions = fakeProfessions()
    await publish(professions, 'software-producer')
    const { colony, apiKey } = await registeredCitizen()
    const stranger = await connectedClient({ ...colony, professions })
    const citizen = await connectedClient({ ...colony, professions }, `Bearer ${apiKey}`)

    const anonymousTools = (await stranger.client.listTools()).tools
    const authenticatedTools = (await citizen.client.listTools()).tools
    const tool = authenticatedTools.find((candidate) => candidate.name === TOOL)

    expect(anonymousTools.map(({ name }) => name)).not.toContain(TOOL)
    expect(authenticatedTools).toHaveLength(129)
    expect(authenticatedTools.filter(({ name }) => name === TOOL)).toHaveLength(1)
    expect(AUTHENTICATED_TOOLS.filter((name) => name === TOOL)).toEqual([TOOL])
    expect(UNAUTHENTICATED_TOOLS).not.toContain(TOOL)
    expect(Object.keys(tool?.inputSchema.properties ?? {})).toEqual([
      'act',
      'key',
      'expectedAssignmentVersion',
    ])
    expect(tool?._meta).toEqual({ 'ai.kolonie/docs': expect.stringContaining(TOOL) })
    expect(JSON.stringify(tool)).not.toContain('software-producer')
    expect(JSON.stringify(tool)).not.toContain(definition('software-producer').mission)
    expect(new TextEncoder().encode(JSON.stringify(tool)).length).toBe(852)

    await Promise.all([stranger.close(), citizen.close()])
  })

  it('keeps its entire tools/list entry byte-identical as catalogue data changes', async () => {
    const professions = fakeProfessions()
    await publish(professions, 'software-producer')
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient({ ...colony, professions }, `Bearer ${apiKey}`)

    const before = (await client.listTools()).tools.find((candidate) => candidate.name === TOOL)
    await publish(professions, 'citizen-mentor')
    await publish(professions, 'operations-steward')
    await publish(professions, 'software-producer', 2)
    const after = (await client.listTools()).tools.find((candidate) => candidate.name === TOOL)
    expect(JSON.stringify(after)).toBe(JSON.stringify(before))

    const listed = await call(client, { act: 'list' })
    expect(listed.structuredContent).toEqual({
      professions: [
        {
          key: 'citizen-mentor',
          title: 'Citizen Mentor',
          summary: 'Summary for citizen-mentor.',
          version: 1,
        },
        {
          key: 'operations-steward',
          title: 'Operations Steward',
          summary: 'Summary for operations-steward.',
          version: 1,
        },
        {
          key: 'software-producer',
          title: 'Software Producer',
          summary: 'Summary for software-producer.',
          version: 2,
        },
      ],
    })
    const read = await call(client, { act: 'get', key: 'software-producer' })
    expect(read.structuredContent).toEqual({
      lifecycle: 'active',
      definition: definition('software-producer', 2),
    })
    await close()
  })

  it('lists and gets for candidates, including a retained retired definition', async () => {
    const professions = fakeProfessions()
    await publish(professions, 'software-producer')
    await publish(professions, 'citizen-mentor')
    await professions.retire({ key: 'citizen-mentor', expectedVersion: 1 })
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient({ ...colony, professions }, `Bearer ${apiKey}`)

    expect((await call(client, { act: 'list' })).structuredContent).toEqual({
      professions: [
        {
          key: 'software-producer',
          title: 'Software Producer',
          summary: 'Summary for software-producer.',
          version: 1,
        },
      ],
    })
    expect((await call(client, { act: 'get', key: 'citizen-mentor' })).structuredContent).toEqual({
      lifecycle: 'retired',
      definition: definition('citizen-mentor'),
    })
    await close()
  })

  it('returns structured validation failures for invalid action and argument combinations', async () => {
    const professions = fakeProfessions()
    await publish(professions, 'software-producer')
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient({ ...colony, professions }, `Bearer ${apiKey}`)

    for (const invalid of [
      { act: 'unknown' },
      { act: 'list', key: 'software-producer' },
      { act: 'get' },
      { act: 'get', key: 'Software Producer' },
      { act: 'get', key: 'software-producer', extra: true },
      { act: 'choose', key: 'software-producer', expectedAssignmentVersion: 0 },
    ]) {
      const result = await call(client, invalid)
      expect(result.isError, JSON.stringify(invalid)).toBe(true)
      expect(errorOf(result).code).toBe('validation_failed')
    }
    await close()
  })

  it('separates unknown reads, retired choices and caller eligibility', async () => {
    const professions = fakeProfessions()
    await publish(professions, 'software-producer')
    await professions.retire({ key: 'software-producer', expectedVersion: 1 })
    const { colony, agent, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient({ ...colony, professions }, `Bearer ${apiKey}`)

    expect(errorOf(await call(client, { act: 'get', key: 'unknown-profession' })).code).toBe(
      'not_found',
    )
    expect(
      errorOf(
        await call(client, {
          act: 'choose',
          key: 'software-producer',
          expectedAssignmentVersion: null,
        }),
      ).code,
    ).toBe('validation_failed')
    expect(errorOf(await call(client, { act: 'choose', key: 'software-producer' })).code).toBe(
      'forbidden',
    )

    colony.standing(agent.id, { status: 'citizen' })
    expect(errorOf(await call(client, { act: 'choose', key: 'software-producer' })).code).toBe(
      'conflict',
    )

    withAuthenticatedAgent(colony, (current) => ({ ...current, accountType: 'test' }))
    expect((await call(client, { act: 'get', key: 'software-producer' })).isError).toBeFalsy()
    expect(errorOf(await call(client, { act: 'choose', key: 'software-producer' })).code).toBe(
      'forbidden',
    )
    await close()
  })

  it('chooses, switches and rejects stale or missing assignment versions without changing state', async () => {
    const professions = fakeProfessions()
    await publish(professions, 'software-producer')
    await publish(professions, 'citizen-mentor')
    const { colony, agent, apiKey } = await registeredCitizen()
    colony.standing(agent.id, { status: 'citizen' })
    const { client, close } = await connectedClient({ ...colony, professions }, `Bearer ${apiKey}`)

    const first = await call(client, {
      act: 'choose',
      key: 'software-producer',
    })
    expect(first.structuredContent).toMatchObject({
      assignment: { key: 'software-producer', assignmentVersion: 1 },
      definition: definition('software-producer'),
      next: [
        { tool: TOOL, arguments: { act: 'get', key: 'software-producer' } },
        {
          tool: TOOL,
          arguments: {
            act: 'choose',
            key: 'citizen-mentor',
            expectedAssignmentVersion: 1,
          },
        },
      ],
    })

    expect(errorOf(await call(client, { act: 'choose', key: 'citizen-mentor' })).code).toBe(
      'conflict',
    )
    expect(
      errorOf(
        await call(client, {
          act: 'choose',
          key: 'citizen-mentor',
          expectedAssignmentVersion: 9,
        }),
      ).code,
    ).toBe('conflict')
    expect(
      await professions.assign({ agentId: agent.id, key: 'software-producer', expectedVersion: 1 }),
    ).toMatchObject({
      outcome: 'assigned',
      assignment: { key: 'software-producer', assignmentVersion: 1 },
    })

    const switched = await call(client, {
      act: 'choose',
      key: 'citizen-mentor',
      expectedAssignmentVersion: 1,
    })
    expect(switched.structuredContent).toMatchObject({
      assignment: { key: 'citizen-mentor', assignmentVersion: 2 },
      definition: definition('citizen-mentor'),
    })
    await close()
  })

  it('checks concurrency before idempotency and reads back a retired assignment unchanged', async () => {
    const professions = fakeProfessions()
    await publish(professions, 'software-producer')
    const { colony, agent, apiKey } = await registeredCitizen()
    colony.standing(agent.id, { status: 'citizen' })
    const { client, close } = await connectedClient({ ...colony, professions }, `Bearer ${apiKey}`)

    const first = await call(client, {
      act: 'choose',
      key: 'software-producer',
    })
    const assignment = (first.structuredContent as { assignment: { chosenAt: string } }).assignment
    expect(errorOf(await call(client, { act: 'choose', key: 'software-producer' })).code).toBe(
      'conflict',
    )

    await professions.retire({ key: 'software-producer', expectedVersion: 1 })
    const same = await call(client, {
      act: 'choose',
      key: 'software-producer',
      expectedAssignmentVersion: 1,
    })
    expect(same.structuredContent).toMatchObject({
      assignment: { key: 'software-producer', assignmentVersion: 1, chosenAt: assignment.chosenAt },
      definition: definition('software-producer'),
    })
    const readback = await call(client, {
      act: 'choose',
      key: 'software-producer',
      expectedAssignmentVersion: 1,
    })
    expect(readback.structuredContent).toMatchObject({
      assignment: { key: 'software-producer', assignmentVersion: 1 },
    })
    expect(
      (readback.structuredContent as { assignment: { chosenAt: string } }).assignment.chosenAt,
    ).toBe(assignment.chosenAt)
    await close()
  })
})
