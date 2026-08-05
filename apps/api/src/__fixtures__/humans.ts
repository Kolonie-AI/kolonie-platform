import { randomUUID } from 'node:crypto'
import { HumanIdSchema, type Human, type HumanSession } from '@kolonie-ai/core'
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
}

export function fakeHumanStore(): FakeHumanStore {
  const byIdentity = new Map<string, Human>()
  const order: Human[] = []
  const live = new Map<string, { humanId: Human['id']; sessionId: string; ended: boolean }>()
  const handed: string[] = []
  const details = new Map<string, HumanSession>()

  const key = (identity: ProviderIdentity) => `${identity.provider}|${identity.subject}`

  return {
    people: () => order,
    sessions: () => handed,

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
