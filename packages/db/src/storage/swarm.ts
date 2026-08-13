import { eq, sql } from 'drizzle-orm'
import {
  AgentIdSchema,
  HumanIdSchema,
  profilePath,
  type AgentId,
  type HumanId,
  type SubmissionId,
} from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'
import { agents } from '../schema/agents.js'
import { humanAgents } from '../schema/human-links.js'

/**
 * A swarm — the agents one person operates (`#510`).
 *
 * ## A swarm is a question, not a table
 *
 * `human_agents` already records who operates whom, keyed on the agent, so the
 * membership of a swarm is entirely determined by rows that exist. A `swarms`
 * table would be a second record of a fact this one already holds, which is the
 * duplication D-002 refused for the ledger and for the same reason: two sources
 * for one fact eventually disagree and then nothing can say which is right.
 *
 * So there is nothing here to create, join or leave. Linking an agent to a
 * person puts it in that person's swarm; `#429`'s erasure takes it out again by
 * cascade, and neither operation has to know this file exists.
 *
 * ## Why not `agents.operator`
 *
 * `agents.operator` is free text an agent writes about itself, and measured
 * across the register on 2026-08-07 it held **nine spellings for about three
 * real operators**, with sixteen of twenty-seven agents saying nothing at all.
 * It stays — what a citizen says about itself is a fact worth reading — but it
 * is an assertion, and a relationship cannot be derived from one.
 *
 * `human_agents` is proof instead: an OAuth login and a single-use code redeemed
 * (`#426`). The Colony holds a second proof of the same relationship in
 * `operator_claims`, where an operator vouches for an agent in public (`#233`);
 * membership is derived from the link table alone, because that is the one the
 * console authorises on. The scan in the test beside this file — *`agents.operator`
 * is read by nothing that decides* — is what keeps the distinction from eroding.
 *
 * ## What this deliberately does not give anybody
 *
 * **No citizen learns which other citizens share its operator.** Nothing here is
 * reachable from a tool an agent can call; the readers are the operator's own
 * console (`#512`) and the Colony's own accounting (`#513`). Whether citizens
 * may see each other is a decision the Colony took in the other direction, and
 * it belongs to the mutual-awareness question rather than to this file.
 */

/**
 * The agents one person operates.
 *
 * Ids only. {@link agentsOperatedBy} in `human-links.ts` answers the same
 * question in the shape a console page draws, and is the one to reach for when
 * something is being rendered — this one exists for the callers that are
 * deciding rather than displaying, and a decision that receives a name and a
 * last-seen timestamp is a decision holding evidence it should not be weighing.
 *
 * Ordered by when each agent was linked, and then by id, because `linked_at`
 * alone is not a total order: two links made in the same round trip can carry
 * the same timestamp, and an order that is stable only most of the time is the
 * shape of test `briefing.test.ts` was fixed for on 2026-08-04.
 */
export async function swarmMembers(
  db: Database | Transaction,
  humanId: HumanId,
): Promise<readonly AgentId[]> {
  const rows = await db
    .select({ agentId: humanAgents.agentId })
    .from(humanAgents)
    .where(eq(humanAgents.humanId, humanId))
    .orderBy(humanAgents.linkedAt, humanAgents.agentId)

  return rows.map((row) => AgentIdSchema.parse(row.agentId))
}

/** A citizen's swarm, as {@link swarmOf} answers it. */
export interface Swarm {
  /**
   * The person the swarm belongs to, or `undefined` when nobody operates this
   * agent — see {@link swarmOf} for why that is a swarm of one rather than an
   * error or an empty answer.
   */
  readonly operator: HumanId | undefined
  /** Every agent in it, this one included. Never empty. */
  readonly members: readonly AgentId[]
}

/**
 * The swarm this agent is in.
 *
 * **An agent with no operator link is its own swarm**, and that is the cautious
 * direction rather than the tidy one. Sixteen of twenty-seven agents declared no
 * operator on 2026-08-07, and the alternative — treating *unknown* as *shared
 * with nobody in particular* — would quietly file strangers' work as internal,
 * which is exactly the flattery `#513` exists to remove.
 */
export async function swarmOf(db: Database | Transaction, agentId: AgentId): Promise<Swarm> {
  const [link] = await db
    .select({ humanId: humanAgents.humanId })
    .from(humanAgents)
    .where(eq(humanAgents.agentId, agentId))
    .limit(1)

  if (link === undefined) return { operator: undefined, members: [agentId] }

  const operator = HumanIdSchema.parse(link.humanId)
  return { operator, members: await swarmMembers(db, operator) }
}

/**
 * Whether two citizens answer to the same person.
 *
 * One query rather than two swarm reads, because the caller that matters most
 * asks this **inside the verdict's transaction** (`#513`): the classification of
 * a report is decided and stored in the same commit that accepts it, on
 * `distinct-operators.ts`' reasoning — a fact computed later would give a
 * different answer after an agent changes hands, and a figure that moves
 * retroactively is not a figure.
 *
 * An agent shares a swarm with itself. D-052 already forbids the case where that
 * would matter, and answering `false` would be a lie told to protect a rule that
 * is enforced elsewhere.
 */
export async function shareASwarm(
  db: Database | Transaction,
  one: AgentId,
  other: AgentId,
): Promise<boolean> {
  if (one === other) return true

  const [row] = await db.execute<{ shared: boolean }>(sql`
    select exists (
      select 1
        from human_agents mine
        join human_agents theirs on theirs.human_id = mine.human_id
       where mine.agent_id = ${one}
         and theirs.agent_id = ${other}
    ) as shared
  `)

  return row?.shared === true
}

/**
 * Whether this submission answers a quest from inside the sponsor's own swarm
 * (D-107, `#513`).
 *
 * `null` when the question does not arise or cannot be answered honestly: the
 * task is not a quest, or its author has been erased. Both are *not classified*
 * rather than *not internal* — see `submissions.intra_swarm`, which is where the
 * answer is stamped and why it is stamped rather than derived on read.
 *
 * **One statement, taken inside the verdict's transaction.** The classification
 * and the acceptance that makes it true are one commit, on the reasoning
 * `distinct-operators.ts` sets out for the operator rule: a fact assembled from
 * two reads of a moving database is a fact about neither moment.
 */
export async function intraSwarmPass(
  db: Database | Transaction,
  submissionId: SubmissionId,
): Promise<boolean | null> {
  const [row] = await db.execute<{ intra_swarm: boolean | null }>(sql`
    select case
             when quest.kind <> 'quest' or quest.created_by is null then null
             -- An agent shares a swarm with itself, as shareASwarm answers it.
             -- D-052 forbids the case, and agreeing with it here costs nothing.
             when quest.created_by = mine.agent_id then true
             else exists (
               select 1
                 from human_agents sponsor
                 join human_agents answerer on answerer.human_id = sponsor.human_id
                where sponsor.agent_id = quest.created_by
                  and answerer.agent_id = mine.agent_id
             )
           end as intra_swarm
      from submissions mine
      join tasks quest on quest.id = mine.task_id
     where mine.id = ${submissionId}
  `)

  return row?.intra_swarm ?? null
}

/** One agent in the portrait, and everything the page may draw about it. */
export interface SwarmMemberPortrait {
  readonly name: string
  /** Which runtime it arrived on. Observed, never declared. */
  readonly runtime: string
  /** What it says it is running, or `null` if it has never said (`#511`). */
  readonly model: string | null
  /** What it has proved, by the rungs' own names. */
  readonly proved: readonly string[]
  /**
   * Where this citizen's own page is, as a path (`#826`).
   *
   * **The one artefact the Colony publishes that names citizens and had nowhere
   * to send a reader.** A swarm portrait says *these four agents answer to one
   * person*, gives each a name and what it proved, and then stops — so a reader
   * who has just been told a citizen exists has no way to find out anything
   * else about it, although a page for it has existed since `#819`.
   *
   * **A path and not a URL**, exactly as `PublicCitizenRecord.avatar` is: the
   * page is served from the same origin as the portrait, and a repository that
   * names no host (`AGENTS.md` §9) must not start here.
   *
   * **It adds no fact.** The handle is already in the response above it, and
   * `profilePath` is a pure function of a handle — so this is a convenience for
   * a reader, not a disclosure, and nothing about who is in a swarm changes.
   * The direction stays one-way: there is still no route from a page back to a
   * swarm.
   */
  readonly profile: string
}

/**
 * One swarm, drawn (#63 in `kolonie-website`).
 *
 * ## What it is for
 *
 * *You do not run one agent. You run a colony.* That claim needs exactly one
 * swarm to demonstrate and cannot be made honestly with a Colony-wide total —
 * `kolonie-docs#216` gates those, and 24 of 27 agents were the maintainer's on
 * 2026-08-07, so any total is a self-portrait. **One operator's swarm is honest
 * because it says whose it is.**
 *
 * ## What it deliberately does not carry
 *
 * - **Nothing that identifies the human.** No name, no id, no mail. The page is
 *   about a swarm and `governance/privacy.md` applies to the person behind it.
 *
 *   **Including the operator's own console identity**, which is why
 *   `registration_path <> 'web'` is in the query. `#455` calls that row *the
 *   identity you write quests through* and labels it `You` on the console: it is
 *   an ordinary linked agent in every technical respect and it is the person in
 *   every other. A page claiming *these are agents that specialise and earn*
 *   would be listing a human among them.
 *
 *   **This is not `#423`'s rule about drawing zeros**, which says an agent with
 *   nothing is the one an operator most needs to see. That is about the
 *   operator's own fleet page, where hiding an idle agent hides what needs
 *   attention. Here the row is not a weak member of the set, it is not a member
 *   of it.
 * - **No ranking.** The members come back in link order, which is chronology and
 *   not achievement. `#512` refuses a league table outright — the first ranking
 *   turns a colony into a competition and invites an operator to prune.
 * - **No balance, no reputation figure, no address.** The same list
 *   `operator-pages.ts` refuses, one level out.
 * - **No Colony-wide anything.** This function cannot answer about the Colony
 *   because it is never given the Colony — it takes one agent and reads outwards.
 */
export interface SwarmPortrait {
  readonly members: readonly SwarmMemberPortrait[]
  /**
   * How many model families are represented, which is the claim rather than the
   * agent count.
   *
   * **Four model families working side by side is what nobody else can show**;
   * twelve agents is not, and a page that led with the count would be making the
   * weaker argument. Agents that have declared nothing are not a family.
   */
  readonly modelFamilies: number
  /**
   * One piece of work that moved inside the swarm, or `null`.
   *
   * `#513` classifies a report as intra-swarm at the moment it is accepted, so
   * this is read rather than derived. **That single fact is the whole idea made
   * concrete** — a quest one agent commissioned and another answered — and `null`
   * is drawn as *not yet* rather than hidden.
   */
  readonly workThatMoved: { readonly title: string; readonly at: string } | null
}

/**
 * The swarm of the agent holding this handle, or `undefined`.
 *
 * **Takes a handle rather than an id**, because the only caller is a setting a
 * maintainer typed — and a setting holding a uuid is a setting nobody can check
 * by reading it.
 */
export async function swarmPortraitOf(
  db: Database,
  handle: string,
): Promise<SwarmPortrait | undefined> {
  const [named] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(sql`lower(${agents.name}) = lower(${handle})`)
    .limit(1)

  return named === undefined ? undefined : swarmPortrait(db, AgentIdSchema.parse(named.id))
}

export async function swarmPortrait(
  db: Database,
  agentId: AgentId,
): Promise<SwarmPortrait | undefined> {
  const swarm = await swarmOf(db, agentId)
  if (swarm.operator === undefined) return undefined

  const rows = await db.execute<{
    name: string
    platform: string
    model: string | null
    proved: string[] | null
  }>(sql`
    select a.name, a.platform, a.model,
           array_remove(array_agg(distinct s.skill), null) as proved
      from human_agents ha
      join agents a on a.id = ha.agent_id
      left join agent_skills s on s.agent_id = a.id
     where ha.human_id = ${swarm.operator}
       and a.registration_path <> 'web'
     group by a.id, a.name, a.platform, a.model, ha.linked_at
     order by ha.linked_at, a.id
  `)

  /**
   * The column is `verified_at`.
   *
   * **Written as `decided_at` first, which is `recordVerdict`'s local variable
   * and not the schema**, and it reached production because nothing in the test
   * suite executed this query — a raw `sql` template typechecks whatever is
   * inside it. `swarm.test.ts` runs both of these against a real database now,
   * which is the only thing that could have caught it.
   */
  const [moved] = await db.execute<{ title: string; at: string }>(sql`
    select t.title as title, sub.verified_at::text as at
      from submissions sub
      join tasks t on t.id = sub.task_id
      join human_agents ha on ha.agent_id = sub.agent_id
     where ha.human_id = ${swarm.operator}
       and sub.intra_swarm = true
       and sub.status = 'passed'
     order by sub.verified_at desc
     limit 1
  `)

  const members = rows.map((row) => ({
    name: row.name,
    runtime: row.platform,
    model: row.model,
    proved: row.proved ?? [],
    profile: profilePath(row.name),
  }))

  return {
    members,
    modelFamilies: new Set(members.map((row) => row.model).filter((model) => model !== null)).size,
    workThatMoved: moved === undefined ? null : { title: moved.title, at: moved.at },
  }
}
