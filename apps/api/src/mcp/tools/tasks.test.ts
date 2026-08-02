import { randomUUID } from 'node:crypto'
import { FrontierResponseSchema, SkillSchema, SubmissionIdSchema } from '@kolonie-ai/core'
import { describe, expect, it } from 'vitest'
import { aTask, fakeCatalogue } from '../../__fixtures__/catalogue.js'
import { connectedClient, registeredCitizen } from '../../__fixtures__/mcp.js'
import { fakeSubmissions } from '../../__fixtures__/submissions.js'
import { buildApp } from '../../app.js'
import { VERDICT_POLL } from '../../submissions.js'

describe('kolonie.tasks.list', () => {
  it('gates the list on the caller’s own skills, whatever the caller sends', async () => {
    const { colony, apiKey, agent } = await registeredCitizen()
    const catalogue = fakeCatalogue()
    const { client, close } = await connectedClient({ ...colony, catalogue }, `Bearer ${apiKey}`)

    // A subject in the arguments is stripped by the input schema rather than
    // honoured: there is no such parameter, on purpose.
    await client.callTool({
      name: 'kolonie.tasks.list',
      arguments: { agentId: randomUUID(), skills: ['builder'] },
    })

    // The subject comes from the credential, exactly as `GET /v1/tasks` takes it
    // — the difference between a filter and a permission (D-014, D-030).
    expect(catalogue.lastQuery()?.agentId).toBe(agent.id)
    await close()
  })

  it('carries each task’s instructions in the text, not only in the structure', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const catalogue = fakeCatalogue()
    const task = aTask({ instructions: 'Set at least one capability on your profile.' })
    catalogue.answers({ outcome: 'listed', page: { items: [task], nextCursor: null } })
    const { client, close } = await connectedClient({ ...colony, catalogue }, `Bearer ${apiKey}`)

    const result = await client.callTool({ name: 'kolonie.tasks.list', arguments: {} })

    // A model reads the text half. An agent that has to make a second call to
    // find out what a task wants will guess instead.
    const text = JSON.stringify(result.content)
    expect(text).toContain('Set at least one capability on your profile.')
    expect(text).toContain(String(task.id))
    expect(text).toContain('kolonie.tasks.submit')
    expect(result.structuredContent).toMatchObject({ items: [{ id: task.id }], nextCursor: null })
    await close()
  })

  /**
   * **What an Academy task pays, said without a zero in it** (#43).
   *
   * `pays 0 coins and 1 reputation` parses as true and teaches the wrong thing:
   * that the Colony mints for schoolwork and is being stingy. `governance/economy.md`
   * §2 draws the line the other way — the Academy pays reputation, Quests pay coins
   * — so the coin half is absent rather than zero, and this is the assertion that
   * keeps it absent.
   */
  it('names reputation and no coin amount for an Academy task', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const catalogue = fakeCatalogue()
    const task = aTask({ kind: 'academy', reward: { coins: 0, reputation: 3 } })
    catalogue.answers({ outcome: 'listed', page: { items: [task], nextCursor: null } })
    const { client, close } = await connectedClient({ ...colony, catalogue }, `Bearer ${apiKey}`)

    const result = await client.callTool({ name: 'kolonie.tasks.list', arguments: {} })

    const text = JSON.stringify(result.content)
    expect(text).toContain('pays 3 reputation')
    expect(text).not.toContain('coins')
    await close()
  })

  /**
   * The other side of the same helper: a Quest genuinely pays coins, and the text
   * says so. Nothing seeds a Quest today — the schema permits one, which is why the
   * branch is worth a test rather than a comment.
   */
  it('names the coin amount for a Quest, because that is what a Quest pays', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const catalogue = fakeCatalogue()
    const task = aTask({ kind: 'quest', reward: { coins: 250, reputation: 0 } })
    catalogue.answers({ outcome: 'listed', page: { items: [task], nextCursor: null } })
    const { client, close } = await connectedClient({ ...colony, catalogue }, `Bearer ${apiKey}`)

    const result = await client.callTool({ name: 'kolonie.tasks.list', arguments: {} })

    const text = JSON.stringify(result.content)
    expect(text).toContain('pays 250 coins')
    expect(text).not.toContain('reputation')
    await close()
  })

  describe('where the agent already stands', () => {
    it('tells an agent waiting on a verdict to wait rather than resubmit', async () => {
      const { colony, apiKey } = await registeredCitizen()
      const catalogue = fakeCatalogue()
      const task = aTask({
        submission: {
          id: SubmissionIdSchema.parse(randomUUID()),
          status: 'pending',
          attempt: 1,
          submittedAt: new Date().toISOString(),
          verifiedAt: null,
        },
      })
      catalogue.answers({ outcome: 'listed', page: { items: [task], nextCursor: null } })
      const { client, close } = await connectedClient({ ...colony, catalogue }, `Bearer ${apiKey}`)

      const result = await client.callTool({ name: 'kolonie.tasks.list', arguments: {} })

      // The one mistake this line exists to prevent. A model handed the bare
      // word "pending" has to know the Colony's lifecycle to act on it, and the
      // wrong guess costs the agent an attempt and the Colony a verification.
      const text = JSON.stringify(result.content)
      expect(text).toContain('with the verifier')
      expect(text).toContain('rather than submitting again')
      await close()
    })

    it('tells an agent whose attempt failed that a retry is open, and which attempt it would be', async () => {
      const { colony, apiKey } = await registeredCitizen()
      const catalogue = fakeCatalogue()
      const now = new Date().toISOString()
      const task = aTask({
        submission: {
          id: SubmissionIdSchema.parse(randomUUID()),
          status: 'failed',
          attempt: 2,
          submittedAt: now,
          verifiedAt: now,
        },
      })
      catalogue.answers({ outcome: 'listed', page: { items: [task], nextCursor: null } })
      const { client, close } = await connectedClient({ ...colony, catalogue }, `Bearer ${apiKey}`)

      const result = await client.callTool({ name: 'kolonie.tasks.list', arguments: {} })

      const text = JSON.stringify(result.content)
      expect(text).toContain('attempt 2 failed')
      expect(text).toContain('attempt 3')
      await close()
    })

    /**
     * The overwhelmingly common row. A line repeated on every task of every page
     * is one a model learns to skip, and it would take the two above with it.
     */
    it('says nothing at all about a task never submitted to', async () => {
      const { colony, apiKey } = await registeredCitizen()
      const catalogue = fakeCatalogue()
      catalogue.answers({
        outcome: 'listed',
        page: { items: [aTask({ submission: null })], nextCursor: null },
      })
      const { client, close } = await connectedClient({ ...colony, catalogue }, `Bearer ${apiKey}`)

      const result = await client.callTool({ name: 'kolonie.tasks.list', arguments: {} })

      expect(JSON.stringify(result.content)).not.toContain('you:')
      await close()
    })

    it('carries the submission in the structured half as well as the text', async () => {
      const { colony, apiKey } = await registeredCitizen()
      const catalogue = fakeCatalogue()
      const submissionId = SubmissionIdSchema.parse(randomUUID())
      const task = aTask({
        submission: {
          id: submissionId,
          status: 'pending',
          attempt: 1,
          submittedAt: new Date().toISOString(),
          verifiedAt: null,
        },
      })
      catalogue.answers({ outcome: 'listed', page: { items: [task], nextCursor: null } })
      const { client, close } = await connectedClient({ ...colony, catalogue }, `Bearer ${apiKey}`)

      const result = await client.callTool({ name: 'kolonie.tasks.list', arguments: {} })

      expect(result.structuredContent).toMatchObject({
        items: [{ id: task.id, submission: { id: submissionId, status: 'pending', attempt: 1 } }],
      })
      await close()
    })
  })

  it('says an empty list means wait, not that the Colony is broken', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const result = await client.callTool({ name: 'kolonie.tasks.list', arguments: {} })

    expect(result.isError).toBeFalsy()
    // A rung whose verifier cannot decide stays invisible. An agent told only
    // "0 tasks" concludes it has finished the Academy.
    expect(JSON.stringify(result.content)).toContain('not a refusal')
    await close()
  })

  it('points at the frontier when there is nothing to start', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const result = await client.callTool({ name: 'kolonie.tasks.list', arguments: {} })

    // The list is narrow on purpose (D-014), so the empty case has to name the
    // call that explains it — otherwise a graph model is strictly worse than
    // the ladder, where the next step was implied by a number.
    expect(JSON.stringify(result.content)).toContain('kolonie.tasks.frontier')
    await close()
  })

  it('shows what each task requires and grants, so no second call is needed', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const catalogue = fakeCatalogue()
    const task = aTask({ requires: [SkillSchema.parse('profile')], grants: [] })
    catalogue.answers({ outcome: 'listed', page: { items: [task], nextCursor: null } })
    const { client, close } = await connectedClient({ ...colony, catalogue }, `Bearer ${apiKey}`)

    const result = await client.callTool({ name: 'kolonie.tasks.list', arguments: {} })

    const text = JSON.stringify(result.content)
    expect(text).toContain('requires profile')
    // A badge says so rather than looking like a rung an agent is waiting on.
    expect(text).toContain('grants nothing')
    await close()
  })

  it('rejects a cursor it never issued in the same vocabulary the endpoint uses', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const catalogue = fakeCatalogue()
    catalogue.answers({ outcome: 'invalid-cursor' })
    const { client, close } = await connectedClient({ ...colony, catalogue }, `Bearer ${apiKey}`)

    const result = await client.callTool({
      name: 'kolonie.tasks.list',
      arguments: { cursor: 'not-a-cursor' },
    })

    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('validation_failed')
    await close()
  })
})

describe('kolonie.tasks.submit', () => {
  it('defaults the payload, so the mistake that failed Level 0 cannot be made', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const submissions = fakeSubmissions()
    const task = aTask()
    const { client, close } = await connectedClient({ ...colony, submissions }, `Bearer ${apiKey}`)

    const result = await client.callTool({
      name: 'kolonie.tasks.submit',
      arguments: { taskId: task.id },
    })

    // Every task text said "submit with an empty payload ({})" until 2026-07-28,
    // which is a 422 against an endpoint that wants {"payload": {}}. A named
    // argument that defaults has no envelope to get wrong.
    expect(result.isError).toBeFalsy()
    expect(submissions.lastCommand()).toMatchObject({ taskId: task.id, payload: {} })
    await close()
  })

  it('takes the agent from the credential — there is nowhere to put someone else’s', async () => {
    const { colony, agent, apiKey } = await registeredCitizen()
    const submissions = fakeSubmissions()
    const { client, close } = await connectedClient({ ...colony, submissions }, `Bearer ${apiKey}`)

    const { tools } = await client.listTools()
    await client.callTool({
      name: 'kolonie.tasks.submit',
      arguments: { taskId: aTask().id, payload: {} },
    })

    const tool = tools.find((candidate) => candidate.name === 'kolonie.tasks.submit')
    // `report` joined them with #56, and it is in this list rather than only in
    // its own test because the assertion is *what an agent may send* — a field
    // appearing here that the domain does not take is exactly what this catches.
    expect(Object.keys(tool?.inputSchema.properties ?? {}).sort()).toEqual([
      'assistance',
      'payload',
      'report',
      'taskId',
    ])
    expect(submissions.lastCommand()?.agentId).toBe(agent.id)
    await close()
  })

  /**
   * The declaration over MCP (`#39`). The HTTP half is in
   * `routes/submissions.test.ts`, and both surfaces have to take it: a field
   * only one door accepts makes the count `ROADMAP.md` rests on partial by
   * surface rather than by agent.
   */
  it('passes a declared assistance through, and tells the model what it recorded', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const submissions = fakeSubmissions()
    const { client, close } = await connectedClient({ ...colony, submissions }, `Bearer ${apiKey}`)

    const result = await client.callTool({
      name: 'kolonie.tasks.submit',
      arguments: { taskId: aTask().id, assistance: 'operator-provided' },
    })

    expect(submissions.lastCommand()?.assistance).toBe('operator-provided')
    // In the text as well as the structure: a model that cannot see what was
    // recorded cannot correct it on the next attempt.
    expect(JSON.stringify(result.content)).toContain('operator-provided')
    await close()
  })

  it('records unknown when the agent declares nothing, never none', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const submissions = fakeSubmissions()
    const { client, close } = await connectedClient({ ...colony, submissions }, `Bearer ${apiKey}`)

    await client.callTool({ name: 'kolonie.tasks.submit', arguments: { taskId: aTask().id } })

    // The tool leaves the field out entirely rather than sending `unknown`
    // itself, so what silence means is decided in core and in the column —
    // one place, not three.
    expect(submissions.lastCommand()?.assistance).toBe('unknown')
    await close()
  })

  it('refuses an assisted submission where the task refuses one, with the stable code', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const submissions = fakeSubmissions()
    submissions.answers({ outcome: 'assistance-refused', declared: 'operator-performed' })
    const { client, close } = await connectedClient({ ...colony, submissions }, `Bearer ${apiKey}`)

    const result = await client.callTool({
      name: 'kolonie.tasks.submit',
      arguments: { taskId: aTask().id, assistance: 'operator-performed' },
    })

    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('assistance_refused')
    await close()
  })

  it('tells an agent that declaring honestly costs no more than silence', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const { tools } = await client.listTools()
    const tool = tools.find((candidate) => candidate.name === 'kolonie.tasks.submit')

    // The one thing this field must not do is read as a confession. An agent
    // that worked alone and did not know it could say so is the case that
    // poisons the number.
    const described = JSON.stringify(tool)
    expect(described).toContain('not held against you')
    // Escaped, because this is JSON: the quotes around `none` are the tool's,
    // not the assertion's.
    expect(described).toContain('only \\"none\\" earns the full reward')
    await close()
  })

  it('sends the agent to kolonie.me for the verdict rather than to a path', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const result = await client.callTool({
      name: 'kolonie.tasks.submit',
      arguments: { taskId: aTask().id },
    })

    // Verification is asynchronous (D-005). An agent that is not told where the
    // answer appears invents a polling loop, and every skill invents a different one.
    const text = JSON.stringify(result.content)
    expect(text).toContain('kolonie.me')
    expect(text).toContain(String(VERDICT_POLL.afterSeconds))
    await close()
  })

  it('names a refusal an agent can branch on', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const submissions = fakeSubmissions()
    submissions.answers({ outcome: 'missing-skills', missing: [SkillSchema.parse('browser')] })
    const { client, close } = await connectedClient({ ...colony, submissions }, `Bearer ${apiKey}`)

    const result = await client.callTool({
      name: 'kolonie.tasks.submit',
      arguments: { taskId: aTask().id },
    })

    expect(result.isError).toBe(true)
    // The same stable code the endpoint sends, so "wait" and "never" stay
    // distinguishable on both surfaces.
    expect(JSON.stringify(result.content)).toContain('level_locked')
    await close()
  })
})

describe('kolonie.tasks.frontier', () => {
  it('names the missing skill and the task that grants it', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const catalogue = fakeCatalogue()
    const granting = aTask({ title: 'Prove you can drive a browser' })
    catalogue.answersFrontier({
      skills: [SkillSchema.parse('profile')],
      entries: [
        {
          task: aTask({ title: 'Obtain a mailbox', requires: [SkillSchema.parse('browser')] }),
          missingSkill: SkillSchema.parse('browser'),
          grantedBy: [{ id: granting.id, type: granting.type, title: granting.title }],
        },
      ],
    })
    const { client, close } = await connectedClient({ ...colony, catalogue }, `Bearer ${apiKey}`)

    const result = await client.callTool({ name: 'kolonie.tasks.frontier', arguments: {} })

    const text = JSON.stringify(result.content)
    expect(text).toContain('browser')
    expect(text).toContain('Prove you can drive a browser')
    // The id as well as the title, because the agent's next move is a submit
    // and an id it has to look up is an id it will guess at.
    expect(text).toContain(String(granting.id))
    expect(FrontierResponseSchema.parse(result.structuredContent).entries).toHaveLength(1)
    await close()
  })

  it('asks on behalf of the credential — there is no subject to send', async () => {
    const { colony, apiKey, agent } = await registeredCitizen()
    const catalogue = fakeCatalogue()
    const { client, close } = await connectedClient({ ...colony, catalogue }, `Bearer ${apiKey}`)

    await client.callTool({
      name: 'kolonie.tasks.frontier',
      arguments: { agentId: randomUUID() },
    })

    expect(catalogue.frontierQueries()).toEqual([agent.id])
    await close()
  })

  it('answers the same thing the endpoint does, from the same call', async () => {
    // D-026: a capability the REST surface has and MCP lacks is a capability
    // foreign agents do not have, because they arrive through a skill that
    // names no endpoints. One implementation, two doors.
    const { colony, apiKey } = await registeredCitizen()
    const catalogue = fakeCatalogue()
    catalogue.answersFrontier({
      skills: [SkillSchema.parse('profile')],
      entries: [
        {
          task: aTask({ title: 'Obtain a mailbox', requires: [SkillSchema.parse('browser')] }),
          missingSkill: SkillSchema.parse('browser'),
          grantedBy: [],
        },
      ],
    })

    const app = buildApp({ ...colony, catalogue })
    await app.ready()
    const overHttp = await app.inject({
      method: 'GET',
      url: '/v1/tasks/frontier',
      headers: { authorization: `Bearer ${apiKey}` },
    })
    await app.close()

    const { client, close } = await connectedClient({ ...colony, catalogue }, `Bearer ${apiKey}`)
    const overMcp = await client.callTool({ name: 'kolonie.tasks.frontier', arguments: {} })
    await close()

    expect(overMcp.structuredContent).toEqual(overHttp.json())
  })

  it('says plainly when nothing is one step away', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const result = await client.callTool({ name: 'kolonie.tasks.frontier', arguments: {} })

    expect(result.isError).toBeFalsy()
    expect(JSON.stringify(result.content)).toContain('Nothing is one skill away')
    await close()
  })

  it('is not offered to an anonymous caller', async () => {
    const { colony } = await registeredCitizen()
    const { client, close } = await connectedClient(colony)

    const { tools } = await client.listTools()

    expect(tools.map((tool) => tool.name)).not.toContain('kolonie.tasks.frontier')
    await close()
  })
})
