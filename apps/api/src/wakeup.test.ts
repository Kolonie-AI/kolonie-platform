import { beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import {
  AgentIdSchema,
  SubmissionIdSchema,
  TaskIdSchema,
  WakeupResponseSchema,
} from '@kolonie-ai/core'
import { fakeWakeup, type FakeWakeup } from './__fixtures__/wakeup.js'
import { wakeup } from './wakeup.js'
import type { ContributionDependencies } from './contributions.js'

const agentId = AgentIdSchema.parse(randomUUID())

let source: FakeWakeup

/** No GitHub account, so the contributions half answers empty without reaching out. */
const noContributions: ContributionDependencies = {
  grants: { accountOf: async () => undefined },
  reader: undefined,
}

beforeEach(() => {
  source = fakeWakeup()
})

describe('the wake-up digest', () => {
  it('measures from the previous session, not the current one', async () => {
    source.answersPreviousSession('2026-08-01T09:00:00.000Z')

    const result = await wakeup(agentId, {}, source, noContributions)

    // The agent asking is inside a session of its own. Measuring from that would
    // answer "nothing has changed since you started asking" — true and useless.
    expect(source.windows()).toEqual(['2026-08-01T09:00:00.000Z'])
    expect(result.response.since).toBe('2026-08-01T09:00:00.000Z')
    expect(result.response.firstSession).toBe(false)
  })

  it('says so rather than inventing a window on a first session', async () => {
    source.answersPreviousSession(null)

    const result = await wakeup(agentId, {}, source, noContributions)

    expect(result.response.firstSession).toBe(true)
  })

  /**
   * The property the citizen who reported this asked for by name: an agent that
   * crashes after reading and before acting must see the same digest next time.
   */
  it('is idempotent — reading it twice answers the same thing', async () => {
    source.answersPreviousSession('2026-08-01T09:00:00.000Z')
    source.answersChanges({ reputationDelta: 3 })

    const first = await wakeup(agentId, {}, source, noContributions)
    const second = await wakeup(agentId, {}, source, noContributions)

    expect(second.response).toEqual(first.response)
  })

  it('takes an explicit window over the derived one', async () => {
    source.answersPreviousSession('2026-08-01T09:00:00.000Z')

    const result = await wakeup(
      agentId,
      { since: '2026-07-01T00:00:00.000Z' },
      source,
      noContributions,
    )

    expect(result.response.since).toBe('2026-07-01T00:00:00.000Z')
    // Asking for a window is not the same as having none derived for you, so a
    // caller that named one is never told this is its first session.
    expect(result.response.firstSession).toBe(false)
  })

  /**
   * This is the first call of a wake-up. Refusing it over a mistyped timestamp
   * would leave a scheduled agent with nothing at all — the failure the digest
   * exists to prevent.
   */
  it('falls back to the derived window rather than refusing a malformed since', async () => {
    source.answersPreviousSession('2026-08-01T09:00:00.000Z')

    const result = await wakeup(agentId, { since: 'yesterday' }, source, noContributions)

    expect(result.response.since).toBe('2026-08-01T09:00:00.000Z')
  })

  it('answers a shape the schema accepts', async () => {
    source.answersPreviousSession('2026-08-01T09:00:00.000Z')
    source.answersChanges({
      submissionVerdicts: [
        {
          submissionId: SubmissionIdSchema.parse(randomUUID()),
          taskId: TaskIdSchema.parse(randomUUID()),
          status: 'failed',
          evidence: '2 of the five constraints did not hold.',
          decidedAt: '2026-08-01T10:00:00.000Z',
        },
      ],
    })

    const result = await wakeup(agentId, {}, source, noContributions)

    expect(() => WakeupResponseSchema.parse(result.response)).not.toThrow()
  })

  /**
   * `kolonie-docs#43`, which is the miss this whole class of call exists to
   * prevent: an empty list means *nothing is waiting on you*, and a citizen
   * shown that when the Colony simply could not ask goes back to sleep on a
   * review it needed.
   */
  it('keeps "could not ask" apart from "nothing waiting"', async () => {
    source.answersPreviousSession('2026-08-01T09:00:00.000Z')

    const withAccount = await wakeup(agentId, {}, source, {
      grants: { accountOf: async () => 'octocat' },
      reader: undefined,
    })

    expect(withAccount.response.contributions.pullRequests).toEqual([])
    expect(withAccount.response.contributions.unavailable).not.toBeNull()

    const withoutAccount = await wakeup(agentId, {}, source, noContributions)

    expect(withoutAccount.response.contributions.unavailable).toBeNull()
  })
})
