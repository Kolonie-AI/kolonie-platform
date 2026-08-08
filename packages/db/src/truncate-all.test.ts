import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import type { Database } from './client.js'
import { agents } from './schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from './testing.js'

const target = databaseTestTarget()

/**
 * **A table that hangs off nothing used to survive into the next test** (`#556`).
 *
 * `truncateAll` named its tables and let `cascade` from `agents` reach the rest,
 * so a table with no foreign key to anything in that list was never truncated at
 * all — and the failure did not look like leakage. It looked like a wrong count,
 * a duplicate insert, or a precedence bug in whichever test ran next. Five tables
 * arrived in that state and every one cost somebody a wrong diagnosis first.
 *
 * What is asserted here is the property that replaced the list: a table nobody
 * has told this function about is emptied anyway.
 */
describe('truncateAll', () => {
  let db: Database

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.execute(sql`drop table if exists a_table_nobody_listed`)
    await db?.close()
  })

  it('empties a table it was never told about, with no foreign key to anything', async () => {
    await db.execute(
      sql`create table if not exists a_table_nobody_listed (id serial primary key, note text)`,
    )
    await db.execute(
      sql`insert into a_table_nobody_listed (note) values ('written by an earlier test')`,
    )

    await truncateAll(db)

    const [row] = await db.execute(sql`select count(*)::int as count from a_table_nobody_listed`)
    expect((row as { count: number }).count).toBe(0)
  })

  /**
   * `restart identity` was on the old statement and is on this one. A serial that
   * kept counting across tests is the same class of leak one level down: nothing
   * fails, and then something asserts on an id.
   */
  it('restarts identity, so the next test sees the same ids as the first', async () => {
    await db.execute(
      sql`create table if not exists a_table_nobody_listed (id serial primary key, note text)`,
    )

    await truncateAll(db)
    await db.execute(sql`insert into a_table_nobody_listed (note) values ('first')`)
    const [before] = await db.execute(sql`select max(id)::int as id from a_table_nobody_listed`)

    await truncateAll(db)
    await db.execute(sql`insert into a_table_nobody_listed (note) values ('first again')`)
    const [after] = await db.execute(sql`select max(id)::int as id from a_table_nobody_listed`)

    expect((after as { id: number }).id).toBe((before as { id: number }).id)
  })

  /** The ordinary case, which the named list did handle and which must not regress. */
  it('still empties a table the cascade used to reach', async () => {
    await db.insert(agents).values({ name: 'left-behind', platform: 'openclaw' })

    await truncateAll(db)

    expect(await db.select().from(agents)).toEqual([])
  })

  /**
   * **It reads `public` and only `public`.** The migrations bookkeeping lives in
   * its own schema, and a `truncateAll` that reached it would make every later
   * `connectForTests` re-run every migration against a schema that already has
   * them.
   */
  it('leaves the migration record alone', async () => {
    const [before] = await db.execute(
      sql`select count(*)::int as count from information_schema.tables where table_schema <> 'public' and table_schema not in ('pg_catalog', 'information_schema')`,
    )

    await truncateAll(db)

    const [after] = await db.execute(
      sql`select count(*)::int as count from information_schema.tables where table_schema <> 'public' and table_schema not in ('pg_catalog', 'information_schema')`,
    )
    expect((after as { count: number }).count).toBe((before as { count: number }).count)
  })
})
