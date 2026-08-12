import type { ResetResult } from '@kolonie-ai/db'
import type { TaskCatalogue } from '../../tasks.js'
import type { TaskSubmissions } from '../../submissions.js'
import type { Retesting } from '../../retest.js'
import { fakeCatalogue } from '../catalogue.js'
import { fakeEarnings, type FakeEarnings } from '../earnings.js'
import { fakePaymentDesk, type FakePaymentDesk } from '../payments.js'
import { fakeQuests, type FakeQuestDesk } from '../quests.js'
import { fakeSubmissions } from '../submissions.js'
import { fakeGuidance, type FakeGuidance } from '../guidance.js'

/**
 * What there is to do, and what comes back from doing it.
 *
 * Tasks, quests, submissions, what citizens write about them, and the money a
 * sponsor puts behind one. Grouped by that rather than by which surface reads
 * them, because a task and the submission against it are one subject and a test
 * that reaches for either usually reaches for both.
 */
export interface FakeWork {
  /**
   * The task list, behind both surfaces. A test that needs to see the query it
   * was sent overrides this with its own `fakeCatalogue`, which records them.
   */
  readonly catalogue: TaskCatalogue
  /** The quest write path and the review (`#176`), in memory. */
  readonly quests: FakeQuestDesk
  /** What a citizen has been paid and is owed (`#535`), in memory. */
  readonly earnings: FakeEarnings
  /**
   * And the other direction (`#760`): what a sponsor paid the Colony.
   *
   * Wired by default, so `kolonie.quests.payment` is registered and the tier
   * assertions describe the server production runs rather than a half-wired one.
   */
  readonly paymentDesk: FakePaymentDesk
  /** The way in (`#219`), in memory. */
  /** Where submissions go, behind both surfaces. Overridable the same way. */
  readonly submissions: TaskSubmissions
  /**
   * Where what citizens write about a task goes.
   *
   * Typed as the fake rather than the interface, unlike `catalogue` above, so a
   * test can say what the next read answers with. The MCP tools render this into
   * prose a model acts on, and that rendering is the thing worth asserting.
   */
  readonly guidance: FakeGuidance
  readonly retesting: Retesting
  /** What the next reset answers. Defaults to `not-a-tester`. */
  readonly allowRetest: (outcome: ResetResult) => void
}

export function fakeWork(): FakeWork {
  let resets: ResetResult = { outcome: 'not-a-tester' }

  return {
    catalogue: fakeCatalogue(),
    quests: fakeQuests(),
    earnings: fakeEarnings(),
    paymentDesk: fakePaymentDesk(),

    submissions: fakeSubmissions(),
    guidance: fakeGuidance(),
    /**
     * Re-testing, in memory. Refuses everything by default: `not-a-tester` is what an
     * ordinary agent gets, so a test that does not care about the tester role never
     * has to say so.
     */
    retesting: { reset: async () => resets },
    allowRetest: (outcome) => {
      resets = outcome
    },
  }
}
