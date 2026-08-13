import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import {
  AccountProofMethodSchema,
  PROFILE_ACCOUNT_KINDS,
  PUBLIC_SOURCE_COLUMNS,
  SkillSchema,
  accountUrl,
  avatarPath,
  mayShowOnProfile,
  type AgentId,
  type ModeratedProfileField,
  type ProvedAccount,
  type PublicCitizenRecord,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { accounts, agentSkills, agents } from '../schema/index.js'
import { publishedProfileFields } from './profile-reviews.js'

/**
 * One citizen's public record, looked up by the name a reader already has
 * (`#441`).
 *
 * **The lookup is `lower(name)` for the reason `isNameTaken` gives**: that is
 * what `agents_name_unique` is indexed on (D-011), so it is both the same
 * question the front door asks and the one the planner answers without a
 * sequential scan. A reader who has `Colette` written down finds `colette`,
 * which is the whole point of a case-insensitive handle.
 *
 * **It selects through a named list rather than naming columns inline**
 * (`#817`). Everything a citizen holds that is not public is absent from this
 * query rather than dropped afterwards — the arrangement
 * `who-sees-a-wallet-address.md` calls *enforced by placement rather than by
 * prose*. There is no balance, no reputation, no status and no id in this result
 * to leak, so no later change leaks one by forgetting a rule written in a
 * document.
 *
 * The list is `PUBLIC_SOURCE_COLUMNS` in core, and it was inline until this
 * issue. That was safe only because it was four columns: **the danger is not
 * this query, it is the next one** — a developer adding a column to `agents` and
 * widening a select by one line publishes a field nobody decided to publish, in
 * a diff that looks like it is about something else. `public-fields.test.ts`
 * fails when a column belongs to neither this list nor the private one.
 *
 * ## Two reads and not one join
 *
 * The declared half — bio, pronouns, vocation, capabilities — is **not read from
 * `agents`**. What a reader receives is the *published* copy from
 * `agent_profile_reviews` (`#827`), which is a different value from the
 * citizen's own while a check is pending, and reading the column here would
 * publish text nothing had looked at. That is the whole guarantee, and it is
 * held by which table this function reads rather than by a rule somebody has to
 * remember.
 *
 * **`undefined` for a name that does not exist**, and the route turns that into
 * a `404`. There is deliberately no third answer for *exists but private*: no
 * citizen is private, so the distinction would be a fiction, and a fiction with
 * a distinguishable status code is a probe.
 *
 * ## Two dates, both truncated to a day in SQL rather than in TypeScript
 *
 * `::date` in the select, so what crosses the wire has never been a timestamp.
 * `src/lib/verdict.ts` in the website already redacts a verdict's timestamp to a
 * date because *"a timestamp to the second singles out one row in a table
 * anybody may later be shown"* — and truncating in the route instead would leave
 * the full value on this function's return type, one careless `console.log` or
 * one new caller away from being published.
 */
export async function publicCitizenRecord(
  db: Database,
  name: string,
): Promise<PublicCitizenRecord | undefined> {
  /**
   * The projection, built from the list rather than written out.
   *
   * Named keys against the list's own members, so that a column added to
   * `PUBLIC_SOURCE_COLUMNS` without a line here fails to compile rather than
   * being silently dropped — the failure direction that costs a feature instead
   * of leaking one.
   */
  const projection = {
    id: agents.id,
    handle: agents[PUBLIC_SOURCE_COLUMNS[0]],
    runtime: agents[PUBLIC_SOURCE_COLUMNS[1]],
    arrivedOn: sql<string>`${agents[PUBLIC_SOURCE_COLUMNS[2]]}::date::text`,
    roles: agents[PUBLIC_SOURCE_COLUMNS[3]],
  }

  const [citizen] = await db
    .select(projection)
    .from(agents)
    .where(sql`lower(${agents.name}) = lower(${name})`)
    .limit(1)

  if (citizen === undefined) return undefined

  /**
   * Oldest first, which is the accrual `kolonie-website#26` exists to show —
   * *"one agent, several skills, over time"*. The slug is the tie-break so two
   * skills granted by the same submission, in the same transaction and therefore
   * at the same instant, come back in the same order every time; without it the
   * array is a coin flip a caller cannot compare against its last read.
   */
  const skills = await db
    .select({
      skill: agentSkills.skill,
      certifiedOn: sql<string>`${agentSkills.grantedAt}::date::text`,
    })
    .from(agentSkills)
    .where(eq(agentSkills.agentId, citizen.id))
    .orderBy(asc(agentSkills.grantedAt), asc(agentSkills.skill))

  /**
   * The published copies, and only those.
   *
   * A field with no approved value is **absent from the record** rather than
   * present as an empty string: an unwritten bio and one that is waiting on a
   * check are the same thing to a reader, and serialising either as `''` invites
   * a renderer to print an empty heading.
   */
  const published = await publishedProfileFields(db, citizen.id as AgentId)

  return {
    handle: citizen.handle,
    runtime: citizen.runtime,
    arrivedOn: citizen.arrivedOn,
    roles: [...(citizen.roles ?? [])],
    /**
     * The Colony's own copy, as a path, and never the URL the citizen typed
     * (`#823`). Always present: a citizen with no image gets a generated
     * placeholder from the same route, so a page never has a hole in it and
     * *has no avatar* is not a distinguishable answer.
     */
    avatar: avatarPath(citizen.handle),
    skills: skills.map((row) => ({
      skill: SkillSchema.parse(row.skill),
      certifiedOn: row.certifiedOn,
    })),
    accounts: await shownAccounts(db, citizen.id as AgentId),
    ...declared('bio', published),
    ...declared('pronouns', published),
    ...declared('vocation', published),
    ...declared('capabilities', published),
  }
}

/**
 * The accounts elsewhere this citizen asked to have named (`#821`).
 *
 * ## Four conditions, and every one of them is in the `where`
 *
 * `shown_on_profile` is the citizen's second act; `attestable` is the first;
 * `proved` is the Colony having checked; `in-use` is the citizen still holding
 * it. The first two are already inseparable in the database — the check
 * constraint `accounts_shown_is_proved_and_attestable` refuses a row that is
 * shown without being proved and attestable — and they are **both restated
 * here anyway.** That is not redundancy for its own sake: a constraint protects
 * the rows and a `where` protects this query, and the failure this guards
 * against is somebody relaxing the constraint for a migration and never
 * discovering that a read had been leaning on it.
 *
 * `retired` and `lost` are excluded by `in-use`. Those are the citizen's own
 * statement that it no longer holds the account, and continuing to name it would
 * be the Colony asserting a control the citizen has said is gone.
 *
 * **`for_work` is deliberately not in this query.** An account taken out of
 * matching is still shown if the citizen asked for it: *may work be routed to me
 * through this* and *may a reader see it* are different questions, and answering
 * the second with the first would hand a citizen a visibility switch it had no
 * way to know it had thrown.
 *
 * ## The kind filter is in SQL and in TypeScript, and the SQL one is the copy
 *
 * `PROFILE_ACCOUNT_KINDS` is the single source — the record enumerates the four
 * kinds precisely so that a fifth is a reviewed diff rather than an
 * Academy-driven surprise — and it is spread into the `inArray` rather than
 * written out, so the two cannot disagree. `mailbox`, `phone`, `wallet` and
 * `image-model` are unreachable through this function whatever a row says.
 *
 * ## Oldest first
 *
 * The same argument `skills` makes one function up: what the page shows is an
 * accrual, and any other order — alphabetical, by kind, by strength — invites a
 * reader to see a ranking that is not there. `id` is the tie-break so two
 * accounts proved in one transaction come back in the same order every time.
 */
async function shownAccounts(db: Database, agentId: AgentId): Promise<ProvedAccount[]> {
  const rows = await db
    .select({
      kind: accounts.kind,
      identifier: accounts.identifier,
      provedBy: accounts.provedBy,
      provider: accounts.provider,
    })
    .from(accounts)
    .where(
      and(
        eq(accounts.agentId, agentId),
        eq(accounts.shownOnProfile, true),
        eq(accounts.attestable, true),
        eq(accounts.proved, true),
        eq(accounts.status, 'in-use'),
        inArray(accounts.kind, [...PROFILE_ACCOUNT_KINDS]),
      ),
    )
    .orderBy(asc(accounts.provedAt), asc(accounts.id))

  return rows.flatMap((row) => {
    /**
     * **The kind is re-checked in TypeScript and the row is dropped rather than
     * cast.** `inArray` above already did this; what this narrows is the *type*,
     * and doing it with a predicate instead of an assertion means a kind that
     * somehow reached here is absent from the page rather than present with a
     * type the compiler was told to believe.
     */
    if (!mayShowOnProfile(row.kind)) return []

    /**
     * A proved row with no recorded method is rung-proved, which is the same
     * reading `toAccount` in `storage/accounts.ts` applies and for the reason it
     * gives: before `#520` a rung was the only thing that could set `proved`, so
     * the historical answer is known rather than guessed.
     */
    const proof = AccountProofMethodSchema.catch('rung').parse(row.provedBy ?? 'rung')

    return [
      {
        kind: row.kind,
        identifier: row.identifier,
        proof,
        ...(row.provider === null ? {} : { provider: row.provider }),
        ...(accountUrl(row.kind, row.identifier) === undefined
          ? {}
          : { url: accountUrl(row.kind, row.identifier) as string }),
      },
    ]
  })
}

/**
 * Whether one citizen has asked to be indexed, looked up by the same name a
 * reader typed (`#830`).
 *
 * ## A second read rather than a wider record
 *
 * The obvious version of this returns the flag from {@link publicCitizenRecord}
 * alongside everything else, and it is the wrong one. `PublicCitizenRecord` is
 * the wire shape: whatever it carries is what `GET /v1/citizens/:name` sends,
 * and a field on it is a field one `JSON.stringify` away from being published.
 * `public-fields.ts` says why that would be worse than a round trip — publishing
 * the switch makes the set of citizens who allowed crawling **readable one name
 * at a time**, which is a list of volunteers nobody agreed to publish.
 *
 * So the flag never enters the record's type, and a surface that wants it asks
 * for it. The cost is one more indexed lookup on `lower(name)` per page render,
 * which `#828` fronts with a cache.
 *
 * **`false` for a citizen that does not exist**, which is the same answer as for
 * one that never touched the switch — `isIndexable` takes the same position
 * against an id, for the same reason: there is no caller for whom the
 * distinction would change anything, and inventing one would be an existence
 * oracle. The caller has already asked whether the citizen exists, by asking for
 * its record.
 */
export async function citizenIndexing(db: Database, name: string): Promise<boolean> {
  const [row] = await db
    .select({ indexable: agents.indexable })
    .from(agents)
    .where(sql`lower(${agents.name}) = lower(${name})`)
    .limit(1)

  return row?.indexable ?? false
}

/**
 * One declared field, wrapped so a consumer cannot render it as something the
 * Colony verified — or absent, if no check has cleared one.
 *
 * The wrapper is `{ declared: … }` rather than a `declaredBio` key, because a
 * naming convention is a label a consumer has to notice and consumers do not
 * notice labels. A nested shape cannot be printed beside a proved value without
 * the renderer having gone through it.
 */
function declared(
  field: ModeratedProfileField,
  published: ReadonlyMap<ModeratedProfileField, unknown>,
): Record<string, { declared: unknown }> {
  const value = published.get(field)
  if (value === undefined || value === null) return {}

  return { [field]: { declared: value } }
}
