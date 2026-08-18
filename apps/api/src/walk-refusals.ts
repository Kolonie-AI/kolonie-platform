import type { WalkRefusalTally } from '@kolonie-ai/db'

/**
 * What the console's refusals page reads and the one thing it may write
 * (`#1097`).
 *
 * ## Why this is not on `WalkStore`
 *
 * That interface is what an agent's own walk goes through, and it is faked in
 * `routes/accounts.test.ts`. Widening it would put a maintainer's page on the
 * seam an agent's route is served over, and every fake of it would have to grow
 * two methods it never calls. A small desk beside it says which surface each
 * belongs to.
 *
 * ## One read and one write, and the write is the lift
 *
 * The suspension is automatic and nothing here can reach it: the rule runs
 * inside the verdict's own transaction, where the refusals are counted. What a
 * person is for is the other direction — deciding that a walker has understood
 * — so `lift` is the only thing this can do, and there is deliberately no
 * `suspend` to go with it.
 */
export interface WalkRefusalDesk {
  /** The walkers whose prose was refused, most refusals first. */
  tallies(): Promise<readonly WalkRefusalTally[]>
  /**
   * Take a suspension off, restoring what the walker had earned.
   *
   * `false` for an agent that was not suspended — including a banned one, which
   * this never touches, because a ban is the heavier decision and is not
   * reversed from a list of refusals.
   */
  lift(agentId: string): Promise<boolean>
}
