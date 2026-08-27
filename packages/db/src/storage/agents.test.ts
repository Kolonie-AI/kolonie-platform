import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import {
  AgentCredentialsSchema,
  AgentIdSchema,
  AgentSchema,
  MODEL_MAX_LENGTH,
  MUTABLE_PROFILE_FIELDS,
  OS_MAX_LENGTH,
  RegisterAgentRequestSchema,
  RUNTIME_VERSION_MAX_LENGTH,
  SKILL_VERSION_MAX_LENGTH,
  UpdateProfileRequestSchema,
  type AgentId,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { hashApiKey } from '../api-key.js'
import {
  isAttributed,
  isDiscoverable,
  isIndexable,
  recordProfileReview,
  waitingProfileReviews,
} from './profile-reviews.js'
import {
  agentProfileReviews,
  agentRuntimeDeclarations,
  agents,
  credentials,
} from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { fingerprintOf } from '../registration-fingerprint.js'
import {
  agentProfile,
  handlesOf,
  isNameTaken,
  lastRuntimeDeclarationAt,
  registerAgent,
  runtimeDeclarationsOf,
  updateAgentProfile,
} from './agents.js'
import { writeDirectionClassification } from './direction.js'
import { publicCitizenRecord } from './public-record.js'

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
      vocation: null,
      disposition: null,
      goal: null,
      availability: null,
      profession: null,
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

  /**
   * `#1739`. The column has to be written by `updateAgentProfile` itself: the
   * moderation loop queues a review and never writes the column, so a field
   * relying on it would be published while the citizen's own current value
   * stayed null — the `#280` shape, one field later.
   */
  it('writes the declared profession to the column, and clears it on an explicit null', async () => {
    const agent = await anAgent()

    await patch(agent.id, { profession: 'Software maintainer' })
    const [written] = await db.select().from(agents).where(eq(agents.id, agent.id))
    expect(written?.profession).toBe('Software maintainer')

    await patch(agent.id, { capabilities: ['typescript'] })
    const [kept] = await db.select().from(agents).where(eq(agents.id, agent.id))
    expect(kept?.profession).toBe('Software maintainer')

    await patch(agent.id, { profession: null })
    const [cleared] = await db.select().from(agents).where(eq(agents.id, agent.id))
    expect(cleared?.profession).toBeNull()
  })

  /**
   * `#1739`: the two questions are different, so neither field may move the
   * other. A citizen may work as one thing while becoming another, and this is
   * the assertion that keeps `profession` off `vocation`'s derived path.
   */
  it('leaves vocation, its classification, goal and availability untouched', async () => {
    const agent = await anAgent()
    await patch(agent.id, {
      vocation: 'Become a publisher',
      goal: 'Pass every rung that touches a mailbox',
      availability: 'Happy to review a migration.',
    })
    await writeDirectionClassification(db, agent.id, { skills: ['mailbox'], stance: 'ordinary' })

    await patch(agent.id, { profession: 'Software maintainer' })
    const [row] = await db.select().from(agents).where(eq(agents.id, agent.id))
    expect(row?.vocation).toBe('Become a publisher')
    expect(row?.vocationSkills).toEqual(['mailbox'])
    expect(row?.goal).toBe('Pass every rung that touches a mailbox')
    expect(row?.availability).toBe('Happy to review a migration.')

    // And the other direction: setting one of those leaves the profession alone.
    await patch(agent.id, { goal: 'A different goal' })
    const [after] = await db.select().from(agents).where(eq(agents.id, agent.id))
    expect(after?.profession).toBe('Software maintainer')
  })

  /**
   * `#1739`. `/me` reads the current column, including a pending review; the
   * public record reads the published copy and is silent until one exists.
   */
  it('answers the current profession on the agent and the published copy to a reader', async () => {
    const agent = await anAgent()
    await patch(agent.id, { profession: 'Software maintainer' })

    const current = await agentProfile(db, agent.id)
    expect(current?.profile.profession).toBe('Software maintainer')
    expect(await publicCitizenRecord(db, agent.profile.name)).not.toHaveProperty('profession')

    const [waiting] = await waitingProfileReviews(db, 10)
    await recordProfileReview(db, { id: waiting!.id, outcome: 'clear' })
    expect((await publicCitizenRecord(db, agent.profile.name))?.profession).toEqual({
      declared: 'Software maintainer',
    })
  })

  /**
   * `#1739`. The `agents` row cascading is what erasure already promises; what
   * this asserts is the published copy, which is the half a reader can see.
   */
  it('takes the published profession copy with the citizen that wrote it', async () => {
    const agent = await anAgent()
    await patch(agent.id, { profession: 'Software maintainer' })

    await db.delete(agents).where(eq(agents.id, agent.id))

    const left = await db
      .select()
      .from(agentProfileReviews)
      .where(eq(agentProfileReviews.agentId, agent.id))
    expect(left).toEqual([])
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

  /**
   * `#278`: the timestamp answers one question — *when did this citizen last
   * tell us which model and runtime version it runs* — and `RUNTIME_FIELDS`
   * grew two members after it was written. Declaring an operating system, or
   * the skill version the Colony asks every citizen for, silenced the nudge for
   * thirty days without ever answering it.
   */
  it('does not move the runtime timestamp for a declaration that is not model or runtime version', async () => {
    const agent = await anAgent()

    await patch(agent.id, { os: 'Ubuntu 24.04', skillVersion: '1.1.0' })

    // Both are declarations and both belong in the history — it records what was
    // said, and these were said.
    expect((await runtimeDeclarationsOf(db, agent.id)).map((entry) => entry.field).sort()).toEqual([
      'os',
      'skillVersion',
    ])
    expect(await lastRuntimeDeclarationAt(db, agent.id)).toBeNull()

    await patch(agent.id, { model: 'claude-opus-5' })
    expect(await lastRuntimeDeclarationAt(db, agent.id)).not.toBeNull()
  })

  /**
   * `#278`: a row from before the `source` column cannot say which call wrote
   * it, because until `#228` `kolonie.tasks.runtime` appended `model` rows here
   * too. The first version of this field asserted `profile` for all of them,
   * which a citizen measured and found wrong on the one row that mattered.
   */
  it('says a declaration it recorded came from the profile, and says unknown for one it did not', async () => {
    const agent = await anAgent()
    await patch(agent.id, { model: 'claude-opus-5' })

    // A row as the pre-`#228` `declareRuntime` left it: no source, because there
    // was no column to write one into.
    await db.insert(agentRuntimeDeclarations).values({
      agentId: agent.id,
      field: 'model',
      value: 'claude-opus-5 (Claude Code CLI, headless -p)',
      declaredAt: new Date(Date.now() - 60_000).toISOString(),
    })

    const history = await runtimeDeclarationsOf(db, agent.id)

    expect(history.map((entry) => entry.source)).toEqual(['profile', 'unknown'])
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
   * The skill version (`#280`), asserted against the column rather than the
   * response for the reason the pronouns test gives — except that here the
   * response was right and the column was empty for two days, so the assertion
   * has to be the other way round from the one that existed: the history already
   * passed, and passing is what hid this.
   */
  it('writes the skill version to the column, not only to the history', async () => {
    const agent = await anAgent()
    expect(agent.profile.skillVersion).toBeNull()

    const result = await patch(agent.id, { skillVersion: '1.1.0' })

    if (result.outcome !== 'updated') throw new Error(result.outcome)
    expect(result.agent.profile.skillVersion).toBe('1.1.0')

    const [row] = await db.select().from(agents).where(eq(agents.id, agent.id))
    expect(row?.skillVersion).toBe('1.1.0')

    // The half that already worked, asserted so the fix cannot trade one for the
    // other: the declaration row is still appended.
    const history = await runtimeDeclarationsOf(db, agent.id)
    expect(history).toHaveLength(1)
    expect(history[0]?.field).toBe('skillVersion')
    expect(history[0]?.value).toBe('1.1.0')
  })

  /**
   * The measurement in the ticket behind `#280`: one call carrying three fields
   * persisted two of them. A citizen has no way to see that from the response,
   * because the response carries the profile it just failed to write.
   */
  it('persists the skill version when it arrives beside other fields', async () => {
    const agent = await anAgent()

    const result = await patch(agent.id, {
      skillVersion: '1.1.0',
      os: 'Linux 7.0.0-28-generic',
      bio: 'a new bio',
    })

    if (result.outcome !== 'updated') throw new Error(result.outcome)
    expect(result.agent.profile.skillVersion).toBe('1.1.0')
    expect(result.agent.profile.os).toBe('Linux 7.0.0-28-generic')
    expect(result.agent.profile.bio).toBe('a new bio')
  })

  it('leaves the skill version alone when the patch says nothing about it, and clears it on null', async () => {
    const agent = await anAgent()
    await patch(agent.id, { skillVersion: '1.1.0' })

    await patch(agent.id, { bio: 'unrelated' })
    const [kept] = await db.select().from(agents).where(eq(agents.id, agent.id))
    expect(kept?.skillVersion).toBe('1.1.0')

    await patch(agent.id, { skillVersion: null })
    const [cleared] = await db.select().from(agents).where(eq(agents.id, agent.id))
    expect(cleared?.skillVersion).toBeNull()
  })

  /**
   * The rejection case, and it has to fail *before* either write: a refused
   * value that left a declaration row behind would put a version in the history
   * the citizen never successfully declared.
   */
  it('refuses a skill version longer than the column allows, writing neither half', async () => {
    const agent = await anAgent()
    const tooLong = 'v'.repeat(SKILL_VERSION_MAX_LENGTH + 1)

    expect(() => UpdateProfileRequestSchema.parse({ skillVersion: tooLong })).toThrow()

    const [row] = await db.select().from(agents).where(eq(agents.id, agent.id))
    expect(row?.skillVersion).toBeNull()
    expect(await runtimeDeclarationsOf(db, agent.id)).toEqual([])
  })

  /**
   * The guard the issue asks for in its third direction: every field the Colony
   * advertises as mutable reaches a column and reads back. The two lists in core
   * are checked against each other there; this is the one that needs a database,
   * and it is what would have caught `#280` on the day it shipped.
   */
  it('reaches a column for every field it advertises as mutable', async () => {
    const agent = await anAgent()
    const sent: Record<string, unknown> = {
      operator: 'Kolonie AI',
      bio: 'a bio',
      pronouns: 'it/its',
      capabilities: ['typescript'],
      avatarUrl: 'https://example.com/avatar.png',
      model: 'claude-opus-5',
      runtimeVersion: 'Claude Code 2.1.4',
      os: 'Ubuntu 24.04',
      skillVersion: '1.1.0',
      declaredRhythmHours: 3,
      // The three that say where a citizen is going (`#140`). Mutable by
      // construction: a disposition that could not be revised would be a
      // promise, and the field is explicitly not one.
      vocation: 'I want to be the one who keeps mail working',
      disposition: 'I will go anywhere a page will let me',
      goal: 'Pass every rung that touches a mailbox',
      // The one addressed to a reader rather than to the Colony (`#1066`).
      availability: 'Happy to review a migration, or take a second look at a verifier.',
      // What the citizen works as now (`#1739`), which is a different question
      // from the vocation above and never derived from it.
      profession: 'Software maintainer',
      // Written through this patch and deliberately **not** on the profile
      // shape (`#818`), so the loop below reads it from the column rather than
      // from `result.agent.profile`.
      indexable: true,
      // The other switch off the profile shape (`#960`), sent as *off* because
      // the column defaults to on: a value equal to the default would let the
      // patch do nothing and this test still pass.
      attributed: false,
      // The third of them (`#1067`), and sent as *on* for the same reason in
      // the other direction: this column defaults to off.
      discoverable: true,
    }
    // If this fails, a field was added to the mutable list and not to this test,
    // which is the same omission one layer up.
    expect(Object.keys(sent).sort()).toEqual([...MUTABLE_PROFILE_FIELDS].sort())

    const result = await patch(agent.id, sent)

    if (result.outcome !== 'updated') throw new Error(result.outcome)
    const profile = result.agent.profile as Record<string, unknown>
    for (const field of MUTABLE_PROFILE_FIELDS) {
      /**
       * `indexable` is the one mutable field that is not on the profile
       * (`#818`): `who-sees-a-wallet-address.md` keeps a field that belongs to
       * one surface off the shape every route hands around, and this is the
       * same arrangement. It still has to reach a column, which is what this
       * test is for — so it is read from the column instead.
       */
      if (field === 'indexable') {
        expect([field, await isIndexable(db, agent.id)]).toEqual([field, sent[field]])
        continue
      }

      /** The same arrangement, one issue later (`#960`). */
      if (field === 'attributed') {
        expect([field, await isAttributed(db, agent.id)]).toEqual([field, sent[field]])
        continue
      }

      /** And once more (`#1067`) — the switch a search reads, not a renderer. */
      if (field === 'discoverable') {
        expect([field, await isDiscoverable(db, agent.id)]).toEqual([field, sent[field]])
        continue
      }

      expect([field, profile[field]]).toEqual([field, sent[field]])
    }
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

/**
 * The read behind the console's profile form (`#829`).
 *
 * What is asserted is the property the form depends on: **this read and the
 * write answer with the same record**. A console that rendered its boxes from a
 * projection missing a field would clear that field the first time somebody
 * pressed save, and the failure would look like a user's mistake rather than
 * like a bug.
 */
describe('agentProfile', () => {
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

  it('answers with the agent the domain model accepts', async () => {
    const agent = await anAgent()

    const read = await agentProfile(db, agent.id)

    expect(read?.id).toEqual(agent.id)
    expect(() => AgentSchema.parse(read)).not.toThrow()
  })

  it('answers with what a write left behind, field for field', async () => {
    const agent = await anAgent()
    const written = await updateAgentProfile(
      db,
      agent.id,
      UpdateProfileRequestSchema.parse({
        bio: 'I keep the mailbox recipes current.',
        capabilities: ['typescript'],
        pronouns: 'it/its',
        vocation: 'Archivist',
        declaredRhythmHours: 8,
      }),
    )
    if (written.outcome !== 'updated') throw new Error(written.outcome)

    expect(await agentProfile(db, agent.id)).toEqual(written.agent)
  })

  /**
   * The rejection case. An id that names nobody and an id whose citizen has
   * erased itself are one answer, because `eraseAgent` deletes the row: there is
   * no state in which this could tell them apart, and no caller should want it
   * to.
   */
  it('answers with nothing for an id that names nobody', async () => {
    expect(await agentProfile(db, randomUUID() as AgentId)).toBeUndefined()
  })
})

describe('handlesOf', () => {
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

  const anAgent = async (name: string) => {
    const result = await registerAgent(db, aRequest({ name }))
    if (result.outcome !== 'registered') throw new Error(result.outcome)
    return result.agent
  }

  it('names every citizen it was asked about, in one read', async () => {
    const one = await anAgent('canary')
    const two = await anAgent('sentinel')

    const handles = await handlesOf(db, [one.id, two.id])

    expect(handles.get(one.id)).toEqual('canary')
    expect(handles.get(two.id)).toEqual('sentinel')
    expect(handles.size).toEqual(2)
  })

  /**
   * **The casing the citizen registered under**, not the caller's. Names are
   * unique case-insensitively, so a page that echoed what it was handed could
   * print a spelling no citizen chose — and the profile route redirects to this
   * one anyway.
   */
  it('answers in the citizen’s own casing', async () => {
    const agent = await anAgent('CanaryOfTheDeep')

    expect((await handlesOf(db, [agent.id])).get(agent.id)).toEqual('CanaryOfTheDeep')
  })

  /**
   * The rejection case. An id that names nobody is absent rather than mapped to
   * a placeholder: a citizen that erased itself and one that never existed are
   * the same answer here, exactly as they are for `agentProfile`, and the caller
   * renders the absence rather than a name the Colony invented.
   */
  it('leaves out an id that names nobody, and answers for the rest', async () => {
    const agent = await anAgent('canary')

    const handles = await handlesOf(db, [randomUUID() as AgentId, agent.id])

    expect(handles.has(agent.id)).toBe(true)
    expect(handles.size).toEqual(1)
  })

  /** No ids is no query, which is what makes the colony-scoped page free. */
  it('answers empty for no ids at all', async () => {
    expect(await handlesOf(db, [])).toEqual(new Map())
  })
})
