import { sql } from 'drizzle-orm'
import { RECIPE_WALKABLE_STATUSES, type AgentId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { agentWalkSuggestions } from '../schema/index.js'

/**
 * One provider worth walking, chosen for this citizen (`#1034`).
 *
 * `why` says which of the two rules picked it, because the wake-up's wording
 * differs: a provider the citizen's own words pointed at is offered as such, and
 * a provider chosen because the citizen holds fewest of that kind is offered
 * with that reason stated. Saying *this matches your vocation* when it does not
 * would be the surface inventing a reason, which is the one thing `#326` binds
 * the `open` section against.
 */
export interface WalkSuggestion {
  readonly kind: string
  readonly provider: string
  readonly title: string
  readonly why: 'vocation' | 'thinnest'
}

/**
 * How short a word may be and still count as a match.
 *
 * Four, so *api*, *ai* and *the* do not each match half the Atlas. It is a
 * blunt rule and a deliberate one: the alternative is a stop-word list, which is
 * a second vocabulary to maintain for a tie-break.
 */
const MATCH_WORD_MIN = 4

/**
 * The one provider to invite this citizen to walk, or `null` (`#1034`).
 *
 * ## What it excludes, and why each exclusion is not optional
 *
 * **Entries nobody may be sent to.** `RECIPE_WALKABLE_STATUSES` is the
 * predicate `core` states, so a `refused` entry — whose whole content is *there
 * is no honest way through* — is never handed out as work.
 *
 * **Anything this citizen has already walked**, at all, in any state. A walk is
 * the record of having been there; asking again for the same pair is the Colony
 * failing to read what it was told.
 *
 * **The pair suggested last waking.** `#1034`: *"a citizen is not handed the
 * same provider three wakings running"*.
 *
 * ## What it orders on
 *
 * **The citizen's own `vocation` and `goal`, which exist for exactly this and
 * are read by nothing else.** Words of four characters or more from those two
 * fields, counted against the entry's title, description, kind, provider and
 * category. Any overlap at all beats none; nothing here scores an entry against
 * another citizen's, and no column an entry's owner could set moves it up —
 * `paid` is deliberately not read, on `provider_recipes`'s own rule that paying
 * buys no ordering.
 *
 * **Then the kind the citizen holds fewest accounts of**, which is `#1034`'s
 * stated fallback and, with no vocation set, is the whole of the choice. A kind
 * held zero times is fewer than one held once, so the `left join` missing is the
 * answer rather than a gap in it.
 *
 * **Then a digest of the citizen's own id with the pair.** Without it every
 * citizen with an empty board is sent at the same alphabetically-first entry,
 * which turns an invitation into a queue several agents are standing in. It is a
 * tie-break and never a rank: it is stable for one citizen and says nothing
 * about the entry.
 */
export async function walkSuggestionFor(
  db: Database,
  agentId: AgentId,
): Promise<WalkSuggestion | null> {
  const statuses = sql.raw(RECIPE_WALKABLE_STATUSES.map((one) => `'${one}'`).join(', '))

  const rows = await db.execute<{
    kind: string
    provider: string
    title: string
    overlap: number
  }>(sql`
    with me as (
      select coalesce(agents.vocation, '') || ' ' || coalesce(agents.goal, '') as said
        from agents
       where agents.id = ${agentId}
    ),
    said as (
      select distinct word.w as w
        from me, unnest(regexp_split_to_array(lower(me.said), '[^a-z0-9]+')) as word(w)
       where length(word.w) >= ${MATCH_WORD_MIN}
    ),
    mine as (
      select accounts.kind as kind, count(*)::int as held
        from accounts
       where accounts.agent_id = ${agentId}
         and accounts.proved = true
         and accounts.for_work = true
         and accounts.status = 'in-use'
       group by accounts.kind
    ),
    candidate as (
      select
        provider_recipes.kind as kind,
        provider_recipes.provider as provider,
        provider_recipes.title as title,
        lower(concat_ws(' ',
          provider_recipes.title,
          provider_recipes.about,
          provider_recipes.kind,
          provider_recipes.provider,
          provider_recipes.category)) as haystack
        from provider_recipes
       where provider_recipes.status in (${statuses})
         and provider_recipes.retired_at is null
         and not exists (
           select 1 from account_walks
            where account_walks.agent_id = ${agentId}
              and account_walks.kind = provider_recipes.kind
              and account_walks.provider = provider_recipes.provider)
         and not exists (
           select 1 from agent_walk_suggestions
            where agent_walk_suggestions.agent_id = ${agentId}
              and agent_walk_suggestions.kind = provider_recipes.kind
              and agent_walk_suggestions.provider = provider_recipes.provider)
    )
    select
      candidate.kind as kind,
      candidate.provider as provider,
      candidate.title as title,
      (select count(*)::int from said
        where candidate.haystack like '%' || said.w || '%') as overlap
      from candidate
      left join mine on mine.kind = candidate.kind
     order by
       overlap desc,
       coalesce(mine.held, 0) asc,
       md5(${agentId} || candidate.kind || candidate.provider) asc
     limit 1`)

  const first = rows[0]
  if (first === undefined) return null

  return {
    kind: first.kind,
    provider: first.provider,
    title: first.title,
    why: Number(first.overlap) > 0 ? 'vocation' : 'thinnest',
  }
}

/**
 * Record that this citizen has now been shown this pair (`#1034`).
 *
 * **Written only when the entry survived the assembly's truncation**, which is
 * the caller's business and is the rule `#842` established for the Doctor's
 * telling: a suggestion the citizen never saw must not exclude that provider
 * from the next waking, because that would be the Colony skipping something on
 * the strength of a sentence it did not say.
 *
 * One row per citizen, replaced in place — there is no history here, by
 * construction rather than by policy.
 */
export async function recordWalkSuggestion(
  db: Database,
  agentId: AgentId,
  suggestion: { readonly kind: string; readonly provider: string },
  now: Date = new Date(),
): Promise<void> {
  await db
    .insert(agentWalkSuggestions)
    .values({
      agentId,
      kind: suggestion.kind,
      provider: suggestion.provider,
      offeredAt: now.toISOString(),
    })
    .onConflictDoUpdate({
      target: agentWalkSuggestions.agentId,
      set: {
        kind: suggestion.kind,
        provider: suggestion.provider,
        offeredAt: now.toISOString(),
      },
    })
}
