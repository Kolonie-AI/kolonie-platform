import { randomUUID } from 'node:crypto'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { describe, expect, it } from 'vitest'
import { FAKE_CALLER_IP } from '../../__fixtures__/colony/index.js'
import { anonymousClient, connectedClient, registeredCitizen } from '../../__fixtures__/mcp.js'
import type { PlaybookReadResult } from '../../playbooks.js'

/**
 * An author reading back what it filed (`#1178`, `kolonie-docs#430`).
 *
 * ## One boundary, asserted from both sides of it
 *
 * The readback is the only path by which a run report leaves the database as
 * prose, so the property worth asserting is not that the author sees its words —
 * it is that *nobody else can reach them by any argument this tool takes*. Both
 * halves are here: the author gets the four answers back, and a second citizen
 * asking for the very same playbook with the very same flag gets `null` and no
 * substring of the first citizen's prose anywhere in the answer.
 *
 * ## Why it hangs off `kolonie.playbooks.get` rather than a tool of its own
 *
 * A citizen has at most one run per playbook — `playbook_runs_agent_playbook_key`,
 * an index and not a convention — so the slug it already used to run the pipeline
 * addresses the report as exactly as a run id would. Walks are addressed by walk
 * id because a walker may have many walks at one provider; runs cannot. The
 * catalogue pays nothing for the argument and would have paid for the tool.
 */
const get = (playbook: string, includeRaw?: boolean) => ({
  name: 'kolonie.playbooks.get',
  arguments: includeRaw === undefined ? { playbook } : { playbook, includeRaw },
})

const report = (args: Record<string, unknown>) => ({
  name: 'kolonie.playbooks.run-report',
  arguments: args,
})

const textOf = (result: Awaited<ReturnType<Client['callTool']>>) => JSON.stringify(result.content)

const ownOf = (result: Awaited<ReturnType<Client['callTool']>>) =>
  (result.structuredContent as unknown as PlaybookReadResult).own

const aCitizen = async () => {
  const { colony, agent, apiKey } = await registeredCitizen()
  return { colony, agent, ...(await connectedClient(colony, `Bearer ${apiKey}`)) }
}

/**
 * A second citizen on the *same* Colony, which is what makes the boundary
 * testable at all: two citizens on two fake colonies share no catalogue, so a
 * stranger reading `null` would prove only that the playbook was not there.
 */
const anotherCitizenOn = async (colony: Awaited<ReturnType<typeof aCitizen>>['colony']) => {
  const registered = await colony.registry.register(
    { name: `stranger-${randomUUID().slice(0, 8)}`, platform: 'openclaw' },
    { ip: FAKE_CALLER_IP },
  )
  if (registered.outcome !== 'registered') throw new Error('fixture failed to register')

  const { agent, credentials } = registered.response
  return { agent, ...(await connectedClient(colony, `Bearer ${credentials.apiKey}`)) }
}

const A_RUN = {
  outcome: 'blocked',
  did: 'Signed up, wired the webhook, and got as far as the third step.',
  broke: 'The provider wanted a card before it would issue the token step four needs.',
  changed: 'Last time I stopped at step one; this time I had the mailbox already.',
  discarded: 'I looked at doing it by hand and stopped when it wanted the same card.',
  takenStepPositions: [1, 2],
  signals: ['ban'],
} as const

describe('kolonie.playbooks.get, includeRaw (#1178)', () => {
  it('reads the author its own four answers, the steps it ticked and the signals it met', async () => {
    const { colony, client, close } = await aCitizen()
    const playbook = colony.playbooks.playbook({ slug: 'a-pipeline', status: 'open' })

    try {
      await client.callTool(report({ playbook: playbook.slug, ...A_RUN }))
      const read = await client.callTool(get(playbook.slug, true))

      const own = ownOf(read)
      expect(read.isError).toBeFalsy()
      expect(own).not.toBeNull()
      expect(own?.outcome).toBe(A_RUN.outcome)
      expect(own?.answers).toEqual({
        did: A_RUN.did,
        broke: A_RUN.broke,
        changed: A_RUN.changed,
        discarded: A_RUN.discarded,
      })
      expect(own?.takenStepPositions).toEqual([1, 2])
      expect(own?.signals).toEqual(['ban'])

      /** In the text too, because a model reading the prose is the reader that matters. */
      expect(textOf(read)).toContain(A_RUN.broke)
    } finally {
      await close()
    }
  })

  /**
   * The boundary, stated as a citizen would hit it: same playbook, same flag,
   * different caller.
   *
   * `null` and not a refusal, for the reason `get` gives a single not-found: a
   * distinct answer for *somebody ran this and it is not you* is an oracle for
   * who has run what, readable one slug at a time.
   */
  it('hands a second citizen null on the same playbook, with none of the first one’s words', async () => {
    const { colony, client, close } = await aCitizen()
    const playbook = colony.playbooks.playbook({ slug: 'a-pipeline', status: 'open' })
    const stranger = await anotherCitizenOn(colony)

    try {
      await client.callTool(report({ playbook: playbook.slug, ...A_RUN }))
      const read = await stranger.client.callTool(get(playbook.slug, true))

      expect(read.isError).toBeFalsy()
      expect(ownOf(read)).toBeNull()
      for (const written of [A_RUN.did, A_RUN.broke, A_RUN.changed, A_RUN.discarded]) {
        expect(textOf(read)).not.toContain(written)
      }
      expect(JSON.stringify(read.structuredContent)).not.toContain(A_RUN.broke)
    } finally {
      await stranger.close()
      await close()
    }
  })

  it('is null for a citizen that has not run the playbook at all', async () => {
    const { colony, client, close } = await aCitizen()
    const playbook = colony.playbooks.playbook({ slug: 'a-pipeline', status: 'open' })

    try {
      const read = await client.callTool(get(playbook.slug, true))

      expect(read.isError).toBeFalsy()
      expect(ownOf(read)).toBeNull()
    } finally {
      await close()
    }
  })

  /**
   * Not asking is its own answer, and it costs the citizen that did not ask
   * nothing: an ordinary `get` reads exactly what it read before this existed.
   */
  it('says nothing about a run the caller did not ask for', async () => {
    const { colony, client, close } = await aCitizen()
    const playbook = colony.playbooks.playbook({ slug: 'a-pipeline', status: 'open' })

    try {
      await client.callTool(report({ playbook: playbook.slug, ...A_RUN }))
      const asked = await client.callTool(get(playbook.slug, false))
      const unasked = await client.callTool(get(playbook.slug))

      expect(ownOf(asked)).toBeNull()
      expect(ownOf(unasked)).toBeNull()
      expect(textOf(unasked)).not.toContain(A_RUN.broke)
    } finally {
      await close()
    }
  })

  /**
   * D-013: a caller with no credential is not shown the tool, so there is no
   * argument for it to pass. The readback adds no second way in.
   */
  it('is unreachable without a credential, because the tool carrying it is not registered', async () => {
    const { client, close } = await anonymousClient()

    const names = (await client.listTools()).tools.map((tool) => tool.name)

    expect(names).not.toContain('kolonie.playbooks.get')
    await close()
  })

  it('follows the report rather than the row, so a replacement is what is read back', async () => {
    const { colony, client, close } = await aCitizen()
    const playbook = colony.playbooks.playbook({ slug: 'a-pipeline', status: 'open' })

    try {
      await client.callTool(report({ playbook: playbook.slug, ...A_RUN }))
      await client.callTool(
        report({
          playbook: playbook.slug,
          outcome: 'completed',
          did: 'Came back with the card sorted and ran it to the end.',
        }),
      )
      const read = await client.callTool(get(playbook.slug, true))

      expect(ownOf(read)?.outcome).toBe('completed')
      expect(ownOf(read)?.answers.broke).toBeNull()
      expect(textOf(read)).not.toContain(A_RUN.broke)
    } finally {
      await close()
    }
  })

  it('reads back a run on a playbook addressed by its id', async () => {
    const { colony, client, close } = await aCitizen()
    const playbook = colony.playbooks.playbook({ slug: 'a-pipeline', status: 'open' })

    try {
      await client.callTool(report({ playbook: playbook.id, ...A_RUN }))
      const read = await client.callTool(get(playbook.id, true))

      expect(ownOf(read)?.runId).toBeTruthy()
      expect(ownOf(read)?.answers.did).toBe(A_RUN.did)
    } finally {
      await close()
    }
  })

  /** Each answer under the question it was asked, from `REPORT_FIELDS` and not a paraphrase. */
  it('renders each answer under the question the citizen was asked', async () => {
    const { colony, client, close } = await aCitizen()
    const playbook = colony.playbooks.playbook({ slug: 'a-pipeline', status: 'open' })

    try {
      await client.callTool(report({ playbook: playbook.slug, ...A_RUN }))
      const read = await client.callTool(get(playbook.slug, true))

      expect(textOf(read)).toContain('Where exactly did it stop, and what did you see?')
      expect(textOf(read)).toContain('to nobody else')
    } finally {
      await close()
    }
  })

  it('says in its description who may read a report back', async () => {
    const { client, close } = await aCitizen()

    const tool = (await client.listTools()).tools.find(
      (listed) => listed.name === 'kolonie.playbooks.get',
    )

    expect(tool?.description).toContain('never to anybody else')
    await close()
  })

  it('will not read a run back off another citizen’s draft, because the playbook is not there', async () => {
    const { colony, client, close } = await aCitizen()
    colony.playbooks.playbook({
      slug: 'somebody-elses-draft',
      status: 'draft',
      authorAgentId: randomUUID(),
    })

    try {
      const refused = await client.callTool(get('somebody-elses-draft', true))

      expect(refused.isError).toBe(true)
      expect(textOf(refused)).toContain('No playbook with that slug or id')
    } finally {
      await close()
    }
  })
})
