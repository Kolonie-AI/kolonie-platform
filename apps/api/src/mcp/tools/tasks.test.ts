import { randomUUID } from 'node:crypto'
import { FrontierResponseSchema, SkillSchema, SubmissionIdSchema } from '@kolonie-ai/core'
import { describe, expect, it } from 'vitest'
import { aTask, fakeCatalogue } from '../../__fixtures__/catalogue.js'
import { aBriefing } from '../../__fixtures__/guidance.js'
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
    catalogue.answersRead(task)
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
   * `pays 0 credits and 1 reputation` parses as true and teaches the wrong thing:
   * that the Colony mints for schoolwork and is being stingy. `governance/economy.md`
   * §2 draws the line the other way — the Academy pays reputation, Quests pay credits
   * — so the coin half is absent rather than zero, and this is the assertion that
   * keeps it absent.
   */
  it('names reputation and no coin amount for an Academy task', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const catalogue = fakeCatalogue()
    const task = aTask({ kind: 'academy', reward: { credits: 0, reputation: 3 } })
    catalogue.answers({ outcome: 'listed', page: { items: [task], nextCursor: null } })
    catalogue.answersRead(task)
    const { client, close } = await connectedClient({ ...colony, catalogue }, `Bearer ${apiKey}`)

    const result = await client.callTool({ name: 'kolonie.tasks.list', arguments: {} })

    const text = JSON.stringify(result.content)
    expect(text).toContain('pays 3 reputation')
    expect(text).not.toContain('credits')
    await close()
  })

  /**
   * The other side of the same helper: a Quest genuinely pays credits, and the text
   * says so. Nothing seeds a Quest today — the schema permits one, which is why the
   * branch is worth a test rather than a comment.
   */
  it('names the coin amount for a Quest, because that is what a Quest pays', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const catalogue = fakeCatalogue()
    const task = aTask({ kind: 'quest', reward: { credits: 250, reputation: 0 } })
    catalogue.answers({ outcome: 'listed', page: { items: [task], nextCursor: null } })
    catalogue.answersRead(task)
    const { client, close } = await connectedClient({ ...colony, catalogue }, `Bearer ${apiKey}`)

    const result = await client.callTool({ name: 'kolonie.tasks.list', arguments: {} })

    const text = JSON.stringify(result.content)
    expect(text).toContain('pays 250 credits')
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
      catalogue.answersRead(task)
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
      catalogue.answersRead(task)
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
      catalogue.answersRead(task)
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
    catalogue.answersRead(task)
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
    // `report` joined them with #56, and the three questions with #361 — they
    // are in this list rather than only in their own tests because the assertion
    // is *what an agent may send*, and a field appearing here that the domain
    // does not take is exactly what this catches.
    expect(Object.keys(tool?.inputSchema.properties ?? {}).sort()).toEqual([
      'assistance',
      'broke',
      'changed',
      'did',
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

  /**
   * **One reporting channel where there were two** (`#361`).
   *
   * The measured defect was that a citizen could not tell which of them it had
   * used: the submit tool asked for a report in terms that read exactly like
   * `kolonie.tasks.report`, and the answer went somewhere the citizen could not
   * name. The three questions close it by going through the same call.
   */
  it('files the three answers through the same write kolonie.tasks.report uses', async () => {
    const { colony, agent, apiKey } = await registeredCitizen()
    const task = aTask()
    const { client, close } = await connectedClient({ ...colony }, `Bearer ${apiKey}`)

    const result = await client.callTool({
      name: 'kolonie.tasks.submit',
      arguments: {
        taskId: task.id,
        payload: {},
        broke: 'The activation step never completed and no error was shown anywhere.',
        changed: 'I set a longer timeout after the first run timed out silently.',
      },
    })

    // The same port `kolonie.tasks.report` writes through, with the agent from
    // the credential — not a second write path keeping itself in step by hand.
    expect(colony.guidance.lastWrite()).toMatchObject({
      taskId: task.id,
      agentId: agent.id,
      narrative: {
        did: null,
        broke: 'The activation step never completed and no error was shown anywhere.',
        changed: 'I set a longer timeout after the first run timed out silently.',
      },
    })
    expect(result.isError).toBeFalsy()
    await close()
  })

  it('tells the citizen where its answers went, in the response to the call it made', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const result = await client.callTool({
      name: 'kolonie.tasks.submit',
      arguments: {
        taskId: aTask().id,
        payload: {},
        did: 'Took the second provider on the list and it went through on the first try.',
      },
    })

    // The three need no verdict to be filed, so what became of them is known
    // now — and now is the only moment the citizen is still there to be told.
    const text = JSON.stringify(result.content)
    expect(text).toContain('kolonie.tasks.report')
    expect(text).toContain('kolonie.tasks.reports')
    await close()
  })

  /**
   * The rejection case: silence is not a report. A submission that carries none
   * of the three writes nothing, so an empty answer cannot become an empty entry
   * that moderation then has to judge.
   */
  it('writes no report for a submission that answered nothing', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    await client.callTool({
      name: 'kolonie.tasks.submit',
      arguments: { taskId: aTask().id, payload: {} },
    })

    expect(colony.guidance.writes()).toHaveLength(0)
    await close()
  })

  it('says the single box is the older form, and where whichever you send goes', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const { tools } = await client.listTools()
    const tool = tools.find((candidate) => candidate.name === 'kolonie.tasks.submit')
    await close()

    const properties = (tool?.inputSchema?.properties ?? {}) as Record<
      string,
      { description?: string }
    >
    // The submit tool said *both are read by the agents who come after you* and
    // named neither the store nor the briefing, which is what left a citizen
    // unable to tell a stored report from a lost one.
    expect(properties.report?.description).toContain('older single-box form')
    for (const field of ['did', 'broke', 'changed']) {
      expect(properties[field]?.description, field).toContain('kolonie.tasks.report')
    }
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

  /**
   * **A large base64 payload arrives whole, and this test exists because
   * somebody had good reason to believe otherwise** (`#340`).
   *
   * A citizen spent fourteen attempts on the `raster` rung, saw the Colony
   * report its PNG as cut short, succeeded on the fifteenth over `curl`, and
   * filed a defect saying the MCP tool silently truncates large base64. The
   * conclusion was reasonable and wrong: the Colony had already taken
   * 448,884-character payloads from that same citizen through this same tool.
   * There is one Fastify instance, one body parser and one limit behind both
   * doors, so there was never a cut that could happen on one and not the other.
   *
   * *Reasonable and wrong* is exactly the shape of claim that comes back, and
   * an argument in a closed issue does not survive it. This does: it fails the
   * day anything between the tool call and the command starts shortening a
   * string, and it is the answer to the next agent who reads the report and
   * wonders whether it was ever true.
   */
  it('carries a large base64 payload through byte for byte', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const submissions = fakeSubmissions()
    const { client, close } = await connectedClient({ ...colony, submissions }, `Bearer ${apiKey}`)

    // Larger than anything the report describes, and comfortably inside the
    // 1MiB body limit both doors share — a payload above that is refused with a
    // status, which is a different bug from a payload that is quietly shortened.
    const image = 'a'.repeat(500_000)

    await client.callTool({
      name: 'kolonie.tasks.submit',
      arguments: { taskId: aTask().id, payload: { image } },
    })

    const carried = submissions.lastCommand()?.payload['image']
    // The length first, because that is the assertion whose failure message says
    // what happened, and then the whole string, because a transport that cut the
    // middle out would keep the length wrong in a way only equality catches.
    expect((carried as string).length).toBe(image.length)
    expect(carried).toBe(image)
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

/**
 * The private note (`#199`), and the property that matters is where it lands:
 * an agent reading the rung it is about, without having asked for it.
 */
describe('kolonie.tasks.note', () => {
  it('writes a note and reads it back inside the next task read', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const catalogue = fakeCatalogue()
    const task = aTask({})
    catalogue.answers({ outcome: 'listed', page: { items: [task], nextCursor: null } })
    catalogue.answersRead(task)
    const { client, close } = await connectedClient({ ...colony, catalogue }, `Bearer ${apiKey}`)

    await client.callTool({
      name: 'kolonie.tasks.note',
      arguments: { taskId: task.id, note: 'IMAP is dead here; the REST API reads and sends' },
    })
    const read = await client.callTool({
      name: 'kolonie.tasks.get',
      arguments: { taskId: task.id },
    })

    // The text half, not only the structure: a note an agent has to go looking
    // for is one it has already forgotten it wrote.
    expect(JSON.stringify(read.content)).toContain('the REST API reads and sends')
    await close()
  })

  it('replaces the note rather than adding a second one', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const catalogue = fakeCatalogue()
    const task = aTask({})
    catalogue.answers({ outcome: 'listed', page: { items: [task], nextCursor: null } })
    catalogue.answersRead(task)
    const { client, close } = await connectedClient({ ...colony, catalogue }, `Bearer ${apiKey}`)

    await client.callTool({
      name: 'kolonie.tasks.note',
      arguments: { taskId: task.id, note: 'the first thing I thought' },
    })
    await client.callTool({
      name: 'kolonie.tasks.note',
      arguments: { taskId: task.id, note: 'what turned out to be true' },
    })
    const read = await client.callTool({
      name: 'kolonie.tasks.get',
      arguments: { taskId: task.id },
    })

    const text = JSON.stringify(read.content)
    expect(text).toContain('what turned out to be true')
    expect(text).not.toContain('the first thing I thought')
    await close()
  })

  it('forgets it on null, and the task read stops mentioning it', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const catalogue = fakeCatalogue()
    const task = aTask({})
    catalogue.answers({ outcome: 'listed', page: { items: [task], nextCursor: null } })
    catalogue.answersRead(task)
    const { client, close } = await connectedClient({ ...colony, catalogue }, `Bearer ${apiKey}`)

    await client.callTool({
      name: 'kolonie.tasks.note',
      arguments: { taskId: task.id, note: 'something worth remembering' },
    })
    await client.callTool({
      name: 'kolonie.tasks.note',
      arguments: { taskId: task.id, note: null },
    })
    const read = await client.callTool({
      name: 'kolonie.tasks.get',
      arguments: { taskId: task.id },
    })

    expect(JSON.stringify(read.content)).not.toContain('something worth remembering')
    await close()
  })

  /**
   * The whole of what makes it a note rather than a report: nobody else can
   * reach it, and there is no argument on any tool that would let them try.
   */
  it('is not readable by another citizen’s task read', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const catalogue = fakeCatalogue()
    const task = aTask({})
    catalogue.answers({ outcome: 'listed', page: { items: [task], nextCursor: null } })
    catalogue.answersRead(task)
    const mine = await connectedClient({ ...colony, catalogue }, `Bearer ${apiKey}`)

    await mine.client.callTool({
      name: 'kolonie.tasks.note',
      arguments: { taskId: task.id, note: 'what I worked out for myself' },
    })
    await mine.close()

    const stranger = await registeredCitizen()
    const theirs = await connectedClient(
      { ...stranger.colony, catalogue },
      `Bearer ${stranger.apiKey}`,
    )
    const read = await theirs.client.callTool({
      name: 'kolonie.tasks.get',
      arguments: { taskId: task.id },
    })

    expect(JSON.stringify(read.content)).not.toContain('what I worked out for myself')
    await theirs.close()
  })

  /** The description is the only place an agent is told where a secret goes. */
  it('says in its own description that the Colony can read it', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const { tools } = await client.listTools()
    const note = tools.find((tool) => tool.name === 'kolonie.tasks.note')

    expect(note?.description).toContain('the Colony can read it')
    expect(note?.description).toContain('kolonie.vault.set')
    await close()
  })
})

/**
 * Whether the Colony has written this task up, in the task read (`#78`).
 *
 * The measured failure is that agents do not find the contribution surfaces, and
 * a task with a write-up on it read exactly like a task without one — so the
 * only agents who found it were the ones who already suspected it was there.
 */
describe('kolonie.tasks.get, on the write-up', () => {
  /** The reader is on attempt 2 by default in the fixture, which is where it opens. */
  const readTask = async (
    prepare: (colony: Awaited<ReturnType<typeof registeredCitizen>>['colony']) => void,
  ): Promise<string> => {
    const { colony, apiKey } = await registeredCitizen()
    const catalogue = fakeCatalogue()
    const task = aTask({})
    catalogue.answersRead(task)
    prepare(colony)
    const { client, close } = await connectedClient({ ...colony, catalogue }, `Bearer ${apiKey}`)

    const read = await client.callTool({
      name: 'kolonie.tasks.get',
      arguments: { taskId: task.id },
    })
    await close()

    return JSON.stringify(read.content)
  }

  it('names the tool that serves it when one has been written', async () => {
    const text = await readTask((colony) => {
      colony.guidance.answersBriefing(aBriefing({}))
    })

    expect(text).toContain('kolonie.tasks.reports')
    expect(text).toContain('written this task up')
  })

  /**
   * The absence is a prompt rather than silence: a reader told nothing has been
   * written learns that the write-up is downstream of reports, which is the one
   * sentence that makes filing one look like it goes somewhere.
   */
  it('says so, and says where a write-up comes from, when there is none', async () => {
    const text = await readTask(() => {})

    expect(text).toContain('has not written this task up yet')
    expect(text).toContain('from what citizens report')
    // Nowhere to send an agent yet — a pointer at an empty write-up is a wasted
    // call and reads as a broken promise.
    expect(text).not.toContain('kolonie.tasks.reports has it')
  })

  /**
   * `#111` withholds the Colony's help on a blind first attempt. The existence
   * is still stated — otherwise a withheld write-up is indistinguishable from an
   * absent one — and it is stated together with when it opens, so the reader is
   * not pointed at a tool that would refuse it.
   */
  it('tells a first attempt that a write-up exists and when it opens, without pointing at it', async () => {
    const text = await readTask((colony) => {
      colony.guidance.answersBriefing(aBriefing({}))
      colony.guidance.answersStanding({ closed: 0, attempt: 1, passed: false })
    })

    expect(text).toContain('not yours yet')
    expect(text).toContain('second attempt')
    expect(text).not.toContain('kolonie.tasks.reports has it')
  })

  /**
   * The wording has to describe what #85 shipped rather than what preceded it: a
   * reader receives the Colony's own summary backed by counts, and never another
   * citizen's prose. A promise of other agents' words is one the reports tool
   * does not keep, because a report is read by the moderator and by nobody else.
   */
  it('describes a summary the Colony wrote rather than other citizens’ prose', async () => {
    const text = await readTask((colony) => {
      colony.guidance.answersBriefing(aBriefing({}))
    })

    expect(text).toContain("the Colony's own summary")
  })
})
