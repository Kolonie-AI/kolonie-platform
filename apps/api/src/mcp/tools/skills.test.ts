import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { FAKE_CALLER_IP, fakeColony, type FakeColony } from '../../__fixtures__/colony/index.js'
import { connectedClient } from '../../__fixtures__/mcp.js'

/**
 * A note against a capability, after the pattern of `kolonie.tasks.note`
 * (`#348`).
 *
 * **The argument for a second note is the moment it is read.** A task note is
 * written during an attempt and read when the task is looked at again; a skill
 * is used *afterwards*, in a quest that has nothing to do with the rung that
 * proved it. Measured 2026-08-05 against commit `bb6aca1`, `agent_skills`
 * carried `agent_id`, `skill`, `submission_id`, `granted_at` — a record that
 * something was awarded and nothing else.
 */
describe('kolonie.skills.note', () => {
  const aCitizenHolding = async (colony: FakeColony, ...skills: readonly string[]) => {
    const registered = await colony.registry.register(
      { name: `noting-${randomUUID().slice(0, 8)}`, platform: 'openclaw' },
      { ip: FAKE_CALLER_IP },
    )
    if (registered.outcome !== 'registered') throw new Error('fixture failed to register')

    const { agent, credentials } = registered.response
    for (const skill of skills) colony.skillNotes.grant(agent.id, skill)
    return { agent, apiKey: credentials.apiKey }
  }

  const note = async (colony: FakeColony, apiKey: string, args: Record<string, unknown>) => {
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)
    const result = await client.callTool({ name: 'kolonie.skills.note', arguments: args })
    await close()
    return result
  }

  it('writes a note against a skill the citizen holds, and reads it back', async () => {
    const colony = fakeColony()
    const { apiKey } = await aCitizenHolding(colony, 'browser')

    const written = await note(colony, apiKey, {
      skill: 'browser',
      note: 'Start it headless or the challenge page never renders.',
    })

    expect(written.isError).toBeFalsy()

    const read = await note(colony, apiKey, { skill: 'browser' })
    expect(JSON.stringify(read.content)).toContain('never renders')
  })

  /** The rejection case the issue names. */
  it('refuses a note against a skill the citizen does not hold', async () => {
    const colony = fakeColony()
    const { apiKey } = await aCitizenHolding(colony, 'browser')

    const refused = await note(colony, apiKey, { skill: 'wallet', note: 'Something.' })

    expect(refused.isError).toBe(true)
    expect(JSON.stringify(refused.content)).toContain('You do not hold wallet')
  })

  it('replaces the note rather than keeping two', async () => {
    const colony = fakeColony()
    const { apiKey } = await aCitizenHolding(colony, 'browser')
    await note(colony, apiKey, { skill: 'browser', note: 'The old thing I believed.' })

    await note(colony, apiKey, { skill: 'browser', note: 'What turned out to be true.' })

    const read = await note(colony, apiKey, { skill: 'browser' })
    expect(JSON.stringify(read.content)).toContain('turned out to be true')
    expect(JSON.stringify(read.content)).not.toContain('old thing')
  })

  /**
   * `null` clears and an absent field reads. Two different intentions, and a
   * shape that let them share a request would silently do the first — the rule
   * `SetTaskNoteRequestSchema` states.
   */
  it('forgets it on null, and reads without touching it when the field is absent', async () => {
    const colony = fakeColony()
    const { apiKey } = await aCitizenHolding(colony, 'browser')
    await note(colony, apiKey, { skill: 'browser', note: 'Something.' })

    const read = await note(colony, apiKey, { skill: 'browser' })
    expect(JSON.stringify(read.content)).toContain('Something.')

    const cleared = await note(colony, apiKey, { skill: 'browser', note: null })
    expect(JSON.stringify(cleared.content)).toContain('forgotten')

    const gone = await note(colony, apiKey, { skill: 'browser' })
    expect(JSON.stringify(gone.content)).toContain('written nothing')
  })

  /**
   * The rule this whole surface is built on: a note read by anybody but its
   * author is a report that skipped moderation.
   */
  it('never hands one citizen another’s note', async () => {
    const colony = fakeColony()
    const mine = await aCitizenHolding(colony, 'browser')
    const theirs = await aCitizenHolding(colony, 'browser')
    await note(colony, theirs.apiKey, { skill: 'browser', note: 'Something private to them.' })

    const read = await note(colony, mine.apiKey, { skill: 'browser' })

    expect(JSON.stringify(read.content)).not.toContain('private to them')
  })

  it('refuses a skill slug that is not one', async () => {
    const colony = fakeColony()
    const { apiKey } = await aCitizenHolding(colony, 'browser')

    const refused = await note(colony, apiKey, { skill: 'Not A Skill', note: 'Something.' })

    expect(refused.isError).toBe(true)
  })
})
