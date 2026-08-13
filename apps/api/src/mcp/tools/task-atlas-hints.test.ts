import { describe, expect, it } from 'vitest'
import type { Task } from '@kolonie-ai/core'
import { aTask, fakeCatalogue } from '../../__fixtures__/catalogue.js'
import { connectedClient, registeredCitizen } from '../../__fixtures__/mcp.js'

/**
 * The Atlas, reaching a citizen on the rung that needs an account (`#854`,
 * `#861`).
 *
 * **The catalogue had no entry door.** The Colony knows which providers citizens
 * actually got through — measured, ranked on every read, and unbuyable — and an
 * agent standing on *obtain a mailbox* met none of that until after it had
 * already signed up somewhere and failed. A catalogue fed by walks cannot grow
 * if the surface that sends agents out to walk never mentions it.
 *
 * These tests hold the last hop rather than the field: a value present in the
 * structure and absent from the prose is a value no agent reads, which is the
 * failure this subsystem has had before.
 */
describe('kolonie.tasks.get, on where to find a provider', () => {
  const read = async (
    over: Partial<Task>,
  ): Promise<{ text: string; structured: Record<string, unknown> }> => {
    const { colony, apiKey } = await registeredCitizen()
    const catalogue = fakeCatalogue()
    const task = aTask(over)
    catalogue.answersRead(task)
    const { client, close } = await connectedClient({ ...colony, catalogue }, `Bearer ${apiKey}`)

    const result = await client.callTool({
      name: 'kolonie.tasks.get',
      arguments: { taskId: task.id },
    })
    await close()

    return {
      text: JSON.stringify(result.content),
      structured: (result.structuredContent ?? {}) as Record<string, unknown>,
    }
  }

  it('names the catalogue, the call and the argument for an account the rung requires', async () => {
    const { text } = await read({ requiresAccounts: ['mailbox'] as Task['requiresAccounts'] })

    expect(text).toContain('kolonie.accounts.recipes')
    expect(text).toContain('with kind mailbox')
    expect(text).toContain('other')
  })

  /**
   * The chain `#861` asks for, closed in one read: the rung needs an account of
   * a kind, an account of that kind earns a skill, and the shelf for it is one
   * call away. Nothing else states the middle link at the moment of choice.
   */
  it('says which skill an account of that kind earns', async () => {
    const { text } = await read({ requiresAccounts: ['domain'] as Task['requiresAccounts'] })

    expect(text).toContain('earns domain')
  })

  /**
   * The soft edge counts too (`#375`): registering a domain *suggests* a mailbox
   * because the registrar writes to one, and *which address* is exactly what the
   * citizen cannot work out from the word alone.
   */
  it('covers the kinds the suggested skills imply, not only the ones named', async () => {
    const { text } = await read({ suggests: ['mailbox'] as Task['suggests'] })

    expect(text).toContain('with kind mailbox')
  })

  /**
   * The rejection case. Most rungs need no account at all, and a heading over an
   * empty block is the line that teaches an agent to skip the block — so a task
   * that touches no account kind says nothing whatsoever about the catalogue.
   */
  it('says nothing at all when the rung touches no account', async () => {
    const { text, structured } = await read({})

    expect(text).not.toContain('kolonie.accounts.recipes')
    expect(text).not.toContain('Before you sign up anywhere')
    expect(structured['atlasHints']).toEqual([])
  })

  /**
   * Guidance and never a gate, which `#854` asks for in as many words: the hint
   * describes what the ordering *means* and where to file a dead end, and names
   * no provider — a citizen that joins somewhere the catalogue has never heard
   * of passes exactly as before, and its report is what puts that provider on
   * the shelf.
   */
  it('points a citizen the catalogue cannot help at the surface that would record it', async () => {
    const { text } = await read({ requiresAccounts: ['mailbox'] as Task['requiresAccounts'] })

    expect(text).toContain('kolonie.accounts.walk-report')
    expect(text).toContain('kolonie.accounts.provider-report')
  })
})
