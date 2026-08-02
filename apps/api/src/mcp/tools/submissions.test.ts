import { randomUUID } from 'node:crypto'
import { ListSubmissionsResponseSchema, SubmissionSchema } from '@kolonie-ai/core'
import { describe, expect, it } from 'vitest'
import { anonymousClient, connectedClient, registeredCitizen } from '../../__fixtures__/mcp.js'
import { fakeSubmissions } from '../../__fixtures__/submissions.js'

describe('kolonie.submissions.list', () => {
  it('is not offered to an anonymous caller', async () => {
    const { client, close } = await anonymousClient()

    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name)).not.toContain('kolonie.submissions.list')
    await close()
  })

  it('appears once a credential is presented', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name)).toContain('kolonie.submissions.list')
    await close()
  })

  it('returns an empty list when the agent has not submitted anything yet', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const submissions = fakeSubmissions()
    submissions.setList([])
    const { client, close } = await connectedClient({ ...colony, submissions }, `Bearer ${apiKey}`)

    const result = await client.callTool({ name: 'kolonie.submissions.list', arguments: {} })

    expect(result.isError).toBeFalsy()
    const structured = ListSubmissionsResponseSchema.parse(result.structuredContent)
    expect(structured.submissions).toEqual([])
    // The text tells the agent what to do next, not just that the list is empty.
    const text = JSON.stringify(result.content)
    expect(text).toContain('not submitted')
    await close()
  })

  it('returns submissions with their statuses', async () => {
    const { colony, apiKey, agent } = await registeredCitizen()
    const submissions = fakeSubmissions()
    submissions.setList([
      SubmissionSchema.parse({
        id: randomUUID(),
        taskId: randomUUID(),
        agentId: agent.id,
        payload: {},
        status: 'passed',
        attempt: 1,
        assistance: 'unknown',
        report: null,
        reportOutcome: null,
        evidence: null,
        submittedAt: '2026-07-29T08:00:00.000Z',
        verifiedAt: '2026-07-29T09:00:00.000Z',
      }),
      SubmissionSchema.parse({
        id: randomUUID(),
        taskId: randomUUID(),
        agentId: agent.id,
        payload: {},
        status: 'failed',
        attempt: 1,
        assistance: 'unknown',
        report: null,
        reportOutcome: null,
        evidence: null,
        submittedAt: '2026-07-29T10:00:00.000Z',
        verifiedAt: '2026-07-29T11:00:00.000Z',
      }),
      SubmissionSchema.parse({
        id: randomUUID(),
        taskId: randomUUID(),
        agentId: agent.id,
        payload: {},
        status: 'pending',
        attempt: 1,
        assistance: 'unknown',
        report: null,
        reportOutcome: null,
        evidence: null,
        submittedAt: '2026-07-29T12:00:00.000Z',
        verifiedAt: null,
      }),
    ])
    const { client, close } = await connectedClient({ ...colony, submissions }, `Bearer ${apiKey}`)

    const result = await client.callTool({ name: 'kolonie.submissions.list', arguments: {} })

    expect(result.isError).toBeFalsy()
    const structured = ListSubmissionsResponseSchema.parse(result.structuredContent)
    expect(structured.submissions).toHaveLength(3)
    // The text names each status, so a model can tell the agent what to do.
    const text = JSON.stringify(result.content)
    expect(text).toContain('passed')
    expect(text).toContain('failed')
    expect(text).toContain('pending')
    await close()
  })

  it('suggests retrying when a submission has failed', async () => {
    const { colony, apiKey, agent } = await registeredCitizen()
    const submissions = fakeSubmissions()
    submissions.setList([
      SubmissionSchema.parse({
        id: randomUUID(),
        taskId: randomUUID(),
        agentId: agent.id,
        payload: {},
        status: 'failed',
        attempt: 1,
        assistance: 'unknown',
        report: null,
        reportOutcome: null,
        evidence: null,
        submittedAt: '2026-07-29T10:00:00.000Z',
        verifiedAt: '2026-07-29T11:00:00.000Z',
      }),
    ])
    const { client, close } = await connectedClient({ ...colony, submissions }, `Bearer ${apiKey}`)

    const result = await client.callTool({ name: 'kolonie.submissions.list', arguments: {} })

    const text = JSON.stringify(result.content)
    expect(text).toMatch(/retried|retry/i)
    await close()
  })

  /**
   * `#73`. **The moment a submission fails is the moment to ask**, and until this
   * landed nothing in a failed verdict mentioned that the Colony wanted to hear
   * why: production on 2026-07-30 held five failed submissions and one report.
   * This is the population with something to say, at the exact moment they know
   * it.
   *
   * The tool is named rather than described, because an agent cannot call a
   * paraphrase — and the cost is stated, because everything else an agent does
   * here is graded and it is entirely reasonable to assume complaining is too.
   */
  it('tells an agent whose submission failed what a report is worth, and what it opens', async () => {
    const { colony, apiKey, agent } = await registeredCitizen()
    const submissions = fakeSubmissions()
    submissions.setList([
      SubmissionSchema.parse({
        id: randomUUID(),
        taskId: randomUUID(),
        agentId: agent.id,
        payload: {},
        status: 'failed',
        attempt: 1,
        assistance: 'unknown',
        report: null,
        reportOutcome: null,
        evidence: null,
        submittedAt: '2026-07-29T10:00:00.000Z',
        verifiedAt: '2026-07-29T11:00:00.000Z',
      }),
    ])
    const { client, close } = await connectedClient({ ...colony, submissions }, `Bearer ${apiKey}`)

    const result = await client.callTool({ name: 'kolonie.submissions.list', arguments: {} })

    const text = JSON.stringify(result.content)
    expect(text).toContain('kolonie.tasks.report')
    /**
     * **The valuation is inverted, and this is what holds it there** (#112). The
     * text used to say a report cost nothing — no reward, no reputation, no
     * standing — three times in one paragraph, to agents graded on everything
     * else, which is a price list they read correctly. What it says now is what
     * is true: the report is worth more than the pass it did not earn, and it is
     * what opens the next attempt.
     */
    expect(text).toMatch(/worth more than the pass you did not earn/)
    expect(text).toMatch(/next attempt at this task opens/)
    expect(text).not.toMatch(/no reward, no reputation/)
    await close()
  })

  /** The same invitation, at the other place a failure is about to become news. */
  it('names the reporting tool in the reply to a submission, before the verdict arrives', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const result = await client.callTool({
      name: 'kolonie.tasks.submit',
      arguments: { taskId: randomUUID() },
    })

    expect(JSON.stringify(result.content)).toContain('kolonie.tasks.report')
    await close()
  })

  /**
   * An agent that has no report of its own still learns what the tool is for from
   * the empty list, which is where an agent looks after being told the tool exists.
   */
  it('invites a report from an agent that has never filed one', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const result = await client.callTool({ name: 'kolonie.me.history', arguments: {} })

    const text = JSON.stringify(result.content)
    expect(text).toContain('kolonie.tasks.report')
    expect(text).toMatch(/next attempt at a task you did not get through/)
    expect(text).not.toMatch(/costs you nothing/)
    await close()
  })

  /**
   * **The sentence the skill called the one that matters** (`#187`).
   *
   * `Kolonie-AI/kolonie-openclaw#9` cut §5 out of the four entry-point skills
   * and sent its content here, on the argument that the tool list is in front
   * of an agent every session while the skill is read once. This is the half
   * that had no destination.
   *
   * It is pinned rather than left to the prose because the assumption it
   * corrects is a reasonable one: everything else an agent does in the Academy
   * is graded, so a report looks graded too — and the agents that assumption
   * stops are the careful ones. `kolonie.tasks.decline`, read in the same
   * situation by the same agent, has always said it, and the silence in the
   * other one is what read as significant.
   */
  it('tells a citizen that reporting costs it nothing', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const { tools } = await client.listTools()
    const report = tools.find((tool) => tool.name === 'kolonie.tasks.report')

    expect(report?.description).toMatch(/no reward, no reputation and no standing/)
    expect(report?.description).toMatch(/not an admission that you failed/)
    await close()
  })
})
