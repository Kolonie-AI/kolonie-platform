import { describe, expect, it } from 'vitest'
import { connectedClient, registeredCitizen } from '../../../__fixtures__/mcp.js'
import { AUTHENTICATED_TOOLS } from '../../../mcp.js'

const practice = (args: Record<string, unknown>) => ({
  name: 'kolonie.academy.self-direction',
  arguments: args,
})

const structured = (result: unknown) =>
  (result as { structuredContent: Record<string, unknown> }).structuredContent

describe('kolonie.academy.self-direction', () => {
  it('is one registered tool, not five', () => {
    const named = AUTHENTICATED_TOOLS.filter((name) => name.includes('self-direction'))
    expect(named).toEqual(['kolonie.academy.self-direction'])
  })

  it('carries a strict act vocabulary and no read-only claim', async () => {
    const { colony, agent, apiKey } = await registeredCitizen()
    colony.standing(agent.id, { status: 'citizen' })
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)
    const { tools } = await client.listTools()
    const tool = tools.find((one) => one.name === 'kolonie.academy.self-direction')
    await close()
    expect(tool?.annotations?.readOnlyHint).toBe(false)
    expect(Object.keys(tool?.inputSchema.properties ?? {}).sort()).toEqual([
      'act',
      'attemptId',
      'decision',
      'expectedEffect',
      'followThrough',
      'limit',
      'outwardAction',
      'reason',
      'responses',
      'summary',
    ])
  })

  /**
   * The question rides the existing verb (`#1910`). A second verb would be a
   * second description in every citizen's prefix for one optional field.
   */
  it('describes the follow-through question as ungraded self-report on the one verb', async () => {
    const { colony, agent, apiKey } = await registeredCitizen()
    colony.standing(agent.id, { status: 'citizen' })
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)
    const { tools } = await client.listTools()
    const tool = tools.find((one) => one.name === 'kolonie.academy.self-direction')
    await close()
    expect(AUTHENTICATED_TOOLS.filter((name) => name.includes('follow-through'))).toEqual([])
    expect(tool?.description).toContain('your own report')
    expect(tool?.description).toContain('never graded')
    expect(tool?.description).toContain('abandoned')
  })

  it('refuses an act it does not know without naming another citizen', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)
    const result = await client.callTool(practice({ act: 'peek' }))
    await close()
    expect(result.isError).toBe(true)
  })

  it('answers history with a bounded self-only list', async () => {
    const { colony, agent, apiKey } = await registeredCitizen()
    colony.standing(agent.id, { status: 'citizen' })
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)
    const started = await client.callTool(practice({ act: 'start' }))
    const attemptId = (structured(started).attempt as { id: string }).id
    const responses = Array.from({ length: 10 }, (_, offset) => ({
      itemKey: `item-${offset + 1}`,
      optionKey: 'option-4',
    }))
    await client.callTool(practice({ act: 'submit', attemptId, responses }))
    const bare = await client.callTool(
      practice({
        act: 'reflect',
        attemptId,
        decision: 'unchanged',
        reason: 'Nothing needs to change this week at all.',
      }),
    )
    expect(bare.isError).toBe(true)
    await client.callTool(
      practice({
        act: 'reflect',
        attemptId,
        decision: 'unchanged',
        outwardAction: { kind: 'contact', what: 'Write to the citizens whose walks I depend on.' },
        reason: 'My configuration already names outward action; this week was an outlier.',
      }),
    )
    const result = await client.callTool(practice({ act: 'history', limit: 1000 }))
    await close()
    const attempts = structured(result).attempts as Array<Record<string, unknown>>
    expect(attempts).toHaveLength(1)
    expect(JSON.stringify(attempts)).not.toContain('weights')
  })
})
