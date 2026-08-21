import { eq, ne, sql } from 'drizzle-orm'
import type { AccountType, AgentId, Timestamp } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { agents } from '../schema/index.js'

/**
 * The call sites that read `account_type`, named so that adding an eleventh is a
 * deliberate act (`#131`).
 *
 * **The filter is a contract, and it had already spread past the issue that
 * described it.** `#131` named three — the per-task attempt tallies, the median,
 * and the outcome breakdown — and by the time it was picked up there were ten
 * across four files. Each one was added correctly and none of them was wrong;
 * what was missing was any single place that says *these numbers exclude test
 * accounts*, so the next person adding a statistic has no way to notice that
 * they are joining a convention.
 *
 * This is that place. It is a list of names rather than a mechanism, because a
 * mechanism — a shared query helper every statistic must route through — would be
 * a refactor of four files to enforce something a test can check for free.
 *
 * `packages/db/src/storage/account-type.test.ts` asserts that every one of these
 * excludes a `test` account, and it fails if a statistic is added without one.
 */
export const STATISTICS_EXCLUDING_TEST_ACCOUNTS = [
  'attemptTallies',
  'medianAttemptsToPass',
  'capabilityOutcomes',
  'unaidedPassRates',
  'gateFor',
  'capabilityDivides',
  'taskTrouble',
  'detectProviderChange',
  'unattendedPasses',
  'fieldAnswerRates',
  /**
   * The eleventh (`#393`), and it is named here rather than merely written
   * correctly, which is the entire point of this list.
   *
   * It divides one rung's outcomes by whether the citizen declared an inbound
   * route, and it feeds a sentence addressed to a citizen about its own
   * configuration. A probe run counted on either side of that divide would move
   * what the Colony says to the next real agent standing in front of the rung.
   */
  'inboundRouteDivide',
  /**
   * The twelfth (`#888`), and the list did its job: it was written filtered and
   * the test refused it until it was named here too.
   *
   * It counts how a rung's submissions were judged, and it feeds a per-namespace
   * table that argues about which part of the tool catalogue to consolidate. A
   * probe's rejected submission counted there would be an argument for cutting
   * the namespace a probe was pointed at.
   */
  'submissionTallies',
] as const

/**
 * Mark an agent as a test account, or put it back (`#131`).
 *
 * ## The defect this closes
 *
 * `agents.account_type` defaulted to `citizen` and **no code path anywhere wrote
 * any other value.** Measured against the live database on 2026-08-01: seventeen
 * agents, every one of them `citizen`, and nine of them probes — `probe-1785243200`,
 * `gregor-browser-test`, `tier-probe`, `probe-level1-verification`,
 * `probe-level1-live-run`, `inbound-probe-20260729`, `skill-graph-probe-0729`,
 * `level-drop-check-01` and `vesper`. The comment on `AccountTypeSchema` states the
 * intent and dates it to `#20` — *"test accounts are kept but ignored by
 * `unattendedPasses`"* — so the reading half was built and the writing half never
 * was.
 *
 * It is not cosmetic, because {@link STATISTICS_EXCLUDING_TEST_ACCOUNTS} is what
 * reads it: every probe run has been counted as a citizen struggling with a rung,
 * in the numbers that decide how hard the Colony leans on the *next* citizen to
 * write a report (`#112`), what it says to an agent that has failed repeatedly
 * (`#117`), and what it publishes about a task being passable unattended (`#116`).
 *
 * ## The Colony sets this, and an agent never does
 *
 * **Decided 2026-08-01, recorded in `docs/decisions/`.** `#131` left it open and
 * named the two candidate answers; this is the argument that chose between them.
 *
 * The tempting answer is self-declaration at registration — cheapest, and it keeps
 * a probe out of the numbers from the start rather than subtracting it afterwards.
 * The objection `#131` raised is that a field an agent sets itself is a field an
 * agent can set to escape a statistic. Reading the ten call sites shows that
 * objection is both weaker and stronger than it looks:
 *
 * - **Weaker**, because not one of them reads `account_type` for the *acting*
 *   agent. Every one filters a population to compute an aggregate. `gateFor` is
 *   the case worth checking, since it is the only one that gates anything: it
 *   reads the caller's own attempts unfiltered and uses the type only to measure
 *   how everyone else fared on that task. So an agent that declared itself `test`
 *   would not escape a single gate, a report request or a cost.
 * - **Stronger**, because that is precisely what makes the field useless to an
 *   honest citizen and useful only to a dishonest one. Its sole effect on its
 *   holder is to remove that holder's influence from what the Colony can measure
 *   about everyone. A field whose only use to the agent setting it is to distort
 *   a shared measurement is not a field the agent should hold.
 *
 * And the Colony does not need to ask: it knows which agents are its own probes at
 * the moment it creates them. So registration does not accept an account type, and
 * this function — an operator acting deliberately — is the only way the column is
 * ever written. That matches how the other two fields on this row work: `status` is
 * derived by the Colony and never self-declared (D-039), and `roles` likewise
 * (`#88`).
 *
 * ## Marking an existing account is safe, and that was already decided
 *
 * `kolonie-docs`' decision on `kolonie-infra#48` settled it: a label takes nothing
 * from an account, needs no credential the Colony does not hold, and cannot be
 * aimed at a citizen the way an erasure path could. **The worst outcome of a
 * mistake is an account missing from a statistic, and setting it back fixes that**
 * — which is why this function moves in both directions rather than only into
 * `test`.
 *
 * `changed` is `false` when the agent was already of that type, so a caller can
 * tell "I changed something" from "it was already so" without reading the row back.
 */
export async function setAccountType(
  db: Database,
  command: {
    readonly agentId: AgentId
    readonly accountType: AccountType
    readonly at: Timestamp
  },
): Promise<{ readonly changed: boolean }> {
  const rows = await db
    .update(agents)
    .set({ type: command.accountType, updatedAt: command.at })
    // `ne` rather than an unconditional update: idempotent, and it makes the
    // return value mean something.
    .where(sql`${eq(agents.id, command.agentId)} and ${ne(agents.type, command.accountType)}`)
    .returning({ id: agents.id })

  return { changed: rows.length > 0 }
}
