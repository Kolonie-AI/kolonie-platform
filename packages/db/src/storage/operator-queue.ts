import { sql } from 'drizzle-orm'
import { inClearingOrder, type HumanId, type WaitingItem, type WaitingKind } from '@kolonie-ai/core'
import type { Database } from '../client.js'

/**
 * Everything waiting on one person, across every agent they operate (#530).
 *
 * ## One query over two tables, and why it is raw SQL
 *
 * The two channels are deliberately different shapes — a request is a
 * conversation whose first message is the ask, a drop is a single field with a
 * prompt above it — and the queue is the one place they have to look the same. A
 * `union all` states that in one place; two queries and a merge in TypeScript
 * would put the *is this still waiting* rule in two dialects, and that rule is
 * the whole correctness of the page.
 *
 * There were three (`#738`): a live browser tab an agent had offered, which was
 * the one arm with a deadline the operator could watch run out. It left with the
 * channel behind it (`#912`), and with it went the one place this query
 * knowingly departed from the rule below.
 *
 * ## What counts as waiting
 *
 * **A thread with no operator message yet.** One the person has already replied
 * to is not waiting on them — the citizen may still be reading it, and a queue
 * that showed answered threads would be a queue that never empties.
 *
 * **The exchange's `closed_at` had no successor and needed none** (`#1325`). A
 * thread cannot be closed, and the condition that did the work was never the
 * closing: it was *has the operator written*. That one carries over unchanged,
 * so the queue behaves exactly as it did while reading a table that is gone.
 *
 * **This person's own threads, joined through their participant row.** The
 * citizen may have more than one operator, and a queue built from `mine` alone
 * would put a colleague's conversation on somebody else's page.
 *
 * **A drop that is unfilled, unexpired and has attempts left.** Exactly
 * `viewDrop`'s three conditions, because an item this page offers and that page
 * refuses is worse than an item not shown.
 *
 * ## Nothing here writes, and nothing here is a command
 *
 * `#512` refuses a control panel and `#530` inherits the refusal. This reads, and
 * now reads only: the expiry sweep that used to run after the select was the
 * share's, and it went with it.
 */

/** One row as the union produces it, before it is given its type. */
interface WaitingRow extends Record<string, unknown> {
  readonly agent_id: string
  readonly agent_name: string
  readonly kind: string
  readonly ask: string
  readonly about: string | null
  readonly since: string
  readonly answer_at: string | null
  readonly request_id: string | null
  readonly drop_id: string | null
}

export async function waitingForOperator(
  db: Database,
  humanId: HumanId,
): Promise<readonly WaitingItem[]> {
  const rows = await db.execute<WaitingRow>(sql`
    with mine as (
      select agent_id from human_agents where human_id = ${humanId}
    ),
    questions as (
      select
        mp.agent_id,
        a.name as agent_name,
        'question' as kind,
        /**
         * The ask, which is the *first* message and never the latest.
         *
         * A citizen may write again while it waits, and the second message is
         * usually a nudge rather than the question. The queue shows what is
         * being asked.
         */
        (select m.body
           from messages m
          where m.conversation_id = c.id
          order by m.created_at asc, m.id asc
          limit 1) as ask,
        coalesce(t.title, w.provider) as about,
        c.created_at as since,
        p.token as answer_at,
        c.id as request_id,
        null::uuid as drop_id
      from message_conversations c
      join message_participants mp
        on mp.conversation_id = c.id and mp.agent_id is not null
      join mine on mine.agent_id = mp.agent_id
      join message_participants op
        on op.conversation_id = c.id and op.human_id = ${humanId}
      join agents a on a.id = mp.agent_id
      left join tasks t on t.id = c.task_id
      left join account_wishes w on w.id = c.wish_id
      left join operator_pages p
        on p.agent_id = mp.agent_id and p.revoked_at is null
      where not exists (
          select 1 from messages m
           where m.conversation_id = c.id and m.sender_party = 'operator-human'
        )
    ),
    handovers as (
      select
        d.agent_id,
        a.name as agent_name,
        d.kind as kind,
        d.prompt as ask,
        t.title as about,
        d.created_at as since,
        null::text as answer_at,
        null::uuid as request_id,
        d.id as drop_id
      -- The drop is a slot since kolonie-platform#955; channel = 'drop' is what
      -- narrows this table back to the rows this branch used to have to itself.
      from account_slots d
      join mine on mine.agent_id = d.agent_id
      join agents a on a.id = d.agent_id
      left join tasks t on t.id = d.task_id
      -- attempts is deliberately not a condition here (kolonie-platform#570).
      -- It was right while the mailed link was the only door: a drop nobody
      -- could open was not something waiting on the operator. The console fills
      -- this by session rather than by token, so an exhausted counter now means
      -- the link is dead, not that this cannot be cleared -- and hiding the row
      -- would put the queue back to listing less than the operator can act on.
      where d.channel = 'drop'
        and d.filled_at is null
        and d.expires_at > now()
    )
    select * from questions
    union all
    select * from handovers
  `)

  const items = rows.map((row): WaitingItem => ({
    agentId: row.agent_id,
    agentName: row.agent_name,
    kind: row.kind as WaitingKind,
    ask: row.ask,
    about: row.about,
    since: row.since,
    /**
     * A question is answered on the page the operator already holds. A drop is
     * not linked at all — see `WaitingItemSchema.answerAt` for why the Colony
     * cannot produce that link and should not learn to.
     */
    answerAt: row.answer_at === null ? null : `/operator/page/${row.answer_at}`,
    /**
     * Which thread this row is, so the console can link to its anchor
     * (`#587`, `#593`).
     *
     * **An id and not a link**, exactly as `dropId` beside it is: it authorises
     * nothing, and the console's own session is what proves the reader may
     * answer. `null` on a drop, which is not a thread.
     */
    requestId: row.request_id,
    /**
     * The drop itself, so the console can offer the field beside the item
     * (`#570`). An id rather than a link, and it authorises nothing — the
     * console's own session does.
     */
    dropId: row.drop_id,
  }))

  // Ordered by `@kolonie-ai/core` rather than by `order by`, so the console, a
  // future API and every test sort it identically — the ordering is the feature.
  return inClearingOrder(items)
}
