import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { AccountKindSchema, RegisterAgentRequestSchema } from '@kolonie-ai/core'
import type { Database } from './client.js'
import { connectForTests, databaseTestTarget, truncateAll } from './testing.js'
import { writeProviderRecipe } from './storage/provider-recipes.js'
import { registerAgent } from './storage/agents.js'
import { unwalkedAtlasEntry } from './storage/exploration.js'

const target = databaseTestTarget()

/**
 * `unwalkedAtlasEntry` against a real database (`#895`).
 *
 * ## Why this file exists rather than another rendering assertion
 *
 * This query shipped on 2026-08-14 in `#881` and threw for **every citizen
 * holding at least one account kind**, once every thirty minutes, until it was
 * read out of Loki:
 *
 * ```
 * and "provider_recipes"."kind" <> all(($1, $2, $3))
 * params: mailbox,github,wallet,1
 * PostgresError 42809: op ANY/ALL (array) requires array on right side
 * ```
 *
 * A JS array interpolated into a Drizzle `sql` template becomes a parenthesised
 * *parameter list*, which is a row constructor. `all()` wants an array.
 *
 * **It was not untested.** `bare-identifiers.test.ts` had measured this exact
 * query the same day, printed the rendered SQL into its own comment — including
 * the `<> all(($1))` — and passed, because what that file asks is whether every
 * identifier is qualified. It is a lint over the text, and the text was fine.
 *
 * So the lesson is not *add a test*, it is **which kind**: a query that is only
 * ever rendered has been checked for the things you can see in a string, and
 * nothing else. A query is exercised by running it. Every assertion below fails
 * against the version that shipped, and none of them would have been reached by
 * looking at the SQL harder.
 *
 * The three cases are the three shapes of the argument — several kinds, exactly
 * one, and none — because the defect is in how the argument is *bound* and only
 * the third had a plausible reason to differ.
 */
describe('the unwalked Atlas entry a stuck citizen is offered', () => {
  let db: Database

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await truncateAll(db)

    // Three entries nobody has walked, ordered by kind then provider — which is
    // the order the function promises, so the expected answer is computable
    // rather than whichever row the planner happened to return.
    for (const entry of [
      { kind: 'github', provider: 'github.com', title: 'GitHub' },
      { kind: 'mailbox', provider: 'mail.tm', title: 'mail.tm' },
      { kind: 'domain', provider: 'njal.la', title: 'njal.la' },
    ] as const) {
      await writeProviderRecipe(db, {
        ...entry,
        kind: AccountKindSchema.parse(entry.kind),
        status: 'joinable',
        category: 'mailbox',
        // `provider_recipes_joinable_has_steps` — a joinable entry carries at
        // least one written step and a proof. Nothing below reads either; they
        // are the minimum the table will accept for a realistic row.
        steps: [{ actor: 'agent', instruction: 'Open the signup page.' }],
        proves: 'rung',
        provesTask: 'email-inbox',
      })
    }
  })

  it('answers for a citizen holding several kinds', async () => {
    // The production case, verbatim in shape: three held kinds, which rendered
    // as `all(($1, $2, $3))` and threw 42809 for every such citizen.
    const entry = await unwalkedAtlasEntry(db, ['mailbox', 'github', 'wallet'])

    expect(entry).not.toBeNull()
    // `domain` is the only kind left, and it is not the alphabetically first
    // row in the table — so this also asserts the exclusion did something
    // rather than the query merely surviving.
    expect(entry?.kind).toBe('domain')
    expect(entry?.provider).toBe('njal.la')
  })

  it('answers for a citizen holding exactly one kind', async () => {
    // One element is the case `bare-identifiers.test.ts` rendered and recorded
    // as safe. It is not: a single-element list is `all(($1))`, which is
    // `all($1)` with a scalar on the right and the same 42809.
    const entry = await unwalkedAtlasEntry(db, ['domain'])

    expect(entry?.kind).toBe('github')
  })

  it('answers for a citizen holding no kinds at all', async () => {
    // The one input for which the predicate has no honest SQL, and therefore
    // the one that must be guarded rather than passed through. Holding nothing
    // excludes nothing, so the whole table is a candidate.
    const entry = await unwalkedAtlasEntry(db, [])

    expect(entry?.kind).toBe('domain')
  })

  it('excludes an entry somebody has already walked', async () => {
    // The other half of the `where`, asserted here so that a later change to
    // the exclusion cannot quietly take the `not exists` with it.
    const before = await unwalkedAtlasEntry(db, ['mailbox', 'github'])
    expect(before?.provider).toBe('njal.la')

    // A walk belongs to a citizen, so one has to exist. Which citizen walked
    // it is irrelevant here — the `not exists` correlates on kind and provider
    // and never on the agent, which is what makes a walk by anybody take the
    // entry off everybody's list.
    const walker = await registerAgent(
      db,
      RegisterAgentRequestSchema.parse({ name: 'Walker', platform: 'openclaw' }),
    )
    if (walker.outcome !== 'registered') throw new Error(walker.outcome)
    await db.execute(
      `insert into account_walks (agent_id, kind, provider, started_at)
       values ('${walker.agent.id}', 'domain', 'njal.la', now())`,
    )

    const after = await unwalkedAtlasEntry(db, ['mailbox', 'github'])
    expect(after).toBeNull()
  })

  it('returns null rather than throwing when every kind is held', async () => {
    // A citizen that holds everything is offered nothing, which is a finding
    // and not an error — the caller reads `null` as *no offer of this shape*.
    const entry = await unwalkedAtlasEntry(db, ['github', 'mailbox', 'domain'])

    expect(entry).toBeNull()
  })
})
