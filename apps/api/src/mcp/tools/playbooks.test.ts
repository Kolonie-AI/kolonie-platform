import { randomUUID } from 'node:crypto'
import {
  AccountCapabilitySchema,
  AccountKindSchema,
  type Account,
  type PlaybookRequiredAccount,
} from '@kolonie-ai/core'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { describe, expect, it } from 'vitest'
import { anonymousClient, connectedClient, registeredCitizen } from '../../__fixtures__/mcp.js'
import type { PlaybookMatch } from '../../playbooks.js'

/**
 * The read surface of Playbooks v1 (`#1174`, `kolonie-docs#430`).
 *
 * ## What is asserted here and what is asserted elsewhere
 *
 * Freeze C's rule — **the account gate is visible and never enforced** — is what
 * these three tools are for, so it is asserted from the outside in every shape a
 * citizen can be in: holding nothing, holding some of it, holding all of it. That
 * a row is stored and read back unchanged belongs to
 * `packages/db/src/storage/playbooks.test.ts`, against a real PostgreSQL; a fake
 * asserting it would be asserting a copy of the mapper.
 *
 * ## Why the account cases are here rather than in a unit test of `matchPlaybook`
 *
 * Both would pass with the matching wired to the wrong citizen. Going through the
 * client is what proves that `match` is computed against *the caller's* register,
 * which is the property the tool adds over the function it calls.
 */
const list = (args: Record<string, unknown> = {}) => ({
  name: 'kolonie.playbooks.list',
  arguments: args,
})
const get = (playbook: string) => ({
  name: 'kolonie.playbooks.get',
  arguments: { playbook },
})
const frontier = () => ({ name: 'kolonie.playbooks.frontier', arguments: {} })

/** The house idiom for reading what a model would actually be shown. */
const textOf = (result: Awaited<ReturnType<Client['callTool']>>) => JSON.stringify(result.content)

const matchOf = (result: Awaited<ReturnType<Client['callTool']>>): PlaybookMatch =>
  (result.structuredContent as { match: PlaybookMatch }).match

const summariesOf = (result: Awaited<ReturnType<Client['callTool']>>) =>
  (result.structuredContent as { playbooks: { slug: string; canExecute: boolean }[] }).playbooks

/** A citizen at the client end, and the Colony it is reading. */
const aCitizen = async () => {
  const { colony, agent, apiKey } = await registeredCitizen()
  return { colony, agent, ...(await connectedClient(colony, `Bearer ${apiKey}`)) }
}

/**
 * A kind and a capability are branded, and a test writes them as prose.
 *
 * Parsed rather than cast, so a vocabulary these fixtures no longer match fails
 * here rather than being asserted against a string the Colony would reject.
 */
const aKind = (name: string) => AccountKindSchema.parse(name)
const aCapability = (name: string) => AccountCapabilitySchema.parse(name)

/** One playbook wanting a proved mailbox and any GitHub account. */
const twoSlots: PlaybookRequiredAccount[] = [
  {
    slot: 'inbox',
    kind: aKind('mailbox'),
    minProved: true,
    capabilities: [aCapability('receive')],
  },
  { slot: 'code', kind: aKind('github'), minProved: false },
]

describe('kolonie.playbooks.list/.get/.frontier (#1174)', () => {
  it('offers none of the three to a caller presenting no credential', async () => {
    const { client, close } = await anonymousClient()

    const names = (await client.listTools()).tools.map((tool) => tool.name)

    // Absent from the listing rather than refusing in the handler: every answer
    // these three give is computed against the caller's own register, so there
    // is nothing for a stranger to be shown a description of (D-013).
    expect(names).not.toContain('kolonie.playbooks.list')
    expect(names).not.toContain('kolonie.playbooks.get')
    expect(names).not.toContain('kolonie.playbooks.frontier')
    await close()
  })

  /**
   * The three sentences the issue asks the descriptions to carry.
   *
   * Asserted on the catalogue rather than on the prose of one handler, because a
   * citizen decides whether to call a tool from its description and may never
   * reach the answer: a listing that failed to say a playbook carries no password
   * is one that has already misled.
   *
   * **The third sentence is the reads' and not the surface's** (`#1176`). Two of
   * the three are true of every playbook tool there will ever be; *runs report
   * elsewhere* was only ever true of a tool that does not take the report, and
   * `kolonie.playbooks.run-report` is where the elsewhere turned out to be. So it
   * is asserted against the reads by name rather than against the prefix, and a
   * fourth read added without it is still caught — `#1179` added three writes,
   * which carry the two sentences and not the third, and `#1180` a fourth.
   * `#1247` added `reports`, which is a read that *is* the reporting surface, so
   * it is excluded from the third sentence on purpose rather than expected to
   * carry it.
   */
  it('says in every description that it carries no credential, whose the doing is, and that runs report elsewhere', async () => {
    const { client, close } = await aCitizen()

    const listed = (await client.listTools()).tools.filter((tool) =>
      tool.name.startsWith('kolonie.playbooks.'),
    )
    const writes = ['run-report', 'propose-step', 'draft', 'update', 'submit', 'fork'].map(
      (name) => `kolonie.playbooks.${name}`,
    )
    // `reports` is a read, and the one place that must *not* say runs report
    // elsewhere — it is the elsewhere (`#1247`).
    const reportSurface = 'kolonie.playbooks.reports'
    const reads = listed.filter(
      (tool) => !writes.includes(tool.name) && tool.name !== reportSurface,
    )

    expect(reads).toHaveLength(listed.length - writes.length - 1)
    // list, get, frontier, history (`#1255`).
    expect(reads).toHaveLength(4)
    expect(listed.map((tool) => tool.name)).toContain(reportSurface)
    for (const tool of listed) {
      expect(tool.description, tool.name).toContain('never carries a credential')
      expect(tool.description, tool.name).toContain('yours and your operator')
    }
    for (const tool of reads) {
      expect(tool.description, tool.name).toContain('reported separately')
    }
    const reports = listed.find((tool) => tool.name === reportSurface)
    expect(reports?.description).not.toContain('reported separately')
    await close()
  })

  it('holding nothing, reports every slot missing and nothing hidden', async () => {
    const { colony, client, close } = await aCitizen()
    colony.playbooks.playbook({
      slug: 'mail-then-commit',
      status: 'open',
      requiredAccounts: [...twoSlots],
    })

    const read = await client.callTool(get('mail-then-commit'))

    expect(read.isError).toBeFalsy()
    const match = matchOf(read)
    expect(match.canExecute).toBe(false)
    expect(match.satisfied).toEqual([])
    expect(match.missing.map((slot) => [slot.slot, slot.reason])).toEqual([
      ['inbox', 'no-account'],
      ['code', 'no-account'],
    ])
    // Visible, not enforced: the steps are in the answer of a citizen that
    // answers none of the slots.
    expect(textOf(read)).toContain('Do the thing')
    // Activity is present even when empty, so a reader knows reports exists (`#1247`).
    // Signal tally rides on activity with the unverified label (`#1252`).
    const activity = (
      read.structuredContent as {
        activity: {
          total: number
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
    expect(activity.total).toBe(0)
    expect(activity.signals).toEqual({
      reports: 0,
      ban: 0,
      traffic: 0,
      'payout-offplatform': 0,
      label: 'self-reported and unverified by the Colony',
    })
    expect(textOf(read)).toContain('Nobody has reported a run yet')
    // Open proposal count is present even when empty (`#1253`).
    expect((read.structuredContent as { openProposalCount: number }).openProposalCount).toBe(0)
    expect(textOf(read)).toContain('No open step proposal')
    await close()
  })

  it('holding some of it, reports the rest', async () => {
    const { colony, agent, client, close } = await aCitizen()
    colony.playbooks.playbook({
      slug: 'mail-then-commit',
      status: 'open',
      requiredAccounts: [...twoSlots],
    })
    colony.playbooks.account(agent.id, {
      kind: aKind('mailbox'),
      identifier: 'canary@example.test',
      proved: true,
      capabilities: [aCapability('receive')],
    })

    const match = matchOf(await client.callTool(get('mail-then-commit')))

    expect(match.canExecute).toBe(false)
    expect(match.satisfied.map((slot) => slot.identifier)).toEqual(['canary@example.test'])
    expect(match.missing.map((slot) => slot.slot)).toEqual(['code'])
    await close()
  })

  it('holding all of it, can execute', async () => {
    const { colony, agent, client, close } = await aCitizen()
    colony.playbooks.playbook({
      slug: 'mail-then-commit',
      status: 'open',
      requiredAccounts: [...twoSlots],
    })
    colony.playbooks.account(agent.id, {
      kind: aKind('mailbox'),
      proved: true,
      capabilities: [aCapability('receive')],
    })
    colony.playbooks.account(agent.id, { kind: aKind('github'), identifier: 'canary' })

    const match = matchOf(await client.callTool(get('mail-then-commit')))

    expect(match.canExecute).toBe(true)
    expect(match.missing).toEqual([])
    await close()
  })

  /**
   * The three ways an account a citizen genuinely holds still does not answer a
   * slot, each with its own reason code and so with its own sentence (`#1181`).
   */
  const doesNotAnswer: {
    what: string
    account: Partial<Account> & Pick<Account, 'kind'>
    reason: string
  }[] = [
    {
      what: 'an account taken out of matching',
      account: { kind: aKind('github'), forWork: false },
      reason: 'no-account',
    },
    {
      what: 'a retired account',
      account: { kind: aKind('github'), status: 'retired' },
      reason: 'no-account',
    },
    {
      what: 'an account at another provider',
      account: { kind: aKind('github'), provider: 'gitea.example' },
      reason: 'no-account-at-provider',
    },
  ]

  it.each(doesNotAnswer)('does not let $what answer the slot', async ({ account, reason }) => {
    const { colony, agent, client, close } = await aCitizen()
    colony.playbooks.playbook({
      slug: 'commit-something',
      status: 'open',
      requiredAccounts: [
        { slot: 'code', kind: aKind('github'), provider: 'github.com', minProved: false },
      ],
    })
    colony.playbooks.account(agent.id, account)

    const match = matchOf(await client.callTool(get('commit-something')))

    expect(match.canExecute).toBe(false)
    expect(match.missing.map((slot) => slot.reason)).toEqual([reason])
    await close()
  })

  it('does not let a declared account answer a slot that asked for a proved one', async () => {
    const { colony, agent, client, close } = await aCitizen()
    colony.playbooks.playbook({
      slug: 'prove-first',
      status: 'open',
      requiredAccounts: [{ slot: 'inbox', kind: aKind('mailbox'), minProved: true }],
    })
    colony.playbooks.account(agent.id, { kind: aKind('mailbox'), proved: false })

    const match = matchOf(await client.callTool(get('prove-first')))

    expect(match.missing.map((slot) => slot.reason)).toEqual(['not-proved'])
    await close()
  })

  /**
   * An account that exposes nothing does not answer a slot that named something.
   *
   * The interesting direction: `every` over an empty *required* list is true and
   * correctly so — a slot naming no capability is answered by any account — but
   * an empty list on the *account* must never satisfy a slot that named one, and
   * the two are one line apart.
   */
  it('does not let an account exposing no capability answer a slot that named one', async () => {
    const { colony, agent, client, close } = await aCitizen()
    colony.playbooks.playbook({
      slug: 'send-something',
      status: 'open',
      requiredAccounts: [
        {
          slot: 'inbox',
          kind: aKind('mailbox'),
          minProved: false,
          capabilities: [aCapability('send')],
        },
      ],
    })
    colony.playbooks.account(agent.id, { kind: aKind('mailbox'), capabilities: [] })

    const match = matchOf(await client.callTool(get('send-something')))

    expect(match.missing.map((slot) => slot.reason)).toEqual(['missing-capabilities'])
    await close()
  })

  /**
   * What a citizen does about a slot it cannot answer (`#1181`).
   *
   * The four reasons are the four sentences, and a kind-only slot and a
   * provider-pinned one are deliberately separate cases: the first has no single
   * entry to point at and must say so by leaving `atlasPath` out, while the
   * second must point at the provider's own page rather than at a list.
   */
  describe('what to do about a missing slot (#1181)', () => {
    it('names the call for a kind-only slot, and no Atlas entry it cannot have', async () => {
      const { colony, client, close } = await aCitizen()
      colony.playbooks.playbook({
        slug: 'needs-a-mailbox',
        status: 'open',
        requiredAccounts: [{ slot: 'inbox', kind: aKind('mailbox'), minProved: false }],
      })

      const match = matchOf(await client.callTool(get('needs-a-mailbox')))

      const [slot] = match.missing
      expect(slot?.kind).toBe('mailbox')
      expect(slot?.hint).toContain('kolonie.accounts.recipes')
      expect(slot?.hint).toContain('mailbox')
      // No provider is pinned, so there is no one page — and a path invented
      // here would be a 404 offered as guidance.
      expect(slot?.atlasPath).toBeUndefined()
      await close()
    })

    it('points a provider-pinned slot at that provider’s Atlas entry', async () => {
      const { colony, client, close } = await aCitizen()
      colony.playbooks.playbook({
        slug: 'needs-github-com',
        status: 'open',
        requiredAccounts: [
          { slot: 'code', kind: aKind('github'), provider: 'github.com', minProved: false },
        ],
      })

      const match = matchOf(await client.callTool(get('needs-github-com')))

      const [slot] = match.missing
      expect(slot?.atlasPath).toBe('/atlas/github.com')
      expect(slot?.hint).toContain('github.com')
      await close()
    })

    /**
     * A pin is free text of up to 128 characters and the Atlas addresses an
     * entry by the provider itself, so a pin written as prose has no page. The
     * hint survives; the path is left out rather than guessed at.
     */
    it('leaves the Atlas path out where the pin is not something the Atlas can address', async () => {
      const { colony, client, close } = await aCitizen()
      colony.playbooks.playbook({
        slug: 'needs-the-house-forge',
        status: 'open',
        requiredAccounts: [
          {
            slot: 'code',
            kind: aKind('github'),
            provider: 'the forge my operator runs',
            minProved: false,
          },
        ],
      })

      const match = matchOf(await client.callTool(get('needs-the-house-forge')))

      const [slot] = match.missing
      expect(slot?.hint).not.toBe('')
      expect(slot?.atlasPath).toBeUndefined()
      await close()
    })

    it('gives the proving and the capability walls their own sentences', async () => {
      const { colony, agent, client, close } = await aCitizen()
      colony.playbooks.playbook({
        slug: 'prove-and-send',
        status: 'open',
        requiredAccounts: [
          { slot: 'inbox', kind: aKind('mailbox'), minProved: true },
          {
            slot: 'outbox',
            kind: aKind('domain'),
            minProved: false,
            capabilities: [aCapability('publish')],
          },
        ],
      })
      colony.playbooks.account(agent.id, { kind: aKind('mailbox'), proved: false })
      colony.playbooks.account(agent.id, { kind: aKind('domain'), capabilities: [] })

      const match = matchOf(await client.callTool(get('prove-and-send')))

      const byReason = new Map(match.missing.map((slot) => [slot.reason, slot.hint]))
      expect(byReason.get('not-proved')).toContain('kolonie.accounts.prove')
      expect(byReason.get('missing-capabilities')).toContain('publish')
      // Four reasons, four sentences: no two walls may read alike, or the hint
      // is decoration on a code the citizen already had.
      expect(new Set(byReason.values()).size).toBe(byReason.size)
      await close()
    })

    /**
     * **No hint promises the account.** What the Atlas records is where other
     * citizens got to, walls included — so the language a hint may not use is
     * the language that turns a record of attempts into an assurance.
     */
    it('promises no citizen an account it cannot promise', async () => {
      const { colony, agent, client, close } = await aCitizen()
      colony.playbooks.playbook({
        slug: 'four-walls',
        status: 'open',
        requiredAccounts: [
          { slot: 'inbox', kind: aKind('mailbox'), minProved: true },
          { slot: 'code', kind: aKind('github'), provider: 'github.com', minProved: false },
          {
            slot: 'zone',
            kind: aKind('domain'),
            minProved: false,
            capabilities: [aCapability('publish')],
          },
          { slot: 'site', kind: aKind('website'), minProved: false },
        ],
      })
      colony.playbooks.account(agent.id, { kind: aKind('mailbox'), proved: false })
      colony.playbooks.account(agent.id, { kind: aKind('github'), provider: 'gitea.example' })
      colony.playbooks.account(agent.id, { kind: aKind('domain'), capabilities: [] })

      const match = matchOf(await client.callTool(get('four-walls')))

      expect(match.missing).toHaveLength(4)
      for (const slot of match.missing) {
        expect(slot.hint).not.toMatch(/guarantee|you will get|will have one|simply sign up/i)
        expect(slot.hint.length).toBeGreaterThan(20)
      }
      await close()
    })

    it('puts the hints where a model reading the text rather than the object sees them', async () => {
      const { colony, client, close } = await aCitizen()
      colony.playbooks.playbook({
        slug: 'read-the-prose',
        status: 'open',
        requiredAccounts: [
          { slot: 'code', kind: aKind('github'), provider: 'github.com', minProved: false },
        ],
      })

      const prose = textOf(await client.callTool(get('read-the-prose')))

      expect(prose).toContain('kolonie.accounts.recipes')
      expect(prose).toContain('/atlas/github.com')
      await close()
    })
  })

  it('answers a clean not-found for a slug nobody holds', async () => {
    const { client, close } = await aCitizen()

    const missing = await client.callTool(get('no-such-pipeline'))

    expect(missing.isError).toBe(true)
    expect(textOf(missing)).toContain('No playbook with that slug or id')
    await close()
  })

  /**
   * A stranger's draft answers exactly as a slug nobody holds.
   *
   * Deliberately incurious about which: an error distinguishing *no such
   * playbook* from *not yours* is a way to ask whether a citizen is drafting
   * something, and the answer would be readable a slug at a time.
   */
  it('answers the same not-found for another citizen’s draft', async () => {
    const { colony, client, close } = await aCitizen()
    colony.playbooks.playbook({
      slug: 'somebody-elses-draft',
      status: 'draft',
      authorAgentId: randomUUID(),
    })

    const refused = await client.callTool(get('somebody-elses-draft'))

    expect(refused.isError).toBe(true)
    expect(textOf(refused)).toContain('No playbook with that slug or id')
    await close()
  })

  it('lets an author read back its own draft', async () => {
    const { colony, agent, client, close } = await aCitizen()
    colony.playbooks.playbook({
      slug: 'my-own-draft',
      status: 'draft',
      authorAgentId: agent.id,
    })

    const read = await client.callTool(get('my-own-draft'))

    expect(read.isError).toBeFalsy()
    expect(textOf(read)).toContain('my-own-draft')
    await close()
  })

  it('reads a playbook by its id as readily as by its slug', async () => {
    const { colony, client, close } = await aCitizen()
    const written = colony.playbooks.playbook({ slug: 'by-either-name', status: 'open' })

    const read = await client.callTool(get(written.id))

    expect(read.isError).toBeFalsy()
    expect(textOf(read)).toContain('by-either-name')
    await close()
  })

  it('lists the open shelf by default and the blocked one on request', async () => {
    const { colony, client, close } = await aCitizen()
    colony.playbooks.playbook({ slug: 'still-works', status: 'open' })
    colony.playbooks.playbook({ slug: 'the-world-broke-it', status: 'blocked' })
    colony.playbooks.playbook({ slug: 'not-yours-to-see', status: 'draft' })

    const open = await client.callTool(list())
    const blocked = await client.callTool(list({ status: 'blocked' }))

    expect(summariesOf(open).map((row) => row.slug)).toEqual(['still-works'])
    expect(summariesOf(blocked).map((row) => row.slug)).toEqual(['the-world-broke-it'])
    await close()
  })

  it('narrows the list to playbooks naming a kind, without narrowing it to what the caller holds', async () => {
    const { colony, client, close } = await aCitizen()
    colony.playbooks.playbook({
      slug: 'wants-a-mailbox',
      status: 'open',
      requiredAccounts: [{ slot: 'inbox', kind: aKind('mailbox'), minProved: false }],
    })
    colony.playbooks.playbook({
      slug: 'wants-a-domain',
      status: 'open',
      requiredAccounts: [{ slot: 'zone', kind: aKind('domain'), minProved: false }],
    })

    const narrowed = await client.callTool(list({ kind: 'mailbox' }))

    // The caller holds neither, and the one it asked about is still listed.
    const rows = summariesOf(narrowed)
    expect(rows.map((row) => row.slug)).toEqual(['wants-a-mailbox'])
    expect(rows[0]?.canExecute).toBe(false)
    await close()
  })

  it('never suggests a blocked, draft or review playbook on the frontier', async () => {
    const { colony, client, close } = await aCitizen()
    colony.playbooks.playbook({ slug: 'startable', status: 'open' })
    colony.playbooks.playbook({ slug: 'broken', status: 'blocked' })
    colony.playbooks.playbook({ slug: 'unfinished', status: 'draft' })
    colony.playbooks.playbook({ slug: 'awaiting-moderation', status: 'review' })
    colony.playbooks.playbook({ slug: 'gone', status: 'retired' })

    const suggested = await client.callTool(frontier())

    expect(summariesOf(suggested).map((row) => row.slug)).toEqual(['startable'])
    await close()
  })

  it('puts the playbook the caller is closest to running first', async () => {
    const { colony, agent, client, close } = await aCitizen()
    colony.playbooks.playbook({
      slug: 'two-away',
      status: 'open',
      requiredAccounts: [
        { slot: 'zone', kind: aKind('domain'), minProved: false },
        { slot: 'site', kind: aKind('website'), minProved: false },
      ],
    })
    colony.playbooks.playbook({
      slug: 'one-away',
      status: 'open',
      requiredAccounts: [
        { slot: 'inbox', kind: aKind('mailbox'), minProved: false },
        { slot: 'code', kind: aKind('github'), minProved: false },
      ],
    })
    colony.playbooks.account(agent.id, { kind: aKind('mailbox') })

    const suggested = summariesOf(await client.callTool(frontier()))

    expect(suggested.map((row) => row.slug)).toEqual(['one-away', 'two-away'])
    await close()
  })

  /**
   * Ordering by reported earnings would be a ranking of unverified claims and
   * would be gamed within a week (`#1252`, `#430 F`). list and frontier keep
   * fewest-missing then recency; a playbook whose runs claim payouts must not
   * leapfrog a newer one with none.
   */
  it('orders frontier by missing slots and recency, never by run signals (#1252)', async () => {
    const { colony, agent, client, close } = await aCitizen()
    const older = colony.playbooks.playbook({
      slug: 'claims-payouts',
      status: 'open',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    colony.playbooks.playbook({
      slug: 'quiet-and-newer',
      status: 'open',
      createdAt: '2026-06-01T00:00:00.000Z',
    })
    // Older playbook is drowning in unverified payout claims. Must not reorder.
    await colony.playbooks.runs.record({
      playbookId: older.id,
      agentId: agent.id,
      report: {
        outcome: 'completed',
        did: 'Ran it end to end and money moved off-platform.',
        signals: ['payout-offplatform', 'traffic'],
      },
    })

    const suggested = summariesOf(await client.callTool(frontier()))

    expect(suggested.map((row) => row.slug)).toEqual(['quiet-and-newer', 'claims-payouts'])
    await close()
  })

  it('says an empty catalogue is empty rather than saying the caller is locked out', async () => {
    const { client, close } = await aCitizen()

    const empty = textOf(await client.callTool(frontier()))

    expect(empty).toContain('Nothing is being withheld')
    await close()
  })
})
