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

/**
 * **A report filed under a name the tool does not have** (`#796`).
 *
 * Reporter 6 filed a support ticket saying `kolonie.tasks.report` refused
 * populated answers as empty, having tried its text as a stringified JSON in
 * `body`, as an object in `body`, as an array in `body` and under `answers`.
 * Every one came back `(body): Answer at least one of the questions`.
 *
 * The accepted shape was never broken — the two tests above have been filing
 * reports through it all along. What was broken is that **every other shape was
 * discarded in silence**, so the refusal described a report with nothing in it
 * and the citizen had no way to learn that the questions have names. Four
 * attempts and a ticket is what that costs.
 */
describe('a report filed under a name this tool does not have', () => {
  const callWith = async (colony: FakeColony, apiKey: string, args: Record<string, unknown>) => {
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)
    try {
      const result = await client.callTool({ name: 'kolonie.tasks.report', arguments: args })
      return { isError: result.isError === true, text: JSON.stringify(result.content) }
    } finally {
      await close()
    }
  }

  const anAnswer = 'The signup form asked for a phone number after the address was accepted.'

  it.each([
    ['a single box called body', { body: anAnswer }],
    ['a wrapper called answers', { answers: { broke: anAnswer } }],
  ])('is refused by name, not reported back as empty: %s', async (_case, extra) => {
    const { colony, apiKey } = await aCitizen()
    const taskId = randomUUID()
    colony.guidance.answersBriefing(undefined)

    const { isError, text } = await callWith(colony, apiKey, { taskId, ...extra })

    expect(isError).toBe(true)
    // The key it actually used, so it can see what happened to its text.
    expect(text).toContain(Object.keys(extra)[0] as string)
    // And the four that exist, so the next call is the right one.
    for (const field of ['did', 'broke', 'changed', 'discarded']) expect(text).toContain(field)
    // The sentence that sent it round again: this is not an empty report.
    expect(text).not.toContain('Answer at least one of the questions')
  })

  /**
   * **The accepted shape still is accepted, and still reaches the store.** A
   * strict boundary is only safe beside the assertion that it did not narrow
   * what a citizen may legitimately send.
   */
  it('records the answers when they are under the names the tool asks for', async () => {
    const { colony, apiKey } = await aCitizen()
    const taskId = randomUUID()
    colony.guidance.answersBriefing(undefined)

    const { isError, text } = await callWith(colony, apiKey, {
      taskId,
      did: 'Opened the provider signup and worked through it in the documented order.',
      broke: anAnswer,
    })

    expect(isError).toBe(false)
    expect(text).toContain('Recorded')
  })

  /**
   * The tool's own argument is not a question of the report, and the handler
   * takes it off before the strict shape sees it. Asserted because forgetting
   * that is how a strict boundary breaks every caller at once.
   */
  it('does not refuse the tool’s own taskId argument', async () => {
    const { colony, apiKey } = await aCitizen()
    colony.guidance.answersBriefing(undefined)

    const { isError, text } = await callWith(colony, apiKey, {
      taskId: randomUUID(),
      broke: anAnswer,
    })

    expect(isError).toBe(false)
    expect(text).not.toContain('taskId')
  })
})
