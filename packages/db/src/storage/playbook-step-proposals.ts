import { and, asc, count, eq, isNull, lt, ne, sql } from 'drizzle-orm'
import {
  PLAYBOOK_STEP_PROPOSALS_OPEN_PER_PLAYBOOK,
  PLAYBOOK_STEP_PROPOSALS_OPEN_TOTAL,
  type AgentId,
  type PlaybookRequiredAccount,
  type PlaybookStep,
  type PlaybookStepProposal,
  type PlaybookStepProposalKind,
  type PlaybookStepProposalStatus,
} from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'
import { playbookStepProposals } from '../schema/playbook-step-proposals.js'
import { playbooks } from '../schema/playbooks.js'

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
  foldedAt: row.foldedAt,
  foldRefusalReason: row.foldRefusalReason,
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
      foldRefusalReason: null,
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
 * Kept for the supersede path and for surfaces that already know which
 * playbook they are looking at. The moderation runner walks
 * {@link pendingPlaybookStepProposalsForModeration} instead — that one is
 * global and joins the pipeline text the judgements need.
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

/**
 * One proposal waiting on a verdict, with the pipeline it is about (`#1254`).
 *
 * The join is load-bearing: coherence needs the current steps and the declared
 * slots, merit needs the step at the proposal's position, and a row whose
 * `againstVersion` no longer matches the playbook is left out of this queue
 * rather than judged against text it was not written for.
 */
export interface PendingPlaybookStepProposal {
  readonly proposalId: string
  readonly playbookId: string
  readonly playbookTitle: string
  readonly playbookSummary: string
  readonly playbookVersion: number
  readonly steps: readonly PlaybookStep[]
  readonly requiredAccounts: readonly PlaybookRequiredAccount[]
  readonly agentId: AgentId
  readonly kind: PlaybookStepProposalKind
  readonly position: number
  readonly title: string | null
  readonly detail: string | null
  readonly why: string
  readonly againstVersion: number
  readonly createdAt: string
}

/**
 * Pending proposals across every playbook, oldest first, against the current
 * revision only.
 *
 * `createdAt` rather than `updatedAt`, because a proposal is never rewritten in
 * place — filing order is the order the issue's "two proposals for the same
 * step" rule wants. A row whose `againstVersion` lags the playbook is excluded
 * here; {@link supersedeStalePlaybookStepProposals} is what retires it when a
 * bump runs, and the runner may also mark one superseded when it notices.
 */
export async function pendingPlaybookStepProposalsForModeration(
  db: Database,
  limit: number,
): Promise<readonly PendingPlaybookStepProposal[]> {
  const rows = await db
    .select({
      proposalId: playbookStepProposals.id,
      playbookId: playbookStepProposals.playbookId,
      playbookTitle: playbooks.title,
      playbookSummary: playbooks.summary,
      playbookVersion: playbooks.version,
      steps: playbooks.steps,
      requiredAccounts: playbooks.requiredAccounts,
      agentId: playbookStepProposals.agentId,
      kind: playbookStepProposals.kind,
      position: playbookStepProposals.position,
      title: playbookStepProposals.title,
      detail: playbookStepProposals.detail,
      why: playbookStepProposals.why,
      againstVersion: playbookStepProposals.againstVersion,
      createdAt: playbookStepProposals.createdAt,
    })
    .from(playbookStepProposals)
    .innerJoin(playbooks, eq(playbooks.id, playbookStepProposals.playbookId))
    .where(
      and(
        eq(playbookStepProposals.status, 'pending'),
        eq(playbookStepProposals.againstVersion, playbooks.version),
        // A fold that bounced the proposal back left a reason; re-judging the
        // same combination would loop. Supersede-on-bump clears these (#1255).
        isNull(playbookStepProposals.foldRefusalReason),
      ),
    )
    .orderBy(asc(playbookStepProposals.createdAt))
    .limit(limit)

  return rows.map((row) => ({
    proposalId: row.proposalId,
    playbookId: row.playbookId,
    playbookTitle: row.playbookTitle,
    playbookSummary: row.playbookSummary,
    playbookVersion: row.playbookVersion,
    steps: row.steps,
    requiredAccounts: row.requiredAccounts,
    agentId: row.agentId as AgentId,
    kind: row.kind as PlaybookStepProposalKind,
    position: row.position,
    title: row.title,
    detail: row.detail,
    why: row.why,
    againstVersion: row.againstVersion,
    createdAt: row.createdAt,
  }))
}

/**
 * What one proposal verdict is, as the runner hands it over.
 *
 * `judged` is the staleness key: a proposal is never edited in place today, but
 * the triple is what the model read, and applying a verdict against different
 * words would attribute a decision nobody made. `accepted` may carry shortened
 * title/detail/why — every character still came from the author; the moderator
 * cuts and does not write (`#1254`).
 */
export type RecordPlaybookStepProposalVerdictInput = {
  readonly proposalId: string
  readonly judged: {
    readonly title: string | null
    readonly detail: string | null
    readonly why: string
  }
} & (
  | {
      readonly decision: 'accepted'
      readonly title: string | null
      readonly detail: string | null
      readonly why: string
    }
  | {
      readonly decision: 'rejected'
      readonly reason: string
    }
  | {
      readonly decision: 'superseded'
    }
)

/**
 * Mark other pending proposals at the same position `superseded`.
 *
 * **Same step means the same `position`, regardless of `kind`.** A `replace 3`,
 * a `remove 3` and an `insert-after 3` all change what step 3 is; accepting one
 * makes the others proposals against a step that is no longer there. Filing
 * order is the queue's, so the accepted one is always the earliest judged.
 *
 * No reason is written: the schema's check only allows `rejection_reason` on
 * `rejected`, and a superseded proposal was not wrong — its author may re-file
 * against the new text. The sentence an author reads is synthesised at read
 * time from `status = 'superseded'`, not stored on the row.
 */
export async function supersedePlaybookStepProposalSiblings(
  db: Db,
  playbookId: string,
  position: number,
  exceptId: string,
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
        eq(playbookStepProposals.position, position),
        ne(playbookStepProposals.id, exceptId),
      ),
    )
    .returning({ id: playbookStepProposals.id })

  return rows.length
}

/**
 * Write one proposal verdict.
 *
 * `stale` rather than an error when the proposal has already been judged, the
 * playbook has moved on under it, or the words the model read are no longer
 * what the row holds. Applying that verdict would accept or refuse text nobody
 * is offering any more.
 *
 * On `accepted`, siblings at the same position are superseded in the same
 * transaction so an accept cannot leave them pending for a later pass to
 * re-judge against a step that has already been decided.
 */
export async function recordPlaybookStepProposalVerdict(
  db: Database,
  input: RecordPlaybookStepProposalVerdictInput,
): Promise<{ readonly outcome: 'written' | 'stale'; readonly superseded: number }> {
  return await db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        title: playbookStepProposals.title,
        detail: playbookStepProposals.detail,
        why: playbookStepProposals.why,
        status: playbookStepProposals.status,
        againstVersion: playbookStepProposals.againstVersion,
        playbookId: playbookStepProposals.playbookId,
        position: playbookStepProposals.position,
        playbookVersion: playbooks.version,
      })
      .from(playbookStepProposals)
      .innerJoin(playbooks, eq(playbooks.id, playbookStepProposals.playbookId))
      .where(eq(playbookStepProposals.id, input.proposalId))
      .limit(1)

    if (row === undefined) return { outcome: 'stale' as const, superseded: 0 }
    if (row.status !== 'pending') return { outcome: 'stale' as const, superseded: 0 }
    if (row.againstVersion !== row.playbookVersion) {
      await tx
        .update(playbookStepProposals)
        .set({ status: 'superseded', updatedAt: new Date().toISOString() })
        .where(eq(playbookStepProposals.id, input.proposalId))
      return { outcome: 'stale' as const, superseded: 0 }
    }
    if (
      row.title !== input.judged.title ||
      row.detail !== input.judged.detail ||
      row.why !== input.judged.why
    ) {
      return { outcome: 'stale' as const, superseded: 0 }
    }

    const now = new Date().toISOString()

    if (input.decision === 'superseded') {
      await tx
        .update(playbookStepProposals)
        .set({ status: 'superseded', updatedAt: now })
        .where(eq(playbookStepProposals.id, input.proposalId))
      return { outcome: 'written' as const, superseded: 0 }
    }

    if (input.decision === 'rejected') {
      await tx
        .update(playbookStepProposals)
        .set({
          status: 'rejected',
          rejectionReason: input.reason || DEFAULT_PROPOSAL_REFUSAL,
          updatedAt: now,
        })
        .where(eq(playbookStepProposals.id, input.proposalId))
      return { outcome: 'written' as const, superseded: 0 }
    }

    await tx
      .update(playbookStepProposals)
      .set({
        status: 'accepted',
        title: input.title,
        detail: input.detail,
        why: input.why,
        rejectionReason: null,
        foldedAt: null,
        foldRefusalReason: null,
        updatedAt: now,
      })
      .where(eq(playbookStepProposals.id, input.proposalId))

    const superseded = await supersedePlaybookStepProposalSiblings(
      tx,
      row.playbookId,
      row.position,
      input.proposalId,
    )

    return { outcome: 'written' as const, superseded }
  })
}

/**
 * What an author reads when the runner refused without saying why.
 *
 * The counterpart of the note path's default: a reason column that could be
 * empty on a rejected proposal would make *not judged* and *judged and told
 * nothing* the same read for the one citizen entitled to know the difference.
 */
const DEFAULT_PROPOSAL_REFUSAL =
  'This proposal crosses one of the Colony’s red lines (governance/red-lines.md).'
