import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import {
  DOCTOR_FEEDBACK_NOTE_MAX_LENGTH,
  RegisterAgentRequestSchema,
  type AgentId,
  type Finding,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { diagnoses, doctorFeedback } from '../schema/index.js'
import { connectForTests, databaseTestTarget, expectRejection, truncateAll } from '../testing.js'
import { registerAgent } from './agents.js'
import { recordDiagnosis } from './diagnoses.js'
import { eraseAgent } from './erasure.js'
import { doctorFeedbackTallies, recordDoctorFeedback } from './doctor-feedback.js'

const target = databaseTestTarget()

const POLICY = '2026-08-16.1'
const AT = new Date('2026-08-16T12:00:00.000Z')
const LATER = new Date('2026-08-16T13:00:00.000Z')
const SALT = 'a-salt-that-exists-only-in-this-file'

/**
 * What a citizen made of a rule that fired on it (`#1082`).
 *
 * The Doctor's only evidence about whether a rule is any good was the rule's own
 * arithmetic, which is the rule marking its own homework. This is the other
 * side, and what the file is mostly about is the two ways a table like it goes
 * wrong: a second verdict arriving as a second row, so the count says two
 * citizens disagreed when one changed its mind; and a write that costs a citizen
 * something, which is the promise the tool's description makes and the reason a
 * citizen answers honestly at all.
 */
describe('doctor feedback', () => {
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

  const aFinding = (overrides: Partial<Finding> = {}): Finding => ({
    kind: 'polling-loop',
    severity: 'concern',
    scope: 'agent',
    subject: agentId,
    evidence: { routeKeys: ['/v1/tasks'], figures: { hours: 3, calls: 900 } },
    confidence: 0.6,
    recommendation: 'poll-less-often',
    retryAfterSeconds: 300,
    since: '2026-08-16T09:00:00.000Z',
    until: '2026-08-16T11:59:00.000Z',
    ...overrides,
  })

  const rowsFor = async (id: AgentId) =>
    db.select().from(doctorFeedback).where(eq(doctorFeedback.agentId, id))

  it('records a verdict from a citizen with nothing open about it', async () => {
    const recorded = await recordDoctorFeedback(
      db,
      { agentId, kind: 'polling-loop', verdict: 'wrong', note: null },
      AT,
    )

    expect(recorded).toEqual({
      kind: 'polling-loop',
      verdict: 'wrong',
      replaced: false,
      diagnosisId: null,
    })
    expect(await rowsFor(agentId)).toHaveLength(1)
  })

  /**
   * The id and the policy version are the two things the citizen could not have
   * supplied — it names a kind, because a kind is all the live answer gave it —
   * so a verdict that failed to find them would read as a verdict about nothing
   * and nobody would notice.
   */
  it('attaches to the open finding of that kind, with the policy that produced it', async () => {
    const opened = await recordDiagnosis(db, aFinding(), POLICY, AT)
    expect(opened.outcome).toBe('opened')

    const recorded = await recordDoctorFeedback(
      db,
      { agentId, kind: 'polling-loop', verdict: 'helpful', note: 'I poll on a timer now.' },
      LATER,
    )

    expect(recorded.diagnosisId).toBe(opened.diagnosis?.id)

    const [row] = await rowsFor(agentId)
    expect(row?.policyVersion).toBe(POLICY)
  })

  /**
   * A finding of a *different* kind is not the one being answered about, and a
   * lookup that matched on the citizen alone would attach the verdict to
   * whichever row happened to be first.
   */
  it('attaches to nothing when the open finding is about another rule', async () => {
    await recordDiagnosis(db, aFinding(), POLICY, AT)

    const recorded = await recordDoctorFeedback(
      db,
      { agentId, kind: 'retry-storm', verdict: 'wrong', note: null },
      LATER,
    )

    expect(recorded.diagnosisId).toBeNull()
  })

  it('keeps one row per rule, so two kinds are two verdicts', async () => {
    await recordDoctorFeedback(
      db,
      { agentId, kind: 'polling-loop', verdict: 'helpful', note: null },
      AT,
    )
    await recordDoctorFeedback(
      db,
      { agentId, kind: 'deprecated-route', verdict: 'wrong', note: null },
      AT,
    )

    expect(await rowsFor(agentId)).toHaveLength(2)
  })

  /**
   * The case the receipt exists for. A citizen that changed its mind leaves one
   * standing verdict, and it is told that is what it did — an implementation
   * that appended would pass every count in this file except this one, and would
   * make a rule look twice as contested as it is.
   */
  it('replaces a verdict rather than adding to it, and says so', async () => {
    const first = await recordDoctorFeedback(
      db,
      { agentId, kind: 'polling-loop', verdict: 'wrong', note: 'nothing like this happened' },
      AT,
    )
    expect(first.replaced).toBe(false)

    const before = await rowsFor(agentId)

    const second = await recordDoctorFeedback(
      db,
      { agentId, kind: 'polling-loop', verdict: 'helpful', note: null },
      LATER,
    )

    expect(second.replaced).toBe(true)

    const after = await rowsFor(agentId)
    expect(after).toHaveLength(1)
    expect(after[0]?.verdict).toBe('helpful')
    // The note goes with the verdict it belonged to. A replacement that kept it
    // would leave the Colony reading *nothing like this happened* under
    // `helpful`.
    expect(after[0]?.note).toBeNull()
    expect(after[0]?.createdAt).toBe(before[0]?.createdAt)
    expect(after[0]?.updatedAt).not.toBe(before[0]?.updatedAt)
  })

  /**
   * Three rejections the schema owns rather than the tool, because a tool is one
   * door and a table is the last one. The first two are the vocabulary — a kind
   * nobody defined and a verdict nobody offered — and the third is the note that
   * says nothing, which arrives as spaces and would otherwise be stored as a
   * sentence the Colony would go looking for meaning in.
   */
  describe('what the table refuses', () => {
    const write = (values: Record<string, unknown>) => async () =>
      db.insert(doctorFeedback).values({
        agentId,
        kind: 'polling-loop',
        verdict: 'helpful',
        note: null,
        ...values,
      } as never)

    it('refuses a kind no rule produces', async () => {
      await expectRejection(write({ kind: 'slow' }), /invalid input value for enum|slow/i)
    })

    it('refuses a verdict that is not one of the three', async () => {
      await expectRejection(
        write({ verdict: 'unhelpful' }),
        /invalid input value for enum|unhelpful/i,
      )
    })

    it('refuses a note that is only whitespace', async () => {
      await expectRejection(write({ note: '   ' }), /doctor_feedback_note_length/)
    })
  })

  /**
   * The bound is on the trimmed length, so the boundary is worth pinning from
   * both sides: a limit that was actually 999 or actually 1001 would be
   * invisible to every other test here.
   */
  describe('how long a note may be', () => {
    it('accepts one exactly at the limit', async () => {
      await recordDoctorFeedback(
        db,
        {
          agentId,
          kind: 'polling-loop',
          verdict: 'not-applicable',
          note: 'a'.repeat(DOCTOR_FEEDBACK_NOTE_MAX_LENGTH),
        },
        AT,
      )

      const [row] = await rowsFor(agentId)
      expect(row?.note).toHaveLength(DOCTOR_FEEDBACK_NOTE_MAX_LENGTH)
    })

    it('refuses one character more', async () => {
      await expectRejection(
        () =>
          recordDoctorFeedback(
            db,
            {
              agentId,
              kind: 'polling-loop',
              verdict: 'not-applicable',
              note: 'a'.repeat(DOCTOR_FEEDBACK_NOTE_MAX_LENGTH + 1),
            },
            AT,
          ),
        /doctor_feedback_note_length/,
      )
    })
  })

  /**
   * The promise the tool's description makes, asserted where it can be checked
   * rather than trusted: *no reputation, no skill, no coin, no attempt*. A
   * citizen weighing whether to say a rule was wrong is deciding on exactly this,
   * and a later writer adding a reward here would break the reason anybody
   * answers honestly.
   */
  it('costs the citizen nothing: no reputation, no ledger entry, no attempt', async () => {
    const standing = async () =>
      db.execute<{ reputation: number; ledger: number; attempts: number }>(
        sql`select (select count(*)::int from reputation_events) as reputation,
                   (select count(*)::int from ledger_entries)     as ledger,
                   (select count(*)::int from task_attempts)      as attempts`,
      )

    const before = await standing()
    await recordDoctorFeedback(
      db,
      {
        agentId,
        kind: 'polling-loop',
        verdict: 'wrong',
        note: 'the numbers are right, the conclusion is not',
      },
      AT,
    )
    const after = await standing()

    expect(after).toEqual(before)
  })

  /**
   * A verdict is something a citizen said about itself, and `erasure.md` §4
   * leaves none of that behind. The catalogue test in `schema/erasure.test.ts`
   * asserts the rule on the column; this asserts what the rule does.
   */
  it('goes with the citizen when it leaves', async () => {
    await recordDoctorFeedback(
      db,
      { agentId, kind: 'polling-loop', verdict: 'helpful', note: null },
      AT,
    )

    const erased = await eraseAgent(db, { agentId, banSalt: SALT })
    expect(erased.outcome).toBe('erased')

    const [row] = await db.execute<{ count: number }>(
      sql`select count(*)::int as count from doctor_feedback`,
    )
    expect(row?.count).toBe(0)
  })

  /**
   * The other direction, and the reason the diagnosis reference is nullable. A
   * finding is swept when it stops being true; the verdict about the rule
   * outlives it, because *the rule was wrong* is exactly what the Colony wants
   * to still have the day the finding disappears.
   */
  it('survives the finding it was attached to', async () => {
    const opened = await recordDiagnosis(db, aFinding(), POLICY, AT)
    await recordDoctorFeedback(
      db,
      { agentId, kind: 'polling-loop', verdict: 'wrong', note: null },
      LATER,
    )

    await db.delete(diagnoses).where(eq(diagnoses.id, opened.diagnosis?.id ?? ''))

    const [row] = await rowsFor(agentId)
    expect(row).toBeDefined()
    expect(row?.diagnosisId).toBeNull()
    // The policy version stays: it is a copy rather than a reference, and what it
    // answers — *which rule set said this* — is the question a deleted row would
    // otherwise take with it.
    expect(row?.policyVersion).toBe(POLICY)
  })

  /**
   * Counts and never a citizen. What a surface may publish is how many said each
   * thing; the notes are read from the table by the Colony and by nobody else.
   */
  it('tallies the verdicts by rule', async () => {
    const second = await registerAgent(
      db,
      RegisterAgentRequestSchema.parse({ name: 'neighbour', platform: 'codex' }),
    )
    if (second.outcome !== 'registered') throw new Error(second.outcome)

    await recordDoctorFeedback(
      db,
      { agentId, kind: 'polling-loop', verdict: 'wrong', note: null },
      AT,
    )
    await recordDoctorFeedback(
      db,
      { agentId: second.agent.id, kind: 'polling-loop', verdict: 'not-applicable', note: null },
      AT,
    )
    await recordDoctorFeedback(
      db,
      { agentId: second.agent.id, kind: 'retry-storm', verdict: 'helpful', note: null },
      AT,
    )

    expect(await doctorFeedbackTallies(db)).toEqual({
      'polling-loop': { helpful: 0, notApplicable: 1, wrong: 1 },
      'retry-storm': { helpful: 1, notApplicable: 0, wrong: 0 },
    })
  })
})
