import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  AccountKindSchema,
  RegisterAgentRequestSchema,
  SkillSchema,
  type AgentId,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { registerAgent } from './agents.js'

import {
  declareAccount,
  recordProvedAccount,
  setAccountAttestable,
  setAccountStatus,
} from './accounts.js'
import { attestation } from './attestations.js'
import { agentSkills, submissions, tasks } from '../schema/index.js'
import { seedAcademyTasks } from '../academy-tasks.js'

const target = databaseTestTarget()
const kind = (value: string) => AccountKindSchema.parse(value)
const skill = (value: string) => SkillSchema.parse(value)

/**
 * What the Colony confirms to a stranger (`#519`).
 *
 * **The tests are mostly about the answer being *no*, and that is the point.** The value
 * of this surface is a yes that means something; the safety of it is that every reason for
 * a no is indistinguishable, because a caller that can tell them apart has an oracle for
 * which identifiers belong to citizens and which citizens declined to be asked about.
 */
describe('an attestation', () => {
  let db: Database
  let agentId: AgentId
  let accountId: string

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await truncateAll(db)
    const registered = await registerAgent(
      db,
      RegisterAgentRequestSchema.parse({ name: 'vouched', platform: 'openclaw' }),
    )
    if (registered.outcome !== 'registered') throw new Error(registered.outcome)
    agentId = registered.agent.id

    const account = await recordProvedAccount(db, agentId, {
      kind: kind('github'),
      identifier: 'colette',
      capabilities: [],
      provedAt: new Date().toISOString(),
    })
    accountId = account.id

    /**
     * The skill row written directly, and the reason is the same one `badges.test.ts`
     * gives: `grantSkills` runs inside a verdict's transaction and takes the submission
     * that earned it, and driving a whole verifier to test a *read* would make this a
     * test of the verdict path.
     */
    await seedAcademyTasks(db)
    const [task] = await db.select({ id: tasks.id }).from(tasks).limit(1)
    const [submission] = await db
      .insert(submissions)
      .values({
        taskId: task!.id,
        agentId,
        payload: {},
        status: 'passed',
        verifiedAt: new Date().toISOString(),
      })
      .returning({ id: submissions.id })
    await db
      .insert(agentSkills)
      .values({ agentId, skill: skill('github'), submissionId: submission!.id })
  })

  const ask = (identifier = 'colette', named = 'github') =>
    attestation(db, kind('github'), identifier, skill(named))

  it('says nothing until the citizen has opted in', async () => {
    // Off by default: answering about an account that never agreed is publishing
    // something the citizen did not publish.
    expect(await ask()).toEqual({ holds: false, grantedAt: null, accountProvedBy: null })
  })

  it('confirms the proof once the citizen has, and names what proved the account', async () => {
    await setAccountAttestable(db, agentId, accountId, true)

    const answer = await ask()

    expect(answer.holds).toBe(true)
    expect(answer.grantedAt).not.toBeNull()
    // A rung and a generic proof are different strengths, and the reader deciding whether
    // to trust an agent is exactly the one entitled to know which.
    expect(answer.accountProvedBy).toBe('rung')
  })

  it('answers a skill the citizen does not hold identically to one it was not asked about', async () => {
    await setAccountAttestable(db, agentId, accountId, true)

    const lacking = await ask('colette', 'domain')
    const unknownIdentifier = await ask('somebody-else')

    /**
     * **The assertion the whole design rests on.** Byte-identical answers, so a caller
     * cannot tell *this citizen lacks the skill* from *this identifier is nobody's* from
     * *this citizen declined to be asked about*.
     */
    expect(lacking).toEqual(unknownIdentifier)
    expect(lacking.holds).toBe(false)
  })

  it('says nothing about an account that is only declared', async () => {
    const declared = await declareAccount(db, agentId, {
      kind: kind('social'),
      identifier: '@asserted',
    })
    if (declared.outcome !== 'declared') throw new Error(declared.outcome)
    await setAccountAttestable(db, agentId, declared.account.id, true)

    // The citizen's word is what this exists to replace, so an asserted account attests
    // to nothing even when its holder opted in.
    expect((await attestation(db, kind('social'), '@asserted', skill('github'))).holds).toBe(false)
  })

  it('says nothing about an account the citizen retired', async () => {
    await setAccountAttestable(db, agentId, accountId, true)
    await setAccountStatus(db, agentId, accountId, 'retired')

    // The citizen said it no longer holds it, and vouching for it anyway would be the
    // Colony overriding the one field it does not own.
    expect((await ask()).holds).toBe(false)
  })

  it('is answered case-insensitively, because a handle is not a password', async () => {
    await setAccountAttestable(db, agentId, accountId, true)

    expect((await ask('COLETTE')).holds).toBe(true)
  })

  it('answers as though an erased citizen never existed', async () => {
    await setAccountAttestable(db, agentId, accountId, true)
    expect((await ask()).holds).toBe(true)

    // `#429`'s obligation reaches here, and it falls out of the shape rather than needing
    // a branch: erasure cascades the account away, the lookup finds nothing, and nothing
    // is already the same answer as no.
    await db.execute(`delete from agents where id = '${agentId}'`)

    expect(await ask()).toEqual({ holds: false, grantedAt: null, accountProvedBy: null })
  })
})
