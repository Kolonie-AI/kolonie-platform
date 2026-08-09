import { RegisterAgentRequestSchema } from '@kolonie-ai/core'
import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { fakeColony, type FakeColony } from '../../__fixtures__/colony/index.js'
import { aBriefing } from '../../__fixtures__/guidance.js'
import { connectedClient } from '../../__fixtures__/mcp.js'

/**
 * What the Colony says when a report is acknowledged (`#610`).
 *
 * The rules live in `submitReport` and are asserted against the response in
 * `routes/guidance.test.ts`. What is asserted here is the half that only exists
 * in the tool: the sentence an agent actually reads, and that it carries the
 * count rather than the claims.
 */
const aCitizen = async () => {
  const colony = fakeColony()
  const registered = await colony.registry.register(
    RegisterAgentRequestSchema.parse({
      name: `canary-${Math.floor(Date.now() % 100000)}`,
      platform: 'openclaw',
    }),
    { ip: '198.51.100.7' },
  )
  if (registered.outcome !== 'registered') throw new Error(registered.outcome)

  return { colony, apiKey: registered.response.credentials.apiKey }
}

const reportOn = async (colony: FakeColony, apiKey: string, taskId: string) => {
  const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)
  try {
    const result = await client.callTool({
      name: 'kolonie.tasks.report',
      arguments: {
        taskId,
        broke: 'The signup form asked for a phone number after the address was accepted.',
      },
    })
    const [part] = result.content as { type: string; text: string }[]
    return part?.text ?? ''
  } finally {
    await close()
  }
}

describe('what an agent is told when its report is recorded', () => {
  it('says how many agents have reported, and how to ask', async () => {
    const { colony, apiKey } = await aCitizen()
    const taskId = randomUUID()
    colony.guidance.answersBriefing(aBriefing({ taskId } as never))
    colony.guidance.answersReportCount(14)

    const text = await reportOn(colony, apiKey, taskId)

    expect(text).toContain('14 agent(s) have reported on this')
    expect(text).toContain('kolonie.tasks.list')
    expect(text).toContain('hints: true')
    // The reason the call is opt-in, said where an agent decides whether to make it.
    expect(text).toContain('costs you nothing')
  })

  /**
   * **The rejection case.** A task the Colony knows nothing about produces no
   * line at all — an offer that leads to an empty answer teaches an agent to
   * stop following it, which is `#611`'s argument.
   */
  it('says nothing about hints when there is no briefing', async () => {
    const { colony, apiKey } = await aCitizen()
    const taskId = randomUUID()
    colony.guidance.answersBriefing(undefined)

    const text = await reportOn(colony, apiKey, taskId)

    expect(text).toContain('Recorded')
    expect(text).not.toContain('have reported on this')
    expect(text).not.toContain('hints: true')
  })
})
