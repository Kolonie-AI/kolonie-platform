import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import {
  AgentCredentialsSchema,
  AgentIdSchema,
  AgentSchema,
  MODEL_MAX_LENGTH,
  OS_MAX_LENGTH,
  RegisterAgentRequestSchema,
  RUNTIME_VERSION_MAX_LENGTH,
  UpdateProfileRequestSchema,
  type AgentId,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { hashApiKey } from '../api-key.js'
import { agents, credentials } from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { fingerprintOf } from '../registration-fingerprint.js'
import {
  isNameTaken,
  lastRuntimeDeclarationAt,
  registerAgent,
  runtimeDeclarationsOf,
  updateAgentProfile,
} from './agents.js'

const target = databaseTestTarget()

/** Every field defaulted, exactly as the endpoint will hand it over. */
const aRequest = (overrides: Record<string, unknown> = {}) =>
  RegisterAgentRequestSchema.parse({ name: 'canary', platform: 'openclaw', ...overrides })

describe('registerAgent', () => {
  let db: Database

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await truncateAll(db)
  })

  it('creates an agent the domain model accepts', async () => {
    const result = await registerAgent(db, aRequest())

    expect(result.outcome).toBe('registered')
    if (result.outcome !== 'registered') return
    expect(() => AgentSchema.parse(result.agent)).not.toThrow()
    expect(result.agent.profile.name).toBe('canary')
  })

  it('starts the agent as a candidate with no roles and no skills (D-001)', async () => {
    const result = await registerAgent(db, aRequest())

    if (result.outcome !== 'registered') throw new Error(result.outcome)
    expect(result.agent.status).toBe('candidate')
    expect(result.agent.roles).toEqual([])
    expect(result.agent.skills).toEqual([])
  })

  it('returns credentials the domain model accepts', async () => {
    const result = await registerAgent(db, aRequest())

    if (result.outcome !== 'registered') throw new Error(result.outcome)
    expect(() => AgentCredentialsSchema.parse(result.credentials)).not.toThrow()
    expect(result.credentials.agentId).toBe(result.agent.id)
  })

  it('stores only a hash — the key itself is nowhere in the database', async () => {
    const result = await registerAgent(db, aRequest())
    if (result.outcome !== 'registered') throw new Error(result.outcome)

    const [row] = await db
      .select()
      .from(credentials)
      .where(eq(credentials.agentId, result.agent.id))

    expect(row?.secretHash).toBe(hashApiKey(result.credentials.apiKey))
    expect(row?.secretHash).not.toBe(String(result.credentials.apiKey))
    // The whole row, serialised, must not contain the plaintext anywhere —
    // including in a column nobody thought about.
    expect(JSON.stringify(row)).not.toContain(String(result.credentials.apiKey))
  })

  it('issues exactly one credential, unlabelled and unrevoked', async () => {
    const result = await registerAgent(db, aRequest())
    if (result.outcome !== 'registered') throw new Error(result.outcome)

    const rows = await db.select().from(credentials).where(eq(credentials.agentId, result.agent.id))

    expect(rows).toHaveLength(1)
    expect(rows[0]?.kind).toBe('api-key')
    expect(rows[0]?.label).toBeNull()
    expect(rows[0]?.revokedAt).toBeNull()
    expect(rows[0]?.lastUsedAt).toBeNull()
  })

  it('gives two agents two different keys', async () => {
    const first = await registerAgent(db, aRequest({ name: 'canary-one' }))
    const second = await registerAgent(db, aRequest({ name: 'canary-two' }))

    if (first.outcome !== 'registered' || second.outcome !== 'registered') {
      throw new Error('expected both registrations to succeed')
    }
    expect(String(first.credentials.apiKey)).not.toBe(String(second.credentials.apiKey))
  })

  /**
   * **A citizen arrives with an empty profile, and that is the decision** (`#137`).
   *
   * Registration settles the three things the row cannot exist without. The rest
   * — capabilities, bio, avatar — is Academy Level 0, the moment an agent decides
   * what it is, and a door that could write them let the rung be satisfied before
   * the agent had considered the question. The schema refuses them one layer up;
   * this asserts that storage writes the column defaults rather than carrying
   * anything through.
   */
  it('starts a citizen with an empty profile beyond what registration settles', async () => {
    const result = await registerAgent(
      db,
      aRequest({ name: 'well-described', platform: 'claude', operator: 'Kolonie AI' }),
    )

    if (result.outcome !== 'registered') throw new Error(result.outcome)
    expect(result.agent.profile).toEqual({
      name: 'well-described',
      platform: 'claude',
      operator: 'Kolonie AI',
      // Everything an agent *presents itself* with is a later edit to a row that
      // already exists, and these are the column defaults it starts from.
      pronouns: null,
      model: null,
      runtimeVersion: null,
      os: null,
      skillVersion: null,
      bio: null,
      capabilities: [],
      avatarUrl: null,
      declaredRhythmHours: null,
    })
  })

  describe('rejection', () => {
    it('refuses a name that is already taken', async () => {
      await registerAgent(db, aRequest())
      const second = await registerAgent(db, aRequest())

      expect(second).toEqual({ outcome: 'name-taken', name: 'canary' })
    })

    it('refuses a name that differs only in case (D-011)', async () => {
      await registerAgent(db, aRequest({ name: 'canary' }))
      const impersonator = await registerAgent(db, aRequest({ name: 'CaNaRy' }))

      expect(impersonator.outcome).toBe('name-taken')
    })

    it('leaves nothing behind when it refuses — no agent, no credential', async () => {
      await registerAgent(db, aRequest())
      await registerAgent(db, aRequest())

      expect(await db.select().from(agents)).toHaveLength(1)
      expect(await db.select().from(credentials)).toHaveLength(1)
    })

    it('still allows the name once the first holder is gone', async () => {
      const first = await registerAgent(db, aRequest())
      if (first.outcome !== 'registered') throw new Error(first.outcome)
      await db.delete(agents).where(eq(agents.id, first.agent.id))

      expect((await registerAgent(db, aRequest())).outcome).toBe('registered')
    })

    it('does not report an unrelated failure as a taken name', async () => {
      // `platform` is a Postgres enum. A value outside it is a genuine fault,
      // and must surface as one rather than be flattened into a conflict.
      await expect(
        // @ts-expect-error the point of this test is that the value is invalid;
        // the type system refusing it is half the guarantee, Postgres the other.
        registerAgent(db, { ...aRequest(), platform: 'not-a-platform' }),
      ).rejects.toThrow()
    })
  })

  /**
   * D-028: the front door records where a registration came from, so the
   * question *"which other agents arrived from here"* can be asked later. These
   * assert the storage half — that the value is written, kept opaque, and never
   * turned into a constraint.
   */
  describe('registration fingerprint', () => {
    /** RFC 5737 documentation addresses. `AGENTS.md` §9 — never a real one. */
    const CALLER = '192.0.2.10'
    const OTHER_CALLER = '192.0.2.11'

    const fingerprintOfAgent = async (id: AgentId) => {
      const [row] = await db.select().from(agents).where(eq(agents.id, id))
      return row?.registrationFingerprint ?? null
    }

    it('records the fingerprint the caller handed it', async () => {
      const result = await registerAgent(db, aRequest(), fingerprintOf(CALLER))
      if (result.outcome !== 'registered') throw new Error('expected a registration')

      expect(await fingerprintOfAgent(result.agent.id)).toBe(fingerprintOf(CALLER))
    })

    it('never stores the address itself', async () => {
      const result = await registerAgent(db, aRequest(), fingerprintOf(CALLER))
      if (result.outcome !== 'registered') throw new Error('expected a registration')

      const [row] = await db.select().from(agents).where(eq(agents.id, result.agent.id))
      expect(JSON.stringify(row)).not.toContain(CALLER)
    })

    /**
     * The query the column exists for. If this stopped working, the answer to
     * "is one operator holding five accounts" would be unavailable at exactly
     * the moment someone needed it.
     */
    it('groups two registrations from one caller under one value', async () => {
      await registerAgent(db, aRequest({ name: 'canary' }), fingerprintOf(CALLER))
      await registerAgent(db, aRequest({ name: 'sparrow' }), fingerprintOf(CALLER))
      await registerAgent(db, aRequest({ name: 'magpie' }), fingerprintOf(OTHER_CALLER))

      const rows = await db
        .select()
        .from(agents)
        .where(eq(agents.registrationFingerprint, fingerprintOf(CALLER)))

      expect(rows.map((row) => row.name).sort()).toEqual(['canary', 'sparrow'])
    })

    /**
     * Not unique, and this is the assertion that keeps it that way. A fleet
     * behind one NAT and two citizens in one office are ordinary; a constraint
     * here would refuse the second honest agent while the farming case simply
     * changes address.
     */
    it('lets several agents share one fingerprint', async () => {
      const first = await registerAgent(db, aRequest({ name: 'canary' }), fingerprintOf(CALLER))
      const second = await registerAgent(db, aRequest({ name: 'sparrow' }), fingerprintOf(CALLER))

      expect(first.outcome).toBe('registered')
      expect(second.outcome).toBe('registered')
    })

    /**
     * A caller whose address could not be resolved still registers. Absent means
     * "not recorded" — turning it into a refusal would make a missing header a
     * closed front door.
     */
    it('registers without one, leaving the column null', async () => {
      const result = await registerAgent(db, aRequest())
      if (result.outcome !== 'registered') throw new Error('expected a registration')

      expect(await fingerprintOfAgent(result.agent.id)).toBeNull()
    })
  })
})

describe('updateAgentProfile', () => {
  let db: Database

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await truncateAll(db)
  })

  /** A registered agent to patch. Registration is the only way one comes into being. */
  const anAgent = async (overrides: Record<string, unknown> = {}) => {
    const result = await registerAgent(db, aRequest(overrides))
    if (result.outcome !== 'registered') throw new Error(result.outcome)
    return result.agent
  }

  const patch = async (agentId: AgentId, request: Record<string, unknown>) =>
    updateAgentProfile(db, agentId, UpdateProfileRequestSchema.parse(request))

  it('sets capabilities, which is what Level 0 asks for', async () => {
    const agent = await anAgent()

    const result = await patch(agent.id, { capabilities: ['typescript', 'research'] })

    expect(result.outcome).toBe('updated')
    if (result.outcome !== 'updated') return
    expect(result.agent.profile.capabilities).toEqual(['typescript', 'research'])
    expect(() => AgentSchema.parse(result.agent)).not.toThrow()
  })

  /**
   * The declared rhythm (#142). Storage takes the number as given: whether it
   * is inside the Colony's current range was decided one layer up, against
   * configuration, because a bound enforced here would be a second copy of a
   * figure that is meant to move without a migration.
   */
  it('records a declared rhythm, and clears it on an explicit null', async () => {
    const agent = await anAgent()

    const set = await patch(agent.id, { declaredRhythmHours: 8 })
    expect(set.outcome === 'updated' && set.agent.profile.declaredRhythmHours).toBe(8)

    const cleared = await patch(agent.id, { declaredRhythmHours: null })
    expect(cleared.outcome === 'updated' && cleared.agent.profile.declaredRhythmHours).toBeNull()
  })

  it('starts with no declared rhythm rather than with the Colony’s suggestion', async () => {
    const agent = await anAgent()

    // `null` is a real answer: not having said is a different fact from having
    // chosen twelve hours, and #143 refuses an attempt rather than assuming one.
    expect(agent.profile.declaredRhythmHours).toBeNull()
  })

  it('persists the change rather than only reporting it', async () => {
    const agent = await anAgent()

    await patch(agent.id, { capabilities: ['solidity'] })
    const [row] = await db.select().from(agents).where(eq(agents.id, agent.id))

    expect(row?.capabilities).toEqual(['solidity'])
  })

  /**
   * The property that makes this PATCH rather than PUT (D-017), asserted against
   * a real server: absence and `null` are different requests, and only the
   * database can prove the column was left as it was.
   */
  it('leaves a field the request did not mention alone', async () => {
    const agent = await anAgent()
    await patch(agent.id, { operator: 'Kolonie AI', bio: 'keep me' })

    const result = await patch(agent.id, { capabilities: ['typescript'] })

    if (result.outcome !== 'updated') throw new Error(result.outcome)
    expect(result.agent.profile.operator).toBe('Kolonie AI')
    expect(result.agent.profile.bio).toBe('keep me')
  })

  /**
   * The pronouns a citizen declares (#127), asserted against the column rather
   * than against the response — a value the route reports back but never wrote
   * is the failure mode this whole field has to avoid, and only the database
   * can rule it out.
   */
  it('writes declared pronouns to the column, and clears them on an explicit null', async () => {
    const agent = await anAgent()

    await patch(agent.id, { pronouns: 'it/its' })
    const [written] = await db.select().from(agents).where(eq(agents.id, agent.id))
    expect(written?.pronouns).toBe('it/its')

    // Untouched by a patch that says nothing about it.
    await patch(agent.id, { capabilities: ['typescript'] })
    const [kept] = await db.select().from(agents).where(eq(agents.id, agent.id))
    expect(kept?.pronouns).toBe('it/its')

    await patch(agent.id, { pronouns: null })
    const [cleared] = await db.select().from(agents).where(eq(agents.id, agent.id))
    expect(cleared?.pronouns).toBeNull()
  })

  /**
   * `governance/erasure.md`: everything a citizen wrote goes with it. Pronouns
   * are free text a citizen wrote, and the column hangs on the row that
   * cascades — which is what makes that true without a second deletion path
   * anybody could forget to extend.
   */
  it('takes declared pronouns with the citizen that declared them', async () => {
    const agent = await anAgent()
    await patch(agent.id, { pronouns: 'they/them' })

    await db.delete(agents).where(eq(agents.id, agent.id))

    const [row] = await db.select().from(agents).where(eq(agents.id, agent.id))
    expect(row).toBeUndefined()
  })

  it('clears a nullable field when the request sends null', async () => {
    const agent = await anAgent({ operator: 'Kolonie AI' })

    const result = await patch(agent.id, { operator: null })

    if (result.outcome !== 'updated') throw new Error(result.outcome)
    expect(result.agent.profile.operator).toBeNull()
  })

  it('accepts an empty patch and answers with the agent unchanged', async () => {
    // Registered, then written — capabilities stopped being a registration field
    // in `#137`, so the only way to hold one is the way a citizen gets one.
    const registered = await anAgent()
    const written = await patch(registered.id, { capabilities: ['typescript'] })
    if (written.outcome !== 'updated') throw new Error(written.outcome)

    const result = await patch(registered.id, {})

    if (result.outcome !== 'updated') throw new Error(result.outcome)
    expect(result.agent).toEqual(written.agent)
  })

  it('moves updated_at, so a client polling on it sees the change', async () => {
    const agent = await anAgent()

    const result = await patch(agent.id, { capabilities: ['typescript'] })

    if (result.outcome !== 'updated') throw new Error(result.outcome)
    expect(Date.parse(result.agent.updatedAt)).toBeGreaterThanOrEqual(Date.parse(agent.updatedAt))
    expect(result.agent.createdAt).toBe(agent.createdAt)
  })

  it('reports an unknown agent rather than pretending it updated one', async () => {
    const result = await patch(AgentIdSchema.parse(randomUUID()), { capabilities: ['x'] })

    expect(result.outcome).toBe('unknown-agent')
  })

  /**
   * A profile edit can no longer collide with another citizen's. The wallet
   * address was the only unique field it could touch, and it is gone — an
   * address is now learned at the `solana-wallet` rung and nowhere else
   * (`kolonie-platform#102`).
   *
   * So a failure from this write is the Colony being broken rather than somebody
   * having got there first, and it has to surface as one. This is what stopped
   * being flattened into a `wallet-taken` outcome.
   */
  it('lets a genuine fault throw rather than reporting it as an outcome', async () => {
    const agent = await anAgent()

    // `capabilities` is `text[]`. A bare string is a genuine fault.
    await expect(
      updateAgentProfile(db, agent.id, {
        // @ts-expect-error the point is that the value is invalid; the type
        // system refusing it is half the guarantee, Postgres the other.
        capabilities: 'not-an-array',
      }),
    ).rejects.toThrow()
  })
})

/**
 * The self-declared runtime facts and their history (#139).
 *
 * Against a real database rather than a fake, because the whole of this feature
 * is a second table written in the same transaction as the profile — which is
 * exactly what a fake cannot be wrong about.
 */
describe('runtime declarations', () => {
  let db: Database

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await truncateAll(db)
  })

  const anAgent = async () => {
    const result = await registerAgent(db, aRequest())
    if (result.outcome !== 'registered') throw new Error(result.outcome)
    return result.agent
  }

  const patch = async (agentId: AgentId, request: Record<string, unknown>) =>
    updateAgentProfile(db, agentId, UpdateProfileRequestSchema.parse(request))

  it('starts a citizen having declared nothing', async () => {
    const agent = await anAgent()

    expect(agent.profile.model).toBeNull()
    expect(agent.profile.runtimeVersion).toBeNull()
    // Not zero and not the epoch: never declared is its own answer, and
    // `isRuntimeDeclarationStale` is where it becomes *do not nudge*.
    expect(await lastRuntimeDeclarationAt(db, agent.id)).toBeNull()
    expect(await runtimeDeclarationsOf(db, agent.id)).toEqual([])
  })

  it('records what was declared, on the profile and in the history', async () => {
    const agent = await anAgent()

    const result = await patch(agent.id, { model: 'claude-opus-5' })

    if (result.outcome !== 'updated') throw new Error(result.outcome)
    expect(result.agent.profile.model).toBe('claude-opus-5')

    const history = await runtimeDeclarationsOf(db, agent.id)
    expect(history).toHaveLength(1)
    expect(history[0]?.field).toBe('model')
    expect(history[0]?.value).toBe('claude-opus-5')
  })

  it('writes one row per field when both are declared at once', async () => {
    const agent = await anAgent()

    await patch(agent.id, { model: 'claude-opus-5', runtimeVersion: 'Claude Code 2.1.4' })

    const history = await runtimeDeclarationsOf(db, agent.id)
    expect(history.map((entry) => entry.field).sort()).toEqual(['model', 'runtimeVersion'])
  })

  it('keeps every value, so what was running when can be answered', async () => {
    const agent = await anAgent()

    await patch(agent.id, { model: 'the-old-one' })
    await patch(agent.id, { model: 'the-new-one' })

    const history = await runtimeDeclarationsOf(db, agent.id)
    // Newest first, and the superseded value survives — which is the entire
    // point of the table. A history that kept only the current value would
    // answer nothing the profile column does not.
    expect(history.map((entry) => entry.value)).toEqual(['the-new-one', 'the-old-one'])
  })

  /**
   * Clearing is a real declaration, not a gap. A citizen that says *I no longer
   * know what I am running* has told the Colony something different from one
   * that never answered.
   */
  it('records a clearing as an entry of its own', async () => {
    const agent = await anAgent()

    await patch(agent.id, { model: 'claude-opus-5' })
    const cleared = await patch(agent.id, { model: null })

    if (cleared.outcome !== 'updated') throw new Error(cleared.outcome)
    expect(cleared.agent.profile.model).toBeNull()

    const history = await runtimeDeclarationsOf(db, agent.id)
    expect(history.map((entry) => entry.value)).toEqual([null, 'claude-opus-5'])
  })

  /**
   * The behaviour the staleness nudge rests on. Re-declaring an unchanged value
   * has to move the timestamp, or a citizen honestly running the same model for
   * a year is nudged forever with nothing it can do to stop it.
   */
  it('records a re-declaration of an unchanged value, and moves the timestamp', async () => {
    const agent = await anAgent()

    await patch(agent.id, { model: 'claude-opus-5' })
    const first = await lastRuntimeDeclarationAt(db, agent.id)

    await patch(agent.id, { model: 'claude-opus-5' })
    const second = await lastRuntimeDeclarationAt(db, agent.id)

    expect(await runtimeDeclarationsOf(db, agent.id)).toHaveLength(2)
    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    expect(Date.parse(second ?? '')).toBeGreaterThanOrEqual(Date.parse(first ?? ''))
  })

  /** A patch that touches neither field leaves the history alone. */
  it('writes nothing when the patch is about something else', async () => {
    const agent = await anAgent()

    await patch(agent.id, { capabilities: ['typescript'] })

    expect(await runtimeDeclarationsOf(db, agent.id)).toEqual([])
    expect(await lastRuntimeDeclarationAt(db, agent.id)).toBeNull()
  })

  it('keeps one citizen’s declarations out of another’s', async () => {
    const first = await anAgent()
    const secondResult = await registerAgent(db, aRequest({ name: 'other-canary' }))
    if (secondResult.outcome !== 'registered') throw new Error(secondResult.outcome)

    await patch(first.id, { model: 'claude-opus-5' })

    expect(await runtimeDeclarationsOf(db, secondResult.agent.id)).toEqual([])
  })

  /** The rejection case the definition of done names. */
  it('refuses a value longer than the field allows', async () => {
    const agent = await anAgent()

    await expect(patch(agent.id, { model: 'm'.repeat(MODEL_MAX_LENGTH + 1) })).rejects.toThrow()
    await expect(
      patch(agent.id, { runtimeVersion: 'v'.repeat(RUNTIME_VERSION_MAX_LENGTH + 1) }),
    ).rejects.toThrow()
    await expect(patch(agent.id, { os: 'o'.repeat(OS_MAX_LENGTH + 1) })).rejects.toThrow()

    // Refused at the boundary, so nothing reached either table.
    expect(await runtimeDeclarationsOf(db, agent.id)).toEqual([])
  })

  /**
   * The operating system (`#192`), which is a third value on the terms the two
   * above already set — so what is tested here is that it travels the same road
   * rather than a road of its own: the column, the history, and the clearing.
   */
  it('records the operating system on the profile and in the history', async () => {
    const agent = await anAgent()
    expect(agent.profile.os).toBeNull()

    const result = await patch(agent.id, { os: 'Ubuntu 24.04.1 LTS (x86_64)' })

    if (result.outcome !== 'updated') throw new Error(result.outcome)
    expect(result.agent.profile.os).toBe('Ubuntu 24.04.1 LTS (x86_64)')

    const history = await runtimeDeclarationsOf(db, agent.id)
    expect(history).toHaveLength(1)
    expect(history[0]?.field).toBe('os')
    expect(history[0]?.value).toBe('Ubuntu 24.04.1 LTS (x86_64)')
  })

  it('records clearing the operating system as a declaration in its own right', async () => {
    const agent = await anAgent()
    await patch(agent.id, { os: 'macOS 15.2 (arm64)' })

    const result = await patch(agent.id, { os: null })

    if (result.outcome !== 'updated') throw new Error(result.outcome)
    expect(result.agent.profile.os).toBeNull()
    // A clearing is something the citizen said, and is not the same as never
    // having said it.
    expect((await runtimeDeclarationsOf(db, agent.id)).map((entry) => entry.value)).toEqual([
      null,
      'macOS 15.2 (arm64)',
    ])
  })

  it('writes one row per field when all three runtime facts are declared at once', async () => {
    const agent = await anAgent()

    await patch(agent.id, {
      model: 'claude-opus-5',
      runtimeVersion: 'Claude Code 2.1.4',
      os: 'Ubuntu 24.04',
    })

    const history = await runtimeDeclarationsOf(db, agent.id)
    expect(history.map((entry) => entry.field).sort()).toEqual(['model', 'os', 'runtimeVersion'])
  })

  /**
   * The other half of the rejection case: registration is not where a citizen
   * says what it runs. Same reasoning as `capabilities` in `#137` — an arriving
   * agent has not been asked anything yet.
   */
  it('is not accepted at registration', () => {
    expect(() =>
      RegisterAgentRequestSchema.parse({
        name: 'canary',
        platform: 'openclaw',
        model: 'claude-opus-5',
      }),
    ).toThrow()
  })
})

/**
 * The name check's comparison, against a real Postgres (#138).
 *
 * Here rather than only behind the API fake, because the whole value of the call
 * is that it agrees with the front door — and what the front door enforces is
 * `agents_name_unique`, a unique index on `lower(name)`. A check written any
 * other way could answer *free* about a name registration then refuses, which is
 * the one way this call could be worse than not existing.
 */
describe('isNameTaken', () => {
  let db: Database

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await truncateAll(db)
  })

  it('says a name nobody holds is free', async () => {
    expect(await isNameTaken(db, 'nobody-has-this')).toBe(false)
  })

  it('says a registered name is taken', async () => {
    await registerAgent(db, aRequest({ name: 'canary' }))

    expect(await isNameTaken(db, 'canary')).toBe(true)
  })

  /**
   * The rejection case the definition of done names, and the one that matters:
   * `Canary` and `canary` are the same name to the index, so they have to be the
   * same name here.
   */
  it('compares case-insensitively, exactly as the unique index does', async () => {
    await registerAgent(db, aRequest({ name: 'Canary' }))

    expect(await isNameTaken(db, 'canary')).toBe(true)
    expect(await isNameTaken(db, 'CANARY')).toBe(true)
    expect(await isNameTaken(db, 'CaNaRy')).toBe(true)

    // And the agreement in the direction that costs something: a name this
    // reports as taken is one registration refuses.
    expect(await registerAgent(db, aRequest({ name: 'canary' }))).toEqual({
      outcome: 'name-taken',
      name: 'canary',
    })
  })

  it('does not match a name that merely contains the one asked about', async () => {
    await registerAgent(db, aRequest({ name: 'canary-two' }))

    expect(await isNameTaken(db, 'canary')).toBe(false)
  })
})
