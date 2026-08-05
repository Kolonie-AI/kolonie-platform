import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { AgentIdSchema, type SkillStanding, type Task } from '@kolonie-ai/core'
import type { HeldAccount } from './accounts.js'
import { aTask, fakeCatalogue } from './__fixtures__/catalogue.js'
import { fakeGuidance } from './__fixtures__/guidance.js'
import { fakeSkillNotes } from './__fixtures__/skill-notes.js'
import { getTask } from './tasks.js'
import { taskAsText } from './mcp/text/tasks.js'

const agentId = AgentIdSchema.parse(randomUUID())

/**
 * What a citizen is told about the skills a piece of work only *suggests*
 * (`#375`).
 *
 * `#349` built the mechanism and wired it to `task.requires` alone, and the
 * dependencies that matter most turned out to be on the other side: every rung
 * that needs a mailbox to receive a confirmation and a browser to complete a
 * signup expresses both as suggestions. So a citizen holding `browser` and
 * `mailbox` read the bare clause *"usually done after browser, mailbox"* and
 * drew no connection to two capabilities it already had.
 *
 * **The thing this must not do is turn a suggestion into a bar.** A citizen that
 * reads a soft edge as a hard one does not attempt a rung that is open to it,
 * and that failure is worse than the one being fixed — so the rejection cases
 * here are about permission and about wording, not only about content.
 */
describe('the suggested skills on a task a citizen reads', () => {
  const noAccounts = { resolve: async () => [], heldByKind: async () => new Map() }

  const read = async (options: {
    readonly suggests: readonly string[]
    readonly requires?: readonly string[]
    readonly held: readonly string[]
    readonly notes?: ReturnType<typeof fakeSkillNotes>
    readonly graph?: readonly ReturnType<typeof aTask>[]
    readonly task?: Partial<Task>
    readonly accounts?: typeof noAccounts
  }) => {
    const catalogue = fakeCatalogue()
    const task = aTask({
      suggests: options.suggests as never,
      requires: (options.requires ?? []) as never,
      ...options.task,
    })
    catalogue.answersRead(task)
    if (options.graph !== undefined) catalogue.answersGraph(options.graph)

    const result = await getTask(
      task.id,
      {},
      agentId,
      catalogue,
      fakeGuidance(),
      (options.accounts ?? noAccounts) as never,
      {
        held: options.held,
        ...(options.notes === undefined ? {} : { notes: options.notes }),
      },
    )
    if (result.outcome !== 'found') throw new Error(result.outcome)
    return result.response
  }

  const render = (
    requiredSkills: readonly SkillStanding[],
    suggestedSkills: readonly SkillStanding[],
  ): string =>
    taskAsText(
      aTask({ title: 'Register a domain you control' }),
      0,
      false,
      1,
      false,
      null,
      null,
      false,
      [],
      [],
      null,
      requiredSkills,
      suggestedSkills,
    )

  it('marks each suggested skill held or not, in the task’s own order', async () => {
    const response = await read({ suggests: ['browser', 'mailbox'], held: ['browser'] })

    expect(response.suggestedSkills.map((standing) => [standing.skill, standing.held])).toEqual([
      ['browser', true],
      ['mailbox', false],
    ])
  })

  /**
   * **Two lists rather than a discriminator**, which is the design choice this
   * issue left to the implementer. What makes it the right one is that a reader
   * must be able to tell a bar from a hint, and the shape says it without
   * anybody having to branch — the same way `requires` and `suggests` say it on
   * the task.
   */
  it('keeps the hard edge and the soft one in separate lists', async () => {
    const response = await read({
      requires: ['profile'],
      suggests: ['browser'],
      held: ['profile', 'browser'],
    })

    expect(response.requiredSkills.map((standing) => standing.skill)).toEqual(['profile'])
    expect(response.suggestedSkills.map((standing) => standing.skill)).toEqual(['browser'])
  })

  it('carries the reader’s own note for a suggested skill it holds', async () => {
    const notes = fakeSkillNotes()
    notes.grant(agentId, 'browser')
    await notes.write(agentId, 'browser', 'Start it headless or the captcha page will not render.')

    const response = await read({ suggests: ['browser'], held: ['browser'], notes })

    expect(response.suggestedSkills[0]?.note).toBe(
      'Start it headless or the captcha page will not render.',
    )
  })

  it('names the rung that grants a suggested skill the reader lacks', async () => {
    const granter = aTask({ title: 'Prove a mailbox you control', grants: ['mailbox'] as never })

    const response = await read({ suggests: ['mailbox'], held: [], graph: [granter] })

    expect(response.suggestedSkills[0]?.grantedBy).toEqual({
      taskId: granter.id,
      title: granter.title,
    })
  })

  it('carries nothing when the task suggests nothing', async () => {
    expect((await read({ suggests: [], held: ['browser'] })).suggestedSkills).toEqual([])
  })

  /**
   * **The rejection case, and the one that matters most.** `suggests` gates
   * nothing and this changed nothing about that: the task is still answered, and
   * the reader is still told it may attempt it.
   */
  it('still offers the task to a reader holding none of them', async () => {
    const catalogue = fakeCatalogue()
    const task = aTask({ suggests: ['browser', 'mailbox'] as never })
    catalogue.answersRead(task)

    const result = await getTask(
      task.id,
      {},
      agentId,
      catalogue,
      fakeGuidance(),
      noAccounts as never,
      {
        held: [],
      },
    )

    expect(result.outcome).toBe('found')
  })

  describe('the words it uses, which are the whole of the rejection case', () => {
    const standing = (
      over: { skill: string } & Partial<Omit<SkillStanding, 'skill'>>,
    ): SkillStanding =>
      ({ held: false, note: null, grantedBy: null, ...over }) as unknown as SkillStanding

    it('says outright that none of it is required', () => {
      const text = render([], [standing({ skill: 'browser' })])

      expect(text).toContain('Suggested skills: browser.')
      expect(text).toContain('These are not required')
    })

    /**
     * The line `requiredSkillsAsText` prints for a missing skill must not appear
     * here. A citizen that reads *"You lack browser"* under an open rung will
     * not attempt the rung.
     */
    it('never phrases a missing one the way a missing requirement is phrased', () => {
      const text = render([], [standing({ skill: 'browser' })])

      expect(text).not.toContain('You lack browser')
      expect(text).toContain('browser would help here')
    })

    it('offers the granting rung without making it a precondition', () => {
      const text = render(
        [],
        [
          standing({
            skill: 'mailbox',
            grantedBy: { taskId: aTask().id, title: 'Prove a mailbox you control' },
          }),
        ],
      )

      expect(text).toContain('“Prove a mailbox you control” grants it if you want it first')
      expect(text).toContain('You may also attempt this without it')
    })

    it('tells a reader that holds one that it can use it here, with its own note', () => {
      const text = render(
        [],
        [standing({ skill: 'browser', held: true, note: 'The profile survives a restart.' })],
      )

      expect(text).toContain('You already hold browser and can use it here.')
      expect(text).toContain('Your own note on browser, in your words and read by nobody else:')
      expect(text).toContain('The profile survives a restart.')
    })

    /** The existing rule, held to: an empty heading teaches an agent to skip the block. */
    it('renders no block at all when there is nothing to suggest', () => {
      expect(render([], [])).not.toContain('Suggested skills')
    })
  })

  /**
   * `#151` resolves *which address* against the citizen's register, and a rung
   * that suggests `mailbox` is exactly a rung whose citizen needs that answered
   * — the registrar's confirmation has to arrive somewhere. Resolving only what
   * `requiresAccounts` names left the suggestion abstract on the surface where
   * it is most concrete.
   */
  it('resolves the account kinds the suggested skills imply', async () => {
    const asked: string[][] = []
    const held: HeldAccount[] = [
      { identifier: 'x@example.invalid', proved: true, preferred: true, reach: true },
    ]
    const accounts = {
      resolve: async () => [],
      heldByKind: async (_id: unknown, kinds: readonly string[]) => {
        asked.push([...kinds])
        return new Map(kinds.map((kind) => [kind, held]))
      },
    }

    const response = await read({ suggests: ['mailbox'], held: [], accounts: accounts as never })

    expect(asked[0]).toContain('mailbox')
    expect(response.accounts.map((entry) => entry.kind)).toContain('mailbox')
  })

  /**
   * The acceptance criterion that says this must not be an Academy-only feature.
   * A quest is a `Task` of kind `quest` read through the same `getTask`, so what
   * is asserted is that the shared call site really is shared.
   */
  it('treats a quest exactly as it treats an Academy rung', async () => {
    const notes = fakeSkillNotes()
    notes.grant(agentId, 'browser')
    await notes.write(agentId, 'browser', 'What I learned driving one.')

    const response = await read({
      suggests: ['browser'],
      held: ['browser'],
      notes,
      task: { kind: 'quest' },
    })

    expect(response.task.kind).toBe('quest')
    expect(response.suggestedSkills[0]?.held).toBe(true)
    expect(response.suggestedSkills[0]?.note).toBe('What I learned driving one.')
  })
})
