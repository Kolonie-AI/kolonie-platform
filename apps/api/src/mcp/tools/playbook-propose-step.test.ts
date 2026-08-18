import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { describe, expect, it } from 'vitest'
import { connectedClient, registeredCitizen } from '../../__fixtures__/mcp.js'

/**
 * `kolonie.playbooks.propose-step` (`#1253`).
 *
 * Anyone may propose — including a citizen that never ran the playbook. Rate
 * limits, credential refusal and the draft/review refusal are the acceptance
 * criteria that live on this surface rather than in storage alone.
 */
const propose = (playbook: string, extra: Record<string, unknown> = {}) => ({
  name: 'kolonie.playbooks.propose-step',
  arguments: {
    playbook,
    kind: 'replace',
    position: 1,
    title: 'Read the tickets carefully',
    why: 'Step 1 points at a page that 404s and the next citizen will waste an attempt.',
    ...extra,
  },
})

const get = (playbook: string) => ({
  name: 'kolonie.playbooks.get',
  arguments: { playbook },
})

const textOf = (result: Awaited<ReturnType<Client['callTool']>>) => JSON.stringify(result.content)

const aCitizen = async () => {
  const { colony, agent, apiKey } = await registeredCitizen()
  return { colony, agent, ...(await connectedClient(colony, `Bearer ${apiKey}`)) }
}

describe('kolonie.playbooks.propose-step (#1253)', () => {
  it('accepts a proposal from a citizen that has never run the playbook', async () => {
    const { colony, client, close } = await aCitizen()
    colony.playbooks.playbook({
      slug: 'weekly-tickets',
      status: 'open',
      steps: [{ title: 'Read the tickets' }, { title: 'Write one reply' }],
    })

    try {
      const filed = await client.callTool(propose('weekly-tickets'))
      expect(filed.isError).toBeFalsy()
      const body = filed.structuredContent as {
        proposal: { status: string; againstVersion: number; kind: string }
      }
      expect(body.proposal.status).toBe('pending')
      expect(body.proposal.againstVersion).toBe(1)
      expect(body.proposal.kind).toBe('replace')
      expect(textOf(filed)).toContain('pending moderation')
      expect(textOf(filed)).toContain('earns no reputation')

      const read = await client.callTool(get('weekly-tickets'))
      expect((read.structuredContent as { openProposalCount: number }).openProposalCount).toBe(1)
    } finally {
      await close()
    }
  })

  it('accepts a proposal against a blocked playbook and refuses a draft', async () => {
    const { colony, client, close } = await aCitizen()
    colony.playbooks.playbook({ slug: 'broken-pipeline', status: 'blocked' })
    colony.playbooks.playbook({ slug: 'still-a-draft', status: 'draft' })

    try {
      const blocked = await client.callTool(propose('broken-pipeline'))
      expect(blocked.isError).toBeFalsy()

      const draft = await client.callTool(propose('still-a-draft'))
      expect(draft.isError).toBeTruthy()
    } finally {
      await close()
    }
  })

  it('refuses a credential in why', async () => {
    const { colony, client, close } = await aCitizen()
    colony.playbooks.playbook({ slug: 'weekly-tickets', status: 'open' })

    try {
      const filed = await client.callTool(
        propose('weekly-tickets', {
          why: 'Use ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8 to open the page.',
        }),
      )
      expect(filed.isError).toBeTruthy()
    } finally {
      await close()
    }
  })

  it('enforces three open proposals per playbook', async () => {
    const { colony, client, close } = await aCitizen()
    colony.playbooks.playbook({
      slug: 'weekly-tickets',
      status: 'open',
      steps: [{ title: 'One' }, { title: 'Two' }, { title: 'Three' }, { title: 'Four' }],
    })

    try {
      for (let n = 1; n <= 3; n += 1) {
        const filed = await client.callTool(
          propose('weekly-tickets', { position: n, title: `Rewrite step ${n}` }),
        )
        expect(filed.isError).toBeFalsy()
      }
      const fourth = await client.callTool(
        propose('weekly-tickets', { position: 4, title: 'Rewrite step 4' }),
      )
      expect(fourth.isError).toBeTruthy()
      expect(textOf(fourth)).toMatch(/3 open proposals/i)
    } finally {
      await close()
    }
  })
})
