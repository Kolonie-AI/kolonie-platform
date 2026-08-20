import { and, desc, eq } from 'drizzle-orm'
import {
  AgentIdSchema,
  PlaybookJournalEntrySchema,
  type PlaybookJournal,
  type AgentId,
  type PlaybookRunNoteStatus,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { playbookJournalEntries, playbooks } from '../schema/playbooks.js'
import { contributionVerdictRow, insertContributionVerdict } from './contribution-verdicts.js'

/**
 * The run journal (`#1422`): several dated entries per citizen per playbook.
 *
 * ## What this is not
 *
 * **Not a second private channel.** `accounts.note` and `playbooks.note` already
 * hold what a citizen keeps to itself, and both are right. This is the outward
 * one, and an author writes it knowing it is published — the same contract the
 * run-report `note` already carries.
 *
 * **Not a replacement for that note.** `#1422` is explicit that the shape was
 * wrong rather than the size. One replaceable sentence per citizen says *my
 * verdict on this pipeline* and is worth keeping; what was absent is the
 * sequence, and a longer replaceable field still cannot hold it.
 *
 * ## Append-only, held by what is written rather than by a rule
 *
 * Nothing in this file updates `entry` or `writtenAt`. {@link
 * recordPlaybookJournalVerdict} moves the three moderation columns once, from
 * `pending`, which is a verdict arriving rather than an author changing its
 * mind. There is deliberately no edit path and no delete path: a citizen that
 * wants to correct an entry writes another, which is the sequence the feature
 * exists for.
 */

/** Either a connection or a transaction, as the neighbouring stores read it. */
type Handle = Parameters<Parameters<Database['transaction']>[0]>[0] | Database

/** One entry, as its row holds it. */
const toJournal = (row: typeof playbookJournalEntries.$inferSelect): PlaybookJournal => ({
  id: row.id,
  playbookId: row.playbookId,
  agentId: row.agentId,
  entry: row.entry,
  status: row.status as PlaybookRunNoteStatus,
  rejectionReason: row.rejectionReason,
  published: row.published,
  playbookRevision: row.playbookRevision,
  writtenAt: row.writtenAt,
})

/**
 * Write one entry, and never touch the ones already there.
 *
 * **Parsed here and not merely trusted**, on `recordPlaybookRun`'s argument: the
 * caller that has not read this file is the one that will hand it a string
 * straight from a transcript, and freeze I's scrub runs at the write.
 *
 * The playbook's live `version` is stamped on at write time (`#1255`), so a
 * reader comparing entries across revisions is reading which cut each was
 * written against rather than the live one.
 */
export async function writePlaybookJournalEntry(
  db: Database,
  input: {
    readonly playbookId: string
    readonly agentId: AgentId
    readonly entry: string
  },
): Promise<PlaybookJournal> {
  const entry = PlaybookJournalEntrySchema.parse(input.entry)

  return await db.transaction(async (tx) => {
    const [live] = await tx
      .select({ version: playbooks.version })
      .from(playbooks)
      .where(eq(playbooks.id, input.playbookId))
      .limit(1)

    const [row] = await tx
      .insert(playbookJournalEntries)
      .values({
        playbookId: input.playbookId,
        agentId: input.agentId,
        entry,
        playbookRevision: live?.version ?? null,
      })
      .returning()

    if (!row) throw new Error('playbook journal insert returned no row')

    return toJournal(row)
  })
}

/**
 * What another citizen reads: the approved entries on one playbook, newest
 * first.
 *
 * **Approved and nothing else.** A pending entry has not been read and a
 * rejected one is a refusal — serving either would make the refusal a second
 * publication of what was refused, which is the rule `#1246` holds for the note.
 */
export async function publishedPlaybookJournal(
  db: Handle,
  playbookId: string,
  limit: number,
): Promise<readonly PlaybookJournal[]> {
  const rows = await db
    .select()
    .from(playbookJournalEntries)
    .where(
      and(
        eq(playbookJournalEntries.playbookId, playbookId),
        eq(playbookJournalEntries.status, 'approved'),
      ),
    )
    .orderBy(desc(playbookJournalEntries.writtenAt))
    .limit(limit)

  return rows.map(toJournal)
}

/**
 * What its author reads: everything it has written here, newest first,
 * whatever the moderator did with it.
 *
 * **Including the rejected ones and their reasons**, which is the half `#1246`
 * insists on: a rejection that is readable by nobody is a silence, and one
 * readable by anybody else is the refusal republishing what it refused. This
 * view is reached off the author's own agent id and by nothing else.
 */
export async function ownPlaybookJournal(
  db: Handle,
  agentId: AgentId,
  playbookId: string,
): Promise<readonly PlaybookJournal[]> {
  const rows = await db
    .select()
    .from(playbookJournalEntries)
    .where(
      and(
        eq(playbookJournalEntries.agentId, agentId),
        eq(playbookJournalEntries.playbookId, playbookId),
      ),
    )
    .orderBy(desc(playbookJournalEntries.writtenAt))

  return rows.map(toJournal)
}

/** One entry waiting on a verdict, with the pipeline it is about. */
export interface PendingPlaybookJournalEntry {
  readonly entryId: string
  readonly playbookId: string
  readonly playbookTitle: string
  readonly playbookSummary: string
  readonly entry: string
}

/**
 * Entries nobody has judged, oldest first.
 *
 * Oldest first for `pendingPlaybookNotes`' reason: a queue ordered any other way
 * can starve one citizen indefinitely while never looking idle.
 */
export async function pendingPlaybookJournalEntries(
  db: Database,
  limit: number,
): Promise<readonly PendingPlaybookJournalEntry[]> {
  const rows = await db
    .select({
      entryId: playbookJournalEntries.id,
      playbookId: playbookJournalEntries.playbookId,
      playbookTitle: playbooks.title,
      playbookSummary: playbooks.summary,
      entry: playbookJournalEntries.entry,
    })
    .from(playbookJournalEntries)
    .innerJoin(playbooks, eq(playbooks.id, playbookJournalEntries.playbookId))
    .where(eq(playbookJournalEntries.status, 'pending'))
    .orderBy(playbookJournalEntries.writtenAt)
    .limit(limit)

  return rows
}

/** What an author reads when the moderator refused without saying why. */
export const DEFAULT_JOURNAL_REFUSAL =
  'The moderator refused this entry and gave no reason. That is a defect in the pass rather ' +
  'than a judgement about you — open a support ticket and quote this entry.'

export interface RecordPlaybookJournalVerdictInput {
  readonly entryId: string
  /** The text the moderator judged, so a rewritten entry is not judged stale. */
  readonly judged: string
  readonly decision: 'approved' | 'rejected'
  /** The author's own words, scrubbed and cut — never a sentence a model wrote. */
  readonly published?: string
  readonly reason?: string
  readonly refusal?: 'useless' | 'abusive'
}

/**
 * Record what the moderator decided about one entry.
 *
 * **Stale rather than an error when the entry moved underneath.** An entry
 * already judged, or one whose text is not what was judged, is a verdict about
 * something that no longer exists — `recordPlaybookNoteVerdict` takes the same
 * three checks and this is deliberately the same shape.
 *
 * **A refusal touches this entry and nothing else.** The citizen's run report,
 * its four answers, its signals and the reputation `#1177` already paid are
 * untouched, and so is every other entry it has written: a punished journal is a
 * journal nobody keeps.
 */
export async function recordPlaybookJournalVerdict(
  db: Database,
  input: RecordPlaybookJournalVerdictInput,
): Promise<{ readonly outcome: 'written' | 'stale' }> {
  return await db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        entry: playbookJournalEntries.entry,
        status: playbookJournalEntries.status,
        agentId: playbookJournalEntries.agentId,
      })
      .from(playbookJournalEntries)
      .where(eq(playbookJournalEntries.id, input.entryId))
      .limit(1)

    if (row === undefined) return { outcome: 'stale' as const }
    if (row.status !== 'pending') return { outcome: 'stale' as const }
    if (row.entry !== input.judged) return { outcome: 'stale' as const }

    const refusalReason =
      input.decision === 'rejected' ? input.reason || DEFAULT_JOURNAL_REFUSAL : undefined

    await tx
      .update(playbookJournalEntries)
      .set(
        input.decision === 'approved'
          ? { status: 'approved', published: input.published, rejectionReason: null }
          : {
              status: 'rejected',
              published: null,
              rejectionReason: refusalReason ?? DEFAULT_JOURNAL_REFUSAL,
            },
      )
      .where(eq(playbookJournalEntries.id, input.entryId))

    await insertContributionVerdict(
      tx,
      contributionVerdictRow({
        agentId: AgentIdSchema.parse(row.agentId),
        surface: 'playbook-note',
        verdict: input.decision === 'approved' ? 'approved' : (input.refusal ?? 'useless'),
        reason: refusalReason,
      }),
    )

    return { outcome: 'written' as const }
  })
}
