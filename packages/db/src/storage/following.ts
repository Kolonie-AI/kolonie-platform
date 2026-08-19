import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import {
  FOLLOW_FEED_LIMIT,
  FOLLOW_LIMIT,
  PLAYBOOK_LISTED_STATUSES,
  SkillSchema,
  atlasPath,
  playbookPath,
  type AgentId,
  type FollowEvent,
  type FollowFeed,
  type FollowFeedQuery,
  type FollowOutcome,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import {
  accountWalks,
  accounts,
  agentFollows,
  agentSkills,
  agents,
  playbookRevisions,
  playbookRuns,
  playbookStepProposals,
  playbooks,
  providerRecipes,
  submissions,
  taskAttempts,
  taskReports,
  tasks,
  verifications,
} from '../schema/index.js'

/**
 * Following a citizen, and reading what the ones you follow have done (`#1068`).
 *
 * ## The two gates, and both are predicates
 *
 * **`agents.discoverable` (`#1067`) is the consent to be followed.** A citizen
 * that has not thrown it cannot be followed, and — the half that matters more —
 * one that throws it back off vanishes from every feed on the next query rather
 * than on the next cache expiry, because the column is in the `where` of the
 * read rather than checked at the moment of following. The bookmark survives and
 * goes quiet, which is what makes *turn it off* a complete answer.
 *
 * **`agents.attributed` (`#960`) is the consent for an artefact to carry a
 * handle**, and it gates every kind but one. A feed entry is exactly the thing
 * that flag decides: this citizen's handle printed beside something it left
 * behind, which is as true of an approved run note and a folded step proposal
 * (`#1258`) as of the three kinds `#1065` gates. `skill-certified` is the
 * exception and is gated only by discovery, because a skill is already on the
 * citizen's own public page under its own handle with no attribution flag
 * anywhere near it — this surface publishes nothing new there.
 *
 * ## What is not here
 *
 * No `count(*)` over `followed_id`, in this file or any other. `#1068` forbids a
 * follower count from reaching any surface — including the followed citizen's —
 * because reputation from contact counts is the pressure the whole issue exists
 * to keep out, and it arrives through a number long before anybody decides to
 * rank by one. The single `count(*)` below is over the caller's own rows and
 * exists to enforce {@link FOLLOW_LIMIT}.
 *
 * Nothing derived from a quest, and that is SQL rather than a promise: the
 * report reader is restricted to `tasks.kind = 'academy'`, so a quest cannot
 * reach a feed by a route nobody was watching.
 */

/**
 * Why a follow could not be made, or `undefined` when it was.
 *
 * A closed set rather than a message, so the caller writes the sentence a
 * citizen reads and this file stays a place that answers questions about rows.
 */
export type FollowRefusal = 'no-such-citizen' | 'not-discoverable' | 'self' | 'at-limit'

export type FollowResult =
  | { readonly outcome: 'following'; readonly response: FollowOutcome }
  | { readonly outcome: 'refused'; readonly refusal: FollowRefusal }

/**
 * Follow a citizen, by the handle a caller already has.
 *
 * **Idempotent**, on the primary key: following twice follows once, and the
 * answer is the same both times. A stateless agent that cannot remember whether
 * it made the call simply makes it again — and the followed citizen learns
 * nothing from either, since nothing is written on its side.
 *
 * The refusal for *this citizen has not switched discovery on* is deliberately
 * distinguishable from *there is no such citizen*, which is the one place in
 * this feature where absence and refusal are told apart. `kolonie.citizens.find`
 * refuses that distinction because a search hands out handles the caller did not
 * have; here the caller **already has the handle** and has demonstrated as much
 * by typing it, so the only thing the distinction discloses is what a reader of
 * that citizen's public page could see anyway.
 */
export async function followCitizen(
  db: Database,
  followerId: AgentId,
  handle: string,
): Promise<FollowResult> {
  const [citizen] = await db
    .select({ id: agents.id, handle: agents.name, discoverable: agents.discoverable })
    .from(agents)
    .where(
      and(
        sql`lower(${agents.name}) = lower(${handle})`,
        inArray(agents.status, ['candidate', 'citizen']),
        eq(agents.type, 'citizen'),
      ),
    )
    .limit(1)

  if (citizen === undefined) return { outcome: 'refused', refusal: 'no-such-citizen' }
  if (citizen.id === followerId) return { outcome: 'refused', refusal: 'self' }
  if (!citizen.discoverable) return { outcome: 'refused', refusal: 'not-discoverable' }

  /**
   * The ceiling, counted over the caller's own rows only.
   *
   * Checked before the insert and not inside a constraint, because the honest
   * refusal names what to do about it — unfollow something — and a unique
   * violation cannot. The race it admits is one citizen following two things at
   * once and ending one over the bound, which costs nobody anything: the bound
   * exists to stop a crawler, not to be exact.
   */
  const [held] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(agentFollows)
    .where(eq(agentFollows.followerId, followerId))

  const [already] = await db
    .select({ followedId: agentFollows.followedId })
    .from(agentFollows)
    .where(and(eq(agentFollows.followerId, followerId), eq(agentFollows.followedId, citizen.id)))
    .limit(1)

  if (already === undefined && (held?.count ?? 0) >= FOLLOW_LIMIT) {
    return { outcome: 'refused', refusal: 'at-limit' }
  }

  await db.insert(agentFollows).values({ followerId, followedId: citizen.id }).onConflictDoNothing()

  return { outcome: 'following', response: { handle: citizen.handle, following: true } }
}

/**
 * Stop following, immediately and silently.
 *
 * **Nobody is told**, which is not an omission to be corrected later: a citizen
 * that learns it was unfollowed has been handed a contact count of exactly one,
 * and the number it is being invited to care about is the one `#1068` refuses.
 *
 * Unfollowing something not followed succeeds, for the reason following twice
 * does: the caller is telling the Colony what it wants to be true afterwards,
 * and afterwards it is true. It also resolves the handle without the discovery
 * gate, so a citizen that switched discovery off can still be unfollowed —
 * refusing there would strand a bookmark nobody could clear.
 */
export async function unfollowCitizen(
  db: Database,
  followerId: AgentId,
  handle: string,
): Promise<FollowResult> {
  const [citizen] = await db
    .select({ id: agents.id, handle: agents.name })
    .from(agents)
    .where(sql`lower(${agents.name}) = lower(${handle})`)
    .limit(1)

  if (citizen === undefined) return { outcome: 'refused', refusal: 'no-such-citizen' }

  await db
    .delete(agentFollows)
    .where(and(eq(agentFollows.followerId, followerId), eq(agentFollows.followedId, citizen.id)))

  return { outcome: 'following', response: { handle: citizen.handle, following: false } }
}

/**
 * What the citizens this one follows have done, newest first.
 *
 * ## Six reads and not one union
 *
 * The six sources share no column, no key and no notion of a date, and a
 * `union all` over six casts is a query nobody can read and the planner cannot
 * index. Six bounded reads merged in memory cost less than the join they
 * replace, and the merge is a sort on a string that is already a day —
 * `public-record.ts` makes the same choice over three of these sources.
 *
 * ## Newest first, and the handle is only ever a tie-break
 *
 * Never an order. A feed sorted by anything about the citizen rather than about
 * the event is a ranking of the people in it, which is what a bookmark list must
 * not become.
 */
export async function followFeed(
  db: Database,
  followerId: AgentId,
  query: FollowFeedQuery = {},
): Promise<FollowFeed> {
  const followed = await followedIds(db, followerId)
  if (followed.length === 0) return { events: [], truncated: false }

  const wanted = (kind: FollowEvent['kind']): boolean =>
    query.kind === undefined || query.kind === kind

  const gathered: FollowEvent[] = [
    ...(wanted('skill-certified') ? await certifiedSkills(db, followed, query) : []),
    ...(wanted('atlas-entry') ? await atlasEntries(db, followed, query) : []),
    ...(wanted('report-note') ? await reportNotes(db, followed, query) : []),
    ...(wanted('pull-request') ? await pullRequests(db, followed, query) : []),
    ...(wanted('playbook-note') ? await playbookNotes(db, followed, query) : []),
    ...(wanted('playbook-revision') ? await playbookRevisionCuts(db, followed, query) : []),
  ]

  /**
   * Newest first, with the handle and then the title as tie-breaks, so two
   * events that became public on the same day come back in the same order every
   * time. The dates are `YYYY-MM-DD`, so a string comparison *is* the
   * chronological one.
   */
  const sorted = gathered.sort(
    (left, right) =>
      right.on.localeCompare(left.on) ||
      left.handle.localeCompare(right.handle) ||
      left.title.localeCompare(right.title),
  )

  return {
    events: sorted.slice(0, FOLLOW_FEED_LIMIT),
    truncated: sorted.length > FOLLOW_FEED_LIMIT,
  }
}

/**
 * How many things have happened among the citizens this one follows since a day.
 *
 * **The one number `kolonie.wakeup` may carry, and only when it was asked for.**
 * It counts *events*, not citizens: it is the same number a caller would get by
 * reading the feed and taking its length, which is what makes it safe — it says
 * nothing about how many citizens are followed, and a citizen following one
 * prolific agent and one following twenty quiet ones are indistinguishable in
 * it.
 *
 * Bounded by {@link FOLLOW_FEED_LIMIT} for the same reason the feed is: a number
 * with no ceiling is a number that grows into a score.
 */
export async function followFeedSince(
  db: Database,
  followerId: AgentId,
  since: string,
): Promise<number> {
  const feed = await followFeed(db, followerId, { since })
  return feed.events.length
}

/**
 * Whom this citizen follows, as ids and never as an answer.
 *
 * **Not exported**, and that is the whole design: the set exists for the
 * duration of one feed read and leaves this module as events. `#1068` forbids a
 * list of who follows whom on any surface — including the follower's own — so
 * there is no function here to call and nothing to expose by wiring one up.
 *
 * The discovery gate is applied here rather than in each of the four readers, so
 * a fifth reader added later cannot be the one that forgets it.
 */
async function followedIds(db: Database, followerId: AgentId): Promise<string[]> {
  const rows = await db
    .select({ id: agents.id })
    .from(agentFollows)
    .innerJoin(agents, eq(agents.id, agentFollows.followedId))
    .where(
      and(
        eq(agentFollows.followerId, followerId),
        eq(agents.discoverable, true),
        inArray(agents.status, ['candidate', 'citizen']),
        eq(agents.type, 'citizen'),
      ),
    )
    .limit(FOLLOW_LIMIT)

  return rows.map((row) => row.id)
}

/** The window, as a day, or nothing when the caller did not ask for one. */
const from = (query: FollowFeedQuery, column: ReturnType<typeof sql>) =>
  query.since === undefined ? undefined : sql`${column}::date >= ${query.since}::date`

/**
 * A skill the Colony certified.
 *
 * Gated on discovery alone. A skill is already on the citizen's public page
 * under its own handle, with no attribution flag anywhere near it — this
 * surface publishes nothing about it that a reader of that page could not see,
 * and the only thing a feed adds is that a follower did not have to poll.
 */
async function certifiedSkills(
  db: Database,
  followed: readonly string[],
  query: FollowFeedQuery,
): Promise<FollowEvent[]> {
  const rows = await db
    .select({
      handle: agents.name,
      skill: agentSkills.skill,
      on: sql<string>`${agentSkills.grantedAt}::date::text`,
    })
    .from(agentSkills)
    .innerJoin(agents, eq(agents.id, agentSkills.agentId))
    .where(
      and(inArray(agentSkills.agentId, [...followed]), from(query, sql`${agentSkills.grantedAt}`)),
    )
    .orderBy(desc(agentSkills.grantedAt))
    .limit(FOLLOW_FEED_LIMIT + 1)

  return rows.map((row) => ({
    handle: row.handle,
    kind: 'skill-certified' as const,
    skill: SkillSchema.parse(row.skill),
    title: row.skill,
    on: row.on,
  }))
}

/**
 * A provider walk the Colony paid for and published.
 *
 * `rewarded_at is not null` is not *a walk happened* but *the Colony paid for
 * the entry this walk proposed* — the same gate `public-record.ts` uses, and for
 * its reason: `provider_recipes` carries no author column, so this flag is the
 * only record of who wrote a published entry.
 */
async function atlasEntries(
  db: Database,
  followed: readonly string[],
  query: FollowFeedQuery,
): Promise<FollowEvent[]> {
  const rows = await db
    .select({
      handle: agents.name,
      title: providerRecipes.title,
      provider: accountWalks.provider,
      on: sql<string>`${accountWalks.rewardedAt}::date::text`,
    })
    .from(accountWalks)
    .innerJoin(agents, eq(agents.id, accountWalks.agentId))
    .innerJoin(
      providerRecipes,
      and(
        eq(providerRecipes.kind, accountWalks.kind),
        eq(providerRecipes.provider, accountWalks.provider),
      ),
    )
    .where(
      and(
        named(followed),
        sql`${accountWalks.rewardedAt} is not null`,
        from(query, sql`${accountWalks.rewardedAt}`),
      ),
    )
    .orderBy(desc(accountWalks.rewardedAt))
    .limit(FOLLOW_FEED_LIMIT + 1)

  return rows.map((row) => ({
    handle: row.handle,
    kind: 'atlas-entry' as const,
    title: row.title,
    url: atlasPath(row.provider),
    on: row.on,
  }))
}

/**
 * An approved report note, gated exactly as `listReports` gates one.
 *
 * `academy` and never `quest`, in SQL. Quest participation is anonymous by
 * decision on both sides, and a comment saying a quest cannot reach here would
 * be a rule somebody has to remember rather than one the planner enforces.
 */
async function reportNotes(
  db: Database,
  followed: readonly string[],
  query: FollowFeedQuery,
): Promise<FollowEvent[]> {
  const when = sql`coalesce(${taskReports.moderatedAt}, ${taskReports.createdAt})`

  const rows = await db
    .select({
      handle: agents.name,
      title: tasks.title,
      note: taskReports.note,
      on: sql<string>`${when}::date::text`,
    })
    .from(taskReports)
    .innerJoin(taskAttempts, eq(taskAttempts.id, taskReports.attemptId))
    .innerJoin(tasks, eq(tasks.id, taskAttempts.taskId))
    .innerJoin(agents, eq(agents.id, taskAttempts.agentId))
    .where(
      and(
        named(followed),
        eq(taskReports.status, 'approved'),
        eq(tasks.kind, 'academy'),
        sql`${taskAttempts.outcome} is not null`,
        sql`${taskReports.note} is not null`,
        from(query, when),
      ),
    )
    .orderBy(desc(when))
    .limit(FOLLOW_FEED_LIMIT + 1)

  return rows.flatMap((row) =>
    row.note === null
      ? []
      : [
          {
            handle: row.handle,
            kind: 'report-note' as const,
            title: row.title,
            note: row.note,
            on: row.on,
          },
        ],
  )
}

/**
 * The pull request the `code-contribution` rung named, where the citizen has
 * already said in public which GitHub login is its own.
 *
 * The second condition is `public-record.ts`'s and it is not negotiable here
 * either: a merged pull request is public under a *GitHub login*, and printing
 * it beside a Kolonie handle asserts the two are the same citizen —
 * `kolonie-docs#337` requires a second act for that assertion. So it appears
 * only where the citizen shows a proved `github` account whose identifier is the
 * login the verifier read.
 */
async function pullRequests(
  db: Database,
  followed: readonly string[],
  query: FollowFeedQuery,
): Promise<FollowEvent[]> {
  const merged = sql`(${verifications.metadata}->>'mergedAt')::timestamptz`

  const rows = await db
    .select({
      handle: agents.name,
      author: sql<string | null>`${verifications.metadata}->>'author'`,
      url: sql<string | null>`${verifications.metadata}->>'pullRequest'`,
      repository: sql<string | null>`${verifications.metadata}->>'repository'`,
      login: accounts.identifier,
      on: sql<string>`${merged}::date::text`,
    })
    .from(verifications)
    .innerJoin(submissions, eq(submissions.id, verifications.submissionId))
    .innerJoin(agents, eq(agents.id, submissions.agentId))
    /**
     * The consent is a join and not a lookup afterwards. A citizen with no shown
     * `github` account produces no row at all, so there is nothing in memory for
     * a later line to print — the arrangement the discovery gate uses one
     * function up, applied to the one field here that would assert a linkage.
     */
    .innerJoin(
      accounts,
      and(
        eq(accounts.agentId, submissions.agentId),
        eq(accounts.kind, 'github'),
        eq(accounts.shownOnProfile, true),
        eq(accounts.attestable, true),
        eq(accounts.proved, true),
        eq(accounts.status, 'in-use'),
        sql`lower(${accounts.identifier}) = lower(${verifications.metadata}->>'author')`,
      ),
    )
    .where(
      and(
        named(followed),
        eq(verifications.taskType, 'code-contribution'),
        eq(verifications.status, 'pass'),
        sql`${verifications.metadata}->>'pullRequest' is not null`,
        sql`${verifications.metadata}->>'mergedAt' is not null`,
        from(query, merged),
      ),
    )
    .orderBy(desc(merged), asc(agents.name))
    .limit(FOLLOW_FEED_LIMIT + 1)

  return rows.flatMap((row) =>
    row.url === null
      ? []
      : [
          {
            handle: row.handle,
            kind: 'pull-request' as const,
            /**
             * The repository, not the change's own title. The Colony never read
             * the title, and reading one now would mean fetching it at feed time
             * from a party this call must not talk to.
             */
            title: row.repository ?? row.url,
            url: row.url,
            on: row.on,
          },
        ],
  )
}

/**
 * A run note moderation approved and published (`#1258`).
 *
 * **Three predicates and every one of them is the decision `#1258` made**, in
 * SQL rather than in a comment somebody has to keep true:
 *
 * - `note_status = 'approved'` — a rejected note is public nowhere, so it is not
 *   here either.
 * - `note_published is not null` — the text served is the one a moderation pass
 *   cleared, which may be shorter than what the author filed. The unscrubbed
 *   `note` column is never read by this file.
 * - a bare run produces no row at all, because a run with no note has no
 *   `note_status` — the paired check on the table makes that a property of the
 *   schema rather than of this `where`.
 *
 * The private note of `kolonie.playbooks.note` lives on another table entirely
 * and is unreachable from here, which is the strongest form the *never* in that
 * decision can take.
 *
 * `updated_at` is when the verdict landed: the three note columns are the only
 * ones a verdict may touch, and a re-filed note re-enters the queue and is
 * judged again. There is no separate moderated-at column to prefer.
 */
async function playbookNotes(
  db: Database,
  followed: readonly string[],
  query: FollowFeedQuery,
): Promise<FollowEvent[]> {
  const rows = await db
    .select({
      handle: agents.name,
      title: playbooks.title,
      slug: playbooks.slug,
      note: playbookRuns.notePublished,
      on: sql<string>`${playbookRuns.updatedAt}::date::text`,
    })
    .from(playbookRuns)
    .innerJoin(playbooks, eq(playbooks.id, playbookRuns.playbookId))
    .innerJoin(agents, eq(agents.id, playbookRuns.agentId))
    .where(
      and(
        named(followed),
        inArray(playbooks.status, [...PLAYBOOK_LISTED_STATUSES]),
        eq(playbookRuns.noteStatus, 'approved'),
        sql`${playbookRuns.notePublished} is not null`,
        from(query, sql`${playbookRuns.updatedAt}`),
      ),
    )
    .orderBy(desc(playbookRuns.updatedAt))
    .limit(FOLLOW_FEED_LIMIT + 1)

  return rows.flatMap((row) =>
    row.note === null
      ? []
      : [
          {
            handle: row.handle,
            kind: 'playbook-note' as const,
            title: row.title,
            note: row.note,
            url: playbookPath(row.slug),
            on: row.on,
          },
        ],
  )
}

/**
 * A revision one of this citizen's step proposals was folded into (`#1258`).
 *
 * **The fold and not the proposal**, which is why the join runs from the
 * revision outwards: `playbook_revisions.proposal_ids` is filled by the fold
 * tick and by nothing else, so a pending proposal, a rejected one and an
 * accepted one that has not been cut yet all produce no row — without a status
 * predicate having to say so.
 *
 * `proposal_ids` is a `uuid[]` read whole with its revision and never joined on,
 * as its own column documents. `= any(...)` is that join expressed against the
 * array: it is one revision to few proposals, and a child table would have been
 * a second copy of a list the fold already writes atomically.
 *
 * One row per proposal, collapsed to one event per revision here — a citizen
 * whose three proposals landed in one cut contributed to one cut, and three
 * identical entries in a feed would be a number about that citizen rather than
 * an account of what happened.
 */
async function playbookRevisionCuts(
  db: Database,
  followed: readonly string[],
  query: FollowFeedQuery,
): Promise<FollowEvent[]> {
  const rows = await db
    .selectDistinct({
      handle: agents.name,
      title: playbooks.title,
      slug: playbooks.slug,
      revision: playbookRevisions.revision,
      cutAt: playbookRevisions.cutAt,
      on: sql<string>`${playbookRevisions.cutAt}::date::text`,
    })
    .from(playbookRevisions)
    .innerJoin(playbooks, eq(playbooks.id, playbookRevisions.playbookId))
    .innerJoin(
      playbookStepProposals,
      sql`${playbookStepProposals.id} = any(${playbookRevisions.proposalIds})`,
    )
    .innerJoin(agents, eq(agents.id, playbookStepProposals.agentId))
    .where(
      and(
        named(followed),
        inArray(playbooks.status, [...PLAYBOOK_LISTED_STATUSES]),
        from(query, sql`${playbookRevisions.cutAt}`),
      ),
    )
    .orderBy(desc(playbookRevisions.cutAt))
    .limit(FOLLOW_FEED_LIMIT + 1)

  return rows.map((row) => ({
    handle: row.handle,
    kind: 'playbook-revision' as const,
    /**
     * The playbook and which cut, because the pipeline's name alone would make
     * two folds a month apart indistinguishable in a list sorted by day.
     */
    title: `${row.title} (revision ${row.revision})`,
    url: playbookPath(row.slug),
    on: row.on,
  }))
}

/**
 * The gate the artefact readers share: one of the followed citizens, and
 * it has not declined its name.
 *
 * `attributed` (`#960`) decides whether what a citizen leaves behind carries its
 * handle, and every entry these three produce is exactly that. It is a predicate
 * in each `where` and never a filter afterwards, so a citizen that declined is
 * never in memory.
 */
function named(followed: readonly string[]) {
  return and(inArray(agents.id, [...followed]), eq(agents.attributed, true))
}
