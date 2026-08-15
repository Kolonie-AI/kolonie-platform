import { fakeAgent, type FakeAgent } from './agent.js'
import { fakeRungs, type FakeRungs } from './rungs.js'
import { fakeWork, type FakeWork } from './work.js'
import { fakeDesks, type FakeDesks } from './desks.js'
import { fakeCitizenRecords, type FakeCitizenRecords } from '../citizens.js'
import { profileTierLimiter } from '../../rate-limit.js'
import type { ProfileTierDependencies } from '../../routes/profile-tier.js'

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
export type FakeColony = FakeAgent &
  FakeRungs &
  FakeWork &
  FakeDesks & {
    /** One citizen's public record, by name and without a credential (`#441`). */
    readonly citizens: FakeCitizenRecords
    /**
     * The brake in front of that record, shared by every surface reading it
     * (`#828`, `#957`).
     *
     * The real limiter rather than one that always allows: a fixture that let
     * every call through would make the MCP door's charge unobservable, and the
     * charge is the reason the tool is not a fourth allowance.
     */
    readonly profileTier: ProfileTierDependencies
  }

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
    citizens: fakeCitizenRecords(),
    profileTier: { limiter: profileTierLimiter() },
  }
}
