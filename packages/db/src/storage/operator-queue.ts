import { sql } from 'drizzle-orm'
import { inClearingOrder, type HumanId, type WaitingItem, type WaitingKind } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { expireStaleShares } from './browser-shares.js'
import { toTimestamp } from './rows.js'

/**
 * Everything waiting on one person, across every agent they operate (#530).
 *
 * ## One query over three tables, and why it is raw SQL
 *
 * The three channels are deliberately different shapes — a request is a
 * conversation whose first message is the ask, a drop is a single field with a
 * prompt above it, a share is a live socket behind a deadline — and the queue is
 * the one place they have to look the same. A `union all` states that in one
 * place; three queries and a merge in TypeScript would put the *is this still
 * waiting* rule in three dialects, and that rule is the whole correctness of the
 * page.
 *
 * ## What counts as waiting
 *
 * **A request with no operator message yet.** An exchange the person has already
 * replied to is not waiting on them, even though it is still open — the citizen
 * may still be reading it, and a queue that showed answered exchanges would be a
 * queue that never empties.
 *
 * **A drop that is unfilled, unexpired and has attempts left.** Exactly
 * `viewDrop`'s three conditions, because an item this page offers and that page
 * refuses is worse than an item not shown.
 *
 * **A share that is open and unaccepted** (`#738`). Unaccepted because a share
 * somebody is already on is not something to offer a second window onto — and
 * *not* filtered on its deadline, which is the one place this query knowingly
 * departs from the rule above. `#738` asks that a lapsed offer be *"visibly
 * expired in the list rather than on the click"*, so the sweep runs **after** the
 * select rather than before it: a share that ran out while the page was being
 * loaded is rendered once, plainly expired, and is gone on the next load. An
 * offer that silently vanished would leave the operator wondering whether they
 * had imagined it.
 *
 * ## Nothing here writes, and nothing here is a command
 *
 * `#512` refuses a control panel and `#530` inherits the refusal. This reads —
 * with the one exception of the expiry sweep, which writes nothing a person
 * chose and only records a deadline that had already passed.
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
  readonly share_id: string | null
  readonly expires_at: string | null
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
        r.agent_id,
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
           from operator_request_messages m
          where m.request_id = r.id
          order by m.written_at asc
          limit 1) as ask,
        coalesce(t.title, w.provider) as about,
        r.opened_at as since,
        p.token as answer_at,
        r.id as request_id,
        null::uuid as drop_id,
        null::uuid as share_id,
        null::timestamptz as expires_at
      from operator_requests r
      join mine on mine.agent_id = r.agent_id
      join agents a on a.id = r.agent_id
      left join tasks t on t.id = r.task_id
      left join account_wishes w on w.id = r.wish_id
      left join operator_pages p
        on p.agent_id = r.agent_id and p.revoked_at is null
      where r.closed_at is null
        and not exists (
          select 1 from operator_request_messages m
           where m.request_id = r.id and m.author = 'operator'
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
        d.id as drop_id,
        null::uuid as share_id,
        null::timestamptz as expires_at
      from operator_drops d
      join mine on mine.agent_id = d.agent_id
      join agents a on a.id = d.agent_id
      left join tasks t on t.id = d.task_id
      -- attempts is deliberately not a condition here (kolonie-platform#570).
      -- It was right while the mailed link was the only door: a drop nobody
      -- could open was not something waiting on the operator. The console fills
      -- this by session rather than by token, so an exhausted counter now means
      -- the link is dead, not that this cannot be cleared -- and hiding the row
      -- would put the queue back to listing less than the operator can act on.
      where d.submitted_at is null
        and d.expires_at > now()
    ),
    sessions as (
      select
        s.agent_id,
        a.name as agent_name,
        'browser-share' as kind,
        -- The agent's own sentence, which is the only wording in this queue an
        -- agent writes (#737). A recipe handoff has the recipe's words
        -- precisely so an agent cannot talk its operator into doing the whole
        -- job; there is no recipe wording for *solve whatever is in front of
        -- me*, because what is in front of it is a thing only it can see.
        s.purpose as ask,
        -- Where it is, assembled rather than joined: a share names a provider
        -- and a recipe step directly and belongs to no task, so there is no
        -- title to coalesce to as the two branches above do.
        nullif(
          concat_ws(
            ', ',
            s.provider,
            case when s.step is null then null else 'step ' || s.step end
          ),
          ''
        ) as about,
        s.offered_at as since,
        null::text as answer_at,
        null::uuid as request_id,
        null::uuid as drop_id,
        s.id as share_id,
        s.expires_at
      from browser_shares s
      join mine on mine.agent_id = s.agent_id
      join agents a on a.id = s.agent_id
      -- No deadline condition, deliberately -- see the note above the function.
      where s.closed_at is null
        and s.accepted_at is null
    )
    select * from questions
    union all
    select * from handovers
    union all
    select * from sessions
  `)

  /**
   * The sweep, **after** the read (`#738`).
   *
   * Everywhere else it runs first, because everywhere else the question is *is
   * this still open* and a lapsed share must answer no. Here the question is
   * what to show a person, and the honest answer for an offer that ran out four
   * minutes ago is to show it as expired once. Closing it now is what makes that
   * once.
   */
  await expireStaleShares(db)

  const items = rows.map((row): WaitingItem => ({
    agentId: row.agent_id,
    agentName: row.agent_name,
    kind: row.kind as WaitingKind,
    ask: row.ask,
    about: row.about,
    since: row.since,
    /**
     * A request is answered on the page the operator already holds. A drop is
     * not linked at all — see `WaitingItemSchema.answerAt` for why the Colony
     * cannot produce that link and should not learn to.
     */
    answerAt: row.answer_at === null ? null : `/operator/page/${row.answer_at}`,
    /**
     * Which exchange this row is, so the console can link to its anchor
     * (`#587`, `#593`).
     *
     * **An id and not a link**, exactly as `dropId` beside it is: it authorises
     * nothing, and the console's own session is what proves the reader may
     * answer. `null` on a drop, which is not an exchange.
     */
    requestId: row.request_id,
    /**
     * The drop itself, so the console can offer the field beside the item
     * (`#570`). An id rather than a link, and it authorises nothing — the
     * console's own session does.
     */
    dropId: row.drop_id,
    /**
     * The share, and its deadline (`#738`). Both null on the other two kinds.
     *
     * An id rather than a link, for the same reason `dropId` is: the console's
     * own session is what proves the reader may open it, and `acceptShare`
     * checks the link again at the socket.
     */
    shareId: row.share_id,
    expiresAt: row.expires_at === null ? null : toTimestamp(row.expires_at),
  }))

  // Ordered by `@kolonie-ai/core` rather than by `order by`, so the console, a
  // future API and every test sort it identically — the ordering is the feature.
  return inClearingOrder(items)
}
