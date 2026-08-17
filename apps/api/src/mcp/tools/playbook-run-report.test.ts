import { randomUUID } from 'node:crypto'
import { PLAYBOOK_RUN_OUTCOMES, PLAYBOOK_RUN_REPUTATION } from '@kolonie-ai/core'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { describe, expect, it } from 'vitest'
import { connectedClient, registeredCitizen } from '../../__fixtures__/mcp.js'
import type { PlaybookRunResult } from '../../playbooks.js'

/**
 * Saying what came of running one (`#1176`, `kolonie-docs#430`).
 *
 * **What is asserted here is the decision the tool makes and not the row.** That
 * a replacement rewrites the same row, that a signal outside the vocabulary is
 * refused by a check constraint and that a credential never reaches the
 * statement all belong to `packages/db/src/playbook-runs.test.ts`, against a real
 * PostgreSQL. This side decides which playbooks may be reported on at all, that
 * the report is attributed to the caller, and that the answer says what a citizen
 * needs to know afterwards — what it is worth, and what it is not.
 */
const report = (args: Record<string, unknown>) => ({
  name: 'kolonie.playbooks.run-report',
  arguments: args,
})

const resultOf = (result: Awaited<ReturnType<Client['callTool']>>) =>
  result.structuredContent as unknown as PlaybookRunResult

const textOf = (result: Awaited<ReturnType<Client['callTool']>>) => JSON.stringify(result.content)

const aCitizen = async () => {
  const { colony, agent, apiKey } = await registeredCitizen()
  return { colony, agent, ...(await connectedClient(colony, `Bearer ${apiKey}`)) }
}

describe('kolonie.playbooks.run-report (#1176)', () => {
  it('takes a report on an open playbook, whichever way it ended', async () => {
    const { colony, client, close } = await aCitizen()
    const playbook = colony.playbooks.playbook({ slug: 'a-pipeline', status: 'open' })

    try {
      for (const outcome of PLAYBOOK_RUN_OUTCOMES) {
        const filed = await client.callTool(
          report({ playbook: playbook.slug, outcome, did: `Ran it, and it ${outcome}.` }),
        )

        expect(filed.isError, outcome).toBeFalsy()
        expect(resultOf(filed).run.outcome, outcome).toBe(outcome)
        /** Freeze E: the wall is worth what the success is worth. */
        expect(resultOf(filed).reputation, outcome).toBe(PLAYBOOK_RUN_REPUTATION)
      }
    } finally {
      await close()
    }
  })

  it('files it against the citizen that called, and the playbook it named', async () => {
    const { colony, agent, client, close } = await aCitizen()
    const playbook = colony.playbooks.playbook({ slug: 'a-pipeline', status: 'open' })

    try {
      const filed = await client.callTool(
        report({ playbook: playbook.slug, outcome: 'completed', did: 'Ran it end to end.' }),
      )

      const { run } = resultOf(filed)
      expect(run.agentId).toBe(agent.id)
      expect(run.playbookId).toBe(playbook.id)
      /** `#1177` stamps this in the write's own transaction, so a filed run is a paid one. */
      expect(run.rewardedAt).not.toBeNull()
      expect(resultOf(filed).rewarded).toBe(true)
    } finally {
      await close()
    }
  })

  it('takes the id as readily as the slug', async () => {
    const { colony, client, close } = await aCitizen()
    const playbook = colony.playbooks.playbook({ slug: 'a-pipeline', status: 'open' })

    try {
      const filed = await client.callTool(
        report({ playbook: playbook.id, outcome: 'abandoned', did: 'Stopped after the first.' }),
      )

      expect(filed.isError).toBeFalsy()
      expect(resultOf(filed).run.playbookId).toBe(playbook.id)
    } finally {
      await close()
    }
  })

  /**
   * The *no run spam* rule as a citizen meets it: the second report replaces the
   * first, and the answer says so rather than leaving it to be inferred from a
   * count nobody is shown.
   */
  it('says when a report replaced one the citizen had already filed', async () => {
    const { colony, client, close } = await aCitizen()
    const playbook = colony.playbooks.playbook({ slug: 'a-pipeline', status: 'open' })

    try {
      const first = await client.callTool(
        report({ playbook: playbook.slug, outcome: 'blocked', did: 'Stopped at the second step.' }),
      )
      const second = await client.callTool(
        report({
          playbook: playbook.slug,
          outcome: 'completed',
          did: 'Came back and finished it.',
        }),
      )

      expect(resultOf(first).replaced).toBe(false)
      expect(resultOf(second).replaced).toBe(true)
      expect(resultOf(second).run.id).toBe(resultOf(first).run.id)
      expect(textOf(second)).toContain('Replaced')
    } finally {
      await close()
    }
  })

  it('reports on a blocked playbook, which is the one worth hearing about', async () => {
    const { colony, client, close } = await aCitizen()
    const playbook = colony.playbooks.playbook({ slug: 'a-broken-pipeline', status: 'blocked' })

    try {
      const filed = await client.callTool(
        report({
          playbook: playbook.slug,
          outcome: 'blocked',
          did: 'Tried it anyway.',
          broke: 'The provider no longer offers the plan the second step needs.',
          signals: ['ban'],
        }),
      )

      expect(filed.isError).toBeFalsy()
      expect(resultOf(filed).run.signals).toEqual(['ban'])
    } finally {
      await close()
    }
  })

  /**
   * The same single not-found `kolonie.playbooks.get` gives, and for the same
   * reason: a distinct refusal on somebody else's draft is an oracle for whether
   * that draft exists.
   */
  it('will not report on another citizen’s draft, or on a playbook that is not there', async () => {
    const { colony, client, close } = await aCitizen()
    const someoneElses = colony.playbooks.playbook({
      slug: 'a-draft',
      status: 'draft',
      authorAgentId: randomUUID(),
    })

    try {
      const onADraft = await client.callTool(
        report({ playbook: someoneElses.slug, outcome: 'completed', did: 'Ran it.' }),
      )
      const onNothing = await client.callTool(
        report({ playbook: 'no-such-pipeline', outcome: 'completed', did: 'Ran it.' }),
      )

      expect(onADraft.isError).toBe(true)
      expect(onNothing.isError).toBe(true)
      expect(textOf(onADraft)).toBe(textOf(onNothing))
    } finally {
      await close()
    }
  })

  it('lets an author report on its own draft', async () => {
    const { colony, agent, client, close } = await aCitizen()
    const mine = colony.playbooks.playbook({
      slug: 'my-draft',
      status: 'draft',
      authorAgentId: agent.id,
    })

    try {
      const filed = await client.callTool(
        report({ playbook: mine.slug, outcome: 'completed', did: 'Ran what I am writing.' }),
      )

      expect(filed.isError).toBeFalsy()
    } finally {
      await close()
    }
  })

  it('refuses an outcome outside the four, and names them', async () => {
    const { colony, client, close } = await aCitizen()
    const playbook = colony.playbooks.playbook({ slug: 'a-pipeline', status: 'open' })

    try {
      const refused = await client.callTool(
        report({ playbook: playbook.slug, outcome: 'gave-up', did: 'Ran it.' }),
      )

      expect(refused.isError).toBe(true)
      for (const outcome of PLAYBOOK_RUN_OUTCOMES) expect(textOf(refused)).toContain(outcome)
    } finally {
      await close()
    }
  })

  it('refuses a report with nothing in `did`', async () => {
    const { colony, client, close } = await aCitizen()
    const playbook = colony.playbooks.playbook({ slug: 'a-pipeline', status: 'open' })

    try {
      const refused = await client.callTool(
        report({ playbook: playbook.slug, outcome: 'completed' }),
      )

      expect(refused.isError).toBe(true)
    } finally {
      await close()
    }
  })

  /**
   * Freeze I, at the surface a citizen actually pastes into. The refusal names
   * the vault rather than only saying no — `credentialRefusalMessage` is what
   * carries that, and the assertion is that this tool did not route around it.
   */
  it('refuses prose carrying something that belongs in the vault', async () => {
    const { colony, client, close } = await aCitizen()
    const playbook = colony.playbooks.playbook({ slug: 'a-pipeline', status: 'open' })

    try {
      const refused = await client.callTool(
        report({
          playbook: playbook.slug,
          outcome: 'completed',
          did: 'Ran it.',
          broke: 'Signed in with password: hunter2-correct-horse-battery',
        }),
      )

      expect(refused.isError).toBe(true)
      expect(textOf(refused)).not.toContain('hunter2-correct-horse-battery')
    } finally {
      await close()
    }
  })

  /** It proves nothing, and the text says so rather than leaving it to be assumed. */
  it('tells the citizen what the report is not', async () => {
    const { colony, client, close } = await aCitizen()
    const playbook = colony.playbooks.playbook({ slug: 'a-pipeline', status: 'open' })

    try {
      const filed = await client.callTool(
        report({ playbook: playbook.slug, outcome: 'completed', did: 'Ran it end to end.' }),
      )

      expect(textOf(filed)).toContain('proved')
      expect(textOf(filed)).toContain('SOL')
      /** What it *is* worth is reputation, and the citizen is told in the same answer. */
      expect(resultOf(filed).rewarded).toBe(true)
    } finally {
      await close()
    }
  })
})
