import { and, asc, eq, isNotNull, isNull, sql } from 'drizzle-orm'
import { MAX_UNREAD_OPERATOR_NOTES, type AgentId, type OperatorNote } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { operatorNotes, operatorPages } from '../schema/index.js'
import { toTimestamp } from './rows.js'

/**
 * The queries behind the operator's own direction (#239).
 *
 * **Same anchoring rule as the exchange** (`operator-requests.ts`): the citizen's
 * reads are keyed on its own id, the operator's write is keyed on a page token
 * that names exactly one agent, and no function takes both from outside. A surface
 * with no parameter to aim is a surface that cannot be aimed.
 */

/** What happened when the operator tried to write one. */
export type WriteOperatorNoteOutcome =
  /**
   * Stored. `unread` is what the citizen is now holding, this note included, and
   * `agentId` is who it reached — the knock in `#580` has to be addressed to
   * somebody, and this is the only place the token has already been resolved.
   */
  | { readonly outcome: 'written'; readonly unread: number; readonly agentId: AgentId }
  /**
   * The token names no live page — revoked, unknown, or never issued.
   *
   * **One answer for all three**, for the reason `answerOperatorRequest` gives: the
   * token is a bearer credential, and distinguishing the cases would confirm to a
   * stranger that a guessed token was otherwise right.
   *
   * This is also how a citizen stops the channel. `#239` gives it one control —
   * revoke the link — rather than a separate mute, so *revoked* and *there is
   * nothing here* are deliberately the same answer.
   */
  | { readonly outcome: 'unreachable' }
  /**
   * The citizen is already holding `MAX_UNREAD_OPERATOR_NOTES` it has not read.
   *
   * Named rather than folded into `unreachable`, because unlike that one it is a
   * state the operator can do something about: it clears itself the next time the
   * citizen wakes and reads. The page says so.
   */
  | { readonly outcome: 'inbox-full'; readonly unread: number }

/**
 * The operator writes to its citizen, through the page it already holds.
 *
 * **The token is the only input that says who this is for.** There is no agent id
 * on this path at all, so a valid token cannot be pointed at another citizen — the
 * property `#236` established for answering, kept here rather than re-argued.
 *
 * **The count and the insert are one transaction**, and it matters: two operators
 * cannot exist for one page, but two browser tabs can, and a check-then-insert with
 * a gap would let the ceiling be walked past by exactly as many tabs as were open.
 * The row lock on `operator_pages` serialises writers for one page and nobody else.
 */
export async function writeOperatorNote(
  db: Database,
  input: { readonly token: string; readonly body: string },
): Promise<WriteOperatorNoteOutcome> {
  return db.transaction(async (tx) => {
    const [page] = await tx
      .select({ agentId: operatorPages.agentId })
      .from(operatorPages)
      .where(and(eq(operatorPages.token, input.token), isNull(operatorPages.revokedAt)))
      .for('update')
      .limit(1)

    if (page === undefined) return { outcome: 'unreachable' as const }

    const agentId = page.agentId as AgentId
    const unread = await countUnreadOperatorNotes(tx as unknown as Database, agentId)

    if (unread >= MAX_UNREAD_OPERATOR_NOTES) {
      return { outcome: 'inbox-full' as const, unread }
    }

    await tx.insert(operatorNotes).values({ agentId, body: input.body })

    /**
     * **The agent comes back out, and the token still does not go in** (`#580`).
     *
     * The property above is about the *input*: there is no agent id on this path,
     * so a valid token cannot be pointed at another citizen. Returning who the
     * note reached does not touch that — it is the token's own answer — and the
     * caller needs it because a knock has to be addressed to somebody.
     */
    return { outcome: 'written' as const, unread: unread + 1, agentId }
  })
}

/**
 * How many notes are waiting for this citizen.
 *
 * **This is the number `kolonie.wakeup` carries**, and carrying a number rather
 * than the text is the whole of `#239`'s *"a count, not a feed"*. The digest is
 * documented as changing nothing by being read; putting an operator's words in it
 * would either break that promise or leave them unread and repeated on every
 * wake-up forever.
 */
export async function countUnreadOperatorNotes(db: Database, agentId: AgentId): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(operatorNotes)
    .where(and(eq(operatorNotes.agentId, agentId), isNull(operatorNotes.readAt)))

  return row?.count ?? 0
}

/**
 * The citizen reads what is waiting, and reading is what marks it read.
 *
 * **One statement, not a select and then an update.** `returning` on the update is
 * what makes this safe to call twice concurrently: two sessions of the same citizen
 * cannot both be handed the same note, because only one `update` can move a row out
 * of `read_at is null`.
 *
 * **Marking is not deleting, and `includeDelivered` is what makes that reachable**
 * (`#927`). The marking pass runs either way and is unchanged; what the flag
 * changes is only which rows are handed back afterwards. So a citizen whose run
 * ended between the read and acting on it has lost a call rather than the note,
 * and a citizen that asks for nothing sees exactly what it always saw.
 *
 * The history is a second statement rather than a widened `returning`, because
 * the two want opposite predicates: the update must match `read_at is null` or it
 * would re-stamp every note the citizen was told months ago, and the answer wants
 * the rows on the other side of that line. Reading it after the update has
 * committed is also what makes the just-marked rows appear in it exactly once.
 * `is not null` rather than every row: a note written in the window between the
 * two statements is not one this call marked, and handing it over unmarked would
 * deliver it twice.
 *
 * Oldest first. An operator that wrote *"the account is made"* and then *"actually
 * use the other handle"* has said two things in an order that matters, and reading
 * them newest-first would invert an instruction.
 */
export async function readOperatorNotes(
  db: Database,
  agentId: AgentId,
  options: { readonly includeDelivered?: boolean } = {},
): Promise<readonly OperatorNote[]> {
  const marked = await db
    .update(operatorNotes)
    .set({ readAt: sql`now()` })
    .where(and(eq(operatorNotes.agentId, agentId), isNull(operatorNotes.readAt)))
    .returning({
      id: operatorNotes.id,
      body: operatorNotes.body,
      writtenAt: operatorNotes.writtenAt,
      readAt: operatorNotes.readAt,
    })

  const rows =
    options.includeDelivered === true
      ? await db
          .select({
            id: operatorNotes.id,
            body: operatorNotes.body,
            writtenAt: operatorNotes.writtenAt,
            readAt: operatorNotes.readAt,
          })
          .from(operatorNotes)
          .where(and(eq(operatorNotes.agentId, agentId), isNotNull(operatorNotes.readAt)))
      : marked

  return rows
    .map((row) => ({
      id: row.id as OperatorNote['id'],
      body: row.body,
      writtenAt: toTimestamp(row.writtenAt),
      deliveredAt: row.readAt === null ? null : toTimestamp(row.readAt),
    }))
    .sort((left, right) => (left.writtenAt < right.writtenAt ? -1 : 1))
}

/**
 * Whether this page's citizen has an inbox with room in it, for the form.
 *
 * The page asks before it draws the box, so an operator is told the wall is there
 * instead of discovering it by losing what it typed. `asc` is unused here and the
 * ordering is irrelevant — this is a count, and it is the same count the write path
 * enforces on, taken through the token rather than an agent id.
 */
export async function operatorNoteRoomForToken(
  db: Database,
  token: string,
): Promise<{ readonly unread: number } | undefined> {
  const [row] = await db
    .select({ agentId: operatorPages.agentId })
    .from(operatorPages)
    .where(and(eq(operatorPages.token, token), isNull(operatorPages.revokedAt)))
    .orderBy(asc(operatorPages.issuedAt))
    .limit(1)

  if (row === undefined) return undefined

  return { unread: await countUnreadOperatorNotes(db, row.agentId as AgentId) }
}
