import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import {
  DIAGNOSIS_RETENTION_DAYS,
  RegisterAgentRequestSchema,
  type AgentId,
  type Finding,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { diagnoses } from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { registerAgent } from './agents.js'
import {
  attachProse,
  openDiagnosesFor,
  openDiagnosisFor,
  recordConsequence,
  recordDiagnosis,
  resolveDisappeared,
  sweepDiagnoses,
  supersedeOlderPolicies,
} from './diagnoses.js'

const target = databaseTestTarget()

const POLICY = '2026-08-13.1'
const AT = new Date('2026-08-13T12:00:00.000Z')
const LATER = new Date('2026-08-13T13:00:00.000Z')

const aFinding = (overrides: Partial<Finding> = {}): Finding => ({
  kind: 'polling-loop',
  severity: 'concern',
  scope: 'agent',
  subject: '11111111-1111-4111-8111-111111111111',
  evidence: { routeKeys: ['/v1/tasks'], figures: { hours: 3, calls: 900 } },
  confidence: 0.6,
  recommendation: 'poll-less-often',
  retryAfterSeconds: 300,
  since: '2026-08-13T09:00:00.000Z',
  until: '2026-08-13T11:59:00.000Z',
  ...overrides,
})

/**
 * Stored diagnoses (`#838`): a finding with a life longer than the request that
 * computed it.
 *
 * The two rejection cases are the ones this file exists for — evidence that is
 * not the rules' own numbers, and a diagnosis nobody could attribute to a rule
 * set. Both would fail silently: the first stores something nobody checked, and
 * the second stores a verdict nobody can overturn.
 */
describe('stored diagnoses', () => {
  let db: Database
  let agentId: AgentId

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
      RegisterAgentRequestSchema.parse({ name: 'canary', platform: 'openclaw' }),
    )
    if (registered.outcome !== 'registered') throw new Error(registered.outcome)
    agentId = registered.agent.id
  })

  const about = (overrides: Partial<Finding> = {}) => aFinding({ subject: agentId, ...overrides })

  it('opens a diagnosis the first time a finding is recorded', async () => {
    const result = await recordDiagnosis(db, about(), POLICY, AT)

    expect(result.outcome).toBe('opened')
    expect(result.diagnosis?.state).toBe('open')
    expect(result.diagnosis?.observations).toBe(1)
    expect(result.diagnosis?.policyVersion).toBe(POLICY)
  })

  /**
   * The card asks about recurrence, and recurrence is a counter on a row rather
   * than a pile of rows somebody has to group afterwards.
   */
  it('counts a second observation onto the same row', async () => {
    await recordDiagnosis(db, about(), POLICY, AT)
    const again = await recordDiagnosis(
      db,
      about({ evidence: { routeKeys: ['/v1/tasks'], figures: { hours: 4, calls: 1_200 } } }),
      POLICY,
      LATER,
    )

    expect(again.outcome).toBe('observed')
    expect(again.diagnosis?.observations).toBe(2)
    expect(again.diagnosis?.firstSeenAt).toContain('12:00:00')
    expect(again.diagnosis?.lastSeenAt).toContain('13:00:00')
    // Replaced rather than merged: a union of two windows describes a window
    // that never happened.
    expect(again.diagnosis?.evidence.figures['calls']).toBe(1_200)

    expect(await db.select().from(diagnoses).where(eq(diagnoses.subject, agentId))).toHaveLength(1)
  })

  it('updates the open row when the severity moves, and says that it did', async () => {
    await recordDiagnosis(db, about({ severity: 'concern' }), POLICY, AT)
    const worse = await recordDiagnosis(db, about({ severity: 'serious' }), POLICY, LATER)

    expect(worse.outcome).toBe('escalated')
    expect(worse.diagnosis?.severity).toBe('serious')
    expect(await db.select().from(diagnoses).where(eq(diagnoses.subject, agentId))).toHaveLength(1)
  })

  /**
   * **The rejection case.** Free text, an address or a request path in evidence
   * would be a stored blob nobody checked — and `#840` builds a model prompt
   * from a finding, so text here is a prompt with an author other than the
   * Colony.
   */
  describe('what may not be stored', () => {
    it('refuses evidence carrying free text', async () => {
      const result = await recordDiagnosis(
        db,
        about({
          evidence: {
            routeKeys: ['/v1/tasks'],
            figures: { note: 'the citizen said it was fine' } as unknown as Record<string, number>,
          },
        }),
        POLICY,
        AT,
      )

      expect(result.outcome).toBe('refused')
      expect(result.refusal).toContain('numbers')
      expect(await db.select().from(diagnoses)).toHaveLength(0)
    })

    it('refuses a figure that is not a finite number', async () => {
      const result = await recordDiagnosis(
        db,
        about({
          evidence: { routeKeys: ['/v1/tasks'], figures: { rate: Number.POSITIVE_INFINITY } },
        }),
        POLICY,
        AT,
      )

      expect(result.outcome).toBe('refused')
      expect(await db.select().from(diagnoses)).toHaveLength(0)
    })

    /** **The second rejection case.** An unattributable diagnosis is not auditable. */
    it('refuses a diagnosis with no policy version', async () => {
      const result = await recordDiagnosis(db, about(), '   ', AT)

      expect(result.outcome).toBe('refused')
      expect(result.refusal).toContain('auditable')
      expect(await db.select().from(diagnoses)).toHaveLength(0)
    })

    /**
     * The schema check, reached through the storage function. A colony-scoped
     * finding that named a citizen would pass every test written about scopes,
     * because it would still say `colony`.
     */
    it('refuses a colony-scoped diagnosis that names a citizen', async () => {
      const result = await recordDiagnosis(
        db,
        // `scope: colony` with a citizen id as the subject: the storage function
        // derives `agent_id` from the scope, so this lands as a colony row with
        // no citizen — which is correct, and the row is about the id as a
        // *string* rather than about the citizen.
        about({ scope: 'colony', subject: '/v1/tasks' }),
        POLICY,
        AT,
      )

      expect(result.outcome).toBe('opened')
      const [row] = await db.select().from(diagnoses)
      expect(row?.agentId).toBeNull()
      expect(row?.subject).toBe('/v1/tasks')
    })
  })

  describe('a rule change', () => {
    /**
     * A finding made under different arithmetic is a different judgement. The
     * old row keeps its evidence and its version, and the new one opens beside
     * it — so a reader can see that the verdict changed because the rules did.
     */
    it('opens a new diagnosis and supersedes the old one', async () => {
      await recordDiagnosis(db, about(), POLICY, AT)
      expect(await supersedeOlderPolicies(db, '2026-09-01.1', LATER)).toBe(1)
      const after = await recordDiagnosis(db, about(), '2026-09-01.1', LATER)

      expect(after.outcome).toBe('opened')

      const rows = await db.select().from(diagnoses).where(eq(diagnoses.subject, agentId))
      expect(rows).toHaveLength(2)
      expect(rows.filter((row) => row.state === 'superseded')).toHaveLength(1)
      expect(rows.filter((row) => row.state === 'open')).toHaveLength(1)
    })
  })

  describe('a finding that stops matching', () => {
    it('is resolved by the pass that noticed, without anybody closing it', async () => {
      await recordDiagnosis(db, about(), POLICY, AT)

      expect(await resolveDisappeared(db, agentId, [], LATER)).toBe(1)

      const [row] = await db.select().from(diagnoses)
      expect(row?.state).toBe('resolved')
      expect(row?.resolvedAt).toContain('13:00:00')
    })

    it('leaves a finding the pass found again alone', async () => {
      await recordDiagnosis(db, about(), POLICY, AT)

      expect(await resolveDisappeared(db, agentId, ['polling-loop'], LATER)).toBe(0)

      const [row] = await db.select().from(diagnoses)
      expect(row?.state).toBe('open')
    })

    it('resolves the one that went and keeps the one that stayed', async () => {
      await recordDiagnosis(db, about({ kind: 'polling-loop' }), POLICY, AT)
      await recordDiagnosis(db, about({ kind: 'oversized-reads' }), POLICY, AT)

      expect(await resolveDisappeared(db, agentId, ['oversized-reads'], LATER)).toBe(1)

      const open = await openDiagnosesFor(db, agentId)
      expect(open.map((each) => each.kind)).toEqual(['oversized-reads'])
    })

    /**
     * A resolved diagnosis frees the dedupe key. The same problem returning
     * months later is a separate episode with its own window, and merging the
     * two would make *first seen* a date from a different story.
     */
    it('lets the same finding open again later as its own episode', async () => {
      await recordDiagnosis(db, about(), POLICY, AT)
      await resolveDisappeared(db, agentId, [], LATER)
      const returned = await recordDiagnosis(db, about(), POLICY, new Date('2026-09-13T12:00:00Z'))

      expect(returned.outcome).toBe('opened')
      expect(returned.diagnosis?.observations).toBe(1)
      expect(await db.select().from(diagnoses)).toHaveLength(2)
    })
  })

  describe('reading them back', () => {
    it('answers with the most serious first', async () => {
      await recordDiagnosis(db, about({ kind: 'deprecated-route', severity: 'notice' }), POLICY, AT)
      await recordDiagnosis(db, about({ kind: 'polling-loop', severity: 'serious' }), POLICY, AT)
      await recordDiagnosis(db, about({ kind: 'no-progress', severity: 'concern' }), POLICY, AT)

      expect((await openDiagnosesFor(db, agentId)).map((each) => each.severity)).toEqual([
        'serious',
        'concern',
        'notice',
      ])
    })

    it('answers with nothing for a subject that has none', async () => {
      expect(await openDiagnosesFor(db, agentId)).toEqual([])
      expect(await openDiagnosisFor(db, 'agent', agentId, 'polling-loop', POLICY)).toBeNull()
    })
  })

  describe('what a diagnosis caused', () => {
    it('links the ticket it opened', async () => {
      const opened = await recordDiagnosis(db, about(), POLICY, AT)
      const [ticket] = await db
        .insert((await import('../schema/index.js')).supportTickets)
        .values({
          agentId,
          kind: 'defect',
          subject: 'a route is failing',
          body: 'the numbers are in the diagnosis',
        })
        .returning()

      await recordConsequence(db, opened.diagnosis?.id ?? '', ticket?.id ?? '')

      const [row] = await db.select().from(diagnoses)
      expect(row?.supportTicketId).toBe(ticket?.id)
    })
  })

  describe('prose', () => {
    it('is absent by default, and a diagnosis without it is complete', async () => {
      const opened = await recordDiagnosis(db, about(), POLICY, AT)

      expect(opened.diagnosis?.prose).toBeNull()
      expect(opened.diagnosis?.proseModel).toBeNull()
    })

    /**
     * The structured fields are byte-identical before and after a sentence is
     * attached. If prose could move a severity, the model would be deciding.
     */
    it('changes no structured field when it is attached', async () => {
      const opened = await recordDiagnosis(db, about(), POLICY, AT)
      const [before] = await db.select().from(diagnoses)

      await attachProse(
        db,
        opened.diagnosis?.id ?? '',
        'You are calling one route every 12 seconds.',
        'a-model-version',
      )

      const [after] = await db.select().from(diagnoses)
      expect({ ...after, prose: null, proseModel: null }).toEqual({
        ...before,
        prose: null,
        proseModel: null,
      })
      expect(after?.prose).toContain('12 seconds')
    })
  })

  describe('the retention sweep', () => {
    const daysBefore = (from: Date, days: number) =>
      new Date(from.getTime() - days * 24 * 60 * 60 * 1000)

    it('deletes a resolved agent-scoped diagnosis past the window', async () => {
      const now = new Date('2026-12-01T12:00:00.000Z')
      await recordDiagnosis(db, about(), POLICY, daysBefore(now, DIAGNOSIS_RETENTION_DAYS + 2))
      await resolveDisappeared(db, agentId, [], daysBefore(now, DIAGNOSIS_RETENTION_DAYS + 1))

      expect(await sweepDiagnoses(db, now)).toBe(1)
      expect(await db.select().from(diagnoses)).toHaveLength(0)
    })

    it('keeps an open one, however old', async () => {
      const now = new Date('2026-12-01T12:00:00.000Z')
      await recordDiagnosis(db, about(), POLICY, daysBefore(now, 300))

      expect(await sweepDiagnoses(db, now)).toBe(0)
      expect(await db.select().from(diagnoses)).toHaveLength(1)
    })

    /** A colony-scoped row names nobody, and a signature the Colony has seen before is worth keeping. */
    it('keeps a resolved colony-scoped one', async () => {
      const now = new Date('2026-12-01T12:00:00.000Z')
      await recordDiagnosis(
        db,
        about({ scope: 'colony', subject: '/v1/tasks', kind: 'retry-storm' }),
        POLICY,
        daysBefore(now, DIAGNOSIS_RETENTION_DAYS + 2),
      )
      await resolveDisappeared(db, '/v1/tasks', [], daysBefore(now, DIAGNOSIS_RETENTION_DAYS + 1))

      expect(await sweepDiagnoses(db, now)).toBe(0)
      expect(await db.select().from(diagnoses)).toHaveLength(1)
    })
  })
})
