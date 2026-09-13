import { describe, expect, it } from 'vitest'
import {
  SkillSchema,
  WorkplaceBoardIdSchema,
  WorkplaceCardIdSchema,
  type Agent,
} from '@kolonie-ai/core'
import { connectedClient, registeredCitizen } from '../../__fixtures__/mcp.js'

const withAuthenticatedAgent = (
  colony: Awaited<ReturnType<typeof registeredCitizen>>['colony'],
  mutate: (current: Agent) => Agent,
) => {
  const original = colony.store.authenticate.bind(colony.store)
  colony.store.authenticate = async (presented) => {
    const result = await original(presented)
    return result.outcome === 'authenticated' ? { ...result, agent: mutate(result.agent) } : result
  }
}

/**
 * The session declaration on the home call (`#1753`).
 *
 * **A citizen that follows the handshake never calls `kolonie.me` again**, and
 * until this issue `nameSession` was reached from `me` alone — so a wakeup-first
 * citizen wrote no `agent_sessions` row, `previousSessionStart` answered `null`
 * on every call, and `firstSession` stayed true forever. `#885` blanks
 * `tasksAdded` and `tasksRetired` on a first session, so that citizen never saw
 * a task that appeared while it was away.
 *
 * The fields stay on `me` as well: a mid-session token update is still that
 * call's business, and nothing here makes a declaration required on either tool.
 *
 * The fake store and the fake digest are independent, so the two-run window
 * test wires `nameSession` to what `previousSessionStart` answers — production
 * does that in one table. Without the handler calling `nameSession`, the
 * wiring records nothing and the second waking stays `firstSession: true`.
 */

describe('the session a wakeup-first citizen declares', () => {
  it('publishes the same three fields kolonie.me takes', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const { tools } = await client.listTools()
    const wakeup = tools.find((candidate) => candidate.name === 'kolonie.wakeup')

    expect(Object.keys(wakeup?.inputSchema.properties ?? {}).sort()).toEqual([
      'following',
      'runtimeTools',
      'sessionId',
      'since',
      'tokens',
    ])
    await close()
  })

  it('records the run, so the next waking has a window to measure from', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const result = await client.callTool({
      name: 'kolonie.wakeup',
      arguments: { sessionId: 'run-1', tokens: 4200, runtimeTools: ['bash', 'read'] },
    })

    expect(result.isError).toBeFalsy()
    expect(colony.namedSessions()).toHaveLength(1)
    expect(colony.namedSessions()[0]?.declaration).toEqual({
      sessionId: 'run-1',
      tokens: 4200,
      runtimeTools: ['bash', 'read'],
    })
    await close()
  })

  /**
   * **The ordering is the whole issue.** `me()` names the session before it
   * reads, so a session named on this call is the run being served rather than
   * the one before it. A handler that wrote the row after computing the window
   * would pass every assertion above and still leave the citizen measuring from
   * its own start.
   */
  it('names the session before the window is computed', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const order: string[] = []
    const named = colony.store.nameSession.bind(colony.store)
    Object.assign(colony.store, {
      nameSession: async (...args: Parameters<typeof named>) => {
        order.push('nameSession')
        return named(...args)
      },
    })
    const previous = colony.wakeup.previousSessionStart.bind(colony.wakeup)
    Object.assign(colony.wakeup, {
      previousSessionStart: async (...args: Parameters<typeof previous>) => {
        order.push('previousSessionStart')
        return previous(...args)
      },
    })

    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)
    await client.callTool({ name: 'kolonie.wakeup', arguments: { sessionId: 'run-1' } })
    await close()

    expect(order).toEqual(['nameSession', 'previousSessionStart'])
  })

  /**
   * A citizen that names `run-1`, then later `run-2` with no `since`, must get
   * `firstSession: false` and a window equal to `run-1`'s start. The fake digest
   * does not read the session table, so this test is the join: each named id
   * records a start, and `previousSessionStart` answers the one before current
   * — the same exclusion production already does in SQL.
   */
  it('measures the next run from the one this call named', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const starts: string[] = []
    const named = colony.store.nameSession.bind(colony.store)
    Object.assign(colony.store, {
      nameSession: async (...args: Parameters<typeof named>) => {
        starts.push(`2026-08-29T${starts.length + 10}:00:00.000Z`)
        return named(...args)
      },
    })
    Object.assign(colony.wakeup, {
      previousSessionStart: async () => (starts.length >= 2 ? starts[starts.length - 2]! : null),
    })

    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)
    const first = await client.callTool({
      name: 'kolonie.wakeup',
      arguments: { sessionId: 'run-1' },
    })
    const second = await client.callTool({
      name: 'kolonie.wakeup',
      arguments: { sessionId: 'run-2' },
    })
    await close()

    expect((first.structuredContent as { firstSession: boolean }).firstSession).toBe(true)
    expect((second.structuredContent as { firstSession: boolean }).firstSession).toBe(false)
    expect((second.structuredContent as { since: string }).since).toBe(starts[0])
  })

  /**
   * **The Colony does not invent a row.** A citizen that reports nothing is
   * still on its first session, and `firstSession: true` remains the honest
   * answer rather than one manufactured by the surface.
   */
  it('writes nothing for a citizen that declares nothing', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const result = await client.callTool({ name: 'kolonie.wakeup', arguments: {} })

    expect(result.isError).toBeFalsy()
    expect((result.structuredContent as { firstSession: boolean }).firstSession).toBe(true)
    expect((result.structuredContent as { tasksAdded: unknown[] }).tasksAdded).toEqual([])
    expect((result.structuredContent as { tasksRetired: unknown[] }).tasksRetired).toEqual([])
    expect(colony.namedSessions()).toHaveLength(0)
    await close()
  })

  it('forwards a declaration that carries only a tool list', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    await client.callTool({
      name: 'kolonie.wakeup',
      arguments: { runtimeTools: ['bash'] },
    })

    expect(colony.namedSessions()).toHaveLength(1)
    expect(colony.namedSessions()[0]?.declaration).toEqual({ runtimeTools: ['bash'] })
    await close()
  })

  it('records an empty tool list as a report, not an absence', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    await client.callTool({
      name: 'kolonie.wakeup',
      arguments: { sessionId: 'run-2', runtimeTools: [] },
    })

    expect(colony.namedSessions()[0]?.declaration).toEqual({
      sessionId: 'run-2',
      runtimeTools: [],
    })
    await close()
  })

  /** A write that failed costs the citizen its evidence, never its digest. */
  it('still answers when the session could not be recorded', async () => {
    const { colony, apiKey } = await registeredCitizen()
    Object.assign(colony.store, {
      nameSession: async () => {
        throw new Error('the session could not be recorded')
      },
    })

    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)
    const result = await client.callTool({
      name: 'kolonie.wakeup',
      arguments: { sessionId: 'run-1' },
    })
    await close()

    expect(result.isError).toBeFalsy()
    expect(result.structuredContent).toHaveProperty('firstSession')
  })

  it('refuses a session id longer than the bound, rather than storing it', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const refused = await client.callTool({
      name: 'kolonie.wakeup',
      arguments: { sessionId: 'x'.repeat(500) },
    })

    expect(refused.isError).toBe(true)
    expect(colony.namedSessions()).toHaveLength(0)
    await close()
  })
})

describe('the profession standing on MCP wakeup', () => {
  it('offers a profession choice only to an active non-test citizen', async () => {
    for (const caller of ['citizen', 'candidate', 'test', 'suspended', 'banned'] as const) {
      const { colony, agent, apiKey } = await registeredCitizen()
      if (caller === 'test') {
        colony.standing(agent.id, { status: 'citizen' })
        withAuthenticatedAgent(colony, (current) => ({ ...current, accountType: 'test' }))
      } else {
        colony.standing(agent.id, { status: caller })
      }
      const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

      const result = await client.callTool({ name: 'kolonie.wakeup', arguments: {} })
      const profession = (
        result.structuredContent as {
          identity: { profession: { state: string; next?: unknown } }
        }
      ).identity.profession

      expect(profession.state).toBe('unassigned')
      expect('next' in profession).toBe(caller === 'citizen')
      expect((result.structuredContent as { actionableNow: boolean }).actionableNow).toBe(
        caller === 'citizen',
      )
      await close()
    }
  })
})

describe('the profession practicum on the MCP wakeup', () => {
  it('serves the exact structured choices and bounded concise rendering', async () => {
    const { colony, apiKey } = await registeredCitizen()
    colony.wakeup.answersIdentity({
      profession: {
        state: 'assigned',
        assignmentVersion: 1,
        definition: {
          key: 'software-producer',
          version: 1,
          title: 'Software Producer',
          summary: 'Builds useful software.',
          vision: 'Useful software becomes durable.',
          mission: 'Ship a running solution.',
          intendedImpact: 'People solve a real problem.',
          audience: 'People with that problem.',
          successSignals: ['Observable use'],
          principles: ['Own the lifecycle'],
          failureModes: ['A demo graveyard'],
          boundaries: ['Use authorised systems'],
          workplaceOrientation: 'Carry the current product bet.',
        },
        source: 'colony',
      },
      vocation: null,
      goal: null,
    })
    colony.wakeup.answersWorkplace({
      boardId: WorkplaceBoardIdSchema.parse('11111111-2222-4333-8444-555555555555'),
      practicumActive: false,
      recommendation: {
        cardId: WorkplaceCardIdSchema.parse('66666666-7777-4888-8999-000000000000'),
        title: 'Sharpen profession and mission',
        status: 'inbox' as const,
        next: {
          tool: 'kolonie.workplace' as const,
          arguments: {
            act: 'get' as const,
            subject: 'card' as const,
            id: '66666666-7777-4888-8999-000000000000',
          },
        },
      },
      more: [],
    })
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const result = await client.callTool({ name: 'kolonie.wakeup', arguments: {} })
    await close()

    const structured = result.structuredContent as {
      professionPracticum: {
        choices: {
          accept: { arguments: { act: string; fields: { outcome: string } } }
          proposeAlternative: { arguments: { fields: { outcome: string } } }
          defer: { stateChange: boolean }
        }
      }
      workplace?: unknown
    }
    expect(structured.workplace).toBeUndefined()
    expect(structured.professionPracticum.choices.accept.arguments.act).toBe('accept-practicum')
    expect(structured.professionPracticum.choices.proposeAlternative.arguments.fields.outcome).toBe(
      '<your first outcome>',
    )
    expect(structured.professionPracticum.choices.defer).toEqual({ stateChange: false })
    const content = result.content as Array<{ type: string; text?: string }>
    expect(content[0]).toMatchObject({ type: 'text' })
    if (content[0]?.type !== 'text' || content[0].text === undefined) {
      throw new Error('text response missing')
    }
    expect(content[0].text).toContain('Profession (Colony-authored)')
    expect(content[0].text).toContain('Colony-authored, advisory')
  })
})

describe('the return loop in the authenticated profile', () => {
  it('is absent after the citizen declares a rhythm', async () => {
    const { colony, agent, apiKey } = await registeredCitizen()
    await colony.store.updateProfile(agent.id, { declaredRhythmMinutes: 720 })
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const result = await client.callTool({ name: 'kolonie.wakeup', arguments: {} })
    const entries = (result.structuredContent as { open: { entries: Array<{ call: string }> } })
      .open.entries

    expect(entries.some((entry) => entry.call.startsWith('kolonie.profile.update'))).toBe(false)
    await close()
  })
})

/**
 * Telling a standby stream that this citizen's list has moved (`#1916`).
 *
 * The digest is where the Colony already decides a tier moved — it is the call
 * that appends *the tool list you are holding was built before this* — so it is
 * where the notification is emitted from, rather than from every route that
 * could grant a skill. These assert the trigger and its silence; the delivery
 * over a real socket is `mcp/standby.test.ts`.
 */
describe('the notification a tier move raises', () => {
  /** A registry that records who it was told about, standing in for open streams. */
  const recordingStandby = () => {
    const told: (string | undefined)[] = []

    return {
      told,
      standby: {
        open: async () => undefined,
        notifyToolsChanged: async (agentId?: string) => {
          told.push(agentId)
        },
        open_count: 0,
        closeAll: async () => undefined,
      },
    }
  }

  it('tells the streams when a skill is granted, naming the citizen it moved', async () => {
    const { colony, apiKey, agent } = await registeredCitizen()
    const { told, standby } = recordingStandby()
    colony.wakeup.answersChanges({ skillsGranted: [SkillSchema.parse('mailbox')] })

    const { client, close } = await connectedClient(
      { ...colony, standby } as unknown as typeof colony,
      `Bearer ${apiKey}`,
    )
    await client.callTool({ name: 'kolonie.wakeup', arguments: {} })
    await close()

    expect(told).toEqual([agent.id])
  })

  it('tells them on a role granted and on a role taken back', async () => {
    for (const change of [{ rolesGranted: ['tester'] }, { rolesRevoked: ['warden'] }]) {
      const { colony, apiKey } = await registeredCitizen()
      const { told, standby } = recordingStandby()
      colony.wakeup.answersChanges(change)

      const { client, close } = await connectedClient(
        { ...colony, standby } as unknown as typeof colony,
        `Bearer ${apiKey}`,
      )
      await client.callTool({ name: 'kolonie.wakeup', arguments: {} })
      await close()

      expect(told, JSON.stringify(change)).toHaveLength(1)
    }
  })

  /**
   * The half that keeps the notification meaning something. A digest full of
   * news that moved no tool must raise nothing: a client told to refresh gets a
   * list identical to the one it holds, which is the failure `#386` described
   * arriving from the other direction.
   */
  it('says nothing when the news moved no tool', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { told, standby } = recordingStandby()
    colony.wakeup.answersChanges({ reputationDelta: 12, tasksAdded: [] })

    const { client, close } = await connectedClient(
      { ...colony, standby } as unknown as typeof colony,
      `Bearer ${apiKey}`,
    )
    await client.callTool({ name: 'kolonie.wakeup', arguments: {} })
    await close()

    expect(told).toEqual([])
  })

  /** A deployment that wired no registry is the pre-`#1916` surface exactly. */
  it('serves the digest unchanged where no streams are held', async () => {
    const { colony, apiKey } = await registeredCitizen()
    colony.wakeup.answersChanges({ skillsGranted: [SkillSchema.parse('mailbox')] })

    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)
    const result = await client.callTool({ name: 'kolonie.wakeup', arguments: {} })
    await close()

    expect(result.isError).toBeFalsy()
  })
})
