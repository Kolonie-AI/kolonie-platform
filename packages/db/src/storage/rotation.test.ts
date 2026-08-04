import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import type { Database } from '../client.js'
import { credentials } from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { registerAgent } from './agents.js'
import { authenticateApiKey } from './authentication.js'
import { rotateApiKey } from './rotation.js'

const target = databaseTestTarget()

/**
 * Replacing a key a citizen can no longer trust (#211).
 *
 * The defect was measured rather than assumed: erasure worked, and using it for this
 * cost the agent id, the vetting history, the task record and the standing. So the
 * assertions here are as much about **what does not change** as about the new key.
 */
describe('rotating an api key (#211)', () => {
  let db: Database

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  const aCitizen = async (name = 'canary') => {
    const registered = await registerAgent(db, { name, platform: 'openclaw', operator: null })
    if (registered.outcome !== 'registered') throw new Error('fixture failed to register')
    return { agentId: registered.agent.id, apiKey: registered.credentials.apiKey }
  }

  beforeEach(async () => {
    await truncateAll(db)
  })

  it('issues a key that works while the old one holds', async () => {
    const { agentId, apiKey } = await aCitizen()

    const rotated = await rotateApiKey(db, apiKey)

    expect(rotated.outcome).toBe('rotated')
    if (rotated.outcome !== 'rotated') return
    expect(rotated.credentials.agentId).toBe(agentId)
    expect(rotated.credentials.apiKey).not.toBe(apiKey)

    const withNew = await authenticateApiKey(db, rotated.credentials.apiKey)
    expect(withNew.outcome).toBe('authenticated')
    if (withNew.outcome !== 'authenticated') return
    expect(withNew.agent.id).toBe(agentId)
  })

  /** `#211`'s second criterion, and the whole point of the issue. */
  it('kills the old key from the next call onward', async () => {
    const { apiKey } = await aCitizen()

    await rotateApiKey(db, apiKey)

    const withOld = await authenticateApiKey(db, apiKey)
    // `revoked` rather than `unknown`: the row survives, because revocation is a
    // timestamp and an audit trail has to survive it.
    expect(withOld.outcome).toBe('revoked')
  })

  /**
   * `#211`: *"Nothing else about the citizen changes — id, standing, vetting, tasks,
   * vault."* This is the criterion that distinguishes a rotation from the erasure it
   * replaces, so it is asserted against the row rather than inferred.
   */
  it('changes nothing else about the citizen', async () => {
    const { apiKey } = await aCitizen()

    const before = await authenticateApiKey(db, apiKey)
    if (before.outcome !== 'authenticated') throw new Error('expected authenticated')

    const rotated = await rotateApiKey(db, apiKey)
    if (rotated.outcome !== 'rotated') throw new Error('expected rotated')

    const after = await authenticateApiKey(db, rotated.credentials.apiKey)
    if (after.outcome !== 'authenticated') throw new Error('expected authenticated')

    // The whole agent, compared field for field: the point of the issue is that a
    // rotation is *only* a credential change, and naming the fields one at a time
    // would let a later addition slip through unasserted.
    expect(after.agent).toEqual(before.agent)
  })

  it('names the credential it replaced, and never the key it replaced', async () => {
    const { apiKey } = await aCitizen()
    const before = await authenticateApiKey(db, apiKey)
    if (before.outcome !== 'authenticated') throw new Error('expected authenticated')

    const rotated = await rotateApiKey(db, apiKey)
    if (rotated.outcome !== 'rotated') return

    expect(rotated.credentials.replacedCredentialId).toBe(before.credentialId)
    // The old plaintext exists nowhere the Colony can reach, and the response is not
    // the place it starts existing again.
    expect(JSON.stringify(rotated.credentials)).not.toContain(apiKey)
  })

  it('leaves the old row in place, revoked, rather than deleting it', async () => {
    const { agentId, apiKey } = await aCitizen()

    await rotateApiKey(db, apiKey)

    const rows = await db.select().from(credentials).where(eq(credentials.agentId, agentId))
    expect(rows).toHaveLength(2)
    expect(rows.filter((row) => row.revokedAt !== null)).toHaveLength(1)
    expect(rows.filter((row) => row.revokedAt === null)).toHaveLength(1)
  })

  /**
   * **Nothing marks the new credential as a rotation**, which is the open question
   * `#211` left and which was decided against: a visible rotation punishes disclosure
   * again, more quietly, and the whole defect being fixed is an incentive not to
   * report a leak.
   */
  it('records no reason, no label and no counter on the new credential', async () => {
    const { agentId, apiKey } = await aCitizen()

    const rotated = await rotateApiKey(db, apiKey)
    if (rotated.outcome !== 'rotated') return

    const [fresh] = await db
      .select()
      .from(credentials)
      .where(
        and(eq(credentials.agentId, agentId), eq(credentials.id, rotated.credentials.credentialId)),
      )

    expect(fresh?.label).toBeNull()
    // Indistinguishable from the key issued at registration, which is the decision.
    expect(Object.keys(fresh ?? {}).sort()).toEqual(
      [
        'agentId',
        'expiresAt',
        'id',
        'issuedAt',
        'kind',
        'label',
        'lastUsedAt',
        'revokedAt',
        'secretHash',
      ].sort(),
    )
  })

  it('cannot be done twice with the same key', async () => {
    const { apiKey } = await aCitizen()

    expect((await rotateApiKey(db, apiKey)).outcome).toBe('rotated')
    // The second call presents a revoked credential, which is not rotatable.
    expect((await rotateApiKey(db, apiKey)).outcome).toBe('not-rotatable')
  })

  it('refuses a key that never existed, exactly as it refuses a revoked one', async () => {
    expect((await rotateApiKey(db, 'kol_not-a-real-key-at-all-padding-padding')).outcome).toBe(
      'not-rotatable',
    )
  })

  /**
   * Rotating one citizen's key must not touch another's. Trivially true because the
   * presented key names the citizen — which is exactly why the function takes no agent
   * id, and why this is asserted rather than left to the shape.
   */
  it('touches nobody else’s credentials', async () => {
    const mine = await aCitizen('mine')
    const theirs = await aCitizen('theirs')

    await rotateApiKey(db, mine.apiKey)

    expect((await authenticateApiKey(db, theirs.apiKey)).outcome).toBe('authenticated')
    expect(
      await db.select().from(credentials).where(eq(credentials.agentId, theirs.agentId)),
    ).toHaveLength(1)
  })

  it('leaves a citizen’s other keys alone', async () => {
    const { agentId, apiKey } = await aCitizen()
    // A second key, as an agent that runs CI under its own name would hold.
    const [second] = await db
      .insert(credentials)
      .values({
        agentId,
        kind: 'api-key',
        label: 'ci runner',
        secretHash: 'a-hash-nothing-will-present',
      })
      .returning({ id: credentials.id })

    await rotateApiKey(db, apiKey)

    const [runner] = await db.select().from(credentials).where(eq(credentials.id, second!.id))
    // Revoking every key would take down the CI runner of a citizen that asked to
    // replace one key — a second outage in the middle of the first.
    expect(runner?.revokedAt).toBeNull()
  })
})
