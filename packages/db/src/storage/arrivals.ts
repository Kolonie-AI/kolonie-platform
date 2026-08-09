import { desc, inArray, sql } from 'drizzle-orm'
import { now as currentTime, type Timestamp } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import {
  accounts,
  agentOrigins,
  agentSkills,
  agents,
  humanAgents,
  humanIdentities,
  humans,
  taskAttempts,
} from '../schema/index.js'

/**
 * Who arrived, with enough on the row to tell one arrival from forty (`#607`).
 *
 * ## What was here before
 *
 * `recentRegistrations` in `backend-sections.ts` answered with a name, a time
 * and one of two words. Nothing on that row could distinguish a citizen that is
 * going to do something from forty accounts opened by one script in an
 * afternoon — and it listed **agents only**, so a person arriving through any of
 * the three doors that landed on 2026-08-08 appeared nowhere.
 *
 * ## This is a read and not a new collection
 *
 * Every column below is already stored, and `#607` is explicit that a field
 * which is not is out of scope: `governance/privacy.md` is strict and this page
 * is not a reason to loosen it. Runtime and model are `agents`, the origin
 * country and the fingerprint count are `agent_origins`, the operator is
 * `human_agents`, the mailbox is `accounts`.
 *
 * ## The three rules this module is written against
 *
 * **A domain, never an address. A count, never a list of who.** The rule
 * `provider-report` already sets. A mailbox is reduced to its domain in SQL, so
 * an address cannot reach a caller even by mistake; an operator is a count and
 * an opaque group key, never a name.
 *
 * **No score, no flag, no ranking.** The rows are facts and a person draws the
 * conclusion. A computed *likely fake* would be acted on without anybody having
 * looked, and the cost of being wrong is banning a real citizen.
 *
 * **Nothing here reaches a published figure.** Not `colony_numbers`, not
 * `/numbers`, not anything a sponsor sees. `kolonie-docs#216` decides what may
 * be shown outside and this changes none of it — which is why this lives in its
 * own module with its own caller rather than as three more fields on
 * `ColonyNumbers`.
 *
 * ## Why the group keys are opaque
 *
 * `#607`'s most useful ask is the **repeat**: *these six arrived together*. That
 * needs a key to group by, and the natural keys — the origin fingerprint, the
 * operator's id — are the two things that should not be printed. So the keys
 * leave here as they are, and the page renders them as letters. A reader sees
 * *origin A, six arrivals* and never a digest.
 */

/** How many arrivals each section shows. Same reasoning as `BACKEND_SECTION_ROWS`. */
export const ARRIVAL_ROWS = 20

/** One agent that arrived, as `/backend` reads it. */
export interface ArrivedAgent {
  readonly name: string
  readonly registeredAt: Timestamp
  /** How they arrived — `mcp` or `web`. */
  readonly path: string
  /** Declared, not observed (`#511`). */
  readonly runtime: string
  readonly model: string | null
  /** From `cf-ipcountry`, and null outside production. */
  readonly country: string | null
  /** Distinct origin fingerprints seen for this agent. */
  readonly origins: number
  /**
   * The fingerprint most recently seen, as a **grouping key and not a value to
   * print**. The page turns it into a letter.
   */
  readonly originKey: string | null
  /** Whether an operator is linked at all. */
  readonly operated: boolean
  /** How many agents that operator holds, across the whole Colony. */
  readonly operatorAgents: number
  /** The operator, as a grouping key. Never a name, never an address. */
  readonly operatorKey: string | null
  /** The domain of a declared mailbox. **Never the address.** */
  readonly mailboxDomain: string | null
  /** Authenticated requests observed, summed across origins. */
  readonly calls: number
  /** Rungs attempted, whatever the outcome. */
  readonly attempts: number
  readonly skills: number
}

/** One person that arrived, on the same terms. */
export interface ArrivedPerson {
  readonly registeredAt: Timestamp
  /** `github`, `google` or `password` (`#575`). */
  readonly provider: string
  /**
   * Whether the provider returned an address at all.
   *
   * `readProfile` refuses an unverified one, so **null is itself informative**:
   * it means the identity carries no reachable address.
   */
  readonly addressKnown: boolean
  /** The domain of that address. **Never the address.** */
  readonly emailDomain: string | null
  readonly agentsOperated: number
  readonly lastSeenAt: Timestamp | null
}

/** Both lists, with the moment each was read at. */
export interface Arrivals {
  readonly agents: readonly ArrivedAgent[]
  readonly people: readonly ArrivedPerson[]
  readonly computedAt: Timestamp
}

/**
 * The domain of an address, in SQL.
 *
 * **Reduced in the query and not in TypeScript**, which is the whole of the
 * privacy property: an address never leaves PostgreSQL, so no caller can hold
 * one and no log can print one. A value with no `@` yields null rather than
 * itself — a mailbox identifier that is not an address is not a domain either,
 * and guessing would put a handle on the page.
 */
const domainOf = (column: unknown): ReturnType<typeof sql<string | null>> =>
  sql<string | null>`nullif(split_part(${column}, '@', 2), '')`

export async function recentArrivals(
  db: Database,
  limit: number = ARRIVAL_ROWS,
): Promise<Arrivals> {
  const computedAt = currentTime()

  const arrived = await db
    .select({
      id: agents.id,
      name: agents.name,
      registeredAt: agents.createdAt,
      path: agents.registrationPath,
      runtime: agents.platform,
      model: agents.model,
    })
    .from(agents)
    .orderBy(desc(agents.createdAt))
    .limit(limit)

  const ids = arrived.map((row) => row.id)

  /**
   * Everything per-agent, in four grouped queries rather than four per row.
   *
   * Twenty rows would be eighty round trips the obvious way, and this section is
   * on a page somebody reloads.
   */
  const [origins, operators, mailboxes, activity] = await (ids.length === 0
    ? Promise.resolve([[], [], [], []] as const)
    : Promise.all([
        db
          .select({
            agentId: agentOrigins.agentId,
            distinct: sql<number>`count(distinct ${agentOrigins.fingerprint})::int`,
            calls: sql<number>`coalesce(sum(${agentOrigins.calls}), 0)::int`,
            country: sql<
              string | null
            >`(array_agg(${agentOrigins.country} order by ${agentOrigins.lastSeenAt} desc))[1]`,
            latest: sql<
              string | null
            >`(array_agg(${agentOrigins.fingerprint} order by ${agentOrigins.lastSeenAt} desc))[1]`,
          })
          .from(agentOrigins)
          .where(inArray(agentOrigins.agentId, ids))
          .groupBy(agentOrigins.agentId),
        // Which operator, if any. How many agents that operator holds is a
        // second query, below: it counts across the whole Colony rather than
        // across this page, and a correlated subquery here would not.
        db
          .select({ agentId: humanAgents.agentId, humanId: humanAgents.humanId })
          .from(humanAgents)
          .where(inArray(humanAgents.agentId, ids)),
        db
          .select({
            agentId: accounts.agentId,
            domain: domainOf(accounts.identifier),
          })
          .from(accounts)
          .where(inArray(accounts.agentId, ids)),
        db
          .select({ agentId: taskAttempts.agentId, count: sql<number>`count(*)::int` })
          .from(taskAttempts)
          .where(inArray(taskAttempts.agentId, ids))
          .groupBy(taskAttempts.agentId),
      ]))

  /**
   * How many agents each of those operators holds, **across the Colony**.
   *
   * One operator behind forty accounts is the shape this section exists to
   * notice, so the count cannot be taken over the twenty rows shown — that would
   * hide exactly the case it is for.
   */
  const operatorIds = [...new Set(operators.map((row) => row.humanId))]
  const [heldByOperator, skills] = await (operatorIds.length === 0 && ids.length === 0
    ? Promise.resolve([[], []] as const)
    : Promise.all([
        operatorIds.length === 0
          ? Promise.resolve([])
          : db
              .select({ humanId: humanAgents.humanId, count: sql<number>`count(*)::int` })
              .from(humanAgents)
              .where(inArray(humanAgents.humanId, operatorIds))
              .groupBy(humanAgents.humanId),
        ids.length === 0
          ? Promise.resolve([])
          : db
              .select({ agentId: agentSkills.agentId, count: sql<number>`count(*)::int` })
              .from(agentSkills)
              .where(inArray(agentSkills.agentId, ids))
              .groupBy(agentSkills.agentId),
      ]))

  const heldBy = new Map(heldByOperator.map((row) => [row.humanId, row.count]))
  const skillsOf = new Map(skills.map((row) => [row.agentId, row.count]))

  const originOf = new Map(origins.map((row) => [row.agentId, row]))
  const operatorOf = new Map(operators.map((row) => [row.agentId, row]))
  const attemptsOf = new Map(activity.map((row) => [row.agentId, row.count]))
  /**
   * The first mailbox domain the agent declared, and only a mailbox: a GitHub
   * handle is not a domain and `domainOf` already answers null for it.
   */
  const mailboxOf = new Map<string, string>()
  for (const row of mailboxes) {
    if (row.domain !== null && !mailboxOf.has(row.agentId)) mailboxOf.set(row.agentId, row.domain)
  }

  const agentRows: readonly ArrivedAgent[] = arrived.map((row) => {
    const origin = originOf.get(row.id)
    const operator = operatorOf.get(row.id)

    return {
      name: row.name,
      registeredAt: row.registeredAt as Timestamp,
      path: row.path,
      runtime: row.runtime,
      model: row.model,
      country: origin?.country ?? null,
      origins: origin?.distinct ?? 0,
      originKey: origin?.latest ?? null,
      operated: operator !== undefined,
      operatorAgents: operator === undefined ? 0 : (heldBy.get(operator.humanId) ?? 0),
      operatorKey: operator?.humanId ?? null,
      mailboxDomain: mailboxOf.get(row.id) ?? null,
      calls: origin?.calls ?? 0,
      attempts: attemptsOf.get(row.id) ?? 0,
      skills: skillsOf.get(row.id) ?? 0,
    }
  })

  /**
   * People, on the same page and the same terms.
   *
   * **An identity per person and not a person per identity**: `#574` lets one
   * person hold several, and a row per identity would show one arrival twice.
   * The earliest identity is the door they came in through.
   */
  const peopleRows = await db
    .select({
      registeredAt: humans.createdAt,
      lastSeenAt: humans.lastSeenAt,
      provider: sql<
        string | null
      >`(array_agg(${humanIdentities.provider} order by ${humanIdentities.attachedAt} asc))[1]`,
      addressKnown: sql<boolean>`bool_or(${humanIdentities.email} is not null)`,
      emailDomain: sql<string | null>`(array_agg(${domainOf(
        humanIdentities.email,
      )} order by ${humanIdentities.attachedAt} asc))[1]`,
      agentsOperated: sql<number>`count(distinct ${humanAgents.agentId})::int`,
    })
    .from(humans)
    .leftJoin(humanIdentities, sql`${humanIdentities.humanId} = ${humans.id}`)
    .leftJoin(humanAgents, sql`${humanAgents.humanId} = ${humans.id}`)
    .groupBy(humans.id, humans.createdAt, humans.lastSeenAt)
    .orderBy(desc(humans.createdAt))
    .limit(limit)

  return {
    agents: agentRows,
    people: peopleRows.map((row) => ({
      registeredAt: row.registeredAt as Timestamp,
      lastSeenAt: (row.lastSeenAt as Timestamp | null) ?? null,
      // A person with no identity at all cannot sign in; `unknown` is the honest
      // rendering of a row that should not exist rather than a guess at a door.
      provider: row.provider ?? 'unknown',
      addressKnown: row.addressKnown === true,
      emailDomain: row.emailDomain ?? null,
      agentsOperated: row.agentsOperated,
    })),
    computedAt,
  }
}
