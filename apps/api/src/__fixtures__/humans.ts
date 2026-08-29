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
  /** Put an agent this person operates on record, without a link code (`#578`). */
  readonly operatesAgent: (humanId: Human['id'], agent: Agent) => void
  /**
   * Put a second person on record holding a given identity (`#574`).
   *
   * The ambiguous case — one address reaching two people — cannot be reached
   * through `findOrCreate` any more, because preventing exactly that is the
   * feature. It is still a state the Colony can arrive at: an address changes
   * hands, and both rows are honest about the day they were written. So the
   * fixture can be told to hold one, which is how the refusal gets tested at
   * all.
   */
  readonly holdsIdentity: (identity: ProviderIdentity) => Human
  /**
   * Make a linked agent read as reachable only through the login, which refuses
   * a deletion (`#429`, retargeted by `#458`).
   */
  readonly makeUnreachable: (agentId: AgentId) => void
  /** And give it a key of its own again, which lifts the refusal (`#458`). */
  readonly holdsOwnKey: (agentId: AgentId) => void
  /**
   * Give a person the `maintainer` role (`#486`).
   *
   * The grant itself is `packages/db`'s — `setHumanRole` writes the array and
   * its audit row in one transaction, and that is tested against a real
   * database. What this exists for is the *gate*: a route test needs a person
   * who holds the role and one who does not, and neither is interesting enough
   * to be worth a second implementation of the grant.
   */
  readonly maintains: (humanId: Human['id']) => void
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
  /**
   * Which linked agents this fake should treat as reachable only through the
   * login (`#429`, retargeted by `#458`).
   *
   * The real predicate asks whether the identity holds a credential of its own;
   * a fake with no credentials table models the answer instead of the columns,
   * which is the same choice every other set in this file makes.
   */
  const unreachableIdentities = new Set<AgentId>()
  /** Agents put on record by name, so `operated` can answer with the real one. */
  const agentsById = new Map<AgentId, Agent>()

  /**
   * Adoption codes, in memory (`#459`).
   *
   * The fake models the *answers* rather than the columns, like every other set
   * here — but it reproduces the two rules the routes rely on: one live code per
   * identity, and an identity that holds a key cannot be handed over. A fake
   * that skipped the second would let a route test pass while the console
   * offered a button whose only answer is a refusal.
   */
  const adoptionCodes = new Map<AgentId, { code: string; expiresAt: string }>()

  const key = (identity: Pick<ProviderIdentity, 'provider' | 'subject'>) =>
    `${identity.provider}|${identity.subject}`

  /**
   * Swap a person for an updated copy, everywhere this fixture holds one
   * (`#574`).
   *
   * `Human` is readonly, so attaching an identity produces a new object rather
   * than mutating the old — and this store keeps the same person in two places.
   * Updating `order` and leaving `byIdentity` pointing at the previous copy is
   * exactly the bug this feature would otherwise hide: signing in through the
   * first door would reach a person with one identity and the second door a
   * person with two.
   */
  const replace = (was: Human, now: Human) => {
    const at = order.indexOf(was)
    if (at >= 0) order[at] = now
    for (const [held, person] of byIdentity) {
      if (person.id === now.id) byIdentity.set(held, now)
    }
  }

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
          name: agentsById.get(agentId)?.profile.name ?? `agent-${agentId.slice(0, 4)}`,
          citizenship: agentsById.get(agentId)?.status ?? 'candidate',
          skillsHeld: 0,
          lastSeenAt: null,
          linkedAt: new Date().toISOString(),
          platform: 'openclaw',
          model: null,
          lastEarned: null,
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

      const unreachable = [...unreachableIdentities].filter(
        (agentId) => links.get(agentId) === humanId,
      )

      if (unreachable.length > 0) {
        return {
          outcome: 'holds-unreachable-identity' as const,
          unreachable: unreachable.map((agentId) => `agent-${agentId.slice(0, 4)}`),
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
          name: agentsById.get(agentId)?.profile.name ?? `agent-${agentId.slice(0, 4)}`,
          linkedAt: new Date().toISOString(),
        })),
    }),

    unreachableIdentities: async (humanId) =>
      [...unreachableIdentities]
        .filter((agentId) => links.get(agentId) === humanId)
        .map((agentId) => `agent-${agentId.slice(0, 4)}`),

    /** This identity has no way in of its own. */
    makeUnreachable: (agentId: AgentId) => {
      unreachableIdentities.add(agentId)
    },

    /**
     * And this one minted its own key, so the login is no longer the only door
     * to it (`#458`, and the state `#459` puts an identity into).
     */
    holdsOwnKey: (agentId: AgentId) => {
      unreachableIdentities.delete(agentId)
    },

    identityHoldsKey: async (agentId) => !unreachableIdentities.has(agentId),

    issueAdoptionCode: async (agentId) => {
      if (!unreachableIdentities.has(agentId)) {
        return { outcome: 'refused', reason: 'already-adopted' }
      }
      // Generating another replaces the first, which is the whole of the
      // one-live-code rule as a caller can observe it.
      const code = {
        code: `ADPT-${String(adoptionCodes.size + 1).padStart(4, '0')}`,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      }
      adoptionCodes.set(agentId, code)
      return { outcome: 'issued', code }
    },

    liveAdoptionCode: async (agentId) => {
      const held = adoptionCodes.get(agentId)
      if (held === undefined) return undefined
      return Date.parse(held.expiresAt) <= Date.now() ? undefined : { expiresAt: held.expiresAt }
    },

    revokeAdoptionCode: async (agentId) => (adoptionCodes.delete(agentId) ? 1 : 0),

    holdsIdentity: (identity: ProviderIdentity) => {
      const human: Human = {
        id: HumanIdSchema.parse(randomUUID()),
        createdAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        roles: [],
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
      return human
    },

    /**
     * Put an agent this person operates on record, without a link code (`#578`).
     *
     * **It was `holdsSponsor` and it also marked the identity unreachable**,
     * because the identity it modelled was one the console had minted and no
     * agent held a key to. Nothing mints one now, so what this models is an
     * ordinary paired agent — and a test that wants the unreachable case says so
     * with `makeUnreachable`, which is what that helper is for.
     */
    operatesAgent: (humanId: Human['id'], agent: Agent) => {
      links.set(agent.id, humanId)
      agentsById.set(agent.id, agent)
    },

    /**
     * The four arrivals, including the two `#574` added.
     *
     * **The address match is modelled here rather than stubbed**, because the
     * route's job is to tell the outcomes apart and a fixture that could only
     * produce two of them would let the other two go untested at this layer.
     * What is *not* modelled is the transaction — that is `packages/db`'s, and
     * its tests run against a real PostgreSQL.
     */
    findByIdentity: async (identity) => byIdentity.get(key(identity)),

    findOrCreate: async (identity) => {
      const existing = byIdentity.get(key(identity))
      if (existing !== undefined) return { outcome: 'returning', human: existing }

      if (identity.email !== null) {
        const matches = [
          ...new Set(
            order.filter((person) =>
              person.identities.some((held) => held.email === identity.email),
            ),
          ),
        ]

        if (matches.length > 1) return { outcome: 'ambiguous' }

        const [only] = matches
        if (only !== undefined) {
          const attached: Human = {
            ...only,
            identities: [
              ...only.identities,
              {
                provider: identity.provider,
                subject: identity.subject,
                email: identity.email,
                attachedAt: new Date().toISOString(),
              },
            ],
          }

          replace(only, attached)
          byIdentity.set(key(identity), attached)
          return { outcome: 'attached', human: attached }
        }
      }

      const human: Human = {
        id: HumanIdSchema.parse(randomUUID()),
        createdAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        // Empty, which is what everybody but the maintainer holds (`#485`). A
        // fixture that granted one by default would make every test that does
        // not care about authority quietly exercise the privileged path.
        roles: [],
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
      return { outcome: 'created', human }
    },

    connect: async (humanId, identity) => {
      const holder = byIdentity.get(key(identity))
      if (holder !== undefined && holder.id !== humanId) return { outcome: 'taken' }

      const person = order.find((candidate) => candidate.id === humanId)
      if (person === undefined) throw new Error(`no such person: ${String(humanId)}`)

      if (holder !== undefined) return { outcome: 'already-theirs', human: person }

      const attached: Human = {
        ...person,
        identities: [
          ...person.identities,
          {
            provider: identity.provider,
            subject: identity.subject,
            email: identity.email,
            attachedAt: new Date().toISOString(),
          },
        ],
      }

      replace(person, attached)
      byIdentity.set(key(identity), attached)
      return { outcome: 'attached', human: attached }
    },

    maintains: (humanId: Human['id']) => {
      const human = order.find((person) => person.id === humanId)
      if (human === undefined) throw new Error(`no such person: ${String(humanId)}`)
      const index = order.indexOf(human)
      const granted: Human = { ...human, roles: ['maintainer'] }
      order[index] = granted
      for (const [identityKey, held] of byIdentity) {
        if (held.id === humanId) byIdentity.set(identityKey, granted)
      }
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
  /**
   * Change what the next `exchangeCode` answers with (`#574`).
   *
   * A second door is a *different identity from the same tenant*, and the
   * alternative — rebuilding the app around a second `fakeTenant` — throws away
   * the store, so the person the test just signed in stops existing. One tenant
   * that can answer differently is the only shape in which the two doors belong
   * to one account.
   */
  readonly answersWith: (identity: ResolvedIdentity) => void
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
  let answer = identity

  return {
    authorizeUrl: ({ connection, state }) => {
      states.push(state)
      return `https://tenant.example.test/authorize?connection=${connection}&state=${state}`
    },
    exchangeCode: async (code) => {
      codes.push(code)
      return answer
    },
    codes: () => codes,
    states: () => states,
    answersWith: (next) => {
      answer = next
    },
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
    // A tenant that confirms nothing confirms nothing whatever it is told to
    // answer with. Present so the two fakes share one type; changing it here
    // would make this the *working* tenant under another name.
    answersWith: () => {},
  }
}

/**
 * The identity a person writes quests through, as the database would hand one
 * back (`#430`).
 *
 * `platform: 'other'` and `registrationPath: 'web'`, which is the pair
 * `registerWebIdentity` writes and the one `outsideQuestAudienceSql` reads. A fake
 * that used any other pair would let a route test pass against an identity the
 * platform cannot produce.
 */
export function anAgent(
  overrides: { id?: AgentId; name?: string; status?: Agent['status'] } = {},
): Agent {
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
      availability: null,
      profession: null,
    },
    status: overrides.status ?? 'candidate',
    accountType: 'citizen',
    roles: [],
    skills: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })
}
