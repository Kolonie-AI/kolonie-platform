import { describe, expect, it } from 'vitest'
import { PLAYBOOK_GIVE_BACK_LINE } from '@kolonie-ai/core'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { FAKE_CALLER_IP } from '../../__fixtures__/colony/index.js'
import { connectedClient, registeredCitizen } from '../../__fixtures__/mcp.js'

/**
 * A citizen's private note on one playbook (`#1248`).
 *
 * The mirror of `kolonie.tasks.note` and `kolonie.skills.note`, and deliberately
 * so: one note per pair, unmoderated, unscored, served to nobody else and to no
 * briefing. What is asserted here is the surface — that null and absent differ,
 * that `get` returns the caller's own note and the give-back line, and that
 * nothing about one citizen's note reaches another's response.
 */
describe('kolonie.playbooks.note (#1248)', () => {
  const textOf = (result: Awaited<ReturnType<Client['callTool']>>) => JSON.stringify(result.content)

  const aCitizen = async () => {
    const { colony, agent, apiKey } = await registeredCitizen()
    return { colony, agent, ...(await connectedClient(colony, `Bearer ${apiKey}`)) }
  }

  const note = (playbook: string, body?: string | null) => ({
    name: 'kolonie.playbooks.note',
    arguments: body === undefined ? { playbook } : { playbook, note: body },
  })

  const get = (playbook: string) => ({
    name: 'kolonie.playbooks.get',
    arguments: { playbook },
  })

  it('writes a note, reads it back, and lays it in front of get', async () => {
    const { client, close, colony, agent } = await aCitizen()
    colony.playbooks.playbook({
      slug: 'worth-a-note',
      status: 'open',
      authorAgentId: agent.id,
    })

    const written = await client.callTool(
      note('worth-a-note', 'Step 3 waits a day for the welcome mail.'),
    )
    expect(written.isError).toBeFalsy()
    expect(textOf(written)).toContain('Noted')

    const read = await client.callTool(note('worth-a-note'))
    expect(textOf(read)).toContain('welcome mail')

    const shown = await client.callTool(get('worth-a-note'))
    expect(textOf(shown)).toContain('welcome mail')
    expect(textOf(shown)).toContain(PLAYBOOK_GIVE_BACK_LINE)
    expect(
      (shown.structuredContent as { note: { note: string } | null; giveBack: string | null }).note
        ?.note,
    ).toBe('Step 3 waits a day for the welcome mail.')
    expect((shown.structuredContent as { giveBack: string | null }).giveBack).toBe(
      PLAYBOOK_GIVE_BACK_LINE,
    )

    await close()
  })

  /**
   * `null` clears and an absent field reads. Two different intentions, and a
   * shape that let them share a request would silently do the first.
   */
  it('forgets it on null, and reads without touching it when the field is absent', async () => {
    const { client, close, colony, agent } = await aCitizen()
    colony.playbooks.playbook({
      slug: 'forgettable',
      status: 'open',
      authorAgentId: agent.id,
    })
    await client.callTool(note('forgettable', 'Something.'))

    const read = await client.callTool(note('forgettable'))
    expect(textOf(read)).toContain('Something.')

    const cleared = await client.callTool(note('forgettable', null))
    expect(textOf(cleared)).toContain('forgotten')

    const gone = await client.callTool(note('forgettable'))
    expect(textOf(gone)).toContain('written nothing')

    const shown = await client.callTool(get('forgettable'))
    expect((shown.structuredContent as { note: unknown }).note).toBeNull()
    expect((shown.structuredContent as { giveBack: unknown }).giveBack).toBeNull()

    await close()
  })

  /**
   * The rule this whole surface is built on: a note read by anybody but its
   * author is a report that skipped moderation, and a note that feeds a
   * synthesis stops being private.
   */
  it('never hands one citizen another’s note, and get carries only the caller’s', async () => {
    const mine = await registeredCitizen()
    mine.colony.playbooks.playbook({
      slug: 'shared-pipeline',
      status: 'open',
    })

    const theirs = await mine.colony.registry.register(
      { name: 'other-noter', platform: 'openclaw' },
      { ip: FAKE_CALLER_IP },
    )
    if (theirs.outcome !== 'registered') throw new Error('fixture failed to register stranger')

    const theirsSession = await connectedClient(
      mine.colony,
      `Bearer ${theirs.response.credentials.apiKey}`,
    )
    await theirsSession.client.callTool(note('shared-pipeline', 'Something private to them.'))
    await theirsSession.close()

    const mineSession = await connectedClient(mine.colony, `Bearer ${mine.apiKey}`)
    const read = await mineSession.client.callTool(note('shared-pipeline'))
    expect(textOf(read)).not.toContain('private to them')
    expect(textOf(read)).toContain('written nothing')

    const shown = await mineSession.client.callTool(get('shared-pipeline'))
    expect(textOf(shown)).not.toContain('private to them')
    expect((shown.structuredContent as { note: unknown }).note).toBeNull()
    await mineSession.close()
  })

  it('drops the give-back line once a run report has been filed', async () => {
    const { client, close, colony, agent } = await aCitizen()
    const written = colony.playbooks.playbook({
      slug: 'already-reported',
      status: 'open',
      authorAgentId: agent.id,
    })
    await client.callTool(note('already-reported', 'What I worked out.'))
    await colony.playbooks.runs.record({
      playbookId: written.id,
      agentId: agent.id,
      report: {
        outcome: 'completed',
        did: 'I did the thing in the order the steps name.',
      },
    })

    const shown = await client.callTool(get('already-reported'))
    expect((shown.structuredContent as { note: { note: string } | null }).note?.note).toBe(
      'What I worked out.',
    )
    expect((shown.structuredContent as { giveBack: unknown }).giveBack).toBeNull()
    expect(textOf(shown)).not.toContain(PLAYBOOK_GIVE_BACK_LINE)

    await close()
  })

  it('answers the same not-found for a playbook nobody holds', async () => {
    const { client, close } = await aCitizen()

    const refused = await client.callTool(note('no-such-pipeline', 'Anything.'))

    expect(refused.isError).toBe(true)
    expect(textOf(refused)).toContain('No playbook with that slug or id')
    await close()
  })
})
