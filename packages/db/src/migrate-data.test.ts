import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { createDatabase, type Database } from './client.js'
import type { JournalEntry } from './migrations.js'
import { databaseTestTarget, expectRejection, MIGRATIONS_FOLDER, resetDatabase } from './testing.js'

const target = databaseTestTarget()

/**
 * The journal as it is on disk, whole. `readJournal` hands back the entries and
 * nothing else, which is all anything else needs; here the `version` and
 * `dialect` beside them have to survive into the folder written below, because
 * that folder is handed to the same migrator that reads the real one.
 */
async function readWholeJournal(): Promise<{ readonly entries: readonly JournalEntry[] }> {
  const raw = await readFile(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8')

  return JSON.parse(raw) as { entries: JournalEntry[] }
}

/**
 * Build a migrations folder holding the entries given, with the named files
 * replaced by the text given, run something against it, and take it away again.
 *
 * **A journal and not a directory listing**, because that is what the migrator
 * reads: `readMigrationFiles` opens `meta/_journal.json` and then opens exactly
 * the `.sql` files its entries name. A journal truncated to the first *n*
 * entries is therefore a complete, valid migrations folder that stops at *n* —
 * which is the whole mechanism this file rests on, and the reason it needs no
 * fork of the migrator and no second implementation of what a migration is.
 */
async function inMigrationsFolder<T>(
  entries: readonly JournalEntry[],
  overrides: Readonly<Record<string, string>>,
  run: (folder: string) => Promise<T>,
): Promise<T> {
  const folder = await mkdtemp(join(tmpdir(), 'kolonie-migrations-'))
  try {
    const journal = await readWholeJournal()
    await mkdir(join(folder, 'meta'))
    await writeFile(join(folder, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries }))

    for (const entry of entries) {
      const override = overrides[entry.tag]
      if (override === undefined) {
        await copyFile(
          join(MIGRATIONS_FOLDER, `${entry.tag}.sql`),
          join(folder, `${entry.tag}.sql`),
        )
      } else {
        await writeFile(join(folder, `${entry.tag}.sql`), override)
      }
    }

    return await run(folder)
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
}

/**
 * Apply every migration up to and including `tag`, and stop there.
 *
 * The stop point is *before* the migration under test rather than after it, and
 * that is the point of the whole exercise: what the deploy does with the
 * remainder is run it in **one transaction**, so a fixture that stopped after
 * the schema half and before the data half would test the two apart and miss
 * exactly what `#1147` is about.
 */
async function migrateThrough(db: Database, tag: string): Promise<void> {
  const journal = await readWholeJournal()
  const upTo = journal.entries.findIndex((entry) => entry.tag === tag)
  if (upTo < 0) {
    throw new Error(`no migration named ${tag} in the journal`)
  }

  await inMigrationsFolder(journal.entries.slice(0, upTo + 1), {}, (folder) =>
    migrate(db, { migrationsFolder: folder }),
  )
}

/**
 * One migration that moves data, and the rows it is supposed to move.
 *
 * `after` is the migration to stop at before seeding — the one *before* the
 * first of the set under test, so that everything the deploy would run in a
 * single transaction is still pending when the rows are in place.
 */
interface DataMigrationCase {
  /** The migration this case exists for, for the name of the test. */
  readonly migration: string
  /** Migrate to here, then seed. */
  readonly after: string
  /** One line: what the migration moves, and what the fixture therefore puts in the way of it. */
  readonly moves: string
  /** Put rows in that the migration will have to move. Returns whatever `check` needs to find them. */
  seed(db: Database): Promise<Record<string, string>>
  /** Assert the rows arrived where the migration says they go. */
  check(db: Database, seeded: Record<string, string>): Promise<void>
}

/**
 * A name no live citizen holds. Nothing in a fixture may be a real identifier,
 * and a random suffix is also what keeps two cases from colliding on the unique
 * index over `agents.name`.
 */
const aName = (prefix: string) => `${prefix}-${randomUUID().slice(0, 8)}`

/**
 * **`0281` and `0282`, the pair this test was written for** (`#947`, `#1147`).
 *
 * `0282` moves every agent holding `steward` onto `warden`. On an empty database
 * its `where` clause matches nothing, the statement is a no-op, and the suite
 * reported green over a migration that failed the deploy — twice, on 2026-08-17,
 * before `634d65c3` rewrote `0281` to build the type afresh instead of adding a
 * value to it.
 *
 * The seed is three agents rather than one, and each answers a different
 * question: that a holder is moved, that a holder of *other* roles keeps them,
 * and that an agent the migration has no business touching is not touched.
 */
const theWardens: DataMigrationCase = {
  migration: '0282_the_wardens_are_the_stewards_that_were',
  after: '0280_atlas_categories_become_a_table',
  moves: 'every agent holding `steward` onto `warden`',

  async seed(db) {
    const insert = async (name: string, roles: string) => {
      const [row] = await db.execute<{ id: string }>(
        sql`insert into agents (name, platform, roles)
            values (${name}, 'openclaw', ${roles}::role[])
            returning id`,
      )
      return row!.id
    }

    return {
      onlySteward: await insert(aName('warden-case-only'), '{steward}'),
      alsoBuilder: await insert(aName('warden-case-also'), '{builder,steward}'),
      neither: await insert(aName('warden-case-neither'), '{builder}'),
    }
  },

  async check(db, seeded) {
    const rolesOf = async (id: string) => {
      const [row] = await db.execute<{ roles: string[] }>(
        sql`select roles::text[] as roles from agents where id = ${id}`,
      )
      return row!.roles
    }

    expect(await rolesOf(seeded['onlySteward']!)).toEqual(['warden'])
    // `array_remove` then append: the role it did not come for survives, and it
    // survives in place rather than being rewritten around the one that moved.
    expect(await rolesOf(seeded['alsoBuilder']!)).toEqual(['builder', 'warden'])
    expect(await rolesOf(seeded['neither']!)).toEqual(['builder'])

    // The office changed hands, so `authority_events` says so — with no actor,
    // because the actor was a migration and inventing one would be a lie in the
    // one table the Colony keeps so that *who let this happen* survives.
    const events = await db.execute<{ action: string; role: string; actor_id: string | null }>(
      sql`select action::text as action, role::text as role, actor_id
            from authority_events
           where subject_agent_id = ${seeded['onlySteward']!}
           order by action`,
    )
    expect(events.map((event) => `${event.action} ${event.role}`)).toEqual([
      'role-granted warden',
      'role-revoked steward',
    ])
    expect(events.every((event) => event.actor_id === null)).toBe(true)

    const [untouched] = await db.execute<{ count: string }>(
      sql`select count(*)::text as count from authority_events
           where subject_agent_id = ${seeded['neither']!}`,
    )
    expect(untouched!.count).toBe('0')
  },
}

const DATA_MIGRATIONS: readonly DataMigrationCase[] = [theWardens]

/**
 * **A migration that moves data, run against a database that has some**
 * (`#1147`).
 *
 * `migrate.test.ts` asserts the two properties a migration needs before it goes
 * near a live database — it works on nothing, and running it twice is running it
 * once — and both are asserted against an empty one. That is the right test and
 * it has a hole in the shape of a `where` clause: a statement that moves rows is
 * a no-op when there are none, so the suite exercises its syntax and never its
 * semantics. `0282` went through it green and failed the deploy.
 *
 * The other half of the hole is *where* the statement runs. The repository
 * already tests data migrations by keeping the statement in TypeScript beside a
 * test that runs it — `raster-rename.ts`, `credit-rename.ts`, `skill-backfill.ts`
 * — which proves the text does what it says, against a fully migrated schema, in
 * a transaction of its own. Neither of those is the transaction the deploy uses.
 * `0281` was split from `0282` precisely because Postgres refuses to use an enum
 * value in the transaction that added it, and the split bought nothing: Drizzle
 * runs **every pending migration in one transaction**, so two files were two
 * files and one transaction, and `55P04` arrived on the deploy.
 *
 * So each case here stops the migrator at the entry before the pair, seeds rows,
 * and then hands the remainder to `migrate()` against the real folder — which is
 * the deploy, statement for statement and transaction for transaction.
 *
 * **Adding a case.** Write a `DataMigrationCase`, put it in `DATA_MIGRATIONS`,
 * and point `after` at the journal entry *before* the first migration of the set.
 * Not every migration needs one — a migration that only moves the schema is
 * covered by the empty-database test, and one that moves data is not.
 */
describe('a migration that moves data', () => {
  let db: Database

  beforeAll(() => {
    // Both `resetDatabase` and Drizzle's `create ... if not exists` emit notices,
    // which are expected here and would only be noise in the report.
    db = createDatabase(target.url, { max: 1, onnotice: () => {} })
  })

  afterAll(async () => {
    await db?.close()
  })

  for (const testCase of DATA_MIGRATIONS) {
    it(`moves ${testCase.moves}`, async () => {
      await resetDatabase(db)
      await migrateThrough(db, testCase.after)

      const seeded = await testCase.seed(db)

      // The real folder, so that what runs is the deploy's own text and the
      // remainder goes in one transaction exactly as the deploy runs it.
      await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER })

      await testCase.check(db, seeded)
    })
  }

  /**
   * **The guard proves it has teeth, rather than being asserted to have them.**
   *
   * `#1147` asks for a test that fails if `0281` goes back to adding a value to
   * the enum instead of building the type afresh. The case above is already that
   * test — put the added value back and it is rejected — but it is rejected for
   * a reason that is stronger than the bug, and a guard that cannot tell those
   * apart is one nobody can read a failure from. So the pair is run here as it
   * shipped, and the difference between the two tests is one row.
   *
   * **Measured while writing this, and it is the finding rather than a detail.**
   * With the added value back and `0282` as it reads *today*, the migrator is
   * rejected whether or not a steward exists: every enum literal in it is a
   * constant, and a constant cast is folded at planning time, which raises
   * before a single row is looked at. With `0282` as it *shipped* — every value
   * reached through `roles::text[]`, on `0073`'s claim that going through `text`
   * resolves at runtime — the cast moves into the `set` clause and is evaluated
   * per matching row. On a database with nobody to move there are no matching
   * rows, so the statement was never once evaluated, on any database, by
   * anything. That is the hole, exactly: not a migration nobody tested, but one
   * whose test could not reach the half that mattered.
   *
   * **Both tests start at `0280` rather than at empty**, and that is not a
   * saving either. From scratch the whole journal is one transaction, so the
   * added value is rejected over `steward` — `0073` added *that* one the same
   * way — which is a true statement about a fresh database and is not the
   * deploy's failure. The deploy had `0073` committed three hundred migrations
   * ago and exactly this pair pending.
   */
  describe('the pair as it shipped', () => {
    /** `0281` and `0282` as they read in `fd1a01aa`, before `634d65c3` rewrote both. */
    const asShipped = {
      '0281_the_steward_becomes_a_warden': `ALTER TYPE "public"."role" ADD VALUE 'warden' BEFORE 'judge';`,
      // The statements only. The prose that came with them is in the file's own
      // history and in the two that replaced it; a copy here would be a second
      // account of a decision, going stale on its own.
      '0282_the_wardens_are_the_stewards_that_were': `
        with held as (
          select id, roles from agents where 'steward' = any(roles::text[])
        ),
        moved as (
          update agents a
             set roles = (array_remove(a.roles::text[], 'steward') || array['warden'])::role[],
                 updated_at = now()
            from held h where a.id = h.id
          returning a.id, a.roles as now_roles, h.roles as was_roles
        )
        insert into authority_events (actor_id, action, subject_agent_id, role)
        select null::uuid, 'role-revoked'::authority_action, m.id, r
          from moved m, unnest(m.was_roles) as r where r::text = 'steward'
        union all
        select null::uuid, 'role-granted'::authority_action, m.id, r
          from moved m, unnest(m.now_roles) as r where r::text = 'warden';`,
    }

    /** Everything up to `0280` committed, then the rest pending — which is the deploy. */
    const theDeploy = async () => {
      await resetDatabase(db)
      await migrateThrough(db, theWardens.after)

      return async () => {
        const journal = await readWholeJournal()
        await inMigrationsFolder(journal.entries, asShipped, (folder) =>
          migrate(db, { migrationsFolder: folder }),
        )
      }
    }

    it('is green on a database with no steward to move', async () => {
      const deploy = await theDeploy()

      await deploy()

      const [warden] = await db.execute<{ present: boolean }>(
        sql`select 'warden' = any(enum_range(null::role)::text[]) as present`,
      )
      expect(warden!.present).toBe(true)
    })

    it('is the failure the deploy saw, once one database holds a steward', async () => {
      const deploy = await theDeploy()
      await theWardens.seed(db)

      // Named, rather than `unsafe use of new value` alone: a from-scratch run
      // raises the same sentence about `steward`, and a guard that could not
      // tell those apart would be satisfied by the wrong bug.
      await expectRejection(deploy, /unsafe use of new value "warden"/i)
    })
  })
})
