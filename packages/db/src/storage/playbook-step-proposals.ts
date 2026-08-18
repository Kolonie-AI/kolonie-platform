import { and, count, eq, lt, sql } from 'drizzle-orm'
import {
  PLAYBOOK_STEP_PROPOSALS_OPEN_PER_PLAYBOOK,
  PLAYBOOK_STEP_PROPOSALS_OPEN_TOTAL,
  type AgentId,
  type PlaybookStepProposal,
  type PlaybookStepProposalKind,
  type PlaybookStepProposalStatus,
} from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'
import { playbookStepProposals } from '../schema/playbook-step-proposals.js'

/** A pool or an open transaction — counters run inside the insert's write. */
type Db = Database | Transaction

/**
 * Step proposals against a published playbook (`#1253`).
 *
 * Anyone may propose — including a citizen that never ran it. No reputation is
 * paid here; the 2 per citizen × playbook already covers contribution. Rate
 * limits (3 open per playbook, 10 open across all) are enforced in the same
 * transaction as the insert so a flood under concurrency cannot slip past a
 * check-then-write.
 */

const toProposal = (row: typeof playbookStepProposals.$inferSelect): PlaybookStepProposal => ({
  id: row.id,
  playbookId: row.playbookId,
  agentId: row.agentId,
  kind: row.kind as PlaybookStepProposalKind,
  position: row.position,
  title: row.title,
  detail: row.detail,
  why: row.why,
  againstVersion: row.againstVersion,
  status: row.status as PlaybookStepProposalStatus,
  rejectionReason: row.rejectionReason,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
})

export type InsertPlaybookStepProposalInput = {
  readonly playbookId: string
  readonly agentId: AgentId
  readonly kind: PlaybookStepProposalKind
  readonly position: number
  readonly title: string | null
  readonly detail: string | null
  readonly why: string
  /** The playbook `version` at the moment of writing. */
  readonly againstVersion: number
}

export type InsertPlaybookStepProposalOutcome =
  | { readonly outcome: 'written'; readonly proposal: PlaybookStepProposal }
  | { readonly outcome: 'rate-limited'; readonly scope: 'playbook' | 'total' }

/**
 * How many open (`pending`) proposals one citizen holds against one playbook.
 */
export async function countOpenPlaybookStepProposalsForPlaybook(
  db: Db,
  agentId: AgentId,
  playbookId: string,
): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(playbookStepProposals)
    .where(
      and(
        eq(playbookStepProposals.agentId, agentId),
        eq(playbookStepProposals.playbookId, playbookId),
        eq(playbookStepProposals.status, 'pending'),
      ),
    )
  return Number(row?.n ?? 0)
}

/**
 * How many open (`pending`) proposals one citizen holds across every playbook.
 */
export async function countOpenPlaybookStepProposalsForAgent(
  db: Db,
  agentId: AgentId,
): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(playbookStepProposals)
    .where(
      and(eq(playbookStepProposals.agentId, agentId), eq(playbookStepProposals.status, 'pending')),
    )
  return Number(row?.n ?? 0)
}

/**
 * How many open proposals sit against one playbook, from anybody.
 *
 * What `kolonie.playbooks.get` carries so a reader knows something is being
 * argued about the pipeline it is about to run.
 */
export async function countOpenPlaybookStepProposals(
  db: Database,
  playbookId: string,
): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(playbookStepProposals)
    .where(
      and(
        eq(playbookStepProposals.playbookId, playbookId),
        eq(playbookStepProposals.status, 'pending'),
      ),
    )
  return Number(row?.n ?? 0)
}

/**
 * File one proposal, or refuse it for a rate limit.
 *
 * The two counters and the insert share a transaction so two concurrent writes
 * cannot both observe "2 open" and both insert a third-plus-one.
 */
export async function insertPlaybookStepProposal(
  db: Database,
  input: InsertPlaybookStepProposalInput,
): Promise<InsertPlaybookStepProposalOutcome> {
  return db.transaction(async (tx) => {
    const perPlaybook = await countOpenPlaybookStepProposalsForPlaybook(
      tx,
      input.agentId,
      input.playbookId,
    )
    if (perPlaybook >= PLAYBOOK_STEP_PROPOSALS_OPEN_PER_PLAYBOOK) {
      return { outcome: 'rate-limited', scope: 'playbook' }
    }

    const total = await countOpenPlaybookStepProposalsForAgent(tx, input.agentId)
    if (total >= PLAYBOOK_STEP_PROPOSALS_OPEN_TOTAL) {
      return { outcome: 'rate-limited', scope: 'total' }
    }

    const [row] = await tx
      .insert(playbookStepProposals)
      .values({
        playbookId: input.playbookId,
        agentId: input.agentId,
        kind: input.kind,
        position: input.position,
        title: input.title,
        detail: input.detail,
        why: input.why,
        againstVersion: input.againstVersion,
        status: 'pending',
      })
      .returning()

    if (row === undefined) {
      throw new Error('playbook_step_proposals insert returned no row')
    }
    return { outcome: 'written', proposal: toProposal(row) }
  })
}

/**
 * Mark pending proposals written against an older revision as `superseded`.
 *
 * Called when a playbook's `version` bumps — an authoring edit today, an
 * accepted proposal tomorrow (`#1255`). Superseded rows are not judged; their
 * authors may re-file against the new text.
 *
 * Returns how many rows moved.
 */
export async function supersedeStalePlaybookStepProposals(
  db: Db,
  playbookId: string,
  currentVersion: number,
): Promise<number> {
  const rows = await db
    .update(playbookStepProposals)
    .set({
      status: 'superseded',
      updatedAt: new Date().toISOString(),
    })
    .where(
      and(
        eq(playbookStepProposals.playbookId, playbookId),
        eq(playbookStepProposals.status, 'pending'),
        lt(playbookStepProposals.againstVersion, currentVersion),
      ),
    )
    .returning({ id: playbookStepProposals.id })

  return rows.length
}

/** One proposal by id, or null. Used by moderation (`#1254`). */
export async function playbookStepProposalById(
  db: Database,
  id: string,
): Promise<PlaybookStepProposal | null> {
  const [row] = await db
    .select()
    .from(playbookStepProposals)
    .where(eq(playbookStepProposals.id, id))
    .limit(1)
  return row === undefined ? null : toProposal(row)
}

/**
 * Pending proposals for one playbook, oldest first.
 *
 * The queue `#1254` will walk. Exported now so the supersede path and the
 * storage tests can assert against the same shape the runner will use.
 */
export async function pendingPlaybookStepProposals(
  db: Database,
  playbookId: string,
  limit = 50,
): Promise<readonly PlaybookStepProposal[]> {
  const rows = await db
    .select()
    .from(playbookStepProposals)
    .where(
      and(
        eq(playbookStepProposals.playbookId, playbookId),
        eq(playbookStepProposals.status, 'pending'),
      ),
    )
    .orderBy(sql`${playbookStepProposals.createdAt} asc`)
    .limit(limit)

  return rows.map(toProposal)
}
