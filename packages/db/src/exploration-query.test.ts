import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { AccountKindSchema, RegisterAgentRequestSchema, type AgentId } from '@kolonie-ai/core'
import type { Database } from './client.js'
import { connectForTests, databaseTestTarget, truncateAll } from './testing.js'
import { writeProviderRecipe } from './storage/provider-recipes.js'
import { registerAgent } from './storage/agents.js'
import { obstacleAhead, unwalkedAtlasEntry } from './storage/exploration.js'
import { tasks } from './schema/tasks.js'

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

  it('does not offer an alias-equivalent recipe after a completed refused walk', async () => {
    await truncateAll(db)

    // The stale row that wakeup selected was written under `chat`, while the
    // route and its walk are keyed as the canonical `communication` kind.
    await writeProviderRecipe(db, {
      kind: AccountKindSchema.parse('chat'),
      provider: 'walked-provider',
      title: 'Walked provider',
      status: 'joinable',
      category: 'communication',
      steps: [{ actor: 'agent', instruction: 'Open the signup page.' }],
      proves: 'rung',
      provesTask: 'social-account',
    })
    await writeProviderRecipe(db, {
      kind: AccountKindSchema.parse('communication'),
      provider: 'walked-provider',
      title: 'Walked provider',
      status: 'refused',
      refusal: 'The route is closed.',
      category: 'communication',
      steps: [],
    })

    const walker = await registerAgent(
      db,
      RegisterAgentRequestSchema.parse({ name: 'Alias walker', platform: 'openclaw' }),
    )
    if (walker.outcome !== 'registered') throw new Error(walker.outcome)
    await db.execute(
      `insert into account_walks (agent_id, kind, provider, started_at, finished_at, outcome, wall)
       values ('${walker.agent.id}', 'communication', 'walked-provider', now(), now(), 'refused', 'human-check')`,
    )

    expect(await unwalkedAtlasEntry(db, [])).toBeNull()
  })

  it('does not offer an alias-equivalent kind the citizen already holds', async () => {
    await truncateAll(db)

    await writeProviderRecipe(db, {
      kind: AccountKindSchema.parse('chat'),
      provider: 'held-provider',
      title: 'Held provider',
      status: 'joinable',
      category: 'communication',
      steps: [{ actor: 'agent', instruction: 'Open the signup page.' }],
      proves: 'rung',
      provesTask: 'social-account',
    })

    expect(await unwalkedAtlasEntry(db, ['communication'])).toBeNull()
  })

  it('returns null rather than throwing when every kind is held', async () => {
    // A citizen that holds everything is offered nothing, which is a finding
    // and not an error — the caller reads `null` as *no offer of this shape*.
    const entry = await unwalkedAtlasEntry(db, ['github', 'mailbox', 'domain'])

    expect(entry).toBeNull()
  })

  /**
   * `#1882`, verbatim from the report: a citizen whose board was empty was told
   * *No citizen has walked discord.com for a chat* and sent to
   * `kolonie.accounts.recipes`, whose very first line for the same pair said
   * **Do not attempt this.** The recipe and the walk suggestion were two answers
   * to one question, and the digest had never read the first before writing the
   * second.
   *
   * The case is refused-and-walked only because the two go together: a `refused`
   * recipe is one whose whole content is *direct signup does not open*, so
   * `No citizen has walked it* is doubly wrong — the door is not only walked,
   * it is shut. An operator-token route on the same provider is a **different
   * route** and stays a candidate, which is the truthful half of the fix.
   */
  it('does not offer discord.com direct signup the recipe already refused, and keeps a distinct joinable route', async () => {
    // The recipe whose refusal the citizen read: direct signup for a chat
    // account, closed with the age/legal-capacity wall.
    await writeProviderRecipe(db, {
      kind: AccountKindSchema.parse('chat'),
      provider: 'discord.com',
      title: 'Discord',
      status: 'refused',
      refusal:
        'Direct signup requires representing you are of legal age and may present a CAPTCHA ' +
        'or device attestation. Do not attempt it.',
      category: 'communication',
      steps: [],
    })

    // An operator-provided-token social route on the same provider: a distinct
    // route that must not make direct signup look unexplored, and must not be
    // lost to the suppression either.
    await writeProviderRecipe(db, {
      kind: AccountKindSchema.parse('social'),
      provider: 'discord.com',
      title: 'Discord (operator token)',
      status: 'joinable',
      category: 'social-publishing',
      steps: [
        {
          actor: 'operator',
          instruction: 'A person is needed.',
          ask: 'Create and hand over an operator token.',
        },
      ],
      proves: 'rung',
      provesTask: 'social-account',
    })

    // A refused walk on the direct route, so the `not exists` half alone — the
    // one that was live before `#1882` — would already exclude it. The refusal
    // below is what makes the case: the recipe itself is the record, and the
    // read must honour it with or without a walk row.
    const walker = await registerAgent(
      db,
      RegisterAgentRequestSchema.parse({ name: 'Refused walker', platform: 'openclaw' }),
    )
    if (walker.outcome !== 'registered') throw new Error(walker.outcome)
    await db.execute(
      `insert into account_walks (agent_id, kind, provider, started_at, finished_at, outcome, wall)
       values ('${walker.agent.id}', 'chat', 'discord.com', now(), now(), 'refused', 'human-check')`,
    )

    const entry = await unwalkedAtlasEntry(db, ['github', 'mailbox', 'domain'])

    // The refused chat route is gone even though a walk exists for it, and the
    // operator-token route on the same provider — a different kind — is the
    // truthful offer that stays. `chat` sorts before `social`, so the answer
    // being the social route also proves the refused row was excluded rather
    // than merely outranked.
    expect(entry).not.toBeNull()
    expect(entry?.kind).not.toBe('chat')
    expect(entry?.kind).toBe('social')
    expect(entry?.provider).toBe('discord.com')
  })

  /**
   * The suppression half on its own: a recipe nobody has walked is still not
   * offered when its status is `refused`. This is the case the report actually
   * describes — *No citizen has walked discord.com for a chat* was true, and
   * the recommendation was wrong anyway, because the recipe already said the
   * door does not open.
   */
  it('does not offer a refused direct-signup recipe even when no walk row exists', async () => {
    await truncateAll(db)

    await writeProviderRecipe(db, {
      kind: AccountKindSchema.parse('chat'),
      provider: 'discord.com',
      title: 'Discord',
      status: 'refused',
      refusal:
        'Direct signup requires representing you are of legal age and may present a CAPTCHA ' +
        'or device attestation. Do not attempt it.',
      category: 'communication',
      steps: [],
    })

    // The only other entry is a kind the citizen holds, so if the refused row
    // were not excluded the answer would name discord.com.
    await writeProviderRecipe(db, {
      kind: AccountKindSchema.parse('github'),
      provider: 'github.com',
      title: 'GitHub',
      status: 'joinable',
      category: 'code-hosting',
      steps: [{ actor: 'agent', instruction: 'Open the signup page.' }],
      proves: 'rung',
      provesTask: 'email-inbox',
    })

    const entry = await unwalkedAtlasEntry(db, ['github', 'mailbox', 'domain'])

    expect(entry).toBeNull()
  })
})

/**
 * `obstacleAhead` against a real database (`#893`).
 *
 * **Exercised rather than rendered**, on the lesson the file above records: a
 * query that is only ever read as a string has been checked for the things you
 * can see in a string and nothing else. Every case below is a `where` clause
 * that has to actually filter.
 */
describe('the obstacle a stuck citizen is pointed at', () => {
  let db: Database
  let agentId: AgentId
  let seeded = 0

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await truncateAll(db)
    const registered = await registerAgent(
      db,
      RegisterAgentRequestSchema.parse({ name: 'Reader', platform: 'openclaw' }),
    )
    if (registered.outcome !== 'registered') throw new Error(registered.outcome)
    agentId = registered.agent.id
  })

  /** One active task, through the schema rather than through hand-written SQL. */
  const aTask = async (over: { readonly requires?: readonly string[] } = {}) => {
    const [row] = await db
      .insert(tasks)
      .values({
        type: `a-rung-${++seeded}`,
        title: `A rung ${seeded}`,
        description: 'What this task is, for a human reading the catalogue.',
        instructions: 'What the agent must actually do.',
        rewardReputation: 1,
        timeoutHours: 24,
        status: 'active',
        requiresSkills: [...(over.requires ?? [])],
      })
      .returning({ id: tasks.id })

    if (row === undefined) throw new Error('insert into tasks returned no row')
    return String(row.id)
  }

  /** A briefing that says something, which is the only kind worth pointing at. */
  const briefed = async (taskId: string, over: { readonly claims?: number } = {}) => {
    const claims = over.claims ?? 1
    /** `written_at` and `model` are set together — the table refuses one without the other. */
    await db.execute(sql`
      insert into task_briefings (task_id, claims, written_at, model)
      values (${taskId},
              ${sql.raw(
                `'${JSON.stringify(
                  Array.from({ length: claims }, () => ({
                    claim: 'The signup form refuses a generated address.',
                    citizens: 3,
                    platforms: {},
                  })),
                )}'::jsonb`,
              )},
              now(), 'a-model')
    `)
  }

  it('offers a task the citizen could attempt whose briefing says something', async () => {
    const taskId = await aTask()
    await briefed(taskId)

    expect(await obstacleAhead(db, agentId)).toEqual({
      taskId,
      title: expect.stringContaining('A rung'),
    })
  })

  /**
   * **The rejection case `#893` names**: not offered on a task the citizen
   * cannot attempt. `attemptableBy` is the rule, read from `tasks.ts` rather
   * than restated, so this also asserts the import did what it claims.
   */
  it('says nothing about a task whose skills the citizen does not hold', async () => {
    await briefed(await aTask({ requires: ['browser'] }))

    expect(await obstacleAhead(db, agentId)).toBeNull()
  })

  /**
   * A row exists as soon as a task is marked dirty. `written_at` separates
   * *nobody has synthesised this* from *this was synthesised*, and an empty
   * `claims` separates a corpus that produced a claim from one that produced
   * none — pointing at either sends a reader to an empty page.
   */
  it('says nothing about a briefing nobody has written', async () => {
    const taskId = await aTask()
    await db.execute(sql`insert into task_briefings (task_id, claims) values (${taskId}, '[]')`)

    expect(await obstacleAhead(db, agentId)).toBeNull()
  })

  it('says nothing about a written briefing that produced no claim', async () => {
    const taskId = await aTask()
    await db.execute(sql`
      insert into task_briefings (task_id, claims, written_at, model)
      values (${taskId}, '[]', now(), 'a-model')
    `)

    expect(await obstacleAhead(db, agentId)).toBeNull()
  })

  /**
   * **A task it attempted and did not pass is still offered**, which is the case
   * this exists for: an agent that stopped somewhere is exactly the reader a
   * write-up of where others stopped is worth something to. Only a pass takes it
   * off the list.
   */
  it('stops offering a task once the citizen has passed it', async () => {
    const taskId = await aTask()
    await briefed(taskId)

    /**
     * A verdict carries its moment — `submissions_verified_at_matches_status` —
     * and each attempt is numbered, which `submissions_task_agent_attempt_unique`
     * enforces.
     */
    await db.execute(sql`
      insert into submissions (agent_id, task_id, payload, status, attempt, verified_at)
      values (${agentId}, ${taskId}, '{}'::jsonb, 'failed', 1, now())
    `)
    expect((await obstacleAhead(db, agentId))?.taskId).toBe(taskId)

    await db.execute(sql`
      insert into submissions (agent_id, task_id, payload, status, attempt, verified_at)
      values (${agentId}, ${taskId}, '{}'::jsonb, 'passed', 2, now())
    `)
    expect(await obstacleAhead(db, agentId)).toBeNull()
  })

  it('says nothing at all when no task carries a briefing', async () => {
    await aTask()

    expect(await obstacleAhead(db, agentId)).toBeNull()
  })
})
