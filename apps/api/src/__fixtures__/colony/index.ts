import { fakeAgent, type FakeAgent } from './agent.js'
import { fakeRungs, type FakeRungs } from './rungs.js'
import { fakeWork, type FakeWork } from './work.js'
import { fakeDesks, type FakeDesks } from './desks.js'

export { FAKE_CALLER_IP } from './agent.js'

/**
 * One in-memory Colony, assembled from four areas (`#270`).
 *
 * The shape is exactly what the single `colony.ts` offered — every field is
 * still `colony.something`, so no test changed — but a field now belongs to one
 * of four files rather than to one 533-line object every feature edited in the
 * middle:
 *
 * | File | What a fixture in it is about |
 * |---|---|
 * | `agent.ts` | the citizen: arriving, being recognised, and what the Colony holds about it |
 * | `rungs.ts` | the Academy rungs, one field each |
 * | `work.ts` | tasks, quests, submissions, what citizens write about them, and the money behind them |
 * | `desks.ts` | the surfaces somebody sits behind: the two support-shaped desks, the account register, the operator's own |
 *
 * The type is an intersection rather than a fifth declaration of the same
 * fields, so a field added to an area is on `FakeColony` without anything here
 * being touched. **This file does not grow when a feature does**, which is the
 * whole point of the split.
 */
export type FakeColony = FakeAgent & FakeRungs & FakeWork & FakeDesks

export function fakeColony(): FakeColony {
  const rungs = fakeRungs()

  return {
    // The rungs first, because the citizen's store reads the wallet rung's
    // challenges: `verifiedWalletOf` has to answer with what the wallet routes
    // wrote, through the one store both of them hold.
    ...rungs,
    ...fakeAgent({ solanaChallenges: rungs.solana.challenges }),
    ...fakeWork(),
    ...fakeDesks(),
  }
}
