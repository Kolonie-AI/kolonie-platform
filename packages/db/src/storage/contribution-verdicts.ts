import { lt } from 'drizzle-orm'
import {
  CONTRIBUTION_VERDICT_RETENTION_DAYS,
  type AgentId,
  type ContributionSurface,
  type ContributionVerdict,
} from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'
import { contributionVerdicts } from '../schema/contribution-verdicts.js'

/**
 * One ledger row, as a moderation path hands it over (`#1259`).
 *
 * Written inside the transaction that applied the verdict — a ledger row that
 * can be lost on its own is a denominator that quietly drifts. Callers skip the
 * write on `stale`: the verdict was never applied.
 */
export interface ContributionVerdictInput {
  readonly agentId: AgentId
  readonly surface: ContributionSurface
  readonly verdict: ContributionVerdict
  /** Required shape for a refusal; omit (or leave undefined) on an approval. */
  readonly reason?: string | undefined
}

/**
 * Append one row to the contribution verdict ledger.
 *
 * Takes `Database | Transaction` so every caller can write it inside the
 * transaction that applied the verdict.
 */
export async function insertContributionVerdict(
  db: Database | Transaction,
  input: ContributionVerdictInput,
): Promise<void> {
  await db.insert(contributionVerdicts).values({
    agentId: input.agentId,
    surface: input.surface,
    verdict: input.verdict,
    reason: input.verdict === 'approved' ? null : (input.reason ?? null),
  })
}

/**
 * Delete rows past the retention window (`#1259`).
 *
 * `now` is an argument, like `sweepDiagnoses`: a retention boundary that cannot
 * be tested without waiting for one is not tested.
 */
export async function sweepContributionVerdicts(
  db: Database | Transaction,
  now: Date,
  retentionDays: number = CONTRIBUTION_VERDICT_RETENTION_DAYS,
): Promise<number> {
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000).toISOString()

  const deleted = await db
    .delete(contributionVerdicts)
    .where(lt(contributionVerdicts.decidedAt, cutoff))
    .returning({ id: contributionVerdicts.id })

  return deleted.length
}
