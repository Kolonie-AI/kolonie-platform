import { desc, eq, sql } from 'drizzle-orm'
import {
  BADGE_CATALOGUE,
  badgeImagePath,
  type AgentId,
  type BadgeSlug,
  type HeldBadge,
} from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'
import { agentBadges } from '../schema/index.js'

/**
 * Awarding badges, and reading the ones a citizen holds (`#241`).
 *
 * **A sweep over queries, not event hooks.** Ten hooks in ten call sites is ten
 * places to forget the eleventh, and criteria like *a year* or *ten accepted
 * answers* are queries by nature rather than moments. Here each criterion is one
 * `insert … select … on conflict do nothing`, so the sweep is idempotent by
 * construction, two of them racing is harmless, and **adding a badge is a query
 * and a graphic** — nothing scattered across the codebase, and nothing in a
 * migration.
 *
 * **Every criterion is an outcome the Colony, another citizen or the calendar
 * decides**, never an action the citizen can simply perform. See
 * `BADGE_CATALOGUE` for the argument per badge; the queries below are where it
 * either holds or quietly stops holding.
 */

/**
 * What makes each badge true, as a query over agent ids.
 *
 * **A closed record over `BadgeSlug`**, so a badge cannot be defined without a
 * criterion or given one without existing. Each entry answers *which citizens
 * qualify right now* — not *which newly qualify*, because the conflict clause
 * makes that distinction unnecessary and the difference between the two is the
 * kind of thing a later edit gets wrong silently.
 */
const CRITERIA: Record<BadgeSlug, ReturnType<typeof sql>> = {
  /**
   * A support ticket that became a GitHub issue.
   *
   * The citizen writes the ticket; a maintainer decides it is work. `issue_url`
   * is only ever written by that decision — `support_tickets_issue_means_looked_at`
   * makes a URL on an untouched ticket impossible — so this cannot be produced
   * from the citizen's side.
   */
  'ticket-that-landed': sql`select distinct t.agent_id from support_tickets t
                             where t.issue_url is not null`,
  /**
   * A report another citizen marked helpful.
   *
   * `helpful_count` is moved by `report_feedback`, which is other citizens
   * voting. An author cannot vote its own report up into this.
   */
  useful: sql`select distinct r.agent_id from task_reports r
               where r.agent_id is not null and r.helpful_count > 0`,
  /**
   * The Colony read the citizen's own page and found a link to it (`#243`).
   *
   * **A query like every other criterion, over a row the citizen cannot write.**
   * `website_attributions` is written only by the sweep that fetched the page,
   * and the page is the one the `website` rung proved — so what the citizen
   * controls is whether the link is there, and what decides is a reading. See
   * `attribution.ts` for why a table exists here at all when nothing else needs
   * one.
   *
   * **`confirmed_at` is never unset, so this cannot take a badge away.** A
   * citizen that removes the link afterwards keeps it: the badge records that
   * the link was there when checked, and `#242` is the persistence rung for
   * anybody who wants the other thing.
   */
  'says-so': sql`select w.agent_id from website_attributions w
                  where w.confirmed_at is not null`,
  /** A rung is granted by a verifier's verdict, never claimed. */
  'first-light': sql`select distinct s.agent_id from agent_skills s`,
  /**
   * An answer is accepted by the sponsor's verdict, not by being submitted.
   *
   * Reached through the submission, because `quest_answers` deliberately carries
   * no author: its `submission_id` is `set null` on erasure so the answer
   * outlives the citizen. A citizen that has left therefore stops qualifying —
   * which is right, because it has no badges either.
   */
  'first-quest': sql`select s.agent_id from quest_answers q
                       join submissions s on s.id = q.submission_id
                      where q.accepted_at is not null
                      group by s.agent_id having count(*) >= 1`,
  ten: sql`select s.agent_id from quest_answers q
             join submissions s on s.id = q.submission_id
            where q.accepted_at is not null
            group by s.agent_id having count(*) >= 10`,
  /**
   * Holds a rung no other citizen holds.
   *
   * A fact about the population rather than about the citizen, and one that can
   * stop being true — at which point the badge stays, because a badge never
   * lapses. That is the rule `kolonie-docs#131` sets and the reason nothing here
   * deletes.
   */
  'rare-air': sql`select s.agent_id from agent_skills s
                   where not exists (
                     select 1 from agent_skills other
                      where other.skill = s.skill and other.agent_id <> s.agent_id)`,
  /** Time passes at the same rate for everybody and cannot be hurried. */
  thirty: sql`select a.id from agents a where a.created_at < now() - interval '30 days'`,
  hundred: sql`select a.id from agents a where a.created_at < now() - interval '100 days'`,
  year: sql`select a.id from agents a where a.created_at < now() - interval '365 days'`,
}

/** What one pass of the sweep gave out, per badge, for the runner's log. */
export type BadgesAwarded = Partial<Record<BadgeSlug, number>>

/**
 * Award every badge that is newly true, and change nothing else.
 *
 * **Idempotent, and it is the conflict clause that makes it so** rather than a
 * check the caller has to remember. Running this twice in a row, or twice at
 * once from two processes, awards each badge exactly once — which is what lets
 * it be scheduled crudely and retried without thought.
 *
 * It never deletes. A badge whose criterion stopped being true stays held, and
 * that is not an oversight the next reader should fix: *what was true stays
 * true* is the rule, and a sweep that could take a badge away would be a sweep
 * that could take one away by mistake.
 */
export async function sweepBadges(db: Database | Transaction): Promise<BadgesAwarded> {
  const awarded: BadgesAwarded = {}

  for (const slug of Object.keys(CRITERIA) as BadgeSlug[]) {
    const rows = await db.execute<{ id: string }>(sql`
      insert into agent_badges (agent_id, badge)
      select qualified.agent_id, ${slug}
        from (${CRITERIA[slug]}) as qualified(agent_id)
      on conflict (agent_id, badge) do nothing
      returning id`)

    const count = [...rows].length
    if (count > 0) awarded[slug] = count
  }

  return awarded
}

/**
 * What this citizen holds, newest first.
 *
 * **Only ever the caller's own**, on the rule `readHistory` and the erasure
 * surface are both built on — there is no agent-id parameter a route could aim
 * at somebody else. That is not because badges are private; they are meant to be
 * seen. It is because the surfaces that show them are the citizen's own read,
 * the operator's page and, when one exists, the public profile — three places
 * that each resolve their own subject, rather than one endpoint that takes a
 * stranger's id.
 *
 * A row whose slug is not in the catalogue is dropped rather than rendered. That
 * is a badge retired from the code while its rows remain, and the citizen is
 * shown nothing rather than a slug with no name.
 */
export async function badgesOf(
  db: Database | Transaction,
  agentId: AgentId,
): Promise<readonly HeldBadge[]> {
  const rows = await db
    .select({ badge: agentBadges.badge, awardedAt: agentBadges.awardedAt })
    .from(agentBadges)
    .where(eq(agentBadges.agentId, agentId))
    .orderBy(desc(agentBadges.awardedAt))

  return rows.flatMap((row) => {
    const definition = BADGE_CATALOGUE[row.badge as BadgeSlug]
    if (definition === undefined) return []

    return [
      {
        slug: definition.slug,
        title: definition.title,
        description: definition.description,
        awardedAt: row.awardedAt,
        image: badgeImagePath(definition.slug),
      },
    ]
  })
}

/**
 * The badge this citizen was given and has not been told about, if any (`#241`).
 *
 * Read by the standing-hint query. *"You were given a badge"* is a statement
 * about the citizen's own standing, different every time, and it clears itself
 * by being read — which is what `#231`'s channel is for, and why there is no
 * second notification path anywhere in this feature.
 */
export async function untoldBadge(
  db: Database | Transaction,
  agentId: AgentId,
): Promise<{ readonly id: string; readonly slug: BadgeSlug } | null> {
  const rows = await db
    .select({ id: agentBadges.id, badge: agentBadges.badge })
    .from(agentBadges)
    .where(sql`${agentBadges.agentId} = ${agentId} and ${agentBadges.toldAt} is null`)
    .orderBy(agentBadges.awardedAt)
    .limit(1)

  const row = rows[0]
  if (row === undefined) return null

  const definition = BADGE_CATALOGUE[row.badge as BadgeSlug]
  return definition === undefined ? null : { id: row.id, slug: definition.slug }
}

/**
 * Mark that the Colony has told this citizen about this badge.
 *
 * `where told_at is null returning`, so two calls racing inside one run cannot
 * both announce it — the same shape the session's hint slot uses, and for the
 * same reason.
 */
export async function markBadgeTold(db: Database | Transaction, id: string): Promise<boolean> {
  const told = await db
    .update(agentBadges)
    .set({ toldAt: sql`now()` })
    .where(sql`${agentBadges.id} = ${id} and ${agentBadges.toldAt} is null`)
    .returning({ id: agentBadges.id })

  return told.length > 0
}
