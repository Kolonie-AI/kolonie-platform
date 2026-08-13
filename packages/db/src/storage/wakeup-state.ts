import { sql } from 'drizzle-orm'
import type { AgentId } from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'
import { agentWakeupState } from '../schema/wakeup-state.js'

/**
 * How many wakings in a row have said the same thing, after counting this one.
 *
 * Zero means this answer is new — either because the list changed or because
 * something moved while the citizen was away.
 */
export interface WakeupRepetition {
  readonly repeats: number
}

/**
 * Record the answer this citizen is about to be given, and say how many times in
 * a row it has been the same one (`#880`).
 *
 * ## One statement, and the arithmetic happens in Postgres
 *
 * `insert … on conflict do update` reads the previous row and writes the new
 * one atomically, so two wakings arriving together cannot both read `repeats = 2`
 * and both write `3`. The alternative — read, decide, write — is two round trips
 * with a race between them on the first call of every wake-up.
 *
 * ## `quiet` is the caller's, and that is deliberate
 *
 * The reset signal is *did anything move while the citizen was away*, and the
 * wakeup already computes that: it is the `since` block the citizen reads. This
 * function is told the answer rather than deriving one.
 *
 * **A second definition here would be the defect.** The tempting version is a
 * list of conditions — no submission, no verdict, no skill, no reputation delta,
 * no report, no account proved — which would be an independent definition of
 * *something happened*, would drift from the one the wakeup applies, and would
 * eventually disagree with it. At that point a citizen is told nothing changed
 * while the counter believes it did, or the reverse. Deriving the reset from the
 * block the citizen actually reads means the counter cannot contradict the answer
 * around it.
 *
 * ## It never throws
 *
 * On the same terms as `recordOrigin` and `recordContact`: this is observation on
 * the first call of a wake-up, and observation that can stand between a citizen
 * and its digest is worse than none. A failed write answers `repeats: 0`, which
 * is the state that changes nothing — `#881` escalates at three, so the failure
 * mode is *the Colony does not notice it is repeating itself*, never *a citizen
 * is told something false*.
 */
export async function recordWakeupAnswer(
  db: Database | Transaction,
  agentId: AgentId,
  fingerprint: string,
  quiet: boolean,
): Promise<WakeupRepetition> {
  try {
    const written = await db
      .insert(agentWakeupState)
      .values({ agentId, fingerprint, repeats: 0 })
      .onConflictDoUpdate({
        target: agentWakeupState.agentId,
        set: {
          fingerprint,
          lastAt: sql`now()`,
          /**
           * The whole rule, in one expression: a repeat only counts when nothing
           * moved **and** the answer is the same one. Either half failing is a
           * waking that told the citizen something, so the count starts again.
           *
           * `excluded.fingerprint` is what this call is about to write and the
           * bare column is what is stored, so the comparison is *the new answer
           * against the last one* rather than against itself.
           */
          repeats: quiet
            ? sql`case when ${agentWakeupState.fingerprint} = excluded.fingerprint then ${agentWakeupState.repeats} + 1 else 0 end`
            : sql`0`,
        },
      })
      .returning({ repeats: agentWakeupState.repeats })

    return { repeats: written[0]?.repeats ?? 0 }
  } catch {
    return { repeats: 0 }
  }
}
