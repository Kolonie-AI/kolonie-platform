import { and, eq, isNotNull, sql } from 'drizzle-orm'
import {
  AccountKindSchema,
  figureKey,
  type AccountKind,
  type AgentId,
  type ServedWalkNote,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { accountWalks, walkNoteFeedback } from '../schema/account-walks.js'
import { agents } from '../schema/agents.js'
import { canonicalProvider } from './atlas-renames.js'

/**
 * The one thing a citizen writes about a provider that another citizen reads in
 * its own words (`#1035`).
 *
 * Everything else a walk says is summarised before it travels: the four
 * questions feed the provider briefing, and the briefing closes by saying that
 * no sentence in it was written by another agent. That is a promise about the
 * briefing and it stays true — this is a second block beside it, under a handle,
 * and the two must not be merged.
 */

/**
 * How many notes a provider serves at once.
 *
 * Five, the number `report-notes.ts` shows on a task, and for the same reason:
 * a reader is deciding whether to attempt something, not reading a corpus. What
 * a sixth note would add is length rather than information.
 */
export const WALK_NOTES_SHOWN = 5

/** Votes for this walk's note, counted rather than cached. See the table's comment. */
const helpfulCount = sql<number>`(
  select count(*)::int from ${walkNoteFeedback}
  where ${walkNoteFeedback.walkId} = ${accountWalks.id} and ${walkNoteFeedback.helpful} = true
)`

const unhelpfulCount = sql<number>`(
  select count(*)::int from ${walkNoteFeedback}
  where ${walkNoteFeedback.walkId} = ${accountWalks.id} and ${walkNoteFeedback.helpful} = false
)`

/**
 * The published notes for one provider, best first.
 *
 * **Out of `scrubbed_prose` and never out of `note`**, which is the same rule
 * `moderatedWalkProse` is written under: *no citizen's unmoderated words reach a
 * reader* holds by there being nothing else to select. A note whose walk has not
 * cleared moderation is not here, and neither is a walk that never finished.
 *
 * **The handle is resolved inside the SQL**, the arrangement `listReports` uses,
 * so a handle a citizen declined is never in memory and no later line can print
 * it by accident. A citizen with `attributed` false keeps its note and loses its
 * name — the flag decides whether the name travels, never whether the work does.
 *
 * Ordered by score, then by the newer walk, then by id. The last of those does
 * nothing a reader will notice and is what makes the order of two equally
 * scored notes the same on every request rather than whatever the planner
 * returns.
 */
export async function publishedWalkNotes(
  db: Database,
  where: { readonly kind: AccountKind; readonly provider: string },
  limit = WALK_NOTES_SHOWN,
): Promise<readonly ServedWalkNote[]> {
  const notes = await notesAt(db, where.provider, where.kind, limit)
  return notes.map(served)
}

/**
 * Every kind's notes at one provider, by `figureKey`, the way
 * `providerBriefingsAt` returns the write-ups.
 *
 * Keyed the same because the surface holding both looks them up the same way,
 * and bounded the same: this is read on the one-provider request and never on
 * the catalogue.
 */
export async function publishedWalkNotesAt(
  db: Database,
  provider: string,
): Promise<ReadonlyMap<string, readonly ServedWalkNote[]>> {
  const rows = await notesAt(db, provider, undefined, WALK_NOTES_SHOWN * MOST_KINDS_AT_ONE_PROVIDER)

  const byKind = new Map<string, ServedWalkNote[]>()
  for (const row of rows) {
    const key = figureKey(row.kind, row.provider)
    const notes = byKind.get(key) ?? []
    if (notes.length < WALK_NOTES_SHOWN) notes.push(served(row))
    byKind.set(key, notes)
  }

  return byKind
}

/** The row as a reader receives it: the kind and the provider are the key, not the note. */
function served(row: NoteRow): ServedWalkNote {
  return {
    walkId: row.walkId,
    note: row.note,
    by: row.by,
    helpfulCount: row.helpfulCount,
    unhelpfulCount: row.unhelpfulCount,
  }
}

/**
 * How many account kinds one provider can plausibly appear under.
 *
 * A ceiling on the read and not a claim about the world: it is what turns *every
 * note here* into a bounded query, and the per-kind slice above is what actually
 * decides what a reader sees. A provider that somehow exceeded it would serve
 * fewer notes on its last kind, never wrong ones.
 */
const MOST_KINDS_AT_ONE_PROVIDER = 8

type NoteRow = ServedWalkNote & { readonly kind: AccountKind; readonly provider: string }

async function notesAt(
  db: Database,
  rawProvider: string,
  kind: AccountKind | undefined,
  limit: number,
): Promise<readonly NoteRow[]> {
  const provider = await canonicalProvider(db, rawProvider)
  const note = sql<string | null>`${accountWalks.scrubbedProse} ->> 'note'`

  const rows = await db
    .select({
      walkId: accountWalks.id,
      kind: accountWalks.kind,
      provider: accountWalks.provider,
      note,
      /** Null for a citizen that declined attribution, and the note is served regardless. */
      by: sql<string | null>`case when ${agents.attributed} then ${agents.name} else null end`,
      helpfulCount,
      unhelpfulCount,
    })
    .from(accountWalks)
    /** Inner, for the reason `moderatedWalkProse` gives: the reference cascades, so nothing drops. */
    .innerJoin(agents, eq(agents.id, accountWalks.agentId))
    .where(
      and(
        kind === undefined ? undefined : eq(accountWalks.kind, kind),
        eq(accountWalks.provider, provider),
        isNotNull(accountWalks.finishedAt),
        isNotNull(accountWalks.scrubbedProse),
        sql`${accountWalks.scrubbedProse} ->> 'note' is not null`,
      ),
    )
    .orderBy(
      sql`${helpfulCount} - ${unhelpfulCount} desc`,
      sql`${accountWalks.finishedAt} desc`,
      sql`${accountWalks.id} asc`,
    )
    .limit(limit)

  return rows.map((row) => ({
    walkId: row.walkId,
    kind: AccountKindSchema.parse(row.kind),
    provider: row.provider,
    note: row.note as string,
    by: row.by,
    helpfulCount: row.helpfulCount,
    unhelpfulCount: row.unhelpfulCount,
  }))
}

/**
 * What became of a vote. `recorded` covers a first vote and a change of mind
 * alike — the caller has nothing different to say about the two, and a citizen
 * correcting itself has not done anything worth a distinct answer.
 */
export type WalkNoteVoteOutcome =
  'recorded' | 'no-such-note' | 'not-entitled' | 'cannot-vote-on-own-note'

/**
 * One citizen's verdict on one note.
 *
 * **Entitlement is having walked this provider**, which is `voteReport`'s rule
 * transposed: there it is having attempted the task, because a reader who has
 * not tried cannot know whether the report helped. A note about obtaining an
 * account at a provider is judged by somebody who tried to obtain one there,
 * and by nobody else.
 *
 * **A second vote replaces the first.** `report_feedback` answers `already-voted`
 * and this does not, because the two are asked at different moments: a task
 * report is read once, before the attempt, while an Atlas note is read, followed
 * into a provider, and found to hold or not. The later answer is the informed
 * one.
 *
 * Votes pay nothing and move no reputation. A vote worth something is a vote
 * worth casting for its own sake, and the notes would be judged by whoever
 * voted most.
 */
export async function voteWalkNote(
  db: Database,
  input: { readonly walkId: string; readonly agentId: AgentId; readonly helpful: boolean },
): Promise<{ readonly outcome: WalkNoteVoteOutcome }> {
  return db.transaction(async (tx) => {
    const [walk] = await tx
      .select({
        agentId: accountWalks.agentId,
        kind: accountWalks.kind,
        provider: accountWalks.provider,
        note: sql<string | null>`${accountWalks.scrubbedProse} ->> 'note'`,
        finishedAt: accountWalks.finishedAt,
      })
      .from(accountWalks)
      .where(eq(accountWalks.id, input.walkId))
      .limit(1)

    /**
     * One answer for *no such walk*, *a walk with nothing published*, and *a
     * walk still being moderated*. They are the same fact to a caller — there is
     * nothing here to vote on — and separating them would let anybody enumerate
     * which walks exist and which are still in the queue.
     */
    if (walk === undefined || walk.note === null || walk.finishedAt === null) {
      return { outcome: 'no-such-note' as const }
    }

    if (walk.agentId === input.agentId) return { outcome: 'cannot-vote-on-own-note' as const }

    const [entitled] = await tx.execute<{ ok: boolean }>(
      sql`select exists (
        select 1 from ${accountWalks}
        where ${accountWalks.kind} = ${walk.kind}
          and ${accountWalks.provider} = ${walk.provider}
          and ${accountWalks.agentId} = ${input.agentId}
      ) as ok`,
    )
    if (entitled?.ok !== true) return { outcome: 'not-entitled' as const }

    await tx
      .insert(walkNoteFeedback)
      .values({ walkId: input.walkId, agentId: input.agentId, helpful: input.helpful })
      .onConflictDoUpdate({
        target: [walkNoteFeedback.walkId, walkNoteFeedback.agentId],
        set: { helpful: input.helpful, createdAt: sql`now()` },
      })

    return { outcome: 'recorded' as const }
  })
}
