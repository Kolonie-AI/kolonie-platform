import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import type { Database } from './client.js'
import { connectForTests, databaseTestTarget, truncateAll } from './testing.js'
import { repairAtlasShelves } from './atlas-shelf.js'

const target = databaseTestTarget()

/**
 * Every catalogue entry on the shelf its kind names (`#917`).
 *
 * **Against a real Postgres and through raw SQL on the way in**, because the
 * rows this repairs cannot be written through `writeProviderRecipe` any more —
 * `#807` closed the `data-apis` fallback that produced them. A fixture that
 * could only construct the correct state would be testing that the repair does
 * nothing.
 */
describe('repairing the shelf a catalogue entry sits on', () => {
  let db: Database

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await truncateAll(db)
  })

  const entry = async (input: {
    readonly kind: string
    readonly provider: string
    readonly category: string
    readonly status?: string
    readonly title?: string
  }) => {
    /**
     * An offered entry has to carry at least one step and a proof
     * (`provider_recipes_joinable_has_steps`), which is right: an entry with no
     * steps is not a recipe. The fixture writes the shape a dressed entry has.
     */
    const steps = `[{"actor":"agent","instruction":"Fill in the signup form."}]`
    await db.execute(sql`
      insert into provider_recipes (kind, provider, title, category, status, steps, proves)
      values (${input.kind}, ${input.provider}, ${input.title ?? input.provider},
              ${input.category}, ${sql.raw(`'${input.status ?? 'joinable'}'`)},
              ${sql.raw(`'${steps}'::jsonb`)}, 'provider-mail')
    `)
  }

  const shelfOf = async (provider: string): Promise<string | undefined> => {
    const [row] = await db.execute<{ category: string }>(sql`
      select category from provider_recipes where provider = ${provider}
    `)

    return row?.category
  }

  /**
   * The measured case: `agentmessage.io` is the only phone provider any citizen
   * has proved, and it sat on `data-apis` from 2026-08-13 until this ran.
   */
  it('moves an entry filed under the old fallback onto the shelf its kind names', async () => {
    await entry({ kind: 'phone', provider: 'agentmessage.example', category: 'data-apis' })

    const result = await repairAtlasShelves(db)

    expect(result.moved).toBe(1)
    expect(await shelfOf('agentmessage.example')).toBe('telephony')
  })

  /** `#917`'s other half: a kind spelled as its own shelf now resolves. */
  it('moves an entry whose kind is a category name onto that category', async () => {
    await entry({ kind: 'code-hosting', provider: 'clawhub.example', category: 'data-apis' })

    expect((await repairAtlasShelves(db)).moved).toBe(1)
    expect(await shelfOf('clawhub.example')).toBe('code-hosting')
  })

  /**
   * **The rejection case in the acceptance criteria.** A shelf is the one field
   * on this row with a single correct value derivable from the row itself, and
   * repairing it must not be a licence to touch anything beside it — least of
   * all the status, which is what decides whether an agent is offered the route.
   */
  it('changes no other field of the entry it moves', async () => {
    await entry({
      kind: 'social',
      provider: 'ieji.example',
      category: 'data-apis',
      title: 'A name a steward wrote',
    })

    const before = await db.execute<Record<string, unknown>>(sql`
      select kind, provider, title, status, steps, proves, updated_at
        from provider_recipes where provider = 'ieji.example'
    `)

    await repairAtlasShelves(db)

    const after = await db.execute<Record<string, unknown>>(sql`
      select kind, provider, title, status, steps, proves, updated_at
        from provider_recipes where provider = 'ieji.example'
    `)

    expect(after[0]).toEqual(before[0])
    expect(await shelfOf('ieji.example')).toBe('social-publishing')
  })

  /**
   * **A kind with no shelf is left where it is**, on the same argument
   * `measuredOnlyRecipes` and `recordMeasuredProvider` already make: the
   * account-kind vocabulary is open, and moving `trello` somewhere plausible
   * would be the bug this repairs, written deliberately.
   */
  it('leaves an entry whose kind names no shelf exactly as it is', async () => {
    await entry({
      kind: 'trello',
      provider: 'trello.example',
      category: 'project-tracking',
      status: 'joinable',
    })

    const result = await repairAtlasShelves(db)

    expect(result).toEqual({ moved: 0, agreed: 0, unshelved: 1 })
    expect(await shelfOf('trello.example')).toBe('project-tracking')
  })

  /** Idempotent by construction: the second pass has nothing to move and says so. */
  it('reports nothing moved on a catalogue that already agrees', async () => {
    await entry({ kind: 'phone', provider: 'agentmessage.example', category: 'data-apis' })

    await repairAtlasShelves(db)
    const second = await repairAtlasShelves(db)

    expect(second).toEqual({ moved: 0, agreed: 1, unshelved: 0 })
  })

  /** The count is what the seed prints, so it has to separate the three states. */
  it('counts the moved, the agreeing and the unshelvable apart', async () => {
    await entry({ kind: 'phone', provider: 'wrong.example', category: 'data-apis' })
    await entry({ kind: 'mailbox', provider: 'right.example', category: 'mailbox' })
    await entry({ kind: 'trello', provider: 'unshelved.example', category: 'project-tracking' })

    expect(await repairAtlasShelves(db)).toEqual({ moved: 1, agreed: 1, unshelved: 1 })
  })
})
