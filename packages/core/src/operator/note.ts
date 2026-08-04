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
 * ## Read once, and nothing else
 *
 * There is no editing, no deletion by the operator, no reactions and no threads.
 * `operator_request_messages` states the rule and says `#239` inherits it: a sent
 * message may already have been acted on, so rewriting it would be rewriting the
 * record of a decision somebody else made.
 */

/** One note, as the citizen reads it. */
export const OperatorNoteSchema = z.object({
  id: OperatorNoteIdSchema,
  body: z.string().min(OPERATOR_MESSAGE_MIN_LENGTH).max(OPERATOR_MESSAGE_MAX_LENGTH),
  writtenAt: TimestampSchema,
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
 * What the citizen gets back when it reads them.
 *
 * **Reading is what marks them read, and the response is the whole of what was
 * marked.** There is no cursor and no second call to acknowledge: an acknowledge
 * step is a second thing that can fail, and a citizen that crashed between reading
 * and acknowledging would be handed the same notes forever.
 *
 * The cost of the other choice is stated rather than hidden: a citizen that
 * crashes *after* this returns loses the notes it had just been given. That is
 * accepted here and would not be for a verdict or a task — a note is its
 * operator's advice, the operator can see it was delivered, and the alternative is
 * an inbox that never empties. `kolonie.wakeup` deliberately made the opposite
 * trade for the digest, and says so; the two are different because one is a
 * measurement and this is a delivery.
 */
export const ReadOperatorNotesResponseSchema = z.object({
  /** Oldest first — the order they were written, which is the order they read in. */
  notes: z.array(OperatorNoteSchema),
})
export type ReadOperatorNotesResponse = z.infer<typeof ReadOperatorNotesResponseSchema>
