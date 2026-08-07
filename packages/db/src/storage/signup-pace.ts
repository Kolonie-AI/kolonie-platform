import { and, count, eq, gt, inArray, sql } from 'drizzle-orm'
import { DEFAULT_SIGNUP_PACE_PER_DAY, SIGNUP_PACE_VAR, type AccountKind } from '@kolonie-ai/core'
import type { AgentId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { accountProofs } from '../schema/account-proofs.js'
import { humanAgents } from '../schema/human-links.js'
import { providerRecipes } from '../schema/provider-recipes.js'
import type { SettingsReader } from './settings.js'

/**
 * How fast one operator may fill the register at one provider (`#532`).
 *
 * ## The unit is the operator, and per-agent would be the wrong one
 *
 * **A provider does not see agents.** It sees a network, a payment instrument, a
 * naming pattern and a responsible party — so ten agents each signing up once looks
 * exactly like one party signing up ten times, because that is what it is. A cap per
 * agent would let a swarm of a hundred produce a hundred accounts in an hour and get
 * **all of them** flagged, including the ones already working.
 *
 * The asset being built is the register. The fastest way to destroy it is to fill it
 * too quickly.
 *
 * ## It defers rather than failing
 *
 * Reaching the cap is not a refusal an agent has to recover from: the recipe waits and
 * continues tomorrow. Nothing is lost, no attempt is spent, and nobody is told to try
 * again — which is the difference between a limit an agent can plan around and one it
 * experiences as the Colony being broken.
 *
 * ## What is counted, and why it is the proof
 *
 * **A proof opened at that provider, by anybody in the operator's swarm, in the last
 * 24 hours.** That is the one Colony-side act that happens exactly once per account
 * and always: a recipe's own steps happen at the provider where the Colony cannot see
 * them, and a handoff happens only on the providers that have a wall. Counting proofs
 * counts accounts.
 *
 * **A rolling 24 hours rather than a calendar day**, because a calendar day makes
 * midnight a cliff every swarm on one clock would pile against — which is precisely
 * the burst the cap exists to prevent.
 *
 * ## A self-operated citizen is not capped
 *
 * An agent with no operator is one responsible party with one agent, and there is
 * nothing for a per-operator cap to aggregate. Capping it would be capping the case
 * the limit was never about.
 */

export type PaceVerdict =
  | { readonly outcome: 'within'; readonly used: number; readonly ceiling: number }
  /** Wait, do not fail. `retryAfterMs` is when the oldest counted proof ages out. */
  | {
      readonly outcome: 'defer'
      readonly used: number
      readonly ceiling: number
      readonly retryAfterMs: number
    }

const ONE_DAY_MS = 24 * 60 * 60 * 1000

/**
 * The ceiling in force for one provider.
 *
 * **The entry's own pace wins over the global one when it names a lower figure, and
 * never a higher one.** `#532` asks that a catalogue entry be able to carry an expected
 * pace, discovered from `provider-report` findings — and a catalogue entry is content,
 * edited more often and by more hands than a setting is. Letting content raise a
 * safety ceiling would mean the conservative default could be undone by an edit
 * nobody reviewed as a limit change. Lowering it is the direction that costs nothing
 * to be wrong about.
 */
export async function paceCeiling(
  db: Database,
  settings: SettingsReader,
  kind: AccountKind,
  provider: string,
): Promise<number> {
  const configured = await settings.read(SIGNUP_PACE_VAR)
  const global =
    configured === undefined || !/^[1-9][0-9]*$/.test(configured.trim())
      ? DEFAULT_SIGNUP_PACE_PER_DAY
      : Number(configured.trim())

  const [entry] = await db
    .select({ pace: providerRecipes.pacePerDay })
    .from(providerRecipes)
    .where(and(eq(providerRecipes.kind, kind), eq(providerRecipes.provider, provider)))
    .limit(1)

  const named = entry?.pace ?? null

  return named === null ? global : Math.min(global, named)
}

/**
 * Whether this citizen's operator may have another account here today.
 *
 * Read before the proof is minted, so a deferral costs nothing at all — no row, no
 * minted string, nothing to clean up.
 */
export async function signupPace(
  db: Database,
  settings: SettingsReader,
  agentId: AgentId,
  kind: AccountKind,
  provider: string,
): Promise<PaceVerdict> {
  const ceiling = await paceCeiling(db, settings, kind, provider)

  /**
   * The swarm, resolved as a query rather than read from a table (`#510`).
   *
   * Two hops on purpose: the operator this agent belongs to, then every agent that
   * operator has. An agent with no operator gets no rows from the first hop, which is
   * the *not capped* case rather than a case to special-write.
   */
  const swarm = db
    .select({ agentId: humanAgents.agentId })
    .from(humanAgents)
    .where(
      inArray(
        humanAgents.humanId,
        db
          .select({ humanId: humanAgents.humanId })
          .from(humanAgents)
          .where(eq(humanAgents.agentId, agentId)),
      ),
    )

  const since = new Date(Date.now() - ONE_DAY_MS).toISOString()

  const [tally] = await db
    .select({
      used: count(),
      /** The oldest one still inside the window, which is when a slot next frees. */
      oldest: sql<string | null>`min(${accountProofs.createdAt})`,
    })
    .from(accountProofs)
    .where(
      and(
        inArray(accountProofs.agentId, swarm),
        eq(accountProofs.kind, kind),
        eq(accountProofs.provider, provider),
        gt(accountProofs.createdAt, since),
      ),
    )

  const used = Number(tally?.used ?? 0)
  if (used < ceiling) return { outcome: 'within', used, ceiling }

  /**
   * When the oldest counted proof leaves the window.
   *
   * A real figure rather than *tomorrow*, so an agent can plan and a maintainer
   * watching a queue drain knows what they are waiting for — the same reason
   * `SETTING_MAX_STALENESS_MS` is a number.
   */
  const oldest = tally?.oldest ?? null
  const retryAfterMs =
    oldest === null ? ONE_DAY_MS : Math.max(0, Date.parse(oldest) + ONE_DAY_MS - Date.now())

  return { outcome: 'defer', used, ceiling, retryAfterMs }
}
