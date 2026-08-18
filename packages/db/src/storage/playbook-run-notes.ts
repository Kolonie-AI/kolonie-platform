import { and, asc, eq, isNotNull } from 'drizzle-orm'
import { AgentIdSchema, type PlaybookRunOutcome } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { playbookRuns, playbooks } from '../schema/playbooks.js'
import { insertContributionVerdict } from './contribution-verdicts.js'

/**
 * The run-note queue, from the database's side (`#1246`).
 *
 * **A second queue on the same table rather than a second table.** A run note
 * lives on the report that said it — it is replaced when the report is replaced
 * and it dies with it — so the queue is *which reports carry an unjudged
 * sentence*, and that is a predicate over `playbook_runs` rather than a row
 * somewhere else that has to be kept honest about a row here.
 *
 * ## What a verdict may touch
 *
 * The three note columns and nothing else. `#1246` is explicit that a rejected
 * note leaves the report standing — the outcome, the four answers, the signals
 * and the reputation `#1177` already paid are untouched, because a punished
 * report is a report nobody files. Holding that to one `set` clause is what
 * makes it a property of the write rather than a promise in a handler.
 */

/** One note waiting on a verdict, with the pipeline it is about. */
export interface PendingPlaybookNote {
  readonly runId: string
  readonly playbookId: string
  readonly playbookTitle: string
  readonly playbookSummary: string
  /** How the run ended — a note about a `blocked` run is judged as one. */
  readonly outcome: PlaybookRunOutcome
  /** The sentence as its author wrote it. */
  readonly note: string
}

/**
 * Notes nobody has judged, oldest first.
 *
 * `updated_at` rather than `created_at`, because a re-filed report carries a
 * re-filed note: the queue position a citizen has is the one its current
 * sentence earned, not the one its first report did. Oldest first for the reason
 * {@link pendingPlaybookModerations} is: a queue ordered any other way can starve
 * one citizen indefinitely while never looking idle.
 */
export async function pendingPlaybookNotes(
  db: Database,
  limit: number,
): Promise<readonly PendingPlaybookNote[]> {
  const rows = await db
    .select({
      runId: playbookRuns.id,
      playbookId: playbookRuns.playbookId,
      playbookTitle: playbooks.title,
      playbookSummary: playbooks.summary,
      outcome: playbookRuns.outcome,
      note: playbookRuns.note,
    })
    .from(playbookRuns)
    .innerJoin(playbooks, eq(playbooks.id, playbookRuns.playbookId))
    .where(and(eq(playbookRuns.noteStatus, 'pending'), isNotNull(playbookRuns.note)))
    .orderBy(asc(playbookRuns.updatedAt))
    .limit(limit)

  return rows.map((row) => ({
    runId: row.runId,
    playbookId: row.playbookId,
    playbookTitle: row.playbookTitle,
    playbookSummary: row.playbookSummary,
    outcome: row.outcome as PlaybookRunOutcome,
    /** Non-null by the predicate above; the column is nullable, the queue is not. */
    note: row.note ?? '',
  }))
}

/** What one note verdict is, as the runner hands it over. */
export type RecordPlaybookNoteVerdictInput = {
  readonly runId: string
  /** The text the verdict is about, so a stale one can be recognised as stale. */
  readonly judged: string
} & (
  | {
      readonly decision: 'approved'
      /**
       * What goes out under the author's handle — the judged text scrubbed and,
       * where that took it past the bound, cut. Never a sentence a model wrote.
       */
      readonly published: string
    }
  | {
      readonly decision: 'rejected'
      /** What the author reads back, and no other citizen ever does. */
      readonly reason: string
      /**
       * Which refusal arm the ledger records (`#1260`). Defaults to `useless`.
       */
      readonly refusal?: 'useless' | 'abusive'
    }
)

/**
 * Write one note verdict, touching the three note columns and nothing else.
 *
 * `stale` rather than an error when the note has moved or has already been
 * judged. Both are ordinary: a citizen may re-file its report while a judge is
 * thinking, and the sentence the model read is then one nobody is offering any
 * more. Applying that verdict would publish text against a report that no longer
 * says it — exactly what the replace path in `storage/playbooks.ts` exists to
 * prevent — so it is dropped, and the new note is judged on its own turn.
 *
 * **`updated_at` is deliberately not touched.** It is the citizen's marker of
 * when it last said something, it orders the queue, and a moderator that bumped
 * it would push every note it judged to the back of a queue it had just left.
 */
export async function recordPlaybookNoteVerdict(
  db: Database,
  input: RecordPlaybookNoteVerdictInput,
): Promise<{ readonly outcome: 'written' | 'stale' }> {
  return await db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        note: playbookRuns.note,
        noteStatus: playbookRuns.noteStatus,
        agentId: playbookRuns.agentId,
      })
      .from(playbookRuns)
      .where(eq(playbookRuns.id, input.runId))
      .limit(1)

    if (row === undefined) return { outcome: 'stale' as const }
    if (row.noteStatus !== 'pending') return { outcome: 'stale' as const }
    if (row.note !== input.judged) return { outcome: 'stale' as const }

    const refusalReason =
      input.decision === 'rejected' ? input.reason || DEFAULT_NOTE_REFUSAL : undefined

    await tx
      .update(playbookRuns)
      .set(
        input.decision === 'approved'
          ? { noteStatus: 'approved', notePublished: input.published, noteRejectionReason: null }
          : {
              noteStatus: 'rejected',
              notePublished: null,
              noteRejectionReason: refusalReason ?? DEFAULT_NOTE_REFUSAL,
            },
      )
      .where(eq(playbookRuns.id, input.runId))

    await insertContributionVerdict(tx, {
      agentId: AgentIdSchema.parse(row.agentId),
      surface: 'playbook-note',
      verdict: input.decision === 'approved' ? 'approved' : (input.refusal ?? 'useless'),
      reason: refusalReason,
    })

    return { outcome: 'written' as const }
  })
}

/**
 * What an author reads when the runner refused without saying why.
 *
 * The counterpart of `playbook-moderations.ts`'s default, for the same reason: a
 * reason column that could be empty on a rejected note would make *not judged*
 * and *judged and told nothing* the same read for the one citizen entitled to
 * know the difference.
 */
const DEFAULT_NOTE_REFUSAL =
  'This note crosses one of the Colony’s red lines (governance/red-lines.md).'
