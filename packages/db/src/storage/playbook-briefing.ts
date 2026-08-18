import { and, asc, desc, eq, isNotNull } from 'drizzle-orm'
import {
  CURRENT_CLAIM_ATTEMPTS,
  PLAYBOOK_BRIEFING_CLAIM_CAP,
  PLAYBOOK_GET_CLAIM_CAP,
  RECENT_REPORTS_IN_CONTEXT,
  ServedPlaybookBriefingClaimSchema,
  claimAgeDays,
  isCurrentClaim,
  now as currentTime,
  type AgentPlatform,
  type PlaybookBriefingClaim,
  type PlaybookBriefingSection,
  type PlaybookBriefingSplit,
  type PlaybookRunOutcome,
  type PlaybookRunSignal,
  type ServedPlaybookBriefingClaim,
} from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'
import { agents } from '../schema/agents.js'
import { playbookBriefingClaims } from '../schema/playbook-briefing-claims.js'
import { playbookRuns, playbooks } from '../schema/playbooks.js'
import { toTimestamp } from './rows.js'

/**
 * Everything the synthesis needs about one approved run note, and nothing about
 * its author (`#1251`).
 *
 * Mirrors `BriefingSource` / `ProviderBriefingSource` / `PlaybookRunSource`: the
 * synthesis writes text that is published, so the less it is handed about who
 * wrote what, the fewer ways there are for that to reach the page.
 */
export interface PlaybookBriefingSource {
  readonly id: string
  readonly outcome: PlaybookRunOutcome
  /** The citizen's own approved, scrubbed sentence. */
  readonly content: string
  readonly takenStepPositions: readonly number[]
  readonly signals: readonly PlaybookRunSignal[]
  readonly platform: AgentPlatform
  readonly revision: number | null
  readonly filedAt: string
}

/** The playbook as the synthesis reads it — title, summary, live revision and steps. */
export interface PlaybookBriefingSubject {
  readonly playbookId: string
  readonly title: string
  readonly summary: string
  readonly revision: number
  readonly steps: readonly { readonly title: string; readonly detail?: string }[]
}

/**
 * Match key for `lastSupportedAt` continuity across a wholesale replace.
 *
 * Identical `(section, stepPosition, text)` keeps the old date; anything else
 * is a new claim. `stepPosition` is compared as null when absent, so a bare
 * `step` claim does not collide with `step:3`.
 */
function claimKey(claim: {
  readonly section: string
  readonly text: string
  readonly stepPosition?: number | null
}): string {
  const step = claim.stepPosition ?? null
  return `${claim.section}\0${step === null ? '' : String(step)}\0${claim.text}`
}

/**
 * The moderated corpus of one playbook, newest first and bounded.
 *
 * **Approved published notes only.** `note_published` is non-null exactly on an
 * approved note — the database asserts that — so this is an approved-only
 * corpus by construction. Private notes and rejected ones have no way in.
 *
 * Bound by {@link RECENT_REPORTS_IN_CONTEXT}, for the same reason the task
 * corpus is: the synthesis reads the whole thing as context.
 */
export async function playbookBriefingCorpus(
  db: Database,
  playbookId: string,
): Promise<readonly PlaybookBriefingSource[]> {
  const rows = await db
    .select({
      id: playbookRuns.id,
      outcome: playbookRuns.outcome,
      content: playbookRuns.notePublished,
      takenStepPositions: playbookRuns.takenStepPositions,
      signals: playbookRuns.signals,
      platform: agents.platform,
      revision: playbookRuns.playbookRevision,
      filedAt: playbookRuns.updatedAt,
    })
    .from(playbookRuns)
    .innerJoin(agents, eq(agents.id, playbookRuns.agentId))
    .where(and(eq(playbookRuns.playbookId, playbookId), isNotNull(playbookRuns.notePublished)))
    .orderBy(desc(playbookRuns.updatedAt))
    .limit(RECENT_REPORTS_IN_CONTEXT)

  return rows.flatMap((row) => {
    if (row.content === null) return []
    return [
      {
        id: row.id,
        outcome: row.outcome as PlaybookRunOutcome,
        content: row.content,
        takenStepPositions: row.takenStepPositions ?? [],
        signals: (row.signals ?? []) as PlaybookRunSignal[],
        platform: row.platform as AgentPlatform,
        revision: row.revision,
        filedAt: toTimestamp(row.filedAt),
      },
    ]
  })
}

/**
 * The playbook text a synthesis needs, or `undefined` when the playbook is gone.
 */
export async function playbookBriefingSubject(
  db: Database,
  playbookId: string,
): Promise<PlaybookBriefingSubject | undefined> {
  const [row] = await db
    .select({
      playbookId: playbooks.id,
      title: playbooks.title,
      summary: playbooks.summary,
      revision: playbooks.version,
      steps: playbooks.steps,
    })
    .from(playbooks)
    .where(eq(playbooks.id, playbookId))
    .limit(1)

  if (row === undefined) return undefined

  return {
    playbookId: row.playbookId,
    title: row.title,
    summary: row.summary,
    revision: row.revision,
    steps: row.steps as PlaybookBriefingSubject['steps'],
  }
}

/**
 * Replace every claim for one playbook with a fresh synthesis (`#1251`).
 *
 * **Wholesale.** Merging invents a history the synthesis did not compute.
 * Continuity of `lastSupportedAt` is matched on `(section, stepPosition, text)`:
 * an identical claim keeps its old date; a reworded one takes the date the
 * claim arrived with (from the synthesis), falling back to `now`.
 *
 * **Empty claims delete.** A playbook whose synthesis found nothing to say has
 * no rows, which is the same answer as never having been synthesised — there is
 * no parent briefing row to keep around empty.
 *
 * Cap: at most {@link PLAYBOOK_BRIEFING_CLAIM_CAP} claims are stored; the rest
 * are dropped in arrival order.
 */
export async function replacePlaybookBriefingClaims(
  db: Database | Transaction,
  playbookId: string,
  claims: readonly PlaybookBriefingClaim[],
  now: string,
  revision: number,
): Promise<void> {
  const existing = await db
    .select({
      section: playbookBriefingClaims.section,
      text: playbookBriefingClaims.text,
      stepPosition: playbookBriefingClaims.stepPosition,
      lastSupportedAt: playbookBriefingClaims.lastSupportedAt,
    })
    .from(playbookBriefingClaims)
    .where(eq(playbookBriefingClaims.playbookId, playbookId))

  const previous = new Map(existing.map((row) => [claimKey(row), toTimestamp(row.lastSupportedAt)]))

  const capped = claims.slice(0, PLAYBOOK_BRIEFING_CLAIM_CAP)
  const rows = capped.map((claim) => {
    const key = claimKey(claim)
    const kept = previous.get(key)
    return {
      playbookId,
      section: claim.section,
      text: claim.text,
      sources: [...claim.sources] as string[],
      reports: claim.reports,
      platforms: { ...claim.platforms },
      lastSupportedAt: kept ?? claim.lastSupportedAt ?? now,
      stepPosition: claim.stepPosition ?? null,
      revision,
    }
  })

  await db.delete(playbookBriefingClaims).where(eq(playbookBriefingClaims.playbookId, playbookId))

  if (rows.length === 0) return

  await db.insert(playbookBriefingClaims).values(rows)
}

/**
 * When the oldest run still inside the recency window was filed, or `null`.
 *
 * `null` means the playbook has had fewer than {@link CURRENT_CLAIM_ATTEMPTS}
 * runs, so nothing has been pushed out of the window and every claim is inside
 * it by definition.
 *
 * **Every run counts, note or not.** The bound measures how much has happened
 * on this playbook since a claim was last confirmed, and a run whose note was
 * refused still happened.
 */
export async function oldestCurrentPlaybookAttempt(
  db: Database,
  playbookId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ filedAt: playbookRuns.updatedAt })
    .from(playbookRuns)
    .where(eq(playbookRuns.playbookId, playbookId))
    .orderBy(desc(playbookRuns.updatedAt))
    .offset(CURRENT_CLAIM_ATTEMPTS - 1)
    .limit(1)

  return row === undefined ? null : toTimestamp(row.filedAt)
}

type StoredClaim = {
  readonly section: PlaybookBriefingSection
  readonly text: string
  readonly sources: readonly string[]
  readonly reports: number
  readonly platforms: Partial<Record<AgentPlatform, number>>
  readonly lastSupportedAt: string
  readonly stepPosition: number | null
}

function toServed(claim: StoredClaim, current: boolean): ServedPlaybookBriefingClaim | undefined {
  const parsed = ServedPlaybookBriefingClaimSchema.safeParse({
    section: claim.section,
    text: claim.text,
    sources: [...claim.sources],
    reports: claim.reports,
    platforms: claim.platforms,
    lastSupportedAt: claim.lastSupportedAt,
    ...(claim.stepPosition === null ? {} : { stepPosition: claim.stepPosition }),
    current,
  })
  return parsed.success ? parsed.data : undefined
}

async function loadStoredClaims(db: Database, playbookId: string): Promise<readonly StoredClaim[]> {
  const rows = await db
    .select({
      section: playbookBriefingClaims.section,
      text: playbookBriefingClaims.text,
      sources: playbookBriefingClaims.sources,
      reports: playbookBriefingClaims.reports,
      platforms: playbookBriefingClaims.platforms,
      lastSupportedAt: playbookBriefingClaims.lastSupportedAt,
      stepPosition: playbookBriefingClaims.stepPosition,
    })
    .from(playbookBriefingClaims)
    .where(eq(playbookBriefingClaims.playbookId, playbookId))
    // Longest-supported first — the get path and a stable reports order.
    .orderBy(asc(playbookBriefingClaims.lastSupportedAt), asc(playbookBriefingClaims.text))

  return rows.map((row) => ({
    section: row.section,
    text: row.text,
    sources: row.sources,
    reports: row.reports,
    platforms: row.platforms as Partial<Record<AgentPlatform, number>>,
    lastSupportedAt: toTimestamp(row.lastSupportedAt),
    stepPosition: row.stepPosition,
  }))
}

/**
 * Every stored claim for a playbook, split into current and demoted (`#1251`).
 *
 * Demoted claims carry `ageDays` so the reader can weigh them. Currency is
 * computed on read via {@link isCurrentClaim}, never stored.
 */
export async function readPlaybookBriefingSplit(
  db: Database,
  playbookId: string,
  at: string = currentTime(),
): Promise<PlaybookBriefingSplit> {
  const [stored, oldest] = await Promise.all([
    loadStoredClaims(db, playbookId),
    oldestCurrentPlaybookAttempt(db, playbookId),
  ])

  const window = { oldestCurrentAttempt: oldest, now: at }
  const current: ServedPlaybookBriefingClaim[] = []
  const demoted: PlaybookBriefingSplit['demoted'] = []

  for (const claim of stored) {
    const isCurrent = isCurrentClaim(claim, window)
    const served = toServed(claim, isCurrent)
    if (served === undefined) continue
    if (isCurrent) {
      current.push(served)
    } else {
      demoted.push({
        ...served,
        current: false,
        ageDays: claimAgeDays(claim, at),
      })
    }
  }

  return { current, demoted }
}

/**
 * The current claims `kolonie.playbooks.get` carries: at most
 * {@link PLAYBOOK_GET_CLAIM_CAP}, longest-supported first (`#1251`).
 */
export async function readPlaybookBriefingSummary(
  db: Database,
  playbookId: string,
  at: string = currentTime(),
): Promise<readonly ServedPlaybookBriefingClaim[]> {
  const { current } = await readPlaybookBriefingSplit(db, playbookId, at)
  return current.slice(0, PLAYBOOK_GET_CLAIM_CAP)
}
