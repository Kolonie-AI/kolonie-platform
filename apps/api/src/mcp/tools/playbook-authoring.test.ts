import { randomUUID } from 'node:crypto'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { AccountKindSchema } from '@kolonie-ai/core'
import { describe, expect, it } from 'vitest'
import { connectedClient, registeredCitizen } from '../../__fixtures__/mcp.js'
import type { PlaybookWriteResult } from '../../playbooks.js'

/**
 * Writing a pipeline of your own (`#1179`, `kolonie-docs#430`).
 *
 * **What is asserted here is who may write and what a refusal says**, not how a
 * row is stored: the merge, the re-parse and the unique index belong to
 * `packages/db/src/storage/playbooks.test.ts` against a real PostgreSQL. This side
 * decides that a draft is nobody else's to change, that another citizen's playbook
 * refuses in exactly the words a slug nobody has taken refuses in, and that
 * submitting *offers* rather than publishes (`#1219`) — the judge decides that,
 * on the moderation runner's next poll, and a test asserting a catalogue entry
 * here would be asserting something this side never does.
 */
const draft = (args: Record<string, unknown>) => ({
  name: 'kolonie.playbooks.draft',
  arguments: args,
})

const update = (args: Record<string, unknown>) => ({
  name: 'kolonie.playbooks.update',
  arguments: args,
})

const submit = (args: Record<string, unknown>) => ({
  name: 'kolonie.playbooks.submit',
  arguments: args,
})

const fork = (args: Record<string, unknown>) => ({
  name: 'kolonie.playbooks.fork',
  arguments: args,
})

const resultOf = (result: Awaited<ReturnType<Client['callTool']>>) =>
  result.structuredContent as unknown as PlaybookWriteResult

const textOf = (result: Awaited<ReturnType<Client['callTool']>>) => JSON.stringify(result.content)

/** The smallest playbook the schema accepts, so a test names only what it is about. */
const aDraft = (slug: string, over: Record<string, unknown> = {}) => ({
  slug,
  title: 'Triage the inbox once a week',
  summary: 'Read what arrived, answer what needs answering, file the rest.',
  steps: [{ title: 'Open the mailbox' }],
  ...over,
})

const aCitizen = async () => {
  const { colony, agent, apiKey } = await registeredCitizen()
  return { colony, agent, ...(await connectedClient(colony, `Bearer ${apiKey}`)) }
}

describe('kolonie.playbooks.draft (#1179)', () => {
  it('writes a draft nobody else can read yet, attributed to its author', async () => {
    const { colony, agent, client, close } = await aCitizen()

    try {
      const written = await client.callTool(draft(aDraft('weekly-inbox-triage')))

      expect(written.isError).toBeFalsy()
      const { playbook } = resultOf(written)
      expect(playbook.slug).toBe('weekly-inbox-triage')
      expect(playbook.authorAgentId).toBe(agent.id)
      expect(playbook.status).toBe('draft')
      expect(playbook.publishedAt).toBeNull()

      /** The catalogue is `open` and `blocked`; a draft is on neither shelf. */
      const listed = await client.callTool({ name: 'kolonie.playbooks.list', arguments: {} })
      expect(textOf(listed)).not.toContain('weekly-inbox-triage')
      void colony
    } finally {
      await close()
    }
  })

  it('takes the slots and the steps that name them', async () => {
    const { client, close } = await aCitizen()

    try {
      const written = await client.callTool(
        draft(
          aDraft('mail-then-post', {
            requiredAccounts: [{ slot: 'mailbox', kind: 'mailbox' }],
            steps: [{ title: 'Read it', usesSlots: ['mailbox'] }, { title: 'Answer it' }],
          }),
        ),
      )

      expect(written.isError).toBeFalsy()
      const { playbook } = resultOf(written)
      expect(playbook.requiredAccounts).toHaveLength(1)
      /** Freeze C: the gate defaults to unproved, and it is visible rather than enforced. */
      expect(playbook.requiredAccounts[0]?.minProved).toBe(false)
      expect(playbook.steps[0]?.usesSlots).toEqual(['mailbox'])
    } finally {
      await close()
    }
  })

  it('refuses a step naming a slot the playbook never declared', async () => {
    const { client, close } = await aCitizen()

    try {
      const written = await client.callTool(
        draft(aDraft('unslotted', { steps: [{ title: 'Read it', usesSlots: ['mailbox'] }] })),
      )

      expect(written.isError).toBeTruthy()
      expect(textOf(written)).toContain('usesSlots')
    } finally {
      await close()
    }
  })

  it('refuses a credential wherever it is written', async () => {
    const { client, close } = await aCitizen()

    try {
      const written = await client.callTool(
        draft(
          aDraft('leaky', {
            steps: [{ title: 'Sign in', detail: 'Use ghp_0123456789abcdefghij0123456789' }],
          }),
        ),
      )

      expect(written.isError).toBeTruthy()
    } finally {
      await close()
    }
  })

  it('refuses a slug another playbook already answers to', async () => {
    const { colony, client, close } = await aCitizen()
    colony.playbooks.playbook({ slug: 'taken-already', status: 'open' })

    try {
      const written = await client.callTool(draft(aDraft('taken-already')))

      expect(written.isError).toBeTruthy()
      expect(textOf(written)).toContain('slug')
    } finally {
      await close()
    }
  })
})

describe('kolonie.playbooks.update (#1179)', () => {
  it('changes what it names and leaves the rest as it was', async () => {
    const { client, close } = await aCitizen()

    try {
      const written = await client.callTool(draft(aDraft('a-pipeline')))
      const before = resultOf(written).playbook

      const changed = await client.callTool(
        update({ playbook: 'a-pipeline', summary: 'Rewritten, and shorter.' }),
      )

      expect(changed.isError).toBeFalsy()
      const after = resultOf(changed).playbook
      expect(after.summary).toBe('Rewritten, and shorter.')
      expect(after.title).toBe(before.title)
      expect(after.steps).toEqual(before.steps)
      expect(after.version).toBe(before.version + 1)
    } finally {
      await close()
    }
  })

  it('refuses a change that names nothing', async () => {
    const { client, close } = await aCitizen()

    try {
      await client.callTool(draft(aDraft('a-pipeline')))
      const changed = await client.callTool(update({ playbook: 'a-pipeline' }))

      expect(changed.isError).toBeTruthy()
    } finally {
      await close()
    }
  })

  it("answers about another citizen's draft the way it answers about no playbook at all", async () => {
    const { colony, client, close } = await aCitizen()
    const stranger = colony.playbooks.playbook({
      slug: 'not-mine',
      status: 'draft',
      authorAgentId: randomUUID(),
    })

    try {
      const theirs = await client.callTool(
        update({ playbook: stranger.slug, summary: 'Mine now.' }),
      )
      const nobodys = await client.callTool(
        update({ playbook: 'nobody-has-this-one', summary: 'Mine now.' }),
      )

      expect(theirs.isError).toBeTruthy()
      expect(nobodys.isError).toBeTruthy()
      /** The one not-found, so a refusal is not an oracle for what other citizens are drafting. */
      expect(textOf(theirs)).toBe(textOf(nobodys))
    } finally {
      await close()
    }
  })

  it('refuses to rewrite a published playbook in place', async () => {
    const { colony, agent, client, close } = await aCitizen()
    colony.playbooks.playbook({ slug: 'published', status: 'open', authorAgentId: agent.id })

    try {
      const changed = await client.callTool(
        update({ playbook: 'published', summary: 'Quietly different.' }),
      )

      expect(changed.isError).toBeTruthy()
      expect(textOf(changed)).toContain('forked')
    } finally {
      await close()
    }
  })

  it('lets its author fix a blocked playbook, which is what blocked is for', async () => {
    const { colony, agent, client, close } = await aCitizen()
    colony.playbooks.playbook({
      slug: 'broke-out-there',
      status: 'blocked',
      authorAgentId: agent.id,
    })

    try {
      const changed = await client.callTool(
        update({ playbook: 'broke-out-there', steps: [{ title: 'The provider moved this' }] }),
      )

      expect(changed.isError).toBeFalsy()
      expect(resultOf(changed).playbook.steps[0]?.title).toBe('The provider moved this')
    } finally {
      await close()
    }
  })
})

describe('kolonie.playbooks.submit (#1179)', () => {
  /**
   * What a submit buys and what it does not (`#1219`).
   *
   * **The negative assertion is the one that matters.** Until that issue this
   * call published in the same transaction, so a test that only checked the
   * status would go green against either behaviour; what says the judge is in
   * the way is that the catalogue is still empty afterwards.
   */
  it('offers a playbook without publishing it', async () => {
    const { client, close } = await aCitizen()

    try {
      await client.callTool(draft(aDraft('weekly-inbox-triage')))
      const offered = await client.callTool(submit({ playbook: 'weekly-inbox-triage' }))

      expect(offered.isError).toBeFalsy()
      const { playbook } = resultOf(offered)
      expect(playbook.status).toBe('review')
      expect(playbook.publishedAt).toBeNull()
      expect(textOf(offered)).toContain('not yet published')

      const listed = await client.callTool({ name: 'kolonie.playbooks.list', arguments: {} })
      expect(textOf(listed)).not.toContain('weekly-inbox-triage')
    } finally {
      await close()
    }
  })

  it('will not publish a playbook that is not the caller’s', async () => {
    const { colony, client, close } = await aCitizen()
    colony.playbooks.playbook({
      slug: 'not-mine',
      status: 'draft',
      authorAgentId: randomUUID(),
    })

    try {
      const offered = await client.callTool(submit({ playbook: 'not-mine' }))

      expect(offered.isError).toBeTruthy()
      const listed = await client.callTool({ name: 'kolonie.playbooks.list', arguments: {} })
      expect(textOf(listed)).not.toContain('not-mine')
    } finally {
      await close()
    }
  })

  it('refuses to offer one that is already waiting on a judge', async () => {
    const { client, close } = await aCitizen()

    try {
      await client.callTool(draft(aDraft('a-pipeline')))
      await client.callTool(submit({ playbook: 'a-pipeline' }))
      const again = await client.callTool(submit({ playbook: 'a-pipeline' }))

      expect(again.isError).toBeTruthy()
    } finally {
      await close()
    }
  })

  it('never suggests a blocked playbook, whoever wrote it', async () => {
    const { colony, agent, client, close } = await aCitizen()
    colony.playbooks.playbook({
      slug: 'broke-out-there',
      status: 'blocked',
      authorAgentId: agent.id,
    })
    colony.playbooks.playbook({ slug: 'a-draft', status: 'draft', authorAgentId: agent.id })

    try {
      const frontier = await client.callTool({ name: 'kolonie.playbooks.frontier', arguments: {} })

      expect(textOf(frontier)).not.toContain('broke-out-there')
      expect(textOf(frontier)).not.toContain('a-draft')
    } finally {
      await close()
    }
  })
})

/**
 * Starting from somebody else's pipeline (`#1180`).
 *
 * **What is asserted here is who may fork what**, and that the fork arrives as a
 * draft of the caller's own. The copy itself — that the steps survive the round
 * trip through the schema and that the source row is not touched — is asserted
 * in `packages/db/src/storage/playbooks.test.ts` against a real PostgreSQL,
 * because that is where a copy would quietly become a move.
 */
describe('kolonie.playbooks.fork (#1180)', () => {
  const anOpenPlaybook = async () => {
    const { colony, agent, client, close } = await aCitizen()
    /** Somebody else's, because forking your own is the uninteresting half. */
    const source = colony.playbooks.playbook({
      slug: 'weekly-inbox-triage',
      status: 'open',
      authorAgentId: randomUUID(),
      steps: [{ title: 'Open the mailbox', usesSlots: ['mailbox'] }],
      requiredAccounts: [
        { slot: 'mailbox', kind: AccountKindSchema.parse('mailbox'), minProved: false },
      ],
    })
    return { colony, agent, client, close, source }
  }

  it('hands the forker a draft of its own, pointing at what it forked', async () => {
    const { agent, client, close, source } = await anOpenPlaybook()

    try {
      const forked = await client.callTool(
        fork({ playbook: 'weekly-inbox-triage', slug: 'inbox-triage-my-way' }),
      )

      expect(forked.isError).toBeFalsy()
      const { playbook } = resultOf(forked)
      expect(playbook.slug).toBe('inbox-triage-my-way')
      expect(playbook.authorAgentId).toBe(agent.id)
      expect(playbook.status).toBe('draft')
      expect(playbook.publishedAt).toBeNull()
      expect(playbook.parentPlaybookId).toBe(source.id)
      expect(playbook.steps).toEqual(source.steps)
      expect(playbook.requiredAccounts).toEqual(source.requiredAccounts)
    } finally {
      await close()
    }
  })

  it('leaves the fork off every shelf until its author submits it', async () => {
    const { client, close } = await anOpenPlaybook()

    try {
      await client.callTool(fork({ playbook: 'weekly-inbox-triage', slug: 'inbox-triage-my-way' }))
      const listed = await client.callTool({ name: 'kolonie.playbooks.list', arguments: {} })

      expect(textOf(listed)).not.toContain('inbox-triage-my-way')
      /** The one it came from is still there, and still somebody else's. */
      expect(textOf(listed)).toContain('weekly-inbox-triage')
    } finally {
      await close()
    }
  })

  it('lets the forker rewrite the copy, which is the point of forking', async () => {
    const { client, close } = await anOpenPlaybook()

    try {
      await client.callTool(fork({ playbook: 'weekly-inbox-triage', slug: 'inbox-triage-my-way' }))
      const changed = await client.callTool(
        update({ playbook: 'inbox-triage-my-way', summary: 'The same idea, my way.' }),
      )

      expect(changed.isError).toBeFalsy()
      expect(resultOf(changed).playbook.summary).toBe('The same idea, my way.')
    } finally {
      await close()
    }
  })

  it('refuses a slug another playbook already answers to', async () => {
    const { client, close } = await anOpenPlaybook()

    try {
      await client.callTool(draft(aDraft('taken-already')))
      const forked = await client.callTool(
        fork({ playbook: 'weekly-inbox-triage', slug: 'taken-already' }),
      )

      expect(forked.isError).toBeTruthy()
      expect(textOf(forked)).toContain('slug')
    } finally {
      await close()
    }
  })

  it('refuses a fork that names no slug of its own', async () => {
    const { client, close } = await anOpenPlaybook()

    try {
      const forked = await client.callTool(fork({ playbook: 'weekly-inbox-triage' }))

      expect(forked.isError).toBeTruthy()
    } finally {
      await close()
    }
  })

  it('will not fork a blocked playbook, which is its author’s to fix', async () => {
    const { colony, client, close } = await aCitizen()
    colony.playbooks.playbook({
      slug: 'broke-out-there',
      status: 'blocked',
      authorAgentId: randomUUID(),
    })

    try {
      const forked = await client.callTool(fork({ playbook: 'broke-out-there', slug: 'my-fix' }))

      expect(forked.isError).toBeTruthy()
      expect(textOf(forked)).toContain('blocked')
    } finally {
      await close()
    }
  })

  it("answers about another citizen's draft the way it answers about no playbook at all", async () => {
    const { colony, client, close } = await aCitizen()
    const stranger = colony.playbooks.playbook({
      slug: 'not-mine',
      status: 'draft',
      authorAgentId: randomUUID(),
    })

    try {
      const theirs = await client.callTool(fork({ playbook: stranger.slug, slug: 'a-copy' }))
      const nobodys = await client.callTool(
        fork({ playbook: 'nobody-has-this-one', slug: 'a-copy' }),
      )

      expect(theirs.isError).toBeTruthy()
      expect(nobodys.isError).toBeTruthy()
      expect(textOf(theirs)).toBe(textOf(nobodys))
    } finally {
      await close()
    }
  })
})
