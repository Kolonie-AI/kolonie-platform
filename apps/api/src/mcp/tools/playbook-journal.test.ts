import { randomUUID } from 'node:crypto'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { describe, expect, it } from 'vitest'
import { FAKE_CALLER_IP } from '../../__fixtures__/colony/index.js'
import { connectedClient, registeredCitizen } from '../../__fixtures__/mcp.js'
import type { PlaybookReadResult, PlaybookRunResult } from '../../playbooks.js'

/**
 * The run journal (`#1422`): several dated entries per citizen, append-only.
 *
 * ## What is worth asserting, and what is not
 *
 * The moderation pipeline is the run note's, shared rather than copied, and it
 * is tested where it lives. What is new here is the **shape**: that an entry is
 * added rather than replacing the last one, that the 400-character verdict note
 * beside it is untouched, and that an entry reaches another citizen only once a
 * moderator has approved it.
 *
 * So every assertion below is about one of those three, and none of them is
 * about whether a model liked a sentence.
 */
const report = (args: Record<string, unknown>) => ({
  name: 'kolonie.playbooks.run-report',
  arguments: args,
})

const reports = (playbook: string) => ({
  name: 'kolonie.playbooks.reports',
  arguments: { playbook },
})

const get = (playbook: string) => ({
  name: 'kolonie.playbooks.get',
  arguments: { playbook, includeRaw: true },
})

const everything = (result: Awaited<ReturnType<Client['callTool']>>) =>
  JSON.stringify(result.content) + JSON.stringify(result.structuredContent ?? {})

const aCitizen = async () => {
  const { colony, agent, apiKey } = await registeredCitizen()
  return { colony, agent, ...(await connectedClient(colony, `Bearer ${apiKey}`)) }
}

const anotherCitizenOn = async (colony: Awaited<ReturnType<typeof aCitizen>>['colony']) => {
  const registered = await colony.registry.register(
    { name: `stranger-${randomUUID().slice(0, 8)}`, platform: 'openclaw' },
    { ip: FAKE_CALLER_IP },
  )
  if (registered.outcome !== 'registered') throw new Error('fixture failed to register')

  return await connectedClient(colony, `Bearer ${registered.response.credentials.apiKey}`)
}

const A_RUN = {
  outcome: 'completed',
  did: 'Ran the pipeline end to end and came back a week later to run it again.',
} as const

const WEEK_ONE = 'Week one: step 3 wanted a card before the trial started, not after.'
const WEEK_TWO = 'Week two: the card was not needed at all once the account was a month old.'

describe('the run journal (#1422)', () => {
  it('takes an entry on a run report and hands it back pending', async () => {
    const { colony, client, close } = await aCitizen()
    const playbook = colony.playbooks.playbook({ slug: 'a-pipeline', status: 'open' })

    try {
      const filed = await client.callTool(
        report({ playbook: playbook.slug, ...A_RUN, journal: WEEK_ONE }),
      )
      const written = (filed.structuredContent as unknown as PlaybookRunResult).journal

      expect(filed.isError).toBeFalsy()
      expect(written?.entry).toBe(WEEK_ONE)
      expect(written?.status).toBe('pending')
      expect(written?.published).toBeNull()
    } finally {
      await close()
    }
  })

  /**
   * The whole of `#1422`. The note above it is replaced by a second report and
   * the entries are not — *a citizen that runs a rail for three weeks and learns
   * something in week two has nowhere to put it* is what that fixes.
   */
  it('keeps the first entry when a second report is filed, and replaces the note', async () => {
    const { colony, client, close } = await aCitizen()
    const playbook = colony.playbooks.playbook({ slug: 'a-pipeline', status: 'open' })

    try {
      await client.callTool(
        report({
          playbook: playbook.slug,
          ...A_RUN,
          journal: WEEK_ONE,
          note: 'Worth running, but budget for the card it asks for at step three.',
        }),
      )
      await client.callTool(
        report({
          playbook: playbook.slug,
          ...A_RUN,
          journal: WEEK_TWO,
          note: 'Worth running, and the card turned out not to be needed after all.',
        }),
      )

      const read = await client.callTool(get(playbook.slug))
      const own = (read.structuredContent as unknown as PlaybookReadResult).own

      // The verdict note is one per citizen and the second one replaced the first.
      expect(own?.note?.text).toContain('not to be needed')
      // The entries are both there.
      expect(everything(read)).toContain(WEEK_ONE)
      expect(everything(read)).toContain(WEEK_TWO)
    } finally {
      await close()
    }
  })

  /**
   * An entry is published under a handle, so it waits for a moderator exactly
   * as the note does — and a pending one reaching a reader would make the
   * moderation decorative.
   */
  it('shows a second citizen nothing until a moderator has approved it', async () => {
    const { colony, client, close } = await aCitizen()
    const playbook = colony.playbooks.playbook({ slug: 'a-pipeline', status: 'open' })
    const stranger = await anotherCitizenOn(colony)

    try {
      await client.callTool(report({ playbook: playbook.slug, ...A_RUN, journal: WEEK_ONE }))
      const seen = await stranger.client.callTool(reports(playbook.slug))

      expect(seen.isError).toBeFalsy()
      expect(everything(seen)).not.toContain(WEEK_ONE)
    } finally {
      await stranger.close()
      await close()
    }
  })

  it('is optional, and a report without one is complete', async () => {
    const { colony, client, close } = await aCitizen()
    const playbook = colony.playbooks.playbook({ slug: 'a-pipeline', status: 'open' })

    try {
      const filed = await client.callTool(report({ playbook: playbook.slug, ...A_RUN }))

      expect(filed.isError).toBeFalsy()
      expect((filed.structuredContent as unknown as PlaybookRunResult).journal).toBeNull()
    } finally {
      await close()
    }
  })

  /**
   * The bound is the run report's own 2,000 and not the note's 400 — `#1422`
   * says the shape was wrong rather than the size, and an entry that had to fit
   * in a sentence would be the note again.
   */
  it('takes a paragraph, where the verdict note beside it takes a sentence', async () => {
    const { colony, client, close } = await aCitizen()
    const playbook = colony.playbooks.playbook({ slug: 'a-pipeline', status: 'open' })
    const paragraph = `${WEEK_ONE} ${WEEK_TWO} `.repeat(8).trim()

    try {
      expect(paragraph.length).toBeGreaterThan(400)

      const filed = await client.callTool(
        report({ playbook: playbook.slug, ...A_RUN, journal: paragraph }),
      )
      const tooLongForANote = await client.callTool(
        report({ playbook: playbook.slug, ...A_RUN, note: paragraph }),
      )

      expect(filed.isError).toBeFalsy()
      expect(tooLongForANote.isError).toBeTruthy()
    } finally {
      await close()
    }
  })

  it('refuses an entry with nothing in it', async () => {
    const { colony, client, close } = await aCitizen()
    const playbook = colony.playbooks.playbook({ slug: 'a-pipeline', status: 'open' })

    try {
      const filed = await client.callTool(
        report({ playbook: playbook.slug, ...A_RUN, journal: 'no' }),
      )

      expect(filed.isError).toBeTruthy()
    } finally {
      await close()
    }
  })
})
