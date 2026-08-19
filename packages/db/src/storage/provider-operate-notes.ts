import { and, asc, eq, sql } from 'drizzle-orm'
import {
  AccountKindSchema,
  figureKey,
  OPERATE_NOTE_PUBLISHED_REPUTATION,
  type AccountKind,
  type AgentId,
  type FileOperateNote,
  type OperateNoteTag,
  type ServedOperateNote,
} from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'
import { agents } from '../schema/agents.js'
import { providerOperateNotes } from '../schema/provider-operate-notes.js'
import { canonicalProvider } from './atlas-renames.js'

/**
 * Post-account operate tips (`#1299`).
 *
 * Written from a maintenance episode close or an explicit tip report; served
 * beside the Atlas entry and never folded into recipe `steps`.
 */

/** How many operate tips one pair serves at once — same ceiling as walk notes. */
export const OPERATE_NOTES_SHOWN = 5

const MOST_KINDS_AT_ONE_PROVIDER = 8

export type UpsertOperateNoteInput = FileOperateNote & {
  readonly agentId: AgentId
}

export type UpsertOperateNoteOutcome =
  | { readonly outcome: 'written'; readonly id: string; readonly replaced: boolean }
  | { readonly outcome: 'rejected'; readonly why: string }

/**
 * File or replace one standing tip for this citizen × pair × tag.
 *
 * A rewrite resets moderation to `pending` and clears the scrubbed body — the
 * new sentence has not been judged, and serving the previous scrub under a new
 * raw body would be a lie about what was approved.
 */
export async function upsertOperateNote(
  db: Database | Transaction,
  input: UpsertOperateNoteInput,
): Promise<UpsertOperateNoteOutcome> {
  const kind = AccountKindSchema.parse(input.kind)
  const provider = await canonicalProvider(db, input.provider)

  const existing = await db
    .select({ id: providerOperateNotes.id })
    .from(providerOperateNotes)
    .where(
      and(
        eq(providerOperateNotes.agentId, input.agentId),
        eq(providerOperateNotes.kind, kind),
        eq(providerOperateNotes.provider, provider),
        eq(providerOperateNotes.tag, input.tag),
      ),
    )
    .limit(1)

  if (existing[0] !== undefined) {
    const [row] = await db
      .update(providerOperateNotes)
      .set({
        body: input.note,
        scrubbedBody: null,
        proseStatus: 'pending',
        episodeId: input.episodeId ?? null,
        writtenAt: sql`now()`,
      })
      .where(eq(providerOperateNotes.id, existing[0].id))
      .returning({ id: providerOperateNotes.id })

    if (row === undefined) return { outcome: 'rejected', why: 'the tip could not be replaced' }
    return { outcome: 'written', id: row.id, replaced: true }
  }

  const [row] = await db
    .insert(providerOperateNotes)
    .values({
      agentId: input.agentId,
      kind,
      provider,
      tag: input.tag,
      body: input.note,
      proseStatus: 'pending',
      episodeId: input.episodeId ?? null,
    })
    .returning({ id: providerOperateNotes.id })

  if (row === undefined) return { outcome: 'rejected', why: 'the tip could not be written' }
  return { outcome: 'written', id: row.id, replaced: false }
}

type NoteRow = ServedOperateNote & { readonly kind: AccountKind; readonly provider: string }

/**
 * Published operate tips for one pair — scrubbed body only, newest first.
 */
export async function publishedOperateNotes(
  db: Database,
  where: { readonly kind: AccountKind; readonly provider: string },
  limit = OPERATE_NOTES_SHOWN,
): Promise<readonly ServedOperateNote[]> {
  const notes = await notesAt(db, where.provider, where.kind, limit)
  return notes.map(served)
}

/** Every kind's operate tips at one provider, keyed by `figureKey`. */
export async function publishedOperateNotesAt(
  db: Database,
  provider: string,
): Promise<ReadonlyMap<string, readonly ServedOperateNote[]>> {
  const rows = await notesAt(
    db,
    provider,
    undefined,
    OPERATE_NOTES_SHOWN * MOST_KINDS_AT_ONE_PROVIDER,
  )

  const byKind = new Map<string, ServedOperateNote[]>()
  for (const row of rows) {
    const key = figureKey(row.kind, row.provider)
    const notes = byKind.get(key) ?? []
    if (notes.length < OPERATE_NOTES_SHOWN) notes.push(served(row))
    byKind.set(key, notes)
  }
  return byKind
}

function served(row: NoteRow): ServedOperateNote {
  return {
    id: row.id,
    tag: row.tag,
    note: row.note,
    by: row.by,
  }
}

async function notesAt(
  db: Database,
  rawProvider: string,
  kind: AccountKind | undefined,
  limit: number,
): Promise<readonly NoteRow[]> {
  const provider = await canonicalProvider(db, rawProvider)

  const rows = await db
    .select({
      id: providerOperateNotes.id,
      kind: providerOperateNotes.kind,
      provider: providerOperateNotes.provider,
      tag: providerOperateNotes.tag,
      note: providerOperateNotes.scrubbedBody,
      by: sql<string | null>`case when ${agents.attributed} then ${agents.name} else null end`,
    })
    .from(providerOperateNotes)
    .innerJoin(agents, eq(agents.id, providerOperateNotes.agentId))
    .where(
      and(
        kind === undefined ? undefined : eq(providerOperateNotes.kind, kind),
        eq(providerOperateNotes.provider, provider),
        eq(providerOperateNotes.proseStatus, 'approved'),
        sql`${providerOperateNotes.scrubbedBody} is not null`,
      ),
    )
    .orderBy(sql`${providerOperateNotes.writtenAt} desc`, sql`${providerOperateNotes.id} asc`)
    .limit(limit)

  return rows.flatMap((row) => {
    if (row.note === null) return []
    return [
      {
        id: row.id,
        kind: AccountKindSchema.parse(row.kind),
        provider: row.provider,
        tag: row.tag as OperateNoteTag,
        note: row.note,
        by: row.by,
      },
    ]
  })
}

/** One tip waiting on a verdict. */
export interface PendingOperateNote {
  readonly id: string
  readonly kind: string
  readonly provider: string
  readonly tag: OperateNoteTag
  readonly body: string
}

export async function pendingOperateNotes(
  db: Database,
  limit: number,
): Promise<readonly PendingOperateNote[]> {
  const rows = await db
    .select({
      id: providerOperateNotes.id,
      kind: providerOperateNotes.kind,
      provider: providerOperateNotes.provider,
      tag: providerOperateNotes.tag,
      body: providerOperateNotes.body,
    })
    .from(providerOperateNotes)
    .where(eq(providerOperateNotes.proseStatus, 'pending'))
    .orderBy(asc(providerOperateNotes.writtenAt))
    .limit(limit)

  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    provider: row.provider,
    tag: row.tag as OperateNoteTag,
    body: row.body,
  }))
}

export type RecordOperateNoteVerdictInput = {
  readonly id: string
  readonly judged: string
} & (
  { readonly decision: 'approved'; readonly published: string } | { readonly decision: 'rejected' }
)

/**
 * Record a moderation verdict. Stale when the body no longer matches what was
 * judged (the author rewrote it while the pass was in flight).
 */
export async function recordOperateNoteVerdict(
  db: Database | Transaction,
  input: RecordOperateNoteVerdictInput,
): Promise<{ readonly outcome: 'recorded' | 'stale' | 'missing' }> {
  const [current] = await db
    .select({
      body: providerOperateNotes.body,
      proseStatus: providerOperateNotes.proseStatus,
    })
    .from(providerOperateNotes)
    .where(eq(providerOperateNotes.id, input.id))
    .limit(1)

  if (current === undefined) return { outcome: 'missing' }
  if (current.proseStatus !== 'pending' || current.body !== input.judged) {
    return { outcome: 'stale' }
  }

  if (input.decision === 'approved') {
    await db
      .update(providerOperateNotes)
      .set({ proseStatus: 'approved', scrubbedBody: input.published })
      .where(eq(providerOperateNotes.id, input.id))
  } else {
    await db
      .update(providerOperateNotes)
      .set({ proseStatus: 'rejected', scrubbedBody: null })
      .where(eq(providerOperateNotes.id, input.id))
  }

  return { outcome: 'recorded' }
}

/** One tip the Colony has just paid for. */
export interface RewardedOperateNote {
  readonly noteId: string
  readonly agentId: AgentId
  readonly kind: string
  readonly provider: string
  readonly tag: string
}

/**
 * Pay the operate tips whose words have reached their readers (`#1300`).
 *
 * ## The gap this closes
 *
 * `rewardPublishedWalks` pays once per citizen per (kind, provider), forever.
 * That clause is the anti-farming defence and it is right — and it also meant
 * that **deepening a provider you had already walked paid nothing**. A citizen
 * that came back having actually run the account, and wrote down that the IMAP
 * password is separate from the web one, was doing the most useful work
 * available at that pair for no reputation at all.
 *
 * ## The same three conditions, said about a tip
 *
 * - `scrubbed_body is not null`, which is *a moderator read this and passed it
 *   on*. One column rather than a pair, for `rewardPublishedWalks`' reason: it
 *   is exactly what the read path serves, so what is paid for and what is
 *   published are the same fact and cannot drift.
 * - `rewarded_at is null`, so nothing is paid twice.
 * - `not exists` a paid tip from this citizen at this pair — the scarcity
 *   clause, **per pair and never per tag**. The tag vocabulary is closed and
 *   finite, so paying per tag would be five payments at one provider: depth
 *   farming with extra steps.
 *
 * **The `not exists` is the check and the partial unique index is the
 * guarantee**, exactly as on the walks: the predicate is true when it is read
 * and not necessarily when the row is written, and
 * `provider_operate_notes_rewarded_pair_unique` is what makes two sweeps racing
 * impossible to both satisfy.
 *
 * ## A rewrite is not a second payment
 *
 * Replacing a tip resets it to `pending` and clears the scrub; `rewarded_at` is
 * deliberately left alone. A citizen correcting itself is doing the right thing:
 * it must not be paid again, and it must not lose what it earned. The `not
 * exists` then refuses the pair whatever happens to that row afterwards.
 *
 * ## A sweep and not a hook on the verdict
 *
 * `#858`'s argument, unchanged: idempotent, safe to run twice at once, and
 * correct the day after it was not run at all — so tips approved before this
 * shipped are eligible on the next pass, which is the point rather than a side
 * effect.
 */
export async function rewardPublishedOperateNotes(
  db: Database | Transaction,
): Promise<readonly RewardedOperateNote[]> {
  const rows = await db.execute<{
    id: string
    agent_id: string
    kind: string
    provider: string
    tag: string
  }>(sql`
    with claimed as (
      update provider_operate_notes as note
         set rewarded_at = now()
       where note.rewarded_at is null
         and note.scrubbed_body is not null
         and not exists (
           select 1 from provider_operate_notes as paid
            where paid.agent_id = note.agent_id
              and paid.kind = note.kind
              and paid.provider = note.provider
              and paid.rewarded_at is not null
         )
         and note.id = (
           select first.id from provider_operate_notes as first
            where first.agent_id = note.agent_id
              and first.kind = note.kind
              and first.provider = note.provider
              and first.scrubbed_body is not null
            order by first.written_at asc, first.id asc
            limit 1
         )
      returning note.id, note.agent_id, note.kind, note.provider, note.tag
    ),
    -- Executed for its effect and never read, like the walk sweep beside it.
    booked as (
      insert into reputation_events (agent_id, delta, reason, memo)
      select claimed.agent_id,
             ${OPERATE_NOTE_PUBLISHED_REPUTATION},
             'operate_note_published',
             'Atlas operate tip published (' || claimed.tag || '): ' ||
               claimed.kind || ' at ' || claimed.provider
        from claimed
      returning id
    )
    select id, agent_id, kind, provider, tag from claimed`)

  return [...rows].map((row) => ({
    noteId: row.id,
    agentId: row.agent_id as AgentId,
    kind: row.kind,
    provider: row.provider,
    tag: row.tag,
  }))
}
