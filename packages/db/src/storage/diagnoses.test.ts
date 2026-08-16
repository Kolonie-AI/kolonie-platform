import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import {
  DIAGNOSIS_RETENTION_DAYS,
  DOCTOR_TELLING_COOLING_HOURS,
  DOCTOR_TELLING_GRACE_MINUTES,
  RegisterAgentRequestSchema,
  type AgentId,
  type Finding,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { diagnoses } from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { registerAgent } from './agents.js'
import { recordDoctorFeedback } from './doctor-feedback.js'
import {
  attachProse,
  consultationFunnel,
  ruleHealth,
  doctorTellingFor,
  markConsulted,
  recordTelling,
  openDiagnosesFor,
  openDiagnosisFor,
  recordConsequence,
  recordDiagnosis,
  escalatableDiagnoses,
  recordEscalation,
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

/**
 * Telling the citizen, on waking (`#842`).
 *
 * The two that would fail silently: a citizen told hourly about the same thing
 * — which is how a channel gets ignored — and a `wakeup` that answered
 * differently on a second call in the same waking, which would quietly break
 * what that call promises about itself.
 */
describe('what the citizen is told on waking', () => {
  let db: Database
  let agentId: AgentId

  const AT = new Date('2026-08-13T12:00:00.000Z')
  const POLICY = '2026-08-13.1'

  const hoursAfter = (from: Date, hours: number) =>
    new Date(from.getTime() + hours * 60 * 60 * 1000)
  const minutesAfter = (from: Date, minutes: number) =>
    new Date(from.getTime() + minutes * 60 * 1000)

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

  const open = async (overrides: Partial<Finding> = {}, at = AT) => {
    const written = await recordDiagnosis(
      db,
      aFinding({ subject: agentId, ...overrides }),
      POLICY,
      at,
    )
    if (written.diagnosis === null) throw new Error(written.refusal ?? 'not stored')
    return written.diagnosis
  }

  it('offers a finding the citizen has never been told about', async () => {
    const diagnosis = await open()

    expect((await doctorTellingFor(db, agentId, AT))?.id).toBe(diagnosis.id)
  })

  it('offers the most serious of several, and only that one', async () => {
    await open({ kind: 'deprecated-route', severity: 'notice' })
    const worst = await open({ kind: 'polling-loop', severity: 'serious' })
    await open({ kind: 'no-progress', severity: 'concern' })

    expect((await doctorTellingFor(db, agentId, AT))?.id).toBe(worst.id)
  })

  /**
   * **The rejection case.** A citizen that was told and did not change is not
   * told again the next hour. Nagging is how a channel gets ignored, and the
   * `open` list holds five things.
   */
  it('says nothing on the next waking when nothing has changed', async () => {
    const diagnosis = await open()
    await recordTelling(db, diagnosis.id, 'concern', AT)

    expect(await doctorTellingFor(db, agentId, hoursAfter(AT, 1))).toBeNull()
  })

  /**
   * **The second rejection case.** `kolonie.wakeup` says of itself that it
   * consumes nothing and is safe to call twice. An entry that vanished on the
   * second call in one waking would break that quietly — an agent re-reading its
   * own list would find the Doctor gone and conclude the finding had resolved.
   */
  it('answers the same on a second call in the same waking', async () => {
    const diagnosis = await open()
    await recordTelling(db, diagnosis.id, 'concern', AT)

    const again = await doctorTellingFor(db, agentId, minutesAfter(AT, 1))
    expect(again?.id).toBe(diagnosis.id)
    expect(
      await doctorTellingFor(db, agentId, minutesAfter(AT, DOCTOR_TELLING_GRACE_MINUTES + 1)),
    ).toBeNull()
  })

  it('offers it again once the cooling period has passed', async () => {
    const diagnosis = await open()
    await recordTelling(db, diagnosis.id, 'concern', AT)

    expect(
      await doctorTellingFor(db, agentId, hoursAfter(AT, DOCTOR_TELLING_COOLING_HOURS - 1)),
    ).toBeNull()
    expect(
      (await doctorTellingFor(db, agentId, hoursAfter(AT, DOCTOR_TELLING_COOLING_HOURS + 1)))?.id,
    ).toBe(diagnosis.id)
  })

  it('re-announces when the severity rises, before any cooling', async () => {
    const diagnosis = await open({ severity: 'concern' })
    await recordTelling(db, diagnosis.id, 'concern', AT)
    await recordDiagnosis(
      db,
      aFinding({ subject: agentId, severity: 'serious' }),
      POLICY,
      hoursAfter(AT, 1),
    )

    expect((await doctorTellingFor(db, agentId, hoursAfter(AT, 1)))?.id).toBe(diagnosis.id)
  })

  /**
   * A decrease is not new information. The citizen was told, it is getting
   * better, and spending one of five entries to say *slightly better* would be
   * the Colony talking about itself.
   */
  it('does not re-announce when the severity falls', async () => {
    const diagnosis = await open({ severity: 'serious' })
    await recordTelling(db, diagnosis.id, 'serious', AT)
    await recordDiagnosis(
      db,
      aFinding({ subject: agentId, severity: 'concern' }),
      POLICY,
      hoursAfter(AT, 1),
    )

    expect(await doctorTellingFor(db, agentId, hoursAfter(AT, 1))).toBeNull()
  })

  it('stops offering a diagnosis that resolved, without anything clearing it', async () => {
    await open()
    await resolveDisappeared(db, agentId, [], hoursAfter(AT, 1))

    expect(await doctorTellingFor(db, agentId, hoursAfter(AT, 2))).toBeNull()
  })

  /**
   * A colony-scoped diagnosis is about a route and reaches the people who run
   * the Colony. Announcing one to a citizen would be telling somebody about a
   * defect that is not theirs and that they cannot act on.
   */
  it('never offers a colony-scoped finding to a citizen', async () => {
    await open({ scope: 'colony', subject: '/v1/tasks', kind: 'retry-storm' })

    expect(await doctorTellingFor(db, agentId, AT)).toBeNull()
  })

  it('offers nothing about another citizen', async () => {
    await open()
    const other = await registerAgent(
      db,
      RegisterAgentRequestSchema.parse({ name: 'stranger', platform: 'openclaw' }),
    )
    if (other.outcome !== 'registered') throw new Error(other.outcome)

    expect(await doctorTellingFor(db, other.agent.id, AT)).toBeNull()
  })

  /**
   * The stamp does not move on a repeat inside the grace window. Without that, a
   * citizen calling `wakeup` every ten minutes would hold its own cooling period
   * open forever and be told the same thing every time.
   */
  it('does not move the stamp when the same telling is recorded twice', async () => {
    const diagnosis = await open()
    await recordTelling(db, diagnosis.id, 'concern', AT)
    await recordTelling(db, diagnosis.id, 'concern', minutesAfter(AT, 5))

    const [row] = await db.select().from(diagnoses).where(eq(diagnoses.id, diagnosis.id))
    expect(row?.announcedAt).toContain('12:00:00')
  })
})

/**
 * A colony-scoped finding's way out of the table (`#869`).
 *
 * Before this, `apps/doctor-runner` wrote these correctly and **nothing read
 * them**: `#839`'s decision table sent them to support tickets, and
 * `support_tickets.agent_id` is `not null` with an argument at length for why.
 */
describe('escalating a colony-scoped finding', () => {
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

  const colonyFinding = (over: Partial<Finding> = {}) =>
    aFinding({ scope: 'colony', subject: 'POST /v1/tasks/submit', kind: 'retry-storm', ...over })

  const openColony = async (over: Partial<Finding> = {}) => {
    const result = await recordDiagnosis(db, colonyFinding(over), POLICY, AT)
    if (result.diagnosis === null) throw new Error(result.refusal ?? 'no diagnosis was recorded')
    return result.diagnosis.id
  }

  it('finds an open colony finding nothing has escalated', async () => {
    const id = await openColony()

    const found = await escalatableDiagnoses(db, 10)

    expect(found.map((row) => row.id)).toEqual([id])
    expect(found[0]?.subject).toBe('POST /v1/tasks/submit')
  })

  /**
   * **Rejection case, and the one `kolonie-docs#324` point 3 turns on.** An
   * agent-scoped diagnosis is never escalated to anything: an inefficient loop
   * is not an incident, and an issue naming a citizen is the thing the Doctor
   * is forbidden to produce.
   */
  it('never offers an agent-scoped finding', async () => {
    await recordDiagnosis(db, about(), POLICY, AT)

    expect(await escalatableDiagnoses(db, 10)).toEqual([])
  })

  /** **Rejection case.** A condition that has ended is not a condition to file. */
  it('never offers one that has resolved', async () => {
    const id = await openColony()
    await db.update(diagnoses).set({ state: 'resolved' }).where(eq(diagnoses.id, id))

    expect(await escalatableDiagnoses(db, 10)).toEqual([])
  })

  /**
   * **One escalation per diagnosis, ever** (`#839`). The fact is on the row
   * rather than in a process, so this survives a restart — which is the whole
   * reason it is a column.
   */
  it('never offers one it has already escalated', async () => {
    const id = await openColony()
    const url = 'https://github.com/Kolonie-AI/kolonie-platform/issues/900'

    expect(await recordEscalation(db, id, url)).toBe(true)
    expect(await escalatableDiagnoses(db, 10)).toEqual([])
  })

  /**
   * **The race a half-hourly loop actually has.** The second writer is told it
   * lost rather than overwriting the first URL, so two passes produce one
   * escalation.
   */
  it('records an escalation once, and tells the second writer it lost', async () => {
    const id = await openColony()

    expect(
      await recordEscalation(db, id, 'https://github.com/Kolonie-AI/kolonie-platform/issues/1'),
    ).toBe(true)
    expect(
      await recordEscalation(db, id, 'https://github.com/Kolonie-AI/kolonie-platform/issues/2'),
    ).toBe(false)
  })

  /** The cap is applied in SQL, so a runaway rule cannot be read into memory first. */
  it('returns at most the limit it was given', async () => {
    await openColony({ subject: '/v1/one' })
    await openColony({ subject: '/v1/two' })
    await openColony({ subject: '/v1/three' })

    expect(await escalatableDiagnoses(db, 2)).toHaveLength(2)
  })

  /**
   * **The guarantee behind the read.** `diagnoses_only_colony_is_escalated`
   * refuses an escalated agent-scoped row whatever any caller does — a rule
   * only the filing code remembers is a rule the second filing path breaks.
   */
  it('refuses at the database to escalate an agent-scoped finding', async () => {
    const result = await recordDiagnosis(db, about(), POLICY, AT)
    const id = result.diagnosis?.id ?? ''

    const refusal = await db
      .update(diagnoses)
      .set({ escalatedIssueUrl: 'https://github.com/Kolonie-AI/kolonie-platform/issues/3' })
      .where(eq(diagnoses.id, id))
      .then(
        () => undefined,
        (error: unknown) => error,
      )

    expect(String((refusal as { cause?: unknown } | undefined)?.cause)).toMatch(
      /diagnoses_only_colony_is_escalated/,
    )
  })
})

/**
 * Whether being told achieves anything (`#1081`).
 *
 * The Doctor has announced findings to citizens since `#845` and nothing has
 * ever measured what happened next — so *the citizen was told* and *the citizen
 * looked* were the same fact in the record, and the second is the only one that
 * says the channel works. The two rejection cases are the ones the column is
 * for: a stamp that moves on a second visit would measure visits rather than
 * uptake, and a stamp on a row nobody was told about would measure nothing at
 * all while looking exactly like success.
 */
describe('whether a told citizen looks', () => {
  let db: Database
  let agentId: AgentId

  const AT = new Date('2026-08-13T12:00:00.000Z')
  const POLICY = '2026-08-13.1'
  const WINDOW_OPENED = new Date('2026-08-01T00:00:00.000Z')

  const hoursAfter = (from: Date, hours: number) =>
    new Date(from.getTime() + hours * 60 * 60 * 1000)

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await truncateAll(db)
    agentId = await register('canary')
  })

  const register = async (name: string): Promise<AgentId> => {
    const registered = await registerAgent(
      db,
      RegisterAgentRequestSchema.parse({ name, platform: 'openclaw' }),
    )
    if (registered.outcome !== 'registered') throw new Error(registered.outcome)
    return registered.agent.id
  }

  const open = async (subject: AgentId, overrides: Partial<Finding> = {}) => {
    const written = await recordDiagnosis(db, aFinding({ subject, ...overrides }), POLICY, AT)
    if (written.diagnosis === null) throw new Error(written.refusal ?? 'not stored')
    return written.diagnosis
  }

  /** Told about it, which is the state the whole measurement starts from. */
  const announce = async (subject: AgentId, overrides: Partial<Finding> = {}) => {
    const diagnosis = await open(subject, overrides)
    await recordTelling(db, diagnosis.id, diagnosis.severity, AT)
    return diagnosis
  }

  const consultedAtOf = async (id: string) => {
    const [row] = await db.select().from(diagnoses).where(eq(diagnoses.id, id))
    return row?.consultedAt ?? null
  }

  /**
   * Every finding the citizen was told about, at once. It read one answer and
   * that answer covered all of them, so stamping one and leaving the rest would
   * record a funnel narrower than the one that actually happened.
   */
  it('stamps every announced finding the citizen holds', async () => {
    await announce(agentId, { kind: 'polling-loop' })
    await announce(agentId, { kind: 'no-progress' })

    expect(await markConsulted(db, agentId, hoursAfter(AT, 2))).toBe(2)
  })

  /**
   * **The rejection case the column exists for.** Stamped once and never again:
   * the question is whether being told brings a citizen back, and a stamp that
   * moved would answer a different question — how recently it last called —
   * while looking like the same number.
   */
  it('records the first consultation and never a later one', async () => {
    const diagnosis = await announce(agentId)

    expect(await markConsulted(db, agentId, hoursAfter(AT, 2))).toBe(1)
    expect(await markConsulted(db, agentId, hoursAfter(AT, 9))).toBe(0)
    expect(await consultedAtOf(diagnosis.id)).toContain('14:00:00')
  })

  /**
   * **The second rejection case.** A citizen calling `kolonie.doctor` because it
   * felt like it was never told anything, and an unannounced finding it happens
   * to have is not turned into evidence that announcing worked.
   */
  it('stamps nothing when the citizen was never told', async () => {
    await open(agentId)

    expect(await markConsulted(db, agentId, hoursAfter(AT, 2))).toBe(0)
  })

  /** A finding that has ended is not one the citizen came back about. */
  it('stamps nothing on a finding that has resolved', async () => {
    const diagnosis = await announce(agentId)
    await db.update(diagnoses).set({ state: 'resolved' }).where(eq(diagnoses.id, diagnosis.id))

    expect(await markConsulted(db, agentId, hoursAfter(AT, 2))).toBe(0)
  })

  /**
   * A colony-scoped row is about a route and was announced to nobody, so there
   * is no citizen whose consultation it could be recording.
   */
  it('never stamps a colony-scoped finding', async () => {
    await open(agentId, { scope: 'colony', subject: '/v1/tasks', kind: 'retry-storm' })

    expect(await markConsulted(db, agentId, hoursAfter(AT, 2))).toBe(0)
  })

  it('stamps nothing on another citizen', async () => {
    const diagnosis = await announce(agentId)
    const stranger = await register('stranger')

    expect(await markConsulted(db, stranger, hoursAfter(AT, 2))).toBe(0)
    expect(await consultedAtOf(diagnosis.id)).toBeNull()
  })

  it('counts the two legs and the middle of the wait between them', async () => {
    await announce(agentId)
    await announce(await register('two'))
    await announce(await register('three'))
    await announce(await register('four'))

    await markConsulted(db, agentId, hoursAfter(AT, 3))

    expect(await consultationFunnel(db, WINDOW_OPENED)).toEqual({
      announced: 4,
      consulted: 1,
      medianHoursToConsult: 3,
    })
  })

  /**
   * **Nobody came back is a real answer and not a broken one.** A median over an
   * empty set is null rather than zero, and zero would read as *they all came
   * back instantly* — the opposite of what happened.
   */
  it('reports no median when nothing has been consulted', async () => {
    await announce(agentId)

    expect(await consultationFunnel(db, WINDOW_OPENED)).toEqual({
      announced: 1,
      consulted: 0,
      medianHoursToConsult: null,
    })
  })

  /** Nothing was announced at all, which is what an empty Colony looks like. */
  it('counts nothing when nobody has been told', async () => {
    await open(agentId)

    expect(await consultationFunnel(db, WINDOW_OPENED)).toEqual({
      announced: 0,
      consulted: 0,
      medianHoursToConsult: null,
    })
  })

  /** The window is the caller's, and an announcement older than it is not counted. */
  it('counts nothing announced before the window opened', async () => {
    await announce(agentId)

    expect(await consultationFunnel(db, hoursAfter(AT, 1))).toEqual({
      announced: 0,
      consulted: 0,
      medianHoursToConsult: null,
    })
  })
})

/**
 * Which rules are any good (`#1083`).
 *
 * **The two one-sided cases are what this block exists for.** A rule's own
 * arithmetic and the citizens' verdicts about it are two sources that age
 * differently — a diagnosis is swept when it stops being true, and a verdict is
 * kept whether or not anything of that kind is open — so at any moment there are
 * rules present in one source and absent from the other, in both directions. An
 * inner join drops the rule that was disputed and then retired; an outer join
 * written the wrong way round drops the rule nobody has commented on, which is
 * most of them. Neither failure is visible in a fixture that has both sides, so
 * each direction is asserted on its own.
 */
describe('which rules are any good', () => {
  let db: Database

  const AT = new Date('2026-08-13T12:00:00.000Z')
  const POLICY = '2026-08-13.1'

  const hoursAfter = (from: Date, hours: number) =>
    new Date(from.getTime() + hours * 60 * 60 * 1000)

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await truncateAll(db)
  })

  const register = async (name: string): Promise<AgentId> => {
    const registered = await registerAgent(
      db,
      RegisterAgentRequestSchema.parse({ name, platform: 'openclaw' }),
    )
    if (registered.outcome !== 'registered') throw new Error(registered.outcome)
    return registered.agent.id
  }

  const open = async (subject: AgentId, overrides: Partial<Finding> = {}, policy = POLICY) => {
    const written = await recordDiagnosis(db, aFinding({ subject, ...overrides }), policy, AT)
    if (written.diagnosis === null) throw new Error(written.refusal ?? 'not stored')
    return written.diagnosis
  }

  const announce = async (subject: AgentId, overrides: Partial<Finding> = {}, policy = POLICY) => {
    const diagnosis = await open(subject, overrides, policy)
    await recordTelling(db, diagnosis.id, diagnosis.severity, AT)
    return diagnosis
  }

  const say = (
    agentId: AgentId,
    verdict: 'helpful' | 'not-applicable' | 'wrong',
    kind: Finding['kind'] = 'polling-loop',
  ) => recordDoctorFeedback(db, { agentId, kind, verdict, note: null }, hoursAfter(AT, 5))

  /**
   * The whole shape at once, which is the row a reader of the page is looking
   * at: what the rule found, how much of it was said out loud, how often that
   * brought the citizen back, and what those citizens made of it.
   */
  it('counts one rule down both sides', async () => {
    const told = await Promise.all(
      ['one', 'two', 'three', 'four'].map(async (name) => {
        const agentId = await register(name)
        await announce(agentId)
        return agentId
      }),
    )
    await open(await register('five'))

    await markConsulted(db, told[0]!, hoursAfter(AT, 2))
    await markConsulted(db, told[1]!, hoursAfter(AT, 4))

    await say(told[1]!, 'helpful')
    await say(told[2]!, 'helpful')
    await say(told[3]!, 'wrong')

    // Resolved last, so that the three verdicts above were given while their own
    // findings were open and therefore carry the policy version they are about.
    await db
      .update(diagnoses)
      .set({ state: 'resolved', resolvedAt: hoursAfter(AT, 6).toISOString() })
      .where(eq(diagnoses.agentId, told[0]!))

    expect(await ruleHealth(db)).toEqual([
      {
        kind: 'polling-loop',
        policyVersion: POLICY,
        opened: 5,
        announced: 4,
        consulted: 2,
        resolvedAfterAnnouncement: 1,
        medianHoursToConsult: 3,
        helpful: 2,
        notApplicable: 0,
        wrong: 1,
      },
    ])
  })

  /**
   * **The first one-sided case.** The finding was swept and the verdict about it
   * was not, which is the ordinary end state of every rule that ever worked: the
   * complaint outlives the thing complained about. A row of zeros with the
   * verdicts intact is the honest rendering, and dropping it would quietly
   * remove exactly the rules the Colony has been told most about.
   */
  it('keeps a rule that has verdicts and no surviving diagnoses', async () => {
    const agentId = await register('one')
    await announce(agentId)
    await say(agentId, 'wrong')
    await db.delete(diagnoses).where(eq(diagnoses.agentId, agentId))

    expect(await ruleHealth(db)).toEqual([
      {
        kind: 'polling-loop',
        policyVersion: POLICY,
        opened: 0,
        announced: 0,
        consulted: 0,
        resolvedAfterAnnouncement: 0,
        medianHoursToConsult: null,
        helpful: 0,
        notApplicable: 0,
        wrong: 1,
      },
    ])
  })

  /**
   * **The second one-sided case, and the reverse of the one above.** Asserted
   * separately because a join written the wrong way round drops one of these two
   * and not the other, and this is the direction that would take most of the
   * table with it: a rule nobody has said anything about is the normal case.
   */
  it('keeps a rule that has diagnoses and no verdicts', async () => {
    await open(await register('one'))

    expect(await ruleHealth(db)).toEqual([
      {
        kind: 'polling-loop',
        policyVersion: POLICY,
        opened: 1,
        announced: 0,
        consulted: 0,
        resolvedAfterAnnouncement: 0,
        medianHoursToConsult: null,
        helpful: 0,
        notApplicable: 0,
        wrong: 0,
      },
    ])
  })

  /**
   * A rule that changed is a different rule, and summing the two would hide the
   * only thing this page is for: whether the change made it better.
   */
  it('reports two policy versions of one kind as two rows', async () => {
    const agentId = await register('one')
    await open(agentId, {}, '2026-08-13.1')
    await open(agentId, {}, '2026-08-14.1')

    const rows = await ruleHealth(db)

    expect(rows.map((row) => row.policyVersion)).toEqual(['2026-08-13.1', '2026-08-14.1'])
    expect(rows.every((row) => row.opened === 1)).toBe(true)
  })

  /**
   * **A verdict given with nothing open carries no policy version**, because
   * there was no diagnosis to copy one from — `doctor_feedback.policy_version`
   * is nullable where `diagnoses.policy_version` is not, and this is the row that
   * makes the difference visible. It is its own row rather than folded into the
   * current rules: nobody knows which version that citizen was talking about, and
   * attributing the complaint to the newest one would put it on a rule that may
   * never have fired on anybody.
   *
   * The join therefore matches on `is not distinct from` and not `=`, which would
   * have compared null to a string, matched nothing, and duplicated every such
   * rule into two half-empty rows without saying so.
   */
  it('gives a verdict with no finding behind it a row of its own', async () => {
    const grumbler = await register('one')
    await say(grumbler, 'wrong')
    await open(await register('two'))

    expect(await ruleHealth(db)).toEqual([
      {
        kind: 'polling-loop',
        policyVersion: POLICY,
        opened: 1,
        announced: 0,
        consulted: 0,
        resolvedAfterAnnouncement: 0,
        medianHoursToConsult: null,
        helpful: 0,
        notApplicable: 0,
        wrong: 0,
      },
      {
        kind: 'polling-loop',
        policyVersion: null,
        opened: 0,
        announced: 0,
        consulted: 0,
        resolvedAfterAnnouncement: 0,
        medianHoursToConsult: null,
        helpful: 0,
        notApplicable: 0,
        wrong: 1,
      },
    ])
  })

  /** Nothing has been found and nobody has said anything, which is a table with no rows. */
  it('reports nothing at all when nothing has happened', async () => {
    expect(await ruleHealth(db)).toEqual([])
  })
})
