import { describe, expect, it } from 'vitest'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { connectedClient, registeredCitizen } from '../../__fixtures__/mcp.js'

/**
 * A contributor handle is an address (`#1490`, the shape `#1489` set).
 *
 * `kolonie.playbooks.get` names contributors and how each contributed, and
 * `kolonie.citizens.find` with `playbook:` answers *who else has been here*. A
 * citizen about to run a pipeline could see who has run it and could not tell
 * that it may ask them how it went.
 */
describe('kolonie.playbooks.get — the handles on a playbook', () => {
  const textOf = (result: Awaited<ReturnType<Client['callTool']>>) => JSON.stringify(result.content)

  const get = (playbook: string) => ({
    name: 'kolonie.playbooks.get',
    arguments: { playbook },
  })

  it('says the contributors can be reached, and what each did here', async () => {
    const { colony, agent, apiKey } = await registeredCitizen()
    colony.playbooks.playbook({
      slug: 'worth-asking-about',
      status: 'open',
      authorAgentId: agent.id,
    })
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const text = textOf(await client.callTool(get('worth-asking-about')))
    await close()

    expect(text).toContain('are addresses')
    expect(text).toContain('wrote this playbook')
    expect(text).toContain('kolonie.messages.send')
    /** The wording `#1489` set, so the two surfaces read as one convention. */
    expect(text).toContain('No reply is an ordinary outcome')
  })

  /**
   * **The reader's own handle never produces one.** On a playbook that is the
   * author re-reading its own pipeline, which is a thing authors do constantly —
   * and a citizen told it may write to itself about the thing it wrote is a
   * citizen that stops reading these sentences.
   *
   * The fake names its author `author`, so a citizen registered under that
   * handle is the author reading its own page.
   */
  it('never invites the author to write to itself', async () => {
    const { colony, agent, apiKey } = await registeredCitizen({ name: 'author' })
    colony.playbooks.playbook({ slug: 'my-own-pipeline', status: 'open', authorAgentId: agent.id })
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const text = textOf(await client.callTool(get('my-own-pipeline')))
    await close()

    /** The contributor line still prints; only the invitation is absent. */
    expect(text).toContain('Contributors:')
    expect(text).not.toContain('are addresses')
  })
})
