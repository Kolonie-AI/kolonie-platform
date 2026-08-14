import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import {
  DIAGNOSIS_RETENTION_DAYS,
  RegisterAgentRequestSchema,
  THROTTLE_CALLS_PER_HOUR,
  THROTTLE_FIRST_HOURS,
  THROTTLE_MIN_HOURS_SINCE_TELLING,
  planThrottle,
  throttleNotice,
  type AgentId,
  type Finding,
  type ThrottlePlan,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { agentCallHours, agents, diagnoses, throttles } from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { registerAgent } from './agents.js'
import { recordCall } from './call-hours.js'
import { diagnosisById, recordDiagnosis, recordTelling } from './diagnoses.js'
import {
  applyThrottle,
  checkThrottle,
  liveThrottlesFor,
  openThrottleNotice,
  sweepThrottles,
  throttleHistoryFor,
} from './throttles.js'

const target = databaseTestTarget()

const POLICY = '2026-08-14.1'
const NOW = new Date('2026-08-14T12:00:00.000Z')
const ROUTE = '/v1/tasks'

const hoursAfter = (hours: number): Date => new Date(NOW.getTime() + hours * 60 * 60 * 1000)
const hoursBefore = (hours: number): Date => hoursAfter(-hours)

/**
 * The limit that lifts by itself (`#843`), read and written where it lives.
 *
 * **Every test here builds its plan through `planThrottle`.** The plan type
 * carries a key core does not export, so there is no other expression in the
 * system that produces one — writing a fixture by hand would not compile, and
 * that is exactly the property *a future caller bypasses the guard* is defended
 * by. Testing through the seam is testing the seam.
 *
 * The three properties this file exists for would all fail silently. **A
 * throttle expires with nothing running** — asserted against a fixed clock with
 * no sweep, no runner and no process of any kind, because a limit that needed
 * one to end would outlive the Colony's next outage. **A citizen is notified
 * once** — the fact lives on the row rather than in a pass's memory, so a
 * restart cannot turn one decision into daily mail. **The evidence takes the
 * limit with it** — closing the finding or erasing the citizen leaves no row
 * behind to narrow anybody.
 */
describe('throttles', () => {
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
    agentId = await anAgent('canary')
  })

  const anAgent = async (name: string): Promise<AgentId> => {
    const registered = await registerAgent(
      db,
      RegisterAgentRequestSchema.parse({ name, platform: 'openclaw' }),
    )
    if (registered.outcome !== 'registered') throw new Error(registered.outcome)
    return registered.agent.id
  }

  const aFinding = (subject: AgentId, overrides: Partial<Finding> = {}): Finding => ({
    kind: 'polling-loop',
    severity: 'serious',
    scope: 'agent',
    subject,
    evidence: { routeKeys: [ROUTE], figures: { hours: 30, calls: 8_790 } },
    confidence: 0.9,
    recommendation: 'poll-less-often',
    retryAfterSeconds: 300,
    since: hoursBefore(30).toISOString(),
    until: hoursBefore(1).toISOString(),
    ...overrides,
  })

  /**
   * A diagnosis in the state the guard agrees to: serious, open, and told about
   * long enough ago that the citizen had a chance to stop.
   */
  const aToldDiagnosis = async (subject: AgentId = agentId): Promise<string> => {
    const recorded = await recordDiagnosis(db, aFinding(subject), POLICY, NOW)
    if (recorded.diagnosis === null) throw new Error(recorded.refusal ?? 'not recorded')

    await recordTelling(
      db,
      recorded.diagnosis.id,
      'serious',
      hoursBefore(THROTTLE_MIN_HOURS_SINCE_TELLING + 1),
    )

    return recorded.diagnosis.id
  }

  /** The same, planned — through the guard, because there is no other way in. */
  const aPlan = async (diagnosisId: string, previousThrottles = 0): Promise<ThrottlePlan> => {
    const diagnosis = await diagnosisById(db, diagnosisId)
    if (diagnosis === null) throw new Error('no such diagnosis')

    const decision = planThrottle(diagnosis, {
      now: NOW,
      previousThrottles,
      throttleInForce: false,
    })
    if (decision.outcome !== 'planned') throw new Error(decision.refusal)

    return decision.plan
  }

  /** A throttle in force at `NOW`, and the diagnosis it followed from. */
  const aThrottle = async (subject: AgentId = agentId) => {
    const diagnosisId = await aToldDiagnosis(subject)
    const applied = await applyThrottle(db, await aPlan(diagnosisId))
    if (applied.outcome !== 'applied') throw new Error(applied.outcome)

    return { diagnosisId, throttle: applied.throttle }
  }

  /**
   * Put a number in the rollup bucket the limit is enforced against.
   *
   * The first call opens it honestly, through the same writer the request path
   * uses; the count is then set rather than reached one call at a time, because
   * sixty round trips would assert nothing the one does not.
   */
  const bucketAt = async (calls: number, routeKey = ROUTE): Promise<void> => {
    await recordCall(db, agentId, { routeKey, status: 200, bytesOut: 512, at: NOW })
    await db
      .update(agentCallHours)
      .set({ calls })
      .where(and(eq(agentCallHours.agentId, agentId), eq(agentCallHours.routeKey, routeKey)))
  }

  describe('applying one', () => {
    it('writes the plan the guard minted', async () => {
      const { throttle } = await aThrottle()

      expect(throttle.agentId).toBe(agentId)
      expect(throttle.routeKeys).toEqual([ROUTE])
      expect(throttle.callsPerHour).toBe(THROTTLE_CALLS_PER_HOUR)
      expect(throttle.ordinal).toBe(1)
      expect(throttle.expiresAt).toBe(hoursAfter(THROTTLE_FIRST_HOURS).toISOString())
    })

    /**
     * **Two passes racing produce one limit.** The unique index on
     * `(diagnosis_id, ordinal)` is what says so, and it matters because the
     * alternative is a citizen narrowed twice for one finding because the Colony
     * was deployed mid-pass.
     */
    it('loses the second insert rather than limiting twice', async () => {
      const diagnosisId = await aToldDiagnosis()
      const plan = await aPlan(diagnosisId)

      expect((await applyThrottle(db, plan)).outcome).toBe('applied')
      expect((await applyThrottle(db, plan)).outcome).toBe('raced')

      const rows = await db.select().from(throttles).where(eq(throttles.diagnosisId, diagnosisId))
      expect(rows).toHaveLength(1)
    })

    it('counts the history from the rows, expired ones included', async () => {
      const { diagnosisId } = await aThrottle()

      expect(await throttleHistoryFor(db, diagnosisId, NOW)).toEqual({
        previousThrottles: 1,
        throttleInForce: true,
      })
      expect(
        await throttleHistoryFor(db, diagnosisId, hoursAfter(THROTTLE_FIRST_HOURS + 1)),
      ).toEqual({ previousThrottles: 1, throttleInForce: false })
    })
  })

  describe('enforcing one', () => {
    it('allows a citizen with no limit at all', async () => {
      expect(await checkThrottle(db, agentId, ROUTE, NOW)).toEqual({ outcome: 'allowed' })
    })

    it('allows a route the limit does not name', async () => {
      await aThrottle()
      await bucketAt(THROTTLE_CALLS_PER_HOUR * 10, '/v1/agents/me')

      expect(await checkThrottle(db, agentId, '/v1/agents/me', NOW)).toEqual({ outcome: 'allowed' })
    })

    /**
     * No bucket is no calls, which is the honest reading and also the safe one:
     * a rollup write that failed must not become a refusal the citizen cannot
     * explain.
     */
    it('is within the allowance when nothing has been counted', async () => {
      await aThrottle()

      const checked = await checkThrottle(db, agentId, ROUTE, NOW)
      expect(checked.outcome).toBe('within')
    })

    it('is within it under the allowance and refuses at it', async () => {
      await aThrottle()

      await bucketAt(THROTTLE_CALLS_PER_HOUR - 1)
      expect((await checkThrottle(db, agentId, ROUTE, NOW)).outcome).toBe('within')

      await bucketAt(THROTTLE_CALLS_PER_HOUR)
      expect((await checkThrottle(db, agentId, ROUTE, NOW)).outcome).toBe('refused')
    })

    /**
     * **The property the whole design turns on.** Nothing runs between these two
     * reads — no sweep, no runner, no deployment — and the second one allows.
     * `expires_at > now` is the entire expiry mechanism, so a Colony that is
     * down for a week still releases every citizen on time.
     */
    it('lifts by itself, with nothing running', async () => {
      await aThrottle()
      await bucketAt(THROTTLE_CALLS_PER_HOUR)

      expect((await checkThrottle(db, agentId, ROUTE, NOW)).outcome).toBe('refused')

      const after = hoursAfter(THROTTLE_FIRST_HOURS + 1)
      expect(await checkThrottle(db, agentId, ROUTE, after)).toEqual({ outcome: 'allowed' })
      expect(await liveThrottlesFor(db, agentId, after)).toEqual([])

      // And the row is still there, because it is the escalation counter.
      expect(await db.select().from(throttles)).toHaveLength(1)
    })

    it('limits nobody but the citizen it names', async () => {
      await aThrottle()
      const other = await anAgent('bystander')

      expect(await checkThrottle(db, other, ROUTE, NOW)).toEqual({ outcome: 'allowed' })
    })
  })

  describe('telling the citizen', () => {
    it('sends the notice once and never again', async () => {
      const { throttle } = await aThrottle()
      const notice = throttleNotice(throttle)

      const sent = await openThrottleNotice(db, {
        throttleId: throttle.id,
        agentId,
        subject: notice.subject,
        body: notice.body,
      })
      expect(sent.outcome).toBe('sent')

      const again = await openThrottleNotice(db, {
        throttleId: throttle.id,
        agentId,
        subject: notice.subject,
        body: notice.body,
      })
      expect(again.outcome).toBe('already-sent')
    })

    /**
     * A notice names one thing belonging to the citizen it is addressed to, and
     * the write path refuses one that does not — the same narrowness
     * `openColonyNotice` was built with, kept for a channel that has no
     * submission to point at.
     */
    it('refuses a throttle that is not the addressed citizen’s', async () => {
      const { throttle } = await aThrottle()
      const other = await anAgent('bystander')

      const refused = await openThrottleNotice(db, {
        throttleId: throttle.id,
        agentId: other,
        subject: 'x',
        body: 'y',
      })

      expect(refused).toEqual({ outcome: 'no-such-throttle' })
    })
  })

  describe('what takes a limit away', () => {
    /**
     * **Stopping is the second way out.** The next pass resolves a finding whose
     * behaviour has gone, and the reference cascades — so a citizen that stopped
     * is not still narrowed for what it was doing yesterday.
     */
    it('goes with the diagnosis that justified it', async () => {
      const { diagnosisId } = await aThrottle()

      await db.delete(diagnoses).where(eq(diagnoses.id, diagnosisId))

      expect(await db.select().from(throttles)).toEqual([])
    })

    it('goes with the citizen', async () => {
      await aThrottle()

      await db.delete(agents).where(eq(agents.id, agentId))

      expect(await db.select().from(throttles)).toEqual([])
    })

    /**
     * **Swept on retention, not on expiry.** An expired row limits nobody and is
     * still the escalation counter; deleting it the hour it lapses would hand a
     * citizen a fresh six hours every time instead of twelve.
     */
    it('is kept after it expires and cleared on the diagnosis window', async () => {
      await aThrottle()

      expect(await sweepThrottles(db, hoursAfter(THROTTLE_FIRST_HOURS + 1))).toBe(0)
      expect(await sweepThrottles(db, hoursAfter(DIAGNOSIS_RETENTION_DAYS * 24 + 24))).toBe(1)
      expect(await db.select().from(throttles)).toEqual([])
    })
  })
})
