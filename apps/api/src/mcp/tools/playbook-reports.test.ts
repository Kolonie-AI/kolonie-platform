import { emptyPlaybookSignalsTally, PLAYBOOK_SIGNALS_UNVERIFIED_LABEL } from '@kolonie-ai/core'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { describe, expect, it } from 'vitest'
import { connectedClient, registeredCitizen } from '../../__fixtures__/mcp.js'
import type { PlaybookReportsResult } from '../../playbooks.js'

/**
 * What running a playbook has produced (`#1247`, `#1251`, `#1252`).
 *
 * Storage asserts the SQL — that only `notePublished` is selected, that
 * `attributed: false` blanks the handle, that pending and rejected notes stay
 * out. This side asserts the decision the tool makes: which playbooks may be
 * read at all, that `briefing` is the current/demoted split, that no derived
 * earnings appear, that signal tallies carry the unverified label, and that
 * `get` carries the small activity block (with signals) that points here.
 */
const reports = (args: Record<string, unknown>) => ({
  name: 'kolonie.playbooks.reports',
  arguments: args,
})

const get = (playbook: string) => ({
  name: 'kolonie.playbooks.get',
  arguments: { playbook },
})

const resultOf = (result: Awaited<ReturnType<Client['callTool']>>) =>
  result.structuredContent as unknown as PlaybookReportsResult

const textOf = (result: Awaited<ReturnType<Client['callTool']>>) => JSON.stringify(result.content)

const aCitizen = async () => {
  const { colony, agent, apiKey } = await registeredCitizen()
  return { colony, agent, ...(await connectedClient(colony, `Bearer ${apiKey}`)) }
}

describe('kolonie.playbooks.reports (#1247)', () => {
  it('answers counts, empty notes and an empty briefing on an open playbook with no runs', async () => {
    const { colony, client, close } = await aCitizen()
    const playbook = colony.playbooks.playbook({ slug: 'quiet-pipeline', status: 'open' })

    try {
      const read = await client.callTool(reports({ playbook: playbook.slug }))

      expect(read.isError).toBeFalsy()
      const body = resultOf(read)
      expect(body.activity.total).toBe(0)
      expect(body.activity.byOutcome).toEqual({
        completed: 0,
        blocked: 0,
        abandoned: 0,
        'operator-needed': 0,
      })
      expect(body.signals).toEqual(emptyPlaybookSignalsTally(0))
      expect(body.briefing).toEqual({ current: [], demoted: [] })
      expect(body.notes).toEqual([])
      expect(body.nextCursor).toBeNull()
      expect(JSON.stringify(body)).not.toMatch(/earning|lamport|sol\b/i)
      expect(textOf(read)).toContain('Briefing: nothing written up yet')
      expect(textOf(read)).toContain(PLAYBOOK_SIGNALS_UNVERIFIED_LABEL)
    } finally {
      await close()
    }
  })

  it('tallies signals with the unverified label and the report total (#1252)', async () => {
    const { colony, agent, client, close } = await aCitizen()
    const playbook = colony.playbooks.playbook({ slug: 'signalled-pipeline', status: 'open' })

    try {
      await colony.playbooks.runs.record({
        playbookId: playbook.id,
        agentId: agent.id,
        report: {
          outcome: 'completed',
          did: 'Finished and saw replies arrive.',
          signals: ['traffic', 'payout-offplatform'],
        },
      })

      const read = await client.callTool(reports({ playbook: playbook.slug }))

      expect(read.isError).toBeFalsy()
      const body = resultOf(read)
      expect(body.signals).toEqual({
        reports: 1,
        ban: 0,
        traffic: 1,
        'payout-offplatform': 1,
        label: PLAYBOOK_SIGNALS_UNVERIFIED_LABEL,
      })
      expect(textOf(read)).toContain(PLAYBOOK_SIGNALS_UNVERIFIED_LABEL)
      expect(textOf(read)).toContain('of 1')
      expect(JSON.stringify(body)).not.toMatch(/earning|lamport|sol\b/i)
    } finally {
      await close()
    }
  })

  it('serves an approved note and never the four answers', async () => {
    const { colony, agent, client, close } = await aCitizen()
    const playbook = colony.playbooks.playbook({ slug: 'noted-pipeline', status: 'open' })

    try {
      const { run } = await colony.playbooks.runs.record({
        playbookId: playbook.id,
        agentId: agent.id,
        report: {
          outcome: 'blocked',
          did: 'Opened the form and stopped at the captcha wall.',
          broke: 'The captcha never rendered a code I could read.',
          note: 'The signup form is behind a captcha that never finishes loading.',
        },
      })
      // Force the publication the moderator would write — the fixture has no runner.
      run.noteStatus = 'approved'
      run.notePublished = run.note

      const read = await client.callTool(reports({ playbook: playbook.slug }))

      expect(read.isError).toBeFalsy()
      const body = resultOf(read)
      expect(body.activity.total).toBe(1)
      expect(body.activity.byOutcome.blocked).toBe(1)
      expect(body.notes).toHaveLength(1)
      expect(body.notes[0]?.note).toBe(run.note)
      expect(body.notes[0]?.outcome).toBe('blocked')
      const serialised = JSON.stringify(body)
      expect(serialised).not.toContain(run.did)
      expect(serialised).not.toContain(run.broke)
    } finally {
      await close()
    }
  })

  it('refuses a draft the caller does not own, the same way get does', async () => {
    const { colony, client, close } = await aCitizen()
    colony.playbooks.playbook({ slug: 'somebody-elses-draft', status: 'draft' })

    try {
      const read = await client.callTool(reports({ playbook: 'somebody-elses-draft' }))

      expect(read.isError).toBeTruthy()
      expect(textOf(read)).toMatch(/no playbook/i)
    } finally {
      await close()
    }
  })

  it('get carries the activity summary — with signal tally — that points at reports', async () => {
    const { colony, agent, client, close } = await aCitizen()
    const playbook = colony.playbooks.playbook({ slug: 'active-pipeline', status: 'open' })

    try {
      await colony.playbooks.runs.record({
        playbookId: playbook.id,
        agentId: agent.id,
        report: {
          outcome: 'completed',
          did: 'Ran every step in order and got to the end.',
          signals: ['ban'],
        },
      })

      const read = await client.callTool(get(playbook.slug))

      expect(read.isError).toBeFalsy()
      const activity = (
        read.structuredContent as {
          activity: {
            total: number
            byOutcome: Record<string, number>
            signals: {
              reports: number
              ban: number
              traffic: number
              'payout-offplatform': number
              label: string
            }
          }
        }
      ).activity
      expect(activity.total).toBe(1)
      expect(activity.byOutcome.completed).toBe(1)
      expect(activity.signals).toEqual({
        reports: 1,
        ban: 1,
        traffic: 0,
        'payout-offplatform': 0,
        label: PLAYBOOK_SIGNALS_UNVERIFIED_LABEL,
      })
      expect(textOf(read)).toContain('kolonie.playbooks.reports')
      expect(textOf(read)).toContain(PLAYBOOK_SIGNALS_UNVERIFIED_LABEL)
      // Notes and the full briefing split stay in reports; get carries claims.
      expect(read.structuredContent as object).not.toHaveProperty('notes')
      expect(read.structuredContent as object).not.toHaveProperty('briefing')
      expect((read.structuredContent as { claims: unknown[] }).claims).toEqual([])
    } finally {
      await close()
    }
  })
})
