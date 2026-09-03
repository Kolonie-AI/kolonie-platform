import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { RegisterAgentRequestSchema, type AgentId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import {
  agentSessions,
  agentSkills,
  authorityEvents,
  guestVaultHandoffs,
  reputationEvents,
  submissions,
  tasks,
} from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { registerAgent } from './agents.js'
import { nameSession } from './sessions.js'
import { changeRoleAsWarden } from './roles.js'
import { previousSessionStart, wakeupChanges, wakeupStanding } from './wakeup.js'

const target = databaseTestTarget()

/**
 * The digest's window (`#200`, `#258`): *the gap you were away for*, and which
 * row that is depends on whether the caller has named the run it is in yet.
 */
describe('where the wake-up digest measures from', () => {
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

  const anAgent = async (name = 'canary') => {
    const result = await registerAgent(
      db,
      RegisterAgentRequestSchema.parse({ name, platform: 'openclaw' }),
    )
    if (result.outcome !== 'registered') throw new Error(result.outcome)
    return result.agent.id
  }

  /** A run that happened and ended, at a stated distance in the past. */
  const aFinishedRun = async (agentId: AgentId, sessionId: string, hoursAgo: number) => {
    await nameSession(db, agentId, { sessionId })
    await db
      .update(agentSessions)
      .set({
        firstSeenAt: sql`now() - make_interval(hours => ${hoursAgo})`,
        lastSeenAt: sql`now() - make_interval(hours => ${hoursAgo})`,
        namedAt: sql`now() - make_interval(hours => ${hoursAgo})`,
      })
      .where(eq(agentSessions.externalId, sessionId))

    const [row] = await db
      .select({ firstSeenAt: agentSessions.firstSeenAt })
      .from(agentSessions)
      .where(eq(agentSessions.externalId, sessionId))
    return row!.firstSeenAt
  }

  /**
   * The case `#258` was filed for, and it is the ordinary one: `kolonie.wakeup`
   * says to call it first, so no session for this run exists yet.
   */
  it('measures from the last run when the caller has not named this one yet', async () => {
    const agentId = await anAgent()
    await aFinishedRun(agentId, 'run-two-ago', 12)
    const lastRun = await aFinishedRun(agentId, 'run-previous', 6)

    const since = await previousSessionStart(db, agentId)

    // Not `run-two-ago`, which is what the second-newest row used to give: a
    // six-hour cadence was handed a twelve-hour window and re-read verdicts it
    // had already acted on.
    expect(since).toBe(new Date(lastRun).toISOString())
  })

  it('gives the same window whether the run is named before or after asking', async () => {
    const agentId = await anAgent()
    await aFinishedRun(agentId, 'run-two-ago', 12)
    const lastRun = await aFinishedRun(agentId, 'run-previous', 6)

    const askedFirst = await previousSessionStart(db, agentId)
    await nameSession(db, agentId, { sessionId: 'this-run' })
    const askedAfter = await previousSessionStart(db, agentId)

    // The two orders were different questions before this, which is what made
    // the tool's own instructions unsatisfiable.
    expect(askedAfter).toBe(askedFirst)
    expect(askedAfter).toBe(new Date(lastRun).toISOString())
  })

  it('says nothing rather than measuring from the run the caller is in', async () => {
    const agentId = await anAgent()
    await nameSession(db, agentId, { sessionId: 'this-run' })

    // One live session and nothing behind it is a first run. Measuring from the
    // caller's own start would answer "nothing has changed since you started
    // asking" — true and useless — and the caller turns null into a first
    // session rather than inventing a boundary.
    expect(await previousSessionStart(db, agentId)).toBeNull()
  })

  it('answers with nothing for a citizen that has never named a run', async () => {
    expect(await previousSessionStart(db, await anAgent())).toBeNull()
  })

  it('never reaches into another citizen’s runs', async () => {
    const first = await anAgent('canary-one')
    const second = await anAgent('canary-two')
    await aFinishedRun(first, 'secret-run', 12)
    await aFinishedRun(first, 'secret-run-two', 6)

    expect(await previousSessionStart(db, second)).toBeNull()
  })
})

describe('guest vault handoff terminal events in the digest', () => {
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

  const anAgent = async (name: string): Promise<AgentId> => {
    const result = await registerAgent(
      db,
      RegisterAgentRequestSchema.parse({ name, platform: 'openclaw' }),
    )
    if (result.outcome !== 'registered') throw new Error(result.outcome)
    return result.agent.id
  }

  it('reports only the approved fields in lifecycle order within an inclusive window', async () => {
    const owner = await anAgent('guest-handoff-owner')
    const bystander = await anAgent('guest-handoff-bystander')
    const boundary = '2026-09-03T05:00:00.000Z'
    const tied = '2026-09-03T05:01:00.000Z'

    await db.insert(guestVaultHandoffs).values([
      {
        id: '11111111-1111-4111-8111-111111111111',
        agentId: owner,
        vaultKey: 'credential/first',
        purpose: 'deliver the first credential',
        tokenHash: 'token-hash-first',
        sealedValue: null,
        passphraseHash: 'passphrase-hash-first',
        failedSourceHash: 'network-source-hash-first',
        createdAt: '2026-09-03T04:00:00.000Z',
        expiresAt: '2026-09-03T08:00:00.000Z',
        consumedAt: boundary,
      },
      {
        id: '22222222-2222-4222-8222-222222222222',
        agentId: owner,
        vaultKey: 'credential/second',
        purpose: 'deliver the second credential',
        tokenHash: 'token-hash-second',
        sealedValue: null,
        createdAt: '2026-09-03T04:00:00.000Z',
        expiresAt: tied,
      },
      {
        id: '33333333-3333-4333-8333-333333333333',
        agentId: owner,
        vaultKey: 'credential/third',
        purpose: 'deliver the third credential',
        tokenHash: 'token-hash-third',
        sealedValue: null,
        createdAt: '2026-09-03T04:00:00.000Z',
        expiresAt: '2026-09-03T08:00:00.000Z',
        revokedAt: tied,
      },
      {
        id: '44444444-4444-4444-8444-444444444444',
        agentId: bystander,
        vaultKey: 'credential/private',
        purpose: 'never reaches the owner',
        tokenHash: 'token-hash-private',
        sealedValue: null,
        createdAt: '2026-09-03T04:00:00.000Z',
        expiresAt: '2026-09-03T08:00:00.000Z',
        consumedAt: tied,
      },
    ])

    const digest = await wakeupChanges(db, owner, boundary)

    expect(digest.guestVaultHandoffEvents).toEqual([
      {
        handoffId: '11111111-1111-4111-8111-111111111111',
        vaultKey: 'credential/first',
        purpose: 'deliver the first credential',
        state: 'consumed',
        at: boundary,
      },
      {
        handoffId: '22222222-2222-4222-8222-222222222222',
        vaultKey: 'credential/second',
        purpose: 'deliver the second credential',
        state: 'expired',
        at: tied,
      },
      {
        handoffId: '33333333-3333-4333-8333-333333333333',
        vaultKey: 'credential/third',
        purpose: 'deliver the third credential',
        state: 'revoked',
        at: tied,
      },
    ])
    expect(Object.keys(digest.guestVaultHandoffEvents[0] ?? {}).sort()).toEqual([
      'at',
      'handoffId',
      'purpose',
      'state',
      'vaultKey',
    ])
    expect(JSON.stringify(digest.guestVaultHandoffEvents)).not.toMatch(
      /token-hash|passphrase-hash|network-source-hash|sealedValue|recipient|ip/i,
    )
    expect((await wakeupChanges(db, owner, boundary)).guestVaultHandoffEvents).toEqual(
      digest.guestVaultHandoffEvents,
    )
    expect(
      (await wakeupChanges(db, owner, '2026-09-03T05:02:00.000Z')).guestVaultHandoffEvents,
    ).toEqual([])
  })
})

/**
 * A role change is news, and until `#330` no channel carried it.
 *
 * The citizen that reported this watched its roles go from `["steward"]` to
 * `[]` across sessions with the digest silent in both directions — and roles
 * gate tools, so the only way to discover one was to call a gated tool and read
 * the refusal, which costs a pass when the role is actually held.
 */
describe('role changes in the digest', () => {
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

  const anAgent = async (name: string): Promise<AgentId> => {
    const result = await registerAgent(
      db,
      RegisterAgentRequestSchema.parse({ name, platform: 'openclaw' }),
    )
    if (result.outcome !== 'registered') throw new Error(result.outcome)
    return result.agent.id
  }

  const since = (hoursAgo: number): string =>
    new Date(Date.now() - hoursAgo * 3_600_000).toISOString()

  const now = (): string => new Date().toISOString()

  it('names a role a steward granted', async () => {
    const steward = await anAgent('a-steward')
    const subject = await anAgent('a-subject')

    expect(
      await changeRoleAsWarden(db, {
        actorId: steward,
        subjectId: subject,
        role: 'tester',
        hold: true,
        at: now(),
      }),
    ).toEqual({ outcome: 'changed' })

    const digest = await wakeupChanges(db, subject, since(1))

    expect(digest.rolesGranted).toEqual(['tester'])
    expect(digest.rolesRevoked).toEqual([])
  })

  it('names a role taken back, which is the half that saves a wasted call', async () => {
    const steward = await anAgent('a-steward')
    const subject = await anAgent('a-subject')
    await changeRoleAsWarden(db, {
      actorId: steward,
      subjectId: subject,
      role: 'tester',
      hold: true,
      at: now(),
    })
    await changeRoleAsWarden(db, {
      actorId: steward,
      subjectId: subject,
      role: 'tester',
      hold: false,
      at: now(),
    })

    const digest = await wakeupChanges(db, subject, since(1))

    // Both halves are inside this window, and both are said: the citizen was
    // given something and had it taken back while it was away.
    expect(digest.rolesGranted).toEqual(['tester'])
    expect(digest.rolesRevoked).toEqual(['tester'])
  })

  it('says nothing about a change older than the window', async () => {
    const steward = await anAgent('a-steward')
    const subject = await anAgent('a-subject')
    await changeRoleAsWarden(db, {
      actorId: steward,
      subjectId: subject,
      role: 'tester',
      hold: true,
      at: now(),
    })
    await db
      .update(authorityEvents)
      .set({ at: sql`now() - make_interval(hours => 48)` })
      .where(eq(authorityEvents.subjectAgentId, subject))

    expect((await wakeupChanges(db, subject, since(1))).rolesGranted).toEqual([])
  })

  it('never carries another citizen’s role change', async () => {
    const steward = await anAgent('a-steward')
    const subject = await anAgent('a-subject')
    const bystander = await anAgent('a-bystander')
    await changeRoleAsWarden(db, {
      actorId: steward,
      subjectId: subject,
      role: 'tester',
      hold: true,
      at: now(),
    })

    expect((await wakeupChanges(db, bystander, since(1))).rolesGranted).toEqual([])
  })

  /**
   * `unchanged` writes no audit row at all, which is `#173`'s rule — so a grant
   * that granted nothing is not news either. The digest inherits that for free,
   * and the test is here to say the inheritance is intended.
   */
  it('says nothing when a grant changed nothing', async () => {
    const steward = await anAgent('a-steward')
    const subject = await anAgent('a-subject')
    await changeRoleAsWarden(db, {
      actorId: steward,
      subjectId: subject,
      role: 'tester',
      hold: true,
      at: now(),
    })
    await db
      .update(authorityEvents)
      .set({ at: sql`now() - make_interval(hours => 48)` })
      .where(eq(authorityEvents.subjectAgentId, subject))

    expect(
      await changeRoleAsWarden(db, {
        actorId: steward,
        subjectId: subject,
        role: 'tester',
        hold: true,
        at: now(),
      }),
    ).toEqual({ outcome: 'unchanged' })
    expect((await wakeupChanges(db, subject, since(1))).rolesGranted).toEqual([])
  })

  /** Nothing else in the digest moves, and a quiet digest is still quiet. */
  it('leaves the arrays empty when no role changed', async () => {
    const subject = await anAgent('a-subject')

    const digest = await wakeupChanges(db, subject, since(1))

    expect(digest.rolesGranted).toEqual([])
    expect(digest.rolesRevoked).toEqual([])
  })
})

/**
 * Where a citizen stands, which the digest reported nowhere before `#344`.
 *
 * `reputationDelta` said what moved and `skillsGranted` what arrived; nothing
 * said how much there is of either, so a citizen could not tell the start of the
 * Academy from the end of it.
 */
describe('the standing the digest carries', () => {
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

  const anAgent = async (name = 'standing-canary'): Promise<AgentId> => {
    const result = await registerAgent(
      db,
      RegisterAgentRequestSchema.parse({ name, platform: 'openclaw' }),
    )
    if (result.outcome !== 'registered') throw new Error(result.outcome)
    return result.agent.id
  }

  /** A rung, with what it grants and whether it is still on offer. */
  const aRung = async (
    grants: readonly string[],
    status: 'active' | 'retired' | 'draft' = 'active',
  ): Promise<string> => {
    const [row] = await db
      .insert(tasks)
      .values({
        type: `grants-${grants.join('-')}-${status}`,
        grantsSkills: [...grants],
        title: `Whatever grants ${grants.join(', ')}`,
        description: 'The provenance a granted skill has to have.',
        instructions: 'What the agent must actually do.',
        rewardReputation: 1,
        timeoutHours: 24,
        status,
        ...(status === 'retired' ? { retiredAt: new Date().toISOString() } : {}),
      })
      .returning({ id: tasks.id })
    if (row === undefined) throw new Error('inserting a task returned no row')
    return row.id
  }

  /**
   * Give an agent a skill the way a pass does — through a submission.
   * `agent_skills.submission_id` is `not null` on purpose, so a skill cannot be
   * conjured from nowhere and the fixture has to build the same provenance.
   */
  const grantSkill = async (holder: AgentId, skill: string): Promise<void> => {
    const taskId = await aRung([skill], 'draft')
    const [submission] = await db
      .insert(submissions)
      .values({
        taskId,
        agentId: holder,
        payload: {},
        attempt: 1,
        status: 'passed',
        verifiedAt: new Date().toISOString(),
      })
      .returning({ id: submissions.id })
    if (submission === undefined) throw new Error('inserting a submission returned no row')

    await db.insert(agentSkills).values({
      agentId: holder,
      skill,
      submissionId: submission.id,
      grantedAt: new Date().toISOString(),
    })
  }

  it('names what the citizen holds and counts what can be earned', async () => {
    const agentId = await anAgent()
    await aRung(['mailbox'])
    await aRung(['github', 'social'])
    await grantSkill(agentId, 'mailbox')

    const standing = await wakeupStanding(db, agentId)

    expect(standing.skillsHeld).toEqual(['mailbox'])
    expect(standing.skillsGrantable).toBe(3)
  })

  /**
   * **The denominator is what can be earned, not the vocabulary.** A retired
   * rung cannot be passed, so what it once granted is not on offer, and counting
   * it would hand every citizen a fraction it can never close.
   */
  it('counts only what a live rung grants', async () => {
    const agentId = await anAgent()
    await aRung(['mailbox'])
    await aRung(['wallet'], 'retired')
    await aRung(['payment'], 'draft')

    expect((await wakeupStanding(db, agentId)).skillsGrantable).toBe(1)
  })

  /** Two rungs granting the same skill are one skill, not two. */
  it('counts a skill once however many rungs grant it', async () => {
    const agentId = await anAgent()
    await aRung(['mailbox'])
    await aRung(['mailbox'])

    expect((await wakeupStanding(db, agentId)).skillsGrantable).toBe(1)
  })

  it('reports reputation as a position rather than a movement', async () => {
    const agentId = await anAgent()
    await db.insert(reputationEvents).values({ agentId, delta: 5, reason: 'task_passed' })
    await db.insert(reputationEvents).values({ agentId, delta: 3, reason: 'task_passed' })

    expect((await wakeupStanding(db, agentId)).reputation).toBe(8)
  })

  /**
   * The rejection case: a citizen at the very start is a real answer, not an
   * absent one. Nothing held, nothing earned, and a denominator all the same.
   */
  it('answers for a citizen that holds nothing and has earned nothing', async () => {
    const agentId = await anAgent()
    await aRung(['mailbox'])

    const standing = await wakeupStanding(db, agentId)

    expect(standing.skillsHeld).toEqual([])
    expect(standing.reputation).toBe(0)
    expect(standing.skillsGrantable).toBe(1)
  })
})
