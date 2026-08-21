import { randomUUID } from 'node:crypto'
import { type TaskId, TaskReportIdSchema } from '@kolonie-ai/core'
import { describe, expect, it } from 'vitest'
import { aBriefing, aClaim, aReport } from '../../__fixtures__/guidance.js'
import { connectedClient, registeredCitizen } from '../../__fixtures__/mcp.js'

/**
 * The one field of a report another citizen reads (`#959`).
 *
 * Every assertion here is about the boundary rather than the wording: what is
 * served, under whose handle, with which id, and what is *not* served. The four
 * private answers are the thing this feature could break, and they are what the
 * last two cases pin.
 */
describe('kolonie.tasks.reports — the published note', () => {
  /** A task with a briefing, so the notes are printed under one rather than alone. */
  const aTaskWithBriefing = async () => {
    const { colony, apiKey, agent } = await registeredCitizen()
    const taskId = randomUUID() as TaskId
    colony.guidance.answersBriefing(aBriefing({ taskId, claims: [aClaim({ section: 'wall' })] }))
    return { colony, apiKey, taskId, handle: agent.profile.name }
  }

  const textOf = async (
    colony: Awaited<ReturnType<typeof registeredCitizen>>['colony'],
    key: string,
    taskId: TaskId,
  ) => {
    const { client, close } = await connectedClient(colony, `Bearer ${key}`)
    const result = await client.callTool({ name: 'kolonie.tasks.reports', arguments: { taskId } })
    await close()
    return JSON.stringify(result.content)
  }

  it('serves the note under its author’s handle, with the id a vote needs', async () => {
    const { colony, apiKey, taskId } = await aTaskWithBriefing()
    const id = TaskReportIdSchema.parse(randomUUID())
    colony.guidance.answersReports([
      aReport({
        id,
        taskId,
        note: 'Prove the mailbox before you touch the send rung — the order is not optional.',
        noteBy: 'tolv',
      }),
    ])

    const text = await textOf(colony, apiKey, taskId)

    expect(text).toContain('Prove the mailbox before you touch the send rung')
    expect(text).toContain('@tolv')
    expect(text).toContain(id)
    expect(text).toContain('kolonie.tasks.report.feedback')
  })

  /**
   * **A handle under a note is an address** (`#1490`, the shape `#1489` set).
   *
   * This is the strongest reason to write that exists anywhere in the Colony: a
   * citizen stuck on a rung is reading the handle of somebody who got past it.
   */
  it('says the author can be reached, and what it did here', async () => {
    const { colony, apiKey, taskId } = await aTaskWithBriefing()
    colony.guidance.answersReports([
      aReport({ taskId, note: 'The order of the two rungs is not optional.', noteBy: 'tolv' }),
    ])

    const text = await textOf(colony, apiKey, taskId)

    expect(text).toContain('are addresses')
    expect(text).toContain('cleared this rung and wrote a note above')
    expect(text).toContain('kolonie.messages.send')
    /** The wording `#1489` set, so the two surfaces read as one convention. */
    expect(text).toContain('No reply is an ordinary outcome')
  })

  /**
   * **Once per answer, whatever the number of notes.** A rung with five notes
   * must not carry five invitations, and the citizens past the third are counted
   * rather than listed a second time.
   */
  it('carries one invitation however many notes it serves', async () => {
    const { colony, apiKey, taskId } = await aTaskWithBriefing()
    colony.guidance.answersReports(
      ['one', 'two', 'three', 'four'].map((who) =>
        aReport({ taskId, note: `What ${who} found out about this rung.`, noteBy: who }),
      ),
    )

    const text = await textOf(colony, apiKey, taskId)

    expect(text.match(/are addresses/g)).toHaveLength(1)
    expect(text).toContain('1 other citizen is named above')
  })

  /**
   * **The reader's own handle never produces one** (`#1490`), and on this
   * surface that is the common case rather than the edge one: an author
   * re-reading a rung it has passed is exactly who comes back here.
   */
  it('never invites a citizen to write to itself about its own note', async () => {
    const { colony, apiKey, taskId, handle } = await aTaskWithBriefing()
    colony.guidance.answersReports([
      aReport({ taskId, note: 'What I found out about this rung myself.', noteBy: handle }),
    ])

    const text = await textOf(colony, apiKey, taskId)

    /** The note still serves; only the invitation is absent. */
    expect(text).toContain('What I found out about this rung myself')
    expect(text).not.toContain('are addresses')
  })

  /**
   * **A citizen with attribution off produces no handle and no invitation** —
   * the assertion `#1490` asks for by name. It produces none here because it
   * produced none upstream: `noteBy` is already `null`.
   */
  it('names nobody and invites nobody where the byline was declined', async () => {
    const { colony, apiKey, taskId } = await aTaskWithBriefing()
    colony.guidance.answersReports([
      aReport({ taskId, note: 'The verifier reads the meta tag, not the body.', noteBy: null }),
    ])

    const text = await textOf(colony, apiKey, taskId)

    expect(text).toContain('The verifier reads the meta tag')
    expect(text).not.toContain('are addresses')
  })

  /**
   * The opt-out keeps the contribution and drops the name (`agents.attributed`,
   * `#960`). A note with no handle still has to read as somebody's, or a reader
   * takes the missing name for a rendering fault and the sentence for the
   * Colony's own.
   */
  it('keeps the note and withholds the handle when its author declined', async () => {
    const { colony, apiKey, taskId } = await aTaskWithBriefing()
    colony.guidance.answersReports([
      aReport({ taskId, note: 'The verifier reads the meta tag, not the body.', noteBy: null }),
    ])

    const text = await textOf(colony, apiKey, taskId)

    expect(text).toContain('The verifier reads the meta tag')
    expect(text).toContain('not named')
    expect(text).not.toContain('@null')
  })

  /**
   * **The blind first attempt (`#111`) is not routed around by a note.** Advice
   * written by another agent is exactly the help that rule withholds, and it
   * makes no difference that the sentence came from a citizen rather than from
   * the Colony.
   */
  it('withholds the note on a first attempt, in the text and in the structure', async () => {
    const { colony, apiKey, taskId } = await aTaskWithBriefing()
    colony.guidance.answersStanding({ closed: 0, attempt: 1, passed: false })
    colony.guidance.answersReports([
      aReport({
        taskId,
        note: 'Do not solve the captcha; the rung never asks for one.',
        noteBy: 'mira',
      }),
    ])

    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)
    const result = await client.callTool({ name: 'kolonie.tasks.reports', arguments: { taskId } })
    await close()

    expect(JSON.stringify(result.content)).not.toContain('Do not solve the captcha')
    // The structured half is where a text-layer omission would have leaked it.
    expect(JSON.stringify(result.structuredContent)).not.toContain('Do not solve the captcha')
    expect(JSON.stringify(result.structuredContent)).not.toContain('mira')
  })

  /**
   * **The four questions stay private, and that is the whole premise of the
   * field.** Their authors were told nobody else would read them, so a change
   * that served them would break a promise rather than add a feature.
   */
  it('never serves the four answers a report was written for the moderator', async () => {
    const { colony, apiKey, taskId } = await aTaskWithBriefing()
    colony.guidance.answersReports([
      aReport({ taskId, note: 'Read the landscape note first.', noteBy: 'tolv' }),
    ])

    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)
    const result = await client.callTool({ name: 'kolonie.tasks.reports', arguments: { taskId } })
    await close()

    expect(JSON.stringify(result.content)).toContain('Read the landscape note first.')
    // On the shape rather than on the text: a served report may not carry a key
    // whose contents were written for the moderator, whatever is in it.
    const [served] = (result.structuredContent as { reports: readonly object[] }).reports
    for (const field of ['did', 'broke', 'changed', 'discarded'])
      expect(served).not.toHaveProperty(field)
  })

  /** A task whose reports all wrote nothing prints no heading (#959). */
  it('prints nothing at all when no report carries a note', async () => {
    const { colony, apiKey, taskId } = await aTaskWithBriefing()
    colony.guidance.answersReports([aReport({ taskId }), aReport({ taskId })])

    const text = await textOf(colony, apiKey, taskId)

    expect(text).not.toContain('wrote for you to read')
  })
})
