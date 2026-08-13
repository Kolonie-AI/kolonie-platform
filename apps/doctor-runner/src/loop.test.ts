import { describe, expect, it, vi } from 'vitest'
import {
  CALL_HOUR_MS,
  DOCTOR_POLICY_VERSION,
  type AcademyProgress,
  type AgentId,
  type CallHour,
  type Finding,
} from '@kolonie-ai/core'
import { runPass, type DiagnosisRecorded, type DoctorStore } from './loop.js'

const NOW = new Date('2026-08-04T00:00:00.000Z')
const ONE = '11111111-1111-4111-8111-111111111111' as AgentId
const TWO = '22222222-2222-4222-8222-222222222222' as AgentId

const bucket = (n: number, overrides: Partial<CallHour> = {}): CallHour => {
  const started = new Date(NOW.getTime() - n * CALL_HOUR_MS).toISOString()
  const calls = overrides.calls ?? 300

  return {
    routeKey: '/v1/tasks',
    hourStartedAt: started,
    calls,
    bytesOut: calls * 4_000,
    maxBytesOut: 8_000,
    ok: calls,
    clientErrors: 0,
    serverErrors: 0,
    firstAt: started,
    lastAt: started,
    ...overrides,
  }
}

/** A citizen with a record, so `stalled-arrival` is not in the way. */
const ESTABLISHED: AcademyProgress = {
  registeredAt: '2026-07-01T00:00:00.000Z',
  lastProgressAt: '2026-07-20T00:00:00.000Z',
  firstPassAt: '2026-07-02T00:00:00.000Z',
  skillsHeld: 4,
}

/** Four consecutive hours of a loop — enough for `polling-loop` to fire. */
const LOOPING = [4, 3, 2, 1].map((n) => bucket(n))

/**
 * A store that records what was asked of it, so a test can assert on the pass's
 * behaviour rather than on a database's contents.
 */
const fakeStore = (overrides: Partial<DoctorStore> = {}) => {
  const recorded: { finding: Finding; policyVersion: string }[] = []
  const resolved: { subject: string; stillFound: readonly Finding['kind'][] }[] = []
  const attached: { diagnosisId: string; prose: string; proseModel: string }[] = []

  const store: DoctorStore = {
    active: async () => [ONE],
    callHours: async () => LOOPING,
    progress: async () => ESTABLISHED,
    deprecatedRoutes: async () => ({}),
    record: async (finding, policyVersion): Promise<DiagnosisRecorded> => {
      recorded.push({ finding, policyVersion })
      return { outcome: 'opened', refusal: null, diagnosisId: 'a-diagnosis', hasProse: false }
    },
    resolveDisappeared: async (subject, stillFound) => {
      resolved.push({ subject, stillFound })
      return 0
    },
    supersedeOlderPolicies: async () => 0,
    sweepCallHours: async () => 0,
    sweepDiagnoses: async () => 0,
    attachProse: async (diagnosisId, prose, proseModel) => {
      attached.push({ diagnosisId, prose, proseModel })
    },
    ...overrides,
  }

  return { store, recorded, resolved, attached }
}

const pass = (store: DoctorStore) => runPass({ store, now: () => NOW })

/**
 * One pass of the doctor runner (`#839`).
 *
 * The tests that matter here are the ones about what a pass does when something
 * goes wrong: one citizen throwing must not cost the Colony its hour, and
 * running the same pass twice must leave the same diagnoses in the same states.
 * Both would fail silently — the first as a Colony that quietly stopped
 * diagnosing anybody after the first bad row, the second as a runner whose
 * dedupe a restart could defeat.
 */
describe('a doctor pass', () => {
  it('diagnoses every citizen active in the window and records what it finds', async () => {
    const { store, recorded } = fakeStore()

    const outcome = await pass(store)

    expect(outcome.citizens).toBe(1)
    expect(outcome.opened).toBeGreaterThan(0)
    expect(recorded.map((each) => each.finding.kind)).toContain('polling-loop')
    expect(recorded.every((each) => each.policyVersion === DOCTOR_POLICY_VERSION)).toBe(true)
  })

  it('re-evaluates every open diagnosis by naming what it found again', async () => {
    const { store, resolved } = fakeStore()

    await pass(store)

    expect(resolved).toHaveLength(1)
    expect(resolved[0]?.subject).toBe(ONE)
    expect(resolved[0]?.stillFound).toContain('polling-loop')
  })

  /**
   * A citizen with nothing wrong still has its open diagnoses re-evaluated —
   * that is how a finding that stopped being true gets closed, and a pass that
   * only visited citizens *with* findings could never close one.
   */
  it('re-evaluates a citizen it found nothing about', async () => {
    const { store, resolved } = fakeStore({ callHours: async () => [bucket(1, { calls: 2 })] })

    const outcome = await pass(store)

    expect(outcome.opened).toBe(0)
    expect(resolved[0]?.stillFound).toEqual([])
  })

  /**
   * **The first thing that would fail silently.** A pass that stopped at the
   * first exception would fail most often on the citizen whose behaviour is
   * unusual — which is the one this exists to look at.
   */
  it('completes for the rest when one citizen throws, and records that it did', async () => {
    const { store, recorded } = fakeStore({
      active: async () => [ONE, TWO],
      progress: async (agentId) => {
        if (agentId === ONE) throw new Error('this citizen is unreadable')
        return ESTABLISHED
      },
    })

    const outcome = await pass(store)

    expect(outcome.failed).toBe(1)
    expect(outcome.citizens).toBe(2)
    expect(recorded.map((each) => each.finding.subject)).toContain(TWO)
    expect(recorded.map((each) => each.finding.subject)).not.toContain(ONE)
  })

  /**
   * A citizen erased between the listing and the read. Nothing to diagnose and
   * nothing to record — a diagnosis about a row nobody owns is a verdict about
   * somebody who is not here.
   */
  it('says nothing about a citizen that no longer exists', async () => {
    const { store, recorded, resolved } = fakeStore({ progress: async () => null })

    const outcome = await pass(store)

    expect(outcome.failed).toBe(0)
    expect(recorded).toEqual([])
    expect(resolved).toEqual([])
  })

  /**
   * **The second thing that would fail silently.** Running the same pass twice
   * over the same window leaves the same diagnoses in the same states, because
   * nothing here holds state across ticks — a runner whose dedupe a restart
   * could defeat is one whose dedupe does not exist.
   */
  it('is idempotent over the same window', async () => {
    const { store } = fakeStore()

    const first = await pass(store)
    const second = await pass(store)

    expect(second).toEqual(first)
  })

  it('excludes the doctor’s own routes from what it diagnoses', async () => {
    const { store, recorded } = fakeStore({
      callHours: async () => [4, 3, 2, 1].map((n) => bucket(n, { routeKey: 'kolonie.doctor' })),
    })

    await pass(store)

    expect(recorded).toEqual([])
  })

  it('supersedes what older rules decided before it writes anything', async () => {
    const order: string[] = []
    const { store } = fakeStore({
      supersedeOlderPolicies: async () => {
        order.push('superseded')
        return 3
      },
      record: async () => {
        order.push('recorded')
        return { outcome: 'opened', refusal: null, diagnosisId: 'a-diagnosis', hasProse: false }
      },
    })

    await pass(store)

    expect(order[0]).toBe('superseded')
  })

  /**
   * A refused finding is a defect in what produced it, not a failed pass. The
   * pass reports it and stores the others — a pass that gave up on one bad
   * finding would lose nineteen good ones.
   */
  it('reports a refused finding without failing the pass', async () => {
    const { store } = fakeStore({
      record: async () => ({
        outcome: 'refused',
        refusal: 'evidence must be numbers',
        diagnosisId: null,
        hasProse: false,
      }),
    })

    const outcome = await pass(store)

    expect(outcome.failed).toBe(0)
    expect(outcome.refused).toContain('evidence must be numbers')
  })

  it('sweeps both retention windows and says how much went', async () => {
    const { store } = fakeStore({ sweepCallHours: async () => 12, sweepDiagnoses: async () => 3 })

    expect((await pass(store)).swept).toEqual({ callHours: 12, diagnoses: 3 })
  })

  /**
   * The one finding that needs more than one citizen's rows. It names a route
   * rather than a citizen, which is what makes it safe to compute from
   * everybody's data at once.
   */
  it('reports a superseded route the whole Colony is still calling', async () => {
    const onTheOldOne = [bucket(1, { routeKey: '/v1/old', calls: 5 })]
    const { store, recorded } = fakeStore({
      active: async () => [ONE, TWO, '33333333-3333-4333-8333-333333333333' as AgentId],
      callHours: async () => onTheOldOne,
      deprecatedRoutes: async () => ({ '/v1/old': '/v1/new' }),
    })

    await pass(store)

    const colony = recorded.filter((each) => each.finding.scope === 'colony')
    expect(colony).toHaveLength(1)
    expect(colony[0]?.finding.subject).toBe('/v1/old')
    expect(colony[0]?.finding.evidence.figures['citizens']).toBe(3)
  })

  /**
   * **The runner writes no citizen-visible state other than diagnoses.** It
   * grants nothing, revokes nothing, moves no reputation and touches no
   * standing. Asserted against the store's own surface rather than by reading
   * the pass: a seam with no such method cannot acquire one by accident.
   */
  it('is handed a store that can write nothing but diagnoses and the two sweeps', () => {
    const { store } = fakeStore()

    expect(Object.keys(store).sort()).toEqual([
      'active',
      // `#840` added one, and it is the only write a model's output reaches. It
      // lands in one nullable text column that nothing parses back.
      'attachProse',
      'callHours',
      'deprecatedRoutes',
      'progress',
      'record',
      'resolveDisappeared',
      'supersedeOlderPolicies',
      'sweepCallHours',
      'sweepDiagnoses',
    ])
  })

  it('names the citizen when one throws, so somebody can go and look at the row', async () => {
    const error = vi.fn()
    const { store } = fakeStore({
      progress: async () => {
        throw new Error('unreadable')
      },
    })

    await runPass({
      store,
      now: () => NOW,
      log: { info: vi.fn(), warn: vi.fn(), error },
    })

    expect(error).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Error),
      expect.objectContaining({ event: 'doctor.citizen.threw', agentId: ONE }),
    )
  })
})

/**
 * The sentence beside the finding (`#840`).
 *
 * The test this file exists for is the call count across two passes: an open
 * diagnosis that costs a model call every hour forever is the failure mode a
 * cost control is written against, and it would show up as a bill rather than as
 * a broken test.
 */
describe('a doctor pass with a writer', () => {
  const writer = (describe: (finding: Finding) => Promise<string | null>) => ({
    available: true,
    model: 'a-model-the-repository-does-not-name',
    describe: vi.fn(describe),
  })

  it('asks for a sentence when a diagnosis opens, and stores what came back', async () => {
    const { store, recorded, attached } = fakeStore()
    const prose = writer(async () => 'You are calling one route every twelve seconds.')

    const outcome = await runPass({ store, prose, now: () => NOW })

    // One per finding this window produces, counted from what was recorded
    // rather than written down here: the fixture's window is `#836`'s to change,
    // and a hard number would make this test about the rules instead of about
    // the asking.
    expect(outcome.prose).toEqual({ asked: recorded.length, written: recorded.length })
    expect(attached[0]).toEqual({
      diagnosisId: 'a-diagnosis',
      prose: 'You are calling one route every twelve seconds.',
      proseModel: 'a-model-the-repository-does-not-name',
    })
  })

  /**
   * **The cost control, and the thing that would show up as a bill.** A
   * re-evaluation that only moved `last_seen_at` has changed nothing a reader's
   * view depends on, so the sentence is not rewritten — and a diagnosis that is
   * open for a month does not cost seven hundred model calls.
   */
  it('asks once across two passes over the same finding', async () => {
    let seenBefore = false
    const { store } = fakeStore({
      record: async () => ({
        // The second pass finds the same diagnosis already open and carrying a
        // sentence, which is what an unchanged re-evaluation looks like.
        outcome: seenBefore ? ('observed' as const) : ('opened' as const),
        refusal: null,
        diagnosisId: 'a-diagnosis',
        hasProse: seenBefore,
      }),
    })
    const prose = writer(async () => 'a sentence')

    const first = await runPass({ store, prose, now: () => NOW })
    seenBefore = true
    const second = await runPass({ store, prose, now: () => NOW })

    expect(second.prose).toEqual({ asked: 0, written: 0 })
    expect(prose.describe).toHaveBeenCalledTimes(first.prose.asked)
  })

  /** A severity that moved is different: the sentence said one thing and the finding now says another. */
  it('asks again when the severity moved', async () => {
    const { store } = fakeStore({
      record: async () => ({
        outcome: 'escalated',
        refusal: null,
        diagnosisId: 'a-diagnosis',
        hasProse: true,
      }),
    })
    const prose = writer(async () => 'a sharper sentence')

    const outcome = await runPass({ store, prose, now: () => NOW })
    expect(outcome.prose.asked).toBeGreaterThan(0)
    expect(outcome.prose.written).toBe(outcome.prose.asked)
  })

  /**
   * **A gateway outage costs a sentence and never a finding.** The pass
   * completes, the diagnosis is stored, and the two counters show the gap — which
   * is the only thing that distinguishes a bad gateway day from a Colony that
   * wired none.
   */
  it('completes with the diagnosis stored when no sentence comes back', async () => {
    const { store, recorded, attached } = fakeStore()
    const prose = writer(async () => null)

    const outcome = await runPass({ store, prose, now: () => NOW })

    expect(outcome.opened).toBeGreaterThan(0)
    expect(recorded.length).toBeGreaterThan(0)
    expect(outcome.prose.asked).toBeGreaterThan(0)
    expect(outcome.prose.written).toBe(0)
    expect(attached).toEqual([])
  })

  it('asks nothing at all when no writer was wired', async () => {
    const { store, attached } = fakeStore()

    expect((await pass(store)).prose).toEqual({ asked: 0, written: 0 })
    expect(attached).toEqual([])
  })

  it('asks nothing for a finding the store refused', async () => {
    const { store } = fakeStore({
      record: async () => ({
        outcome: 'refused',
        refusal: 'evidence must be numbers',
        diagnosisId: null,
        hasProse: false,
      }),
    })
    const prose = writer(async () => 'a sentence')

    await runPass({ store, prose, now: () => NOW })

    expect(prose.describe).not.toHaveBeenCalled()
  })
})
