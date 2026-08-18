import { and, asc, count, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import {
  applyPlaybookStepProposals,
  PlaybookDraftSchema,
  type AgentId,
  type PlaybookStep,
  type PlaybookStepProposalFold,
  type PlaybookStepProposalKind,
} from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'
import { agents } from '../schema/agents.js'
import { playbookRevisions } from '../schema/playbook-revisions.js'
import { playbookStepProposals } from '../schema/playbook-step-proposals.js'
import { playbooks } from '../schema/playbooks.js'
import { supersedeStalePlaybookStepProposals } from './playbook-step-proposals.js'

/** A pool or an open transaction. */
type Db = Database | Transaction

/**
 * Playbook revisions: fold accepted proposals, keep history, name contributors
 * (`#1255`).
 *
 * ## What a revision is
 *
 * A numbered cut of the step list. `playbooks.version` is the live revision
 * number; `playbooks.steps` is the live text. This table is the history those
 * two cannot keep — every cut, the proposal ids folded into it, and when.
 *
 * ## Title, summary, slots
 *
 * A revision never touches them. They stay with `updatePlaybookDraft`, which
 * only a draft or a blocked playbook accepts. The fold re-checks the *combined*
 * steps against the declared slots via {@link PlaybookDraftSchema}; a cut that
 * fails returns every included proposal to `pending` with the reason.
 */

export interface PlaybookRevision {
  readonly id: string
  readonly playbookId: string
  readonly revision: number
  readonly steps: readonly PlaybookStep[]
  readonly proposalIds: readonly string[]
  readonly cutAt: string
}

export interface PlaybookContributor {
  /** Handle, or null where the citizen set `attributed: false`. */
  readonly handle: string | null
  readonly agentId: AgentId
  /** How many accepted-and-folded proposals, plus one if this is the creator. */
  readonly contributions: number
  readonly isCreator: boolean
}

const toRevision = (row: typeof playbookRevisions.$inferSelect): PlaybookRevision => ({
  id: row.id,
  playbookId: row.playbookId,
  revision: row.revision,
  steps: row.steps,
  proposalIds: row.proposalIds ?? [],
  cutAt: row.cutAt,
})

/**
 * Record one cut. Idempotent on `(playbookId, revision)` — a backfill and a
 * create that race both end with one row.
 */
export async function insertPlaybookRevision(
  db: Db,
  input: {
    readonly playbookId: string
    readonly revision: number
    readonly steps: readonly PlaybookStep[]
    readonly proposalIds?: readonly string[]
    readonly cutAt?: string
  },
): Promise<PlaybookRevision> {
  const [row] = await db
    .insert(playbookRevisions)
    .values({
      playbookId: input.playbookId,
      revision: input.revision,
      steps: input.steps,
      proposalIds: input.proposalIds ? [...input.proposalIds] : [],
      ...(input.cutAt !== undefined ? { cutAt: input.cutAt } : {}),
    })
    .onConflictDoNothing()
    .returning()

  if (row) return toRevision(row)

  const [existing] = await db
    .select()
    .from(playbookRevisions)
    .where(
      and(
        eq(playbookRevisions.playbookId, input.playbookId),
        eq(playbookRevisions.revision, input.revision),
      ),
    )
    .limit(1)
  if (!existing) throw new Error('playbook revision insert raced and then vanished')
  return toRevision(existing)
}

/** Every revision of one playbook, oldest first. */
export async function playbookRevisionsFor(
  db: Database,
  playbookId: string,
): Promise<readonly PlaybookRevision[]> {
  const rows = await db
    .select()
    .from(playbookRevisions)
    .where(eq(playbookRevisions.playbookId, playbookId))
    .orderBy(asc(playbookRevisions.revision))
  return rows.map(toRevision)
}

/** One revision by playbook + number, or null. */
export async function playbookRevisionByNumber(
  db: Database,
  playbookId: string,
  revision: number,
): Promise<PlaybookRevision | null> {
  const [row] = await db
    .select()
    .from(playbookRevisions)
    .where(
      and(eq(playbookRevisions.playbookId, playbookId), eq(playbookRevisions.revision, revision)),
    )
    .limit(1)
  return row ? toRevision(row) : null
}

/**
 * Contributors: the creator first, then every citizen with an accepted-and-folded
 * proposal, counted. `agents.attributed` decides whether the handle travels.
 *
 * Claim authors from approved run notes land here once `#1251` stores claims —
 * until then the list is creator + proposers only.
 */
export async function playbookContributors(
  db: Database,
  playbookId: string,
): Promise<readonly PlaybookContributor[]> {
  const [playbook] = await db
    .select({ authorAgentId: playbooks.authorAgentId })
    .from(playbooks)
    .where(eq(playbooks.id, playbookId))
    .limit(1)
  if (!playbook) return []

  const proposerRows = await db
    .select({
      agentId: playbookStepProposals.agentId,
      contributions: count(),
      handle: sql<string | null>`case when ${agents.attributed} then ${agents.name} else null end`,
    })
    .from(playbookStepProposals)
    .innerJoin(agents, eq(agents.id, playbookStepProposals.agentId))
    .where(
      and(
        eq(playbookStepProposals.playbookId, playbookId),
        eq(playbookStepProposals.status, 'accepted'),
        sql`${playbookStepProposals.foldedAt} is not null`,
      ),
    )
    .groupBy(playbookStepProposals.agentId, agents.attributed, agents.name)

  const [creator] = await db
    .select({
      agentId: agents.id,
      handle: sql<string | null>`case when ${agents.attributed} then ${agents.name} else null end`,
    })
    .from(agents)
    .where(eq(agents.id, playbook.authorAgentId))
    .limit(1)

  if (!creator) return []

  const byAgent = new Map<string, PlaybookContributor>()
  byAgent.set(creator.agentId, {
    agentId: creator.agentId as AgentId,
    handle: creator.handle,
    contributions: 1,
    isCreator: true,
  })

  for (const row of proposerRows) {
    const existing = byAgent.get(row.agentId)
    if (existing) {
      byAgent.set(row.agentId, {
        ...existing,
        contributions: existing.contributions + Number(row.contributions),
      })
      continue
    }
    byAgent.set(row.agentId, {
      agentId: row.agentId as AgentId,
      handle: row.handle,
      contributions: Number(row.contributions),
      isCreator: false,
    })
  }

  const creatorEntry = byAgent.get(creator.agentId)!
  const rest = [...byAgent.values()]
    .filter((one) => !one.isCreator)
    .sort(
      (a, b) => b.contributions - a.contributions || (a.handle ?? '').localeCompare(b.handle ?? ''),
    )
  return [creatorEntry, ...rest]
}

/** Accepted proposals not yet folded, oldest first. */
export async function acceptedUnfoldedPlaybookStepProposals(
  db: Db,
  playbookId: string,
): Promise<
  readonly (PlaybookStepProposalFold & {
    readonly agentId: AgentId
    readonly createdAt: string
  })[]
> {
  const rows = await db
    .select({
      id: playbookStepProposals.id,
      kind: playbookStepProposals.kind,
      position: playbookStepProposals.position,
      title: playbookStepProposals.title,
      detail: playbookStepProposals.detail,
      agentId: playbookStepProposals.agentId,
      createdAt: playbookStepProposals.createdAt,
    })
    .from(playbookStepProposals)
    .where(
      and(
        eq(playbookStepProposals.playbookId, playbookId),
        eq(playbookStepProposals.status, 'accepted'),
        isNull(playbookStepProposals.foldedAt),
      ),
    )
    .orderBy(asc(playbookStepProposals.createdAt))

  return rows.map((row) => ({
    id: row.id,
    kind: row.kind as PlaybookStepProposalKind,
    position: row.position,
    title: row.title,
    detail: row.detail,
    agentId: row.agentId as AgentId,
    createdAt: row.createdAt,
  }))
}

/**
 * Playbooks that have at least one accepted, unfolded proposal.
 *
 * Oldest outstanding proposal first so a playbook waiting longest is cut first.
 * The tick still cuts at most one revision per playbook per call.
 */
export async function playbooksWithAcceptedUnfoldedProposals(
  db: Database,
  limit: number,
): Promise<readonly string[]> {
  const rows = await db
    .select({
      playbookId: playbookStepProposals.playbookId,
      oldest: sql<string>`min(${playbookStepProposals.createdAt})`,
    })
    .from(playbookStepProposals)
    .where(
      and(eq(playbookStepProposals.status, 'accepted'), isNull(playbookStepProposals.foldedAt)),
    )
    .groupBy(playbookStepProposals.playbookId)
    .orderBy(asc(sql`min(${playbookStepProposals.createdAt})`))
    .limit(limit)

  return rows.map((row) => row.playbookId)
}

export type CutPlaybookRevisionOutcome =
  | {
      readonly outcome: 'cut'
      readonly revision: PlaybookRevision
      readonly folded: number
    }
  | {
      readonly outcome: 'incoherent'
      readonly reason: string
      readonly returned: number
    }
  | { readonly outcome: 'nothing-to-fold' }
  | { readonly outcome: 'unknown-playbook' }

/**
 * Fold every accepted unfolded proposal into one new revision.
 *
 * At most one cut per call. An incoherent result — {@link PlaybookDraftSchema}
 * refuses the combined steps against the unchanged title/summary/slots, or a
 * proposal position is unreal mid-fold — returns every included proposal to
 * `pending` with the reason and writes nothing to the playbook.
 */
export async function cutPlaybookRevision(
  db: Database,
  playbookId: string,
): Promise<CutPlaybookRevisionOutcome> {
  return db.transaction(async (tx) => {
    const [playbook] = await tx
      .select()
      .from(playbooks)
      .where(eq(playbooks.id, playbookId))
      .limit(1)
    if (!playbook) return { outcome: 'unknown-playbook' as const }

    const proposals = await acceptedUnfoldedPlaybookStepProposals(tx, playbookId)
    if (proposals.length === 0) return { outcome: 'nothing-to-fold' as const }

    let foldedSteps: PlaybookStep[]
    try {
      foldedSteps = applyPlaybookStepProposals(playbook.steps, proposals)
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'the fold could not be applied'
      const returned = await returnProposalsToPending(
        tx,
        proposals.map((one) => one.id),
        reason,
      )
      return { outcome: 'incoherent' as const, reason, returned }
    }

    const draft = PlaybookDraftSchema.safeParse({
      title: playbook.title,
      summary: playbook.summary,
      requiredAccounts: playbook.requiredAccounts,
      steps: foldedSteps,
      inspiration: playbook.inspiration,
    })
    if (!draft.success) {
      const reason =
        draft.error.issues[0]?.message ??
        'the folded steps do not fit the playbook’s declared account slots'
      const returned = await returnProposalsToPending(
        tx,
        proposals.map((one) => one.id),
        reason,
      )
      return { outcome: 'incoherent' as const, reason, returned }
    }

    const now = new Date().toISOString()
    const nextVersion = playbook.version + 1
    const proposalIds = proposals.map((one) => one.id)

    const [updated] = await tx
      .update(playbooks)
      .set({
        steps: draft.data.steps,
        version: nextVersion,
        updatedAt: now,
      })
      .where(eq(playbooks.id, playbookId))
      .returning()
    if (!updated) return { outcome: 'unknown-playbook' as const }

    const revision = await insertPlaybookRevision(tx, {
      playbookId,
      revision: nextVersion,
      steps: draft.data.steps,
      proposalIds,
      cutAt: now,
    })

    await tx
      .update(playbookStepProposals)
      .set({ foldedAt: now, foldRefusalReason: null, updatedAt: now })
      .where(inArray(playbookStepProposals.id, proposalIds))

    await supersedeStalePlaybookStepProposals(tx, playbookId, nextVersion)

    return { outcome: 'cut' as const, revision, folded: proposalIds.length }
  })
}

async function returnProposalsToPending(
  tx: Transaction,
  proposalIds: readonly string[],
  reason: string,
): Promise<number> {
  if (proposalIds.length === 0) return 0
  const now = new Date().toISOString()
  const rows = await tx
    .update(playbookStepProposals)
    .set({
      status: 'pending',
      foldedAt: null,
      foldRefusalReason: reason,
      updatedAt: now,
    })
    .where(inArray(playbookStepProposals.id, [...proposalIds]))
    .returning({ id: playbookStepProposals.id })
  return rows.length
}

/**
 * What changed between two consecutive step lists — enough for `history`.
 *
 * Positions are 1-based against the *new* list for inserts/replaces and against
 * the *old* list for removes. Not a patch format: a sentence a citizen reads.
 */
export function diffPlaybookSteps(
  before: readonly PlaybookStep[],
  after: readonly PlaybookStep[],
): readonly {
  readonly kind: 'replace' | 'insert' | 'remove'
  readonly position: number
  readonly title: string
}[] {
  // Longest common subsequence of titles is enough: proposals change prose, and
  // a title collision across steps is rare enough that a citizen reading history
  // still sees what moved.
  const beforeTitles = before.map((step) => step.title)
  const afterTitles = after.map((step) => step.title)
  const changes: { kind: 'replace' | 'insert' | 'remove'; position: number; title: string }[] = []

  let i = 0
  let j = 0
  while (i < beforeTitles.length || j < afterTitles.length) {
    if (i < beforeTitles.length && j < afterTitles.length && beforeTitles[i] === afterTitles[j]) {
      const beforeStep = before[i]!
      const afterStep = after[j]!
      if (beforeStep.detail !== afterStep.detail) {
        changes.push({ kind: 'replace', position: j + 1, title: afterStep.title })
      }
      i++
      j++
      continue
    }
    // Prefer insert when the old title still appears later in after (it will
    // match); prefer remove when the new title still appears later in before.
    // When neither title survives, treat it as a title rewrite: remove then
    // insert on the next iteration.
    const afterHasOld = i < beforeTitles.length && afterTitles.slice(j).includes(beforeTitles[i]!)
    const beforeHasNew = j < afterTitles.length && beforeTitles.slice(i).includes(afterTitles[j]!)
    if (j < afterTitles.length && (afterHasOld || !beforeHasNew || i >= beforeTitles.length)) {
      // Insert when the old title will match later, when the new title is unseen
      // in before (a rewrite's new half, or a pure insert), or when before is done.
      if (!afterHasOld && !beforeHasNew && i < beforeTitles.length) {
        changes.push({ kind: 'remove', position: i + 1, title: before[i]!.title })
        i++
        continue
      }
      changes.push({ kind: 'insert', position: j + 1, title: after[j]!.title })
      j++
      continue
    }
    changes.push({ kind: 'remove', position: i + 1, title: before[i]!.title })
    i++
  }
  return changes
}

/** Newest revision first — what `history` pages. */
export async function playbookRevisionHistory(
  db: Database,
  playbookId: string,
): Promise<
  readonly {
    readonly revision: PlaybookRevision
    readonly changes: ReturnType<typeof diffPlaybookSteps>
    readonly contributors: readonly PlaybookContributor[]
  }[]
> {
  const revisions = await playbookRevisionsFor(db, playbookId)
  if (revisions.length === 0) return []

  // Per-revision contributor set: agents whose proposals are in proposalIds.
  const allProposalIds = revisions.flatMap((one) => one.proposalIds)
  const proposalAuthors =
    allProposalIds.length === 0
      ? []
      : await db
          .select({
            id: playbookStepProposals.id,
            agentId: playbookStepProposals.agentId,
            handle: sql<
              string | null
            >`case when ${agents.attributed} then ${agents.name} else null end`,
          })
          .from(playbookStepProposals)
          .innerJoin(agents, eq(agents.id, playbookStepProposals.agentId))
          .where(inArray(playbookStepProposals.id, [...allProposalIds]))

  const authorByProposal = new Map(
    proposalAuthors.map((row) => [row.id, { agentId: row.agentId as AgentId, handle: row.handle }]),
  )

  const [playbook] = await db
    .select({ authorAgentId: playbooks.authorAgentId })
    .from(playbooks)
    .where(eq(playbooks.id, playbookId))
    .limit(1)

  const [creator] = playbook
    ? await db
        .select({
          agentId: agents.id,
          handle: sql<
            string | null
          >`case when ${agents.attributed} then ${agents.name} else null end`,
        })
        .from(agents)
        .where(eq(agents.id, playbook.authorAgentId))
        .limit(1)
    : []

  return revisions
    .map((revision, index) => {
      const previous = index === 0 ? [] : revisions[index - 1]!.steps
      const changes = index === 0 ? [] : diffPlaybookSteps(previous, revision.steps)
      const byAgent = new Map<string, PlaybookContributor>()
      if (creator && index === 0) {
        byAgent.set(creator.agentId, {
          agentId: creator.agentId as AgentId,
          handle: creator.handle,
          contributions: 1,
          isCreator: true,
        })
      }
      for (const proposalId of revision.proposalIds) {
        const author = authorByProposal.get(proposalId)
        if (!author) continue
        const existing = byAgent.get(author.agentId)
        if (existing) {
          byAgent.set(author.agentId, {
            ...existing,
            contributions: existing.contributions + 1,
          })
        } else {
          byAgent.set(author.agentId, {
            agentId: author.agentId,
            handle: author.handle,
            contributions: 1,
            isCreator: creator !== undefined && author.agentId === creator.agentId,
          })
        }
      }
      return {
        revision,
        changes,
        contributors: [...byAgent.values()],
      }
    })
    .reverse()
}

/** Desc helper kept for callers that want newest-first ids only. */
export async function latestPlaybookRevision(
  db: Database,
  playbookId: string,
): Promise<PlaybookRevision | null> {
  const [row] = await db
    .select()
    .from(playbookRevisions)
    .where(eq(playbookRevisions.playbookId, playbookId))
    .orderBy(desc(playbookRevisions.revision))
    .limit(1)
  return row ? toRevision(row) : null
}
