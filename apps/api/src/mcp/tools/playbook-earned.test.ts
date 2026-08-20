import { randomUUID } from 'node:crypto'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { describe, expect, it } from 'vitest'
import { FAKE_CALLER_IP } from '../../__fixtures__/colony/index.js'
import { connectedClient, registeredCitizen } from '../../__fixtures__/mcp.js'
import type { PlaybookReadResult } from '../../playbooks.js'

/**
 * What a run returned, kept privately (`#1419`).
 *
 * ## The property this file exists to hold
 *
 * `#1252` refused a **published** earnings figure, on the reasoning that a
 * number nobody verified, read by citizens deciding where to spend a day, is
 * gamed within a week. That refusal is not weakened here and is what makes
 * recording an amount at all safe: the record has exactly one reader, and the
 * tests below are the boundary rather than a description of it.
 *
 * So the assertions come in pairs. The author gets its amount back; a second
 * citizen asking every question this surface answers gets no trace of it. And
 * separately: nothing sorts by it, which is asserted by changing the amounts and
 * watching the order not move.
 */
const get = (playbook: string, includeRaw?: boolean) => ({
  name: 'kolonie.playbooks.get',
  arguments: includeRaw === undefined ? { playbook } : { playbook, includeRaw },
})

const report = (args: Record<string, unknown>) => ({
  name: 'kolonie.playbooks.run-report',
  arguments: args,
})

const everything = (result: Awaited<ReturnType<Client['callTool']>>) =>
  JSON.stringify(result.content) + JSON.stringify(result.structuredContent ?? {})

const ownOf = (result: Awaited<ReturnType<Client['callTool']>>) =>
  (result.structuredContent as unknown as PlaybookReadResult).own

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

  const { credentials } = registered.response
  return await connectedClient(colony, `Bearer ${credentials.apiKey}`)
}

const A_RUN = {
  outcome: 'completed',
  did: 'Ran the pipeline end to end and the payout landed four days later.',
} as const

/** A string no other field on any of these surfaces could produce by accident. */
const AMOUNT = '412.75'
const EARNED = { amount: AMOUNT, currency: 'USDC', at: '2026-08-18' } as const

describe('what a run returned, privately (#1419)', () => {
  it('takes an amount, a currency and a date, and reads them back to their author', async () => {
    const { colony, client, close } = await aCitizen()
    const playbook = colony.playbooks.playbook({ slug: 'a-pipeline', status: 'open' })

    try {
      const filed = await client.callTool(
        report({ playbook: playbook.slug, ...A_RUN, earned: EARNED }),
      )
      const read = await client.callTool(get(playbook.slug, true))

      expect(filed.isError).toBeFalsy()
      expect(ownOf(read)?.earned).toEqual(EARNED)
      /** In the prose too, because a model reading it is the reader that matters. */
      expect(everything(read)).toContain(AMOUNT)
    } finally {
      await close()
    }
  })

  /**
   * The one the issue asks for by name. A second citizen on the same Colony —
   * so that reading nothing proves the boundary rather than proving the
   * playbook was somewhere else — asking every question these tools answer.
   */
  it('lets a second citizen reach no trace of it, on any surface it can call', async () => {
    const { colony, client, close } = await aCitizen()
    const playbook = colony.playbooks.playbook({ slug: 'a-pipeline', status: 'open' })
    const stranger = await anotherCitizenOn(colony)

    try {
      await client.callTool(report({ playbook: playbook.slug, ...A_RUN, earned: EARNED }))

      const asked = await Promise.all([
        stranger.client.callTool(get(playbook.slug, true)),
        stranger.client.callTool(get(playbook.slug)),
        stranger.client.callTool({ name: 'kolonie.playbooks.list', arguments: {} }),
        stranger.client.callTool({ name: 'kolonie.playbooks.frontier', arguments: {} }),
        stranger.client.callTool({
          name: 'kolonie.playbooks.reports',
          arguments: { playbook: playbook.slug },
        }),
      ])

      for (const answer of asked) {
        expect(answer.isError).toBeFalsy()
        expect(everything(answer)).not.toContain(AMOUNT)
        expect(everything(answer)).not.toContain('USDC')
      }
      expect(ownOf(asked[0]!)).toBeNull()
    } finally {
      await stranger.close()
      await close()
    }
  })

  /**
   * The author's own public surfaces do not carry it either. The reader being
   * the same citizen is not what makes `reports` safe — everybody reads it.
   */
  it('stays out of the playbook’s own published reports, even for its author', async () => {
    const { colony, client, close } = await aCitizen()
    const playbook = colony.playbooks.playbook({ slug: 'a-pipeline', status: 'open' })

    try {
      await client.callTool(
        report({
          playbook: playbook.slug,
          ...A_RUN,
          earned: EARNED,
          note: 'Worth running twice — the second pass is where the pipeline pays for itself.',
        }),
      )
      const reports = await client.callTool({
        name: 'kolonie.playbooks.reports',
        arguments: { playbook: playbook.slug },
      })

      expect(everything(reports)).not.toContain(AMOUNT)
    } finally {
      await close()
    }
  })

  it('says payout-offplatform for you, and does not ask you to say it twice', async () => {
    const { colony, client, close } = await aCitizen()
    const playbook = colony.playbooks.playbook({ slug: 'a-pipeline', status: 'open' })

    try {
      await client.callTool(report({ playbook: playbook.slug, ...A_RUN, earned: EARNED }))
      const read = await client.callTool(get(playbook.slug, true))

      expect(ownOf(read)?.signals).toEqual(['payout-offplatform'])
    } finally {
      await close()
    }
  })

  it('does not double the signal when the citizen said it as well', async () => {
    const { colony, client, close } = await aCitizen()
    const playbook = colony.playbooks.playbook({ slug: 'a-pipeline', status: 'open' })

    try {
      await client.callTool(
        report({
          playbook: playbook.slug,
          ...A_RUN,
          signals: ['traffic', 'payout-offplatform'],
          earned: EARNED,
        }),
      )
      const read = await client.callTool(get(playbook.slug, true))

      expect(ownOf(read)?.signals).toEqual(['traffic', 'payout-offplatform'])
    } finally {
      await close()
    }
  })

  /**
   * The rejection case. `0.1 + 0.2` is the whole argument: a field that
   * silently accepts `19.99` and stores `19.989999999999998` is worse than one
   * with nothing in it, and a citizen told only *invalid input* cannot act on
   * it.
   */
  it('refuses a float and says why, rather than storing a number nobody typed', async () => {
    const { colony, client, close } = await aCitizen()
    const playbook = colony.playbooks.playbook({ slug: 'a-pipeline', status: 'open' })

    try {
      const filed = await client.callTool(
        report({
          playbook: playbook.slug,
          ...A_RUN,
          earned: { amount: 19.99, currency: 'USD', at: '2026-08-18' },
        }),
      )

      expect(filed.isError).toBeTruthy()
      expect(everything(filed)).toContain('decimal string')
    } finally {
      await close()
    }
  })

  it('refuses an amount that is not a decimal at all', async () => {
    const { colony, client, close } = await aCitizen()
    const playbook = colony.playbooks.playbook({ slug: 'a-pipeline', status: 'open' })

    try {
      for (const amount of ['-5.00', '1,200', '£40', '']) {
        const filed = await client.callTool(
          report({
            playbook: playbook.slug,
            ...A_RUN,
            earned: { amount, currency: 'USD', at: '2026-08-18' },
          }),
        )
        expect(filed.isError, `amount ${JSON.stringify(amount)} was accepted`).toBeTruthy()
      }
    } finally {
      await close()
    }
  })

  /**
   * Nothing anywhere is ordered by it, asserted by moving the amounts and
   * watching the order stay put. A rank that ignored the field would look
   * identical to one that read it on a single pair, so the two runs differ in
   * amount by three orders of magnitude and in nothing else.
   */
  it('orders nothing, on any listing, however much any run returned', async () => {
    const { colony, client, close } = await aCitizen()
    const first = colony.playbooks.playbook({ slug: 'first-pipeline', status: 'open' })
    const second = colony.playbooks.playbook({ slug: 'second-pipeline', status: 'open' })

    const slugsFrom = async () => {
      const listed = await client.callTool({ name: 'kolonie.playbooks.list', arguments: {} })
      return everything(listed)
        .split('"slug":"')
        .slice(1)
        .map((part) => part.split('"')[0])
    }

    try {
      const before = await slugsFrom()

      await client.callTool(
        report({
          playbook: first.slug,
          ...A_RUN,
          earned: { amount: '0.01', currency: 'USD', at: '2026-08-18' },
        }),
      )
      await client.callTool(
        report({
          playbook: second.slug,
          ...A_RUN,
          earned: { amount: '99999.99', currency: 'USD', at: '2026-08-18' },
        }),
      )

      expect(await slugsFrom()).toEqual(before)
    } finally {
      await close()
    }
  })

  /**
   * A report is one row per citizen × playbook and is replaced in place, so an
   * amount outliving the report that claimed it would be a figure nobody filed
   * — the same rule `#1245` holds for the published note.
   */
  it('is cleared by a later report that does not mention it', async () => {
    const { colony, client, close } = await aCitizen()
    const playbook = colony.playbooks.playbook({ slug: 'a-pipeline', status: 'open' })

    try {
      await client.callTool(report({ playbook: playbook.slug, ...A_RUN, earned: EARNED }))
      await client.callTool(
        report({
          playbook: playbook.slug,
          outcome: 'blocked',
          did: 'Came back a month later and the rail had stopped paying entirely.',
        }),
      )
      const read = await client.callTool(get(playbook.slug, true))

      expect(ownOf(read)?.earned).toBeNull()
      expect(everything(read)).not.toContain(AMOUNT)
    } finally {
      await close()
    }
  })

  it('is optional, and a run that returned nothing is a complete report', async () => {
    const { colony, client, close } = await aCitizen()
    const playbook = colony.playbooks.playbook({ slug: 'a-pipeline', status: 'open' })

    try {
      const filed = await client.callTool(report({ playbook: playbook.slug, ...A_RUN }))
      const read = await client.callTool(get(playbook.slug, true))

      expect(filed.isError).toBeFalsy()
      expect(ownOf(read)?.earned).toBeNull()
      expect(ownOf(read)?.signals).toEqual([])
    } finally {
      await close()
    }
  })
})
