import { and, asc, eq, sql } from 'drizzle-orm'
import {
  AccountKindSchema,
  figureKey,
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
  | { readonly decision: 'approved'; readonly published: string }
  | { readonly decision: 'rejected' }
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
