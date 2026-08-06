import { randomUUID } from 'node:crypto'
import {
  AgentIdSchema,
  AgentSchema,
  HumanIdSchema,
  type Agent,
  type AgentId,
  type Human,
  type HumanSession,
} from '@kolonie-ai/core'
import type { HumanAuthentication, OpenedSession, ProviderIdentity } from '@kolonie-ai/db'
import type { HumanDependencies, HumanStore } from '../humans/humans.js'
import type { IdentityProviderTenant, ResolvedIdentity } from '../humans/auth0.js'

/**
 * People, in memory (`#425`).
 *
 * The routes depend on the port, so a route test needs no PostgreSQL — the same
 * arrangement `fakeConsoleStore` uses. What the database actually does with an
 * expired session is tested in `packages/db` against a real one, and this
 * fixture deliberately does not have a second opinion about it.
 */
export interface FakeHumanStore extends HumanStore {
  /** Every person this store holds, in arrival order. */
  readonly people: () => readonly Human[]
  /** Every session value it has handed out, newest last. */
  readonly sessions: () => readonly string[]
  /** Put a sponsor identity on record without going through `openSponsor` (`#430`). */
  readonly holdsSponsor: (humanId: Human['id'], agent: Agent) => void
  /** Make a linked agent read as a sponsor identity, which refuses a deletion (`#429`). */
  readonly makeSponsor: (agentId: AgentId) => void
}

export function fakeHumanStore(): FakeHumanStore {
  const byIdentity = new Map<string, Human>()
  const order: Human[] = []
  const live = new Map<string, { humanId: Human['id']; sessionId: string; ended: boolean }>()
  const handed: string[] = []
  const details = new Map<string, HumanSession>()
  const codes: {
    code: string
    humanId: Human['id'] | null
    agentId: AgentId | null
    used: boolean
  }[] = []
  const links = new Map<AgentId, Human['id']>()
  /** Which linked agents this fake should treat as sponsor identities (`#429`). */
  const sponsorIdentities = new Set<AgentId>()
  const sponsorAgents = new Map<AgentId, Agent>()
  const takenNames = new Set<string>()

  const key = (identity: ProviderIdentity) => `${identity.provider}|${identity.subject}`

  return {
    people: () => order,
    sessions: () => handed,

    issueCodeForHuman: async (humanId) => {
      const code = `TEST-${String(codes.length + 1).padStart(4, '0')}`
      codes.push({ code, humanId, agentId: null, used: false })
      return { code, expiresAt: new Date(Date.now() + 60_000).toISOString() }
    },

    liveCode: async (humanId) => {
      const held = [...codes].reverse().find((c) => c.humanId === humanId && !c.used)
      return held === undefined
        ? undefined
        : { code: held.code, expiresAt: new Date(Date.now() + 60_000).toISOString() }
    },

    issueCodeForAgent: async (agentId) => {
      const code = `TEST-${String(codes.length + 1).padStart(4, '0')}`
      codes.push({ code, humanId: null, agentId, used: false })
      return { code, expiresAt: new Date(Date.now() + 60_000).toISOString() }
    },

    redeemAsAgent: async (code, agentId) => {
      const held = codes.find((c) => c.code === code.toUpperCase())
      if (held === undefined) return { outcome: 'refused', reason: 'unknown' }
      if (held.used) return { outcome: 'refused', reason: 'spent' }
      if (held.humanId === null) return { outcome: 'refused', reason: 'wrong-side' }
      const existing = links.get(agentId)
      if (existing !== undefined && existing !== held.humanId) {
        return { outcome: 'refused', reason: 'already-linked' }
      }
      held.used = true
      links.set(agentId, held.humanId)
      return { outcome: 'linked', agentId, humanId: held.humanId }
    },

    redeemAsHuman: async (code, humanId) => {
      const held = codes.find((c) => c.code === code.toUpperCase())
      if (held === undefined) return { outcome: 'refused', reason: 'unknown' }
      if (held.used) return { outcome: 'refused', reason: 'spent' }
      if (held.agentId === null) return { outcome: 'refused', reason: 'wrong-side' }
      const existing = links.get(held.agentId)
      if (existing !== undefined && existing !== humanId) {
        return { outcome: 'refused', reason: 'already-linked' }
      }
      held.used = true
      links.set(held.agentId, humanId)
      return { outcome: 'linked', agentId: held.agentId, humanId }
    },

    operated: async (humanId) =>
      [...links.entries()]
        .filter(([, held]) => held === humanId)
        .map(([agentId]) => ({
          id: agentId,
          name: `agent-${agentId.slice(0, 4)}`,
          citizenship: 'candidate',
          skillsHeld: 0,
          lastSeenAt: null,
          linkedAt: new Date().toISOString(),
        })),

    operates: async (humanId, agentId) => links.get(agentId) === humanId,

    /**
     * Deleting a person (`#429`).
     *
     * **The join rows go and the agents are not touched**, which is the property
     * the console's routes are tested against here. What the real transaction
     * does to the cascades, the operator addresses and the notes is tested in
     * `packages/db` against a PostgreSQL — a fake that re-implemented those would
     * be asserting its own arithmetic.
     */
    deleteAccount: async (humanId) => {
      if (![...byIdentity.values()].some((human) => human.id === humanId)) {
        return { outcome: 'not-found' as const }
      }

      const sponsors = [...sponsorIdentities].filter((agentId) => links.get(agentId) === humanId)

      if (sponsors.length > 0) {
        return {
          outcome: 'holds-sponsor-identity' as const,
          sponsors: sponsors.map((agentId) => `agent-${agentId.slice(0, 4)}`),
        }
      }

      const orphaned = [...links.entries()]
        .filter(([, id]) => id === humanId)
        .map(([agentId]) => agentId)

      const exported = {
        agents: orphaned.map((agentId) => ({
          id: agentId,
          name: `agent-${agentId.slice(0, 4)}`,
          linkedAt: new Date().toISOString(),
        })),
      }

      for (const agentId of orphaned) links.delete(agentId)
      for (const [identity, human] of byIdentity.entries()) {
        if (human.id === humanId) byIdentity.delete(identity)
      }
      for (const [value, session] of live.entries()) {
        if (session.humanId === humanId) live.delete(value)
      }

      return {
        outcome: 'deleted' as const,
        exported,
        orphaned,
        notify: ['someone@example.com'],
      }
    },

    exportOf: async (humanId) => ({
      agents: [...links.entries()]
        .filter(([, id]) => id === humanId)
        .map(([agentId]) => ({
          id: agentId,
          name: `agent-${agentId.slice(0, 4)}`,
          linkedAt: new Date().toISOString(),
        })),
    }),

    sponsorIdentities: async (humanId) =>
      [...sponsorIdentities]
        .filter((agentId) => links.get(agentId) === humanId)
        .map((agentId) => `agent-${agentId.slice(0, 4)}`),

    makeSponsor: (agentId: AgentId) => {
      sponsorIdentities.add(agentId)
    },

    /**
     * The one identity the console acts as (`#430`).
     *
     * **Resolved off `links` rather than off `sponsorIdentities` above**, which
     * is the same distinction the real storage draws and the one a fake most
     * easily flattens: that set is *who counts as a sponsor for the audience and
     * the deletion refusal*, and it lapses once an identity climbs anything.
     * This is *whom does the console act as*, and it must not.
     */
    sponsorAgent: async (humanId) => {
      const [agentId] = [...links.entries()].filter(([, id]) => id === humanId).map(([one]) => one)
      return agentId === undefined ? undefined : sponsorAgents.get(agentId)
    },

    openSponsor: async ({ humanId, name }) => {
      const [held] = [...links.entries()].filter(([, id]) => id === humanId).map(([one]) => one)
      if (held !== undefined) {
        const agent = sponsorAgents.get(held)
        if (agent !== undefined)
          return { outcome: 'already-held', identity: { id: held, name: agent.profile.name } }
      }

      if (takenNames.has(name.toLowerCase())) return { outcome: 'name-taken', name }

      const agentId = AgentIdSchema.parse(randomUUID())
      takenNames.add(name.toLowerCase())
      links.set(agentId, humanId)
      sponsorIdentities.add(agentId)
      sponsorAgents.set(agentId, anAgent({ id: agentId, name }))
      return { outcome: 'opened', identity: { id: agentId, name } }
    },

    /** Put a sponsor identity on record without going through `openSponsor`. */
    holdsSponsor: (humanId: Human['id'], agent: Agent) => {
      links.set(agent.id, humanId)
      sponsorIdentities.add(agent.id)
      sponsorAgents.set(agent.id, agent)
      takenNames.add(agent.profile.name.toLowerCase())
    },

    findOrCreate: async (identity) => {
      const existing = byIdentity.get(key(identity))
      if (existing !== undefined) return { human: existing, created: false }

      const human: Human = {
        id: HumanIdSchema.parse(randomUUID()),
        createdAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        identities: [
          {
            provider: identity.provider,
            subject: identity.subject,
            email: identity.email,
            attachedAt: new Date().toISOString(),
          },
        ],
      }

      byIdentity.set(key(identity), human)
      order.push(human)
      return { human, created: true }
    },

    openSession: async (humanId, where) => {
      const session = randomUUID()
      const sessionId = randomUUID()
      live.set(session, { humanId, sessionId, ended: false })
      handed.push(session)
      details.set(sessionId, {
        id: sessionId as HumanSession['id'],
        startedAt: new Date().toISOString(),
        lastUsedAt: null,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        browser: where.browser ?? null,
        location: where.location ?? null,
      })
      return { session, maxAgeSeconds: 60 } satisfies OpenedSession
    },

    authenticate: async (session): Promise<HumanAuthentication> => {
      const held = live.get(session)
      if (held === undefined) return { outcome: 'unknown' }
      if (held.ended) return { outcome: 'ended' }

      const human = order.find((person) => person.id === held.humanId)
      if (human === undefined) return { outcome: 'unknown' }
      return { outcome: 'authenticated', human, sessionId: held.sessionId }
    },

    endSession: async (session) => {
      const held = live.get(session)
      if (held === undefined || held.ended) return false
      held.ended = true
      return true
    },

    endSessionById: async (humanId, sessionId) => {
      for (const held of live.values()) {
        if (held.sessionId !== sessionId || held.humanId !== humanId || held.ended) continue
        held.ended = true
        return true
      }
      return false
    },

    endAllSessions: async (humanId) => {
      let ended = 0
      for (const held of live.values()) {
        if (held.humanId !== humanId || held.ended) continue
        held.ended = true
        ended += 1
      }
      return ended
    },

    listSessions: async (humanId) =>
      [...live.values()]
        .filter((held) => held.humanId === humanId && !held.ended)
        .map((held) => details.get(held.sessionId))
        .filter((session): session is HumanSession => session !== undefined),
  }
}

/**
 * A tenant that answers whatever the test says, and records what it was asked.
 *
 * `exchangeCode` refusing is not an edge case here: it is what a replayed code,
 * an expired one and a tenant that has never heard of it all look like from this
 * side, and the route must treat all three the same.
 */
export interface FakeTenant extends IdentityProviderTenant {
  readonly codes: () => readonly string[]
  readonly states: () => readonly string[]
}

export function fakeTenant(
  identity: ResolvedIdentity | undefined = {
    provider: 'github',
    subject: '4815162342',
    email: 'someone@example.test',
  },
): FakeTenant {
  // A default parameter applies to an explicit `undefined` as well, so
  // `fakeTenant(undefined)` builds the *working* tenant. Use `refusingTenant`
  // for the other case rather than passing nothing.
  const codes: string[] = []
  const states: string[] = []

  return {
    authorizeUrl: ({ connection, state }) => {
      states.push(state)
      return `https://tenant.example.test/authorize?connection=${connection}&state=${state}`
    },
    exchangeCode: async (code) => {
      codes.push(code)
      return identity
    },
    codes: () => codes,
    states: () => states,
  }
}

/** Human dependencies with a tenant present, which is the configured case. */
export function fakeHumans(
  overrides: Partial<HumanDependencies> = {},
): HumanDependencies & { readonly store: FakeHumanStore } {
  return {
    store: fakeHumanStore(),
    tenant: fakeTenant(),
    ...overrides,
  } as HumanDependencies & { readonly store: FakeHumanStore }
}

/**
 * A tenant that confirms nothing.
 *
 * Its own function rather than `fakeTenant(undefined)`, which builds the working
 * one — a default parameter is applied to an explicit `undefined` too, and a
 * test written that way asserts the opposite of what it says.
 */
export function refusingTenant(): FakeTenant {
  const codes: string[] = []
  const states: string[] = []

  return {
    authorizeUrl: ({ connection, state }) => {
      states.push(state)
      return `https://tenant.example.test/authorize?connection=${connection}&state=${state}`
    },
    exchangeCode: async (code) => {
      codes.push(code)
      return undefined
    },
    codes: () => codes,
    states: () => states,
  }
}

/**
 * A sponsor identity as the database would hand one back (`#430`).
 *
 * `platform: 'other'` and `registrationPath: 'web'`, which is the pair
 * `registerWebIdentity` writes and the one `arrivedAsSponsorSql` reads. A fake
 * that used any other pair would let a route test pass against an identity the
 * platform cannot produce.
 */
export function anAgent(overrides: { id?: AgentId; name?: string } = {}): Agent {
  const id = overrides.id ?? AgentIdSchema.parse(randomUUID())
  return AgentSchema.parse({
    id,
    profile: {
      name: overrides.name ?? `sponsor-${String(id).slice(0, 6)}`,
      platform: 'other',
      operator: null,
      pronouns: null,
      model: null,
      runtimeVersion: null,
      os: null,
      skillVersion: null,
      bio: null,
      capabilities: [],
      avatarUrl: null,
      declaredRhythmHours: null,
      vocation: null,
      disposition: null,
      goal: null,
    },
    status: 'candidate',
    accountType: 'citizen',
    roles: [],
    skills: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })
}
