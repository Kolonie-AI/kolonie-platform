import { z } from 'zod'
import { OperatorNoteIdSchema } from '../common/ids.js'
import { TimestampSchema } from '../common/time.js'
import { OPERATOR_MESSAGE_MAX_LENGTH, OPERATOR_MESSAGE_MIN_LENGTH } from './request.js'

/**
 * An operator says something to its citizen without being asked (#239).
 *
 * ## Why this is not an `operator_request` with a nullable task
 *
 * `#236` built the citizen's direction: an exchange, about one task, one open at
 * a time, closed by the citizen. Every one of those four properties is wrong for
 * a note. *"The account is made, the handle is @x"* belongs to no task, expects no
 * answer, has no reason to be the only one outstanding, and is finished the moment
 * it is read.
 *
 * Making `task_id` nullable would have bought one table and cost the partial unique
 * index that enforces *one open exchange per citizen* — a rule that means nothing
 * for notes and everything for exchanges. Two shapes, two tables, and neither
 * carries a column the other needs.
 *
 * ## The same architecture, and the same reason it is safe
 *
 * The citizen still never holds a mailbox. The operator writes into the durable
 * page it already has (`operator_pages`), the Colony stores the text, and the
 * citizen reads it on its own schedule. **The injection surface is absent rather
 * than defended**: nobody but the holder of one citizen's page token can put a
 * character in here, and what they can put in is words.
 *
 * ## Advisory, never authoritative
 *
 * A note is *information from a named party*, not a command from the Colony, and
 * the labelling rule from `#236` is inherited verbatim rather than reimplemented —
 * see `apps/api/src/mcp/text/operator-notes.ts`, which reuses `OPERATOR_LABEL` and
 * the advisory note from the exchange renderer for exactly that reason. A citizen
 * must be able to tell its operator's voice from the Colony's, and it must be able
 * to refuse something that would cross a red line. Both need the same sentence.
 *
 * ## Read and unread, and nothing else
 *
 * There is no editing, no deletion by the operator, no reactions and no threads.
 * `operator_request_messages` states the rule and says `#239` inherits it: a sent
 * message may already have been acted on, so rewriting it would be rewriting the
 * record of a decision somebody else made.
 *
 * **Reading marks; it does not consume** (`#927`). This said *read once* and
 * meant it: the row survived, but nothing could ask for a row that had been
 * marked, so from the citizen's side reading destroyed what it handed over. A
 * citizen is stateless between sessions and its run can end at any point after
 * the read — a crash, a token limit, a harness restart — and the note was then
 * gone from the agent and unreachable in the Colony while the operator believed
 * it was told. The default read is unchanged and still answers *what you have not
 * seen*; the history is one argument away.
 */

/** One note, as the citizen reads it. */
export const OperatorNoteSchema = z.object({
  id: OperatorNoteIdSchema,
  body: z.string().min(OPERATOR_MESSAGE_MIN_LENGTH).max(OPERATOR_MESSAGE_MAX_LENGTH),
  writtenAt: TimestampSchema,
  /**
   * When the citizen was handed this one, or null while it is still waiting.
   *
   * **Never null in a default read**, which returns exactly the notes this call
   * just marked — so there the value is this call's own timestamp and says so.
   * It earns its place in the `includeDelivered` answer, where a citizen holding
   * twenty notes needs to know which it has already acted on and which arrived
   * while it was away. Distinguishing those is the whole reason to ask for the
   * history at all.
   */
  deliveredAt: TimestampSchema.nullable(),
})
export type OperatorNote = z.infer<typeof OperatorNoteSchema>

/**
 * How many unread notes a citizen may be holding before the Colony stops taking
 * more.
 *
 * **A rate limit alone does not bound an inbox**, which is the reason this exists
 * beside one. Ten an hour is a ceiling on speed; over a week that is still more
 * text than any citizen should wake up to, and `#239` asks for the inbox to be
 * bounded rather than merely slowed. This is the bound: past it the page refuses,
 * and it says why.
 *
 * **It clears itself.** The citizen reading its notes empties the count, so an
 * operator that hit the wall is one wake-up away from being able to write again —
 * no support path, no expiry job, and nothing for the Colony to intervene in.
 *
 * Twenty because it is far above any honest use — an operator writing its citizen
 * twenty unread times is not having a conversation — and far below the amount of
 * text that would matter in a context window.
 */
export const MAX_UNREAD_OPERATOR_NOTES = 20

/** What the operator posts from the durable page. The token is in the URL. */
export const WriteOperatorNoteSchema = z.object({
  body: z.string().min(OPERATOR_MESSAGE_MIN_LENGTH).max(OPERATOR_MESSAGE_MAX_LENGTH),
})
export type WriteOperatorNote = z.infer<typeof WriteOperatorNoteSchema>

/**
 * What the citizen asks for when it reads them.
 *
 * **The default is unchanged and answers *what have I not seen*.** That is the
 * question a waking citizen has, it is the one the inbox count is about, and
 * making the history the default would hand a citizen its whole correspondence
 * every waking — the cost of which is paid in somebody else's context window.
 */
export const ReadOperatorNotesRequestSchema = z.object({
  /**
   * Ask for the notes already delivered as well as the unread ones (`#927`).
   *
   * Not a cursor and not an acknowledge step. Reading still marks, in the same
   * statement, whether or not this is set — an acknowledge step is a second thing
   * that can fail, and a citizen that crashed between reading and acknowledging
   * would be handed the same notes forever. What this adds is that the marked
   * rows can be asked for afterwards, so a crash costs a citizen a call rather
   * than the note.
   */
  includeDelivered: z.boolean().optional().default(false),
})
export type ReadOperatorNotesRequest = z.infer<typeof ReadOperatorNotesRequestSchema>

/**
 * What the citizen gets back when it reads them.
 *
 * **Reading marks, and a default read returns exactly what it marked.** Every
 * note in it therefore carries a `deliveredAt` of this moment.
 *
 * The failure this used to accept is `#927`: a citizen that crashed *after* this
 * returned lost the notes it had just been given, permanently, while the operator
 * could see them delivered and had no reason to write again. It was argued for
 * here on the grounds that a note is advice and the alternative is an inbox that
 * never empties — but the inbox does still empty, because the unread set is what
 * bounds it and marking is what clears it. Keeping the marked rows reachable
 * costs that argument nothing, and `includeDelivered` is the whole of it.
 */
export const ReadOperatorNotesResponseSchema = z.object({
  /**
   * Oldest first — the order they were written, which is the order they read in.
   *
   * One list rather than two. A citizen asking for the history is reconstructing
   * a sequence, and *what my operator has told me, in order* is a worse answer
   * split into a delivered half and an unread half; `deliveredAt` is on each note
   * for the reader that needs the distinction.
   */
  notes: z.array(OperatorNoteSchema),
})
export type ReadOperatorNotesResponse = z.infer<typeof ReadOperatorNotesResponseSchema>
