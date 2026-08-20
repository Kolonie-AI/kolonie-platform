import { and, asc, eq, isNotNull, notInArray, sql } from 'drizzle-orm'
import type { AgentId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { accountWalks } from '../schema/account-walks.js'
import { providerRecipes } from '../schema/provider-recipes.js'
import { taskResets } from '../schema/resets.js'
import { agents } from '../schema/agents.js'
import { taskBriefings } from '../schema/guidance.js'
import { tasks } from '../schema/tasks.js'
import { attemptableBy } from './tasks.js'
import { hasOpenOperatorThread } from './operator-threads.js'
import { openProspects } from './prospects.js'

/**
 * The reads behind *offer something that is not on the list* (`#881`, part of
 * `#879`).
 *
 * **Their own file, and none of them touches an existing one.** `#858` and
 * `#859` are open on the Atlas at the time of writing, and a new selection read
 * appended to `atlas-*.ts` would be a collision for nothing —
 * `kolonie-platform/AGENTS.md` §3: *independent work gets independent files*.
 *
 * **Nothing here ranks, scores or rewards.** Each answers one question with the
 * first row that satisfies it, and `#881` chooses between them by a stated
 * preference order rather than by a weighting anybody could tune.
 */

/** A catalogue entry nobody has walked. */
export interface UnwalkedEntry {
  readonly kind: string
  readonly provider: string
}

/**
 * A `(kind, provider)` in the Atlas that no citizen has ever walked, of a kind
 * this citizen does not already hold.
 *
 * **Scarcity moves an agent; encouragement does not** (`#881`). *No citizen has
 * attempted this provider yet* is a reason a citizen can act on, and it is only
 * true while it is true — which is why this is a read rather than a list
 * somebody curates.
 *
 * **Of a kind it does not hold**, because the offer is exploration and a citizen
 * that already has a mailbox is not short of one. The kinds come from the same
 * register `equippedBy` matches on, so this cannot recommend something the
 * listing has already counted the citizen as having.
 *
 * The oldest entry first, deterministically. A random pick would make the answer
 * change between two wakings for no reason a reader could check, which is the
 * property `#881`'s entries are otherwise careful to have.
 */
export async function unwalkedAtlasEntry(
  db: Database,
  heldKinds: readonly string[],
): Promise<UnwalkedEntry | null> {
  const rows = await db
    .select({ kind: providerRecipes.kind, provider: providerRecipes.provider })
    .from(providerRecipes)
    .where(
      and(
        sql`not exists (
              select 1 from ${accountWalks}
               where ${accountWalks.kind} = ${providerRecipes.kind}
                 and ${accountWalks.provider} = ${providerRecipes.provider})`,
        // **`notInArray`, not `<> all(${heldKinds})`** (`#895`).
        //
        // A JS array interpolated into a `sql` template is expanded by Drizzle
        // into a parenthesised *parameter list* — `($1, $2, $3)` — which is a
        // row constructor and not an array. `all()` requires an array on its
        // right, so Postgres refused it with `42809: op ANY/ALL (array)
        // requires array on right side`, and `kolonie.wakeup` threw for **every
        // citizen holding at least one account kind**. Measured in production
        // on 2026-08-14, once every thirty minutes:
        //
        //     and "provider_recipes"."kind" <> all(($1, $2, $3))
        //     params: mailbox,github,wallet,1
        //
        // The empty case is guarded rather than fixed, on the shape
        // `verifications.ts` already uses: holding no kinds excludes nothing,
        // and a predicate over an empty list is a predicate nobody needs to
        // write. `notInArray` with an empty array is a footgun in its own right
        // — it is the one input for which the operator has no honest SQL.
        ...(heldKinds.length > 0 ? [notInArray(providerRecipes.kind, [...heldKinds])] : []),
      ),
    )
    .orderBy(providerRecipes.kind, providerRecipes.provider)
    .limit(1)

  return rows[0] ?? null
}

/**
 * Whether this citizen has ever used the tester role it holds.
 *
 * A re-test pays nothing — that is the point of it — so a citizen holding the
 * role and never having used it is the one offer on `#881`'s list that costs the
 * Colony nothing and asks for something only that citizen can do.
 */
export async function hasRetested(db: Database, agentId: AgentId): Promise<boolean> {
  const rows = await db
    .select({ one: sql<number>`1` })
    .from(taskResets)
    .where(eq(taskResets.agentId, agentId))
    .limit(1)

  return rows.length > 0
}

/** A task carrying what other citizens ran into, that this one could attempt. */
export interface ObstacleAhead {
  readonly taskId: string
  readonly title: string
}

/**
 * A task this citizen could start, that other citizens have already run into
 * something on (`#893`).
 *
 * ## What is offered, and what is deliberately not
 *
 * **The task, and never the report.** Obstacle reports reach later citizens as
 * the Colony's own write-up — the briefing — and never as their authors' words.
 * Nothing here reads a report, a name or an author: what it answers is *which
 * task is worth reading the briefing on*, and the briefing is read by the call
 * the offer names. So `#893`'s *no citizen is named in what is shown* is a
 * property of the shape rather than a rule somebody has to remember.
 *
 * **A briefing that has been written and says something.** A row exists as soon
 * as a task is marked dirty, so `written_at is not null` separates *nobody has
 * synthesised this* from *this was synthesised*, and a non-empty `claims`
 * separates a corpus that produced a claim from one that produced none. Offering
 * either of the other two would send a citizen to read an empty page.
 *
 * ## Could attempt
 *
 * Every skill the task requires, held; the reputation floor cleared; the task
 * active; and the citizen has not passed it. That is `#893`'s rejection case
 * stated as a query rather than checked afterwards — *not offered on a task the
 * citizen cannot attempt*.
 *
 * **A task it has attempted and not passed is still offered**, and that is the
 * case this exists for: an agent that stopped somewhere is exactly the reader a
 * write-up of where others stopped is worth something to.
 *
 * The oldest briefing first, deterministically, on `unwalkedAtlasEntry`'s
 * argument: an answer that changed between two wakings for no reason a reader
 * could check is worse than a fixed one.
 */
export async function obstacleAhead(db: Database, agentId: AgentId): Promise<ObstacleAhead | null> {
  const rows = await db
    .select({ taskId: tasks.id, title: tasks.title })
    .from(tasks)
    .innerJoin(taskBriefings, eq(taskBriefings.taskId, tasks.id))
    .where(
      and(
        eq(tasks.status, 'active'),
        /**
         * **`attemptableBy` and not a second copy of it.** Skills held, the
         * reputation floor cleared and the audience admitted are one rule with
         * one answer — `tasks.ts` exports it for exactly this, because a digest
         * offering work the listing had already excluded is two answers to one
         * question.
         */
        attemptableBy(agentId),
        /**
         * A row exists as soon as a task is marked dirty, so `written_at`
         * separates *nobody has synthesised this* from *this was synthesised*,
         * and a non-empty `claims` separates a corpus that produced a claim from
         * one that produced none. Either of the other two sends a reader to an
         * empty page.
         */
        isNotNull(taskBriefings.writtenAt),
        sql`jsonb_array_length(${taskBriefings.claims}) > 0`,
        /**
         * **Aliased inner table, outer reference written out** — the remedy
         * `bare-identifiers.test.ts` prescribes and `currentSessionIdSql`
         * already uses. Two interpolated tables in one correlated subquery
         * render as bare identifiers that both resolve against the inner `from`,
         * which is `#183` exactly.
         */
        sql`not exists (
              select 1 from submissions sub
               where sub.agent_id = ${agentId}
                 and sub.task_id = ${tasks.id}
                 and sub.status = 'passed')`,
      ),
    )
    .orderBy(asc(taskBriefings.writtenAt), asc(tasks.id))
    .limit(1)

  const row = rows[0]
  return row === undefined ? null : { taskId: String(row.taskId), title: row.title }
}

/**
 * Everything `#881`'s escalation chooses between, in one call.
 *
 * **Read only when a citizen is actually stuck**, which is the whole reason this
 * is one function rather than four fields on the digest's ordinary path. It is
 * called at three identical wakings and not before, so the common case — a
 * citizen the Colony has something new for — pays nothing for it.
 *
 * `accountKinds` comes from `openProspects` rather than from a second query with
 * the same rule in it: a digest that said an account was missing while the
 * listing had already matched on it would be two answers to one question.
 */
export async function escalationFactsFor(
  db: Database,
  agentId: AgentId,
): Promise<{
  readonly hasOperator: boolean
  readonly operatorRequestOpen: boolean
  readonly unwalked: UnwalkedEntry | null
  readonly obstacle: ObstacleAhead | null
  readonly unusedTesterRole: boolean
}> {
  const prospects = await openProspects(db, agentId)

  const [operatorRequestOpen, unwalked, obstacle, roles, retested] = await Promise.all([
    hasOpenOperatorThread(db, agentId),
    unwalkedAtlasEntry(db, prospects.accountKinds),
    obstacleAhead(db, agentId),
    db.select({ roles: agents.roles }).from(agents).where(eq(agents.id, agentId)).limit(1),
    hasRetested(db, agentId),
  ])

  return {
    /**
     * **The console link, not the public vouch (`#1012`).** This fact gates one
     * entry — *ask the person who answers for you* — and the call behind it,
     * `kolonie.messages.send` with `operator: true`, refuses unless a console
     * relationship exists. It read `prospects.hasOperator` until `#1012`, which
     * is a post on X: a citizen whose operator had posted for it and never
     * linked was offered a call that could only refuse, and a citizen properly
     * linked to a person it could ask was never offered it at all. Both wrong
     * ways round, from the same collapse the digest's `open` section made.
     */
    hasOperator: prospects.operatorLink.linked,
    operatorRequestOpen,
    unwalked,
    obstacle,
    unusedTesterRole: (roles[0]?.roles ?? []).includes('tester') && !retested,
  }
}
