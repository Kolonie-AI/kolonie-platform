import { describe, expect, it } from 'vitest'
import type { AgentId } from '@kolonie-ai/core'
import { createDrop, type DropStore } from './operator-drops.js'

const AGENT = 'agent-1' as AgentId

/**
 * A store that records what reached it, so a refusal can be told from a drop
 * that was opened and happened to look wrong afterwards.
 */
function recordingStore(): { store: DropStore; opened: unknown[] } {
  const opened: unknown[] = []
  const store = {
    open: async (command: unknown) => {
      opened.push(command)
      return { id: 'drop-1', token: 'tok', expiresAt: '2026-08-18T00:00:00.000Z' }
    },
  } as unknown as DropStore
  return { store, opened }
}

/**
 * What a drop may be asked for, at the surface that mints it (`#938`).
 *
 * The refusal is in `packages/core`, and what these cover is that it is reached
 * before anything is opened — the whole cost of the bug was an operator being
 * handed a link, so a refusal that arrived after `open` would not have helped
 * the citizen that reported it.
 */
describe('createDrop', () => {
  it('refuses a prompt asking for a password that already exists, before opening anything', async () => {
    const { store, opened } = recordingStore()

    const result = await createDrop(
      AGENT,
      {
        kind: 'credential',
        prompt: 'Please paste the GitHub account password here.',
        vaultKey: 'github/octocat',
      },
      { drops: store, dropBaseUrl: 'https://console.example' },
    )

    expect(result.outcome).toBe('rejected')
    expect(opened).toHaveLength(0)
    if (result.outcome !== 'rejected') return
    expect(result.error.code).toBe('validation_failed')
    expect(result.error.message).toContain('kolonie.accounts.handoff')
    expect(result.error.message).toContain('kolonie.accounts.handover')
  })

  it('refuses key material outright', async () => {
    const { store } = recordingStore()

    const result = await createDrop(
      AGENT,
      { kind: 'credential', prompt: 'Put the seed phrase in here.', vaultKey: 'wallet/main' },
      { drops: store, dropBaseUrl: 'https://console.example' },
    )

    expect(result.outcome).toBe('rejected')
    if (result.outcome !== 'rejected') return
    expect(result.error.message).toContain('Key material stays')
  })

  /**
   * The route `handovers.ts` recommends to an agent whose operator holds no
   * console. It says the words in the prompt, and it has to go through — a guard
   * that refused it would close the only channel that case has.
   */
  it('opens the drop the no-console refusal sends an agent to', async () => {
    const { store, opened } = recordingStore()

    const result = await createDrop(
      AGENT,
      {
        kind: 'credential',
        prompt: 'The password you set at the signup form for the mailbox.',
        vaultKey: 'mail/citizen',
      },
      { drops: store, dropBaseUrl: 'https://console.example' },
    )

    expect(result.outcome).toBe('created')
    expect(opened).toHaveLength(1)
  })

  it('says nothing about a token, which is what the channel is for', async () => {
    const { store } = recordingStore()

    const result = await createDrop(
      AGENT,
      {
        kind: 'credential',
        prompt: 'A personal access token with repo scope.',
        vaultKey: 'github/token',
      },
      { drops: store, dropBaseUrl: 'https://console.example' },
    )

    expect(result.outcome).toBe('created')
  })
})
