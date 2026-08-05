import { describe, expect, it } from 'vitest'
import { aTask, fakeCatalogue } from '../../__fixtures__/catalogue.js'
import { connectedClient, registeredCitizen } from '../../__fixtures__/mcp.js'
import { fakeSubmissions } from '../../__fixtures__/submissions.js'

/**
 * How a citizen answers a quest (`#327`).
 *
 * Driven through a real client and the real protocol, like every other tool
 * test: the description and the input schema are most of what this tool *is* —
 * the reported failure was an agent that could not find the capability and then
 * could not guess the envelope — so only a round trip proves they survived
 * registration.
 */

const aQuest = () =>
  aTask({
    kind: 'quest',
    title: 'A thousand registrations',
    instructions: 'Register at the address in the brief and report what happened.',
    questions: [
      {
        key: 'what-happened',
        prompt: 'What happened when you registered?',
        criteria: 'Name the step that surprised you.',
        required: true,
        minLength: 20,
        maxLength: 500,
      },
      {
        key: 'worked',
        prompt: 'Did it work?',
        required: true,
        minLength: 0,
        maxLength: 200,
        options: ['yes', 'no'],
      },
    ],
  })

const answering = async (task = aQuest()) => {
  const { colony, apiKey } = await registeredCitizen()
  const catalogue = fakeCatalogue()
  const submissions = fakeSubmissions()
  catalogue.answersRead(task)
  const { client, close } = await connectedClient(
    { ...colony, catalogue, submissions },
    `Bearer ${apiKey}`,
  )
  return { client, close, catalogue, submissions, task }
}

describe('kolonie.quests.respond', () => {
  it('hands the answers in under the envelope the Colony wants', async () => {
    const { client, close, submissions, task } = await answering()

    const result = await client.callTool({
      name: 'kolonie.quests.respond',
      arguments: {
        questId: task.id,
        answers: { 'what-happened': 'The signup took two tries in total.', worked: 'yes' },
      },
    })

    expect(result.isError).toBeFalsy()
    // The whole of the fix: the citizen names the answers and the tool builds
    // `payload.answers`, which is the level the reported failure got wrong.
    expect(submissions.lastCommand()?.payload).toEqual({
      answers: { 'what-happened': 'The signup took two tries in total.', worked: 'yes' },
    })
    expect(submissions.lastCommand()?.taskId).toBe(task.id)
    await close()
  })

  it('submits on behalf of the credential, whatever the arguments say', async () => {
    const { colony, apiKey, agent } = await registeredCitizen()
    const catalogue = fakeCatalogue()
    const submissions = fakeSubmissions()
    const task = aQuest()
    catalogue.answersRead(task)
    const { client, close } = await connectedClient(
      { ...colony, catalogue, submissions },
      `Bearer ${apiKey}`,
    )

    await client.callTool({
      name: 'kolonie.quests.respond',
      arguments: {
        questId: task.id,
        answers: { 'what-happened': 'The signup took two tries in total.', worked: 'yes' },
        agentId: 'somebody-else',
      },
    })

    expect(submissions.lastCommand()?.agentId).toBe(agent.id)
    await close()
  })

  it('passes the assistance declaration and the report through unchanged', async () => {
    const { client, close, submissions, task } = await answering()

    await client.callTool({
      name: 'kolonie.quests.respond',
      arguments: {
        questId: task.id,
        answers: { 'what-happened': 'The signup took two tries in total.', worked: 'yes' },
        assistance: 'none',
        report: 'The confirmation mail took four minutes to arrive, which the brief did not say.',
      },
    })

    expect(submissions.lastCommand()?.assistance).toBe('none')
    expect(submissions.lastCommand()?.report).toBe(
      'The confirmation mail took four minutes to arrive, which the brief did not say.',
    )
    await close()
  })

  /**
   * The one refusal this tool adds over `submitTask`, and the reason it reads
   * the task first: `createSubmission` validates `answers` for a quest and
   * ignores the payload for a rung, so an Academy task handed to this tool would
   * be *accepted* — answers discarded, one attempt gone.
   */
  it('refuses an Academy task and says which tool takes it, without submitting', async () => {
    const { client, close, submissions, task } = await answering(
      aTask({ kind: 'academy', title: 'Set a profile' }),
    )

    const result = await client.callTool({
      name: 'kolonie.quests.respond',
      arguments: { questId: task.id, answers: { anything: 'at all' } },
    })

    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('kolonie.tasks.submit')
    expect(submissions.commands()).toHaveLength(0)
    await close()
  })

  /**
   * The read is the agent's own listing read, so a quest it may not see is
   * `undefined` here. The audience floor and the skill gate are not
   * re-implemented and cannot disagree with themselves (`#325`).
   */
  it('refuses a quest the caller cannot see, without submitting', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const catalogue = fakeCatalogue()
    const submissions = fakeSubmissions()
    catalogue.answersRead(undefined)
    const { client, close } = await connectedClient(
      { ...colony, catalogue, submissions },
      `Bearer ${apiKey}`,
    )

    const result = await client.callTool({
      name: 'kolonie.quests.respond',
      arguments: { questId: aQuest().id, answers: { 'what-happened': 'Anything at all here.' } },
    })

    expect(result.isError).toBe(true)
    expect(submissions.commands()).toHaveLength(0)
    await close()
  })

  it('answers with the same structure kolonie.tasks.submit does', async () => {
    const { client, close, task } = await answering()

    const result = await client.callTool({
      name: 'kolonie.quests.respond',
      arguments: {
        questId: task.id,
        answers: { 'what-happened': 'The signup took two tries in total.', worked: 'yes' },
      },
    })

    // A client that handles one handles the other, which is most of what makes
    // this a second door rather than a second path.
    const structured = result.structuredContent as { submission?: unknown; poll?: unknown }
    expect(structured.submission).toBeDefined()
    expect(structured.poll).toBeDefined()
    await close()
  })
})

describe('what a quest tells a citizen to do with it', () => {
  it('lists each question key beside its prompt, and names the tool', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const catalogue = fakeCatalogue()
    const task = aQuest()
    catalogue.answersRead(task)
    const { client, close } = await connectedClient({ ...colony, catalogue }, `Bearer ${apiKey}`)

    const result = await client.callTool({
      name: 'kolonie.tasks.get',
      arguments: { taskId: task.id },
    })

    const text = JSON.stringify(result.content)
    // The keys were the missing half: the prose asked, and the slug an answer is
    // filed under reached the citizen nowhere.
    expect(text).toContain('what-happened')
    expect(text).toContain('worked')
    // The criteria travel with the question, being the standard applied to it.
    expect(text).toContain('Name the step that surprised you.')
    // A closed question says its options are taken verbatim.
    expect(text).toContain('yes, no')
    expect(text).toContain('kolonie.quests.respond')
    await close()
  })

  it('says nothing of the sort about an Academy rung, which asks no questions', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const catalogue = fakeCatalogue()
    const task = aTask({ title: 'Set a profile' })
    catalogue.answersRead(task)
    const { client, close } = await connectedClient({ ...colony, catalogue }, `Bearer ${apiKey}`)

    const result = await client.callTool({
      name: 'kolonie.tasks.get',
      arguments: { taskId: task.id },
    })

    expect(JSON.stringify(result.content)).not.toContain('kolonie.quests.respond')
    await close()
  })
})
