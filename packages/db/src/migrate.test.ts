import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { createDatabase, type Database } from './client.js'
import { databaseTestTarget, MIGRATIONS_FOLDER, resetDatabase } from './testing.js'

const target = databaseTestTarget()

if (!target.available) {
  // Deliberately console, and deliberately at module scope: this has to be
  // visible before the reporter prints a tidy "skipped".
  console.warn(`\n${target.reason}\n`)
}

/**
 * The two properties a migration has to have before it is allowed near a live
 * database: it works on nothing, and running it twice is the same as running it
 * once. Both are cheap to assert and expensive to discover in production.
 */
describe.skipIf(!target.available)('the migrations', () => {
  let db: Database

  const objectCounts = async () => {
    const [row] = await db.execute<{ tables: string; enums: string; triggers: string }>(
      sql`select
            (select count(*)::text from information_schema.tables
              where table_schema = 'public' and table_type = 'BASE TABLE') as tables,
            (select count(distinct t.typname)::text from pg_type t
               join pg_enum e on e.enumtypid = t.oid
               join pg_namespace n on n.oid = t.typnamespace
              where n.nspname = 'public') as enums,
            (select count(*)::text from pg_trigger
              where not tgisinternal) as triggers`,
    )
    return row!
  }

  beforeAll(async () => {
    if (!target.available) return
    // `drop schema if exists` and drizzle's `create ... if not exists` both emit
    // notices; they are expected here and would only be noise in the report.
    db = createDatabase(target.url, { max: 1, onnotice: () => {} })
    // An empty database, not merely a truncated one — the schema itself is what
    // is under test here. This also drops drizzle's migration bookkeeping;
    // without that, `migrate()` would report success and create nothing.
    await resetDatabase(db)
  })

  afterAll(async () => {
    await db?.close()
  })

  it('applies to an empty database, then leaves it unchanged on re-run', async () => {
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER })
    const afterFirst = await objectCounts()

    // Drizzle's bookkeeping table is not among them — it lives in its own
    // schema, which is why `resetDatabase` has to drop that one too. Five of them
    // are the guidance subsystem: hints, struggles, tips and feedback (#52), plus
    // `moderations` (#70), which is to a verdict about an entry what
    // `verifications` is to a verdict about a submission.
    // Twenty-seven: `website_challenges` carries the website skill (#57),
    // `task_briefings` (#85) is the Colony's own write-up of a task — the shape
    // that replaced serving citizens' prose to citizens, `vision_challenges`
    // carries the vision skill (#77), and `solana_wallet_challenges` (#62) is
    // the address the Colony's on-chain half is built on. The last two are the
    // erasure boundary (#90): `erasures`, which records that a citizen left and
    // names nobody, and `ban_marks`, which is the only thing an erasure leaves
    // and only when the citizen was under sanction. `erasure_challenges` (#92)
    // makes twenty-eight — the two-step confirmation, which cascades from the
    // agent so that an attempt leaves no trace once the account is gone. And
    // `agent_vault` (#98) makes twenty-nine: the one table here whose contents
    // the Colony cannot read, sealed with the citizen's own key (D-043). And
    // `image_challenges` (#60) makes thirty — the visual specification the
    // Colony draws for a citizen, whose columns are the five things a vision
    // model is then asked about one by one. And `task_attempts` (#108) makes
    // thirty-one: one row per try, opened without asking the agent and closed
    // with an outcome including `abandoned`, which is what made the Colony's
    // most common failure — an attempt that never reached a submission —
    // countable for the first time. And back to **thirty** with #110, which is
    // the rare migration that removes more than it adds: `task_struggles`,
    // `task_tips` and `tip_feedback` become `task_reports` and
    // `report_feedback`, because the two were one concept with two names. And
    // `domain_challenges` makes **thirty-one** with the `domain` rung
    // (kolonie-docs#89): the citizen proves it controls a name's DNS rather than
    // a page on somebody else's host.
    // And `agent_runtime_declarations` makes **thirty-two** (#139): every model
    // and runtime version a citizen has declared, with when. The current values
    // are columns on `agents`; the history is what makes *which models get
    // through which rungs* answerable, and it cascades with the citizen.
    // And `agent_contacts` makes **thirty-three** (#141): when each citizen was
    // in contact, one row per bucket and pruned past its retention bound. It is
    // the record every question about rhythm, dormancy and returning is read
    // from, and the first table whose rows describe a citizen's behaviour
    // rather than its work.
    expect(afterFirst.tables).toBe('33')
    // Twenty: `task_kind` (#43) tells an Academy task from a Quest and therefore
    // what may pay coins; `support_ticket_kind` and `support_ticket_status` (#11)
    // carry what a citizen wrote about and where it stands; `erasure_reason` and
    // `ban_mark_kind` (#90) are closed lists precisely because the rows they sit
    // on must not carry free text. `task_attempt_outcome` and `attempt_opener`
    // (#108) make twenty-two — how a try ended, and what started it. And
    // `email_challenge_purpose` (kolonie-docs#92) makes twenty-three: it is what
    // keeps the granting mailbox node and the sending badge from satisfying each
    // other, the same discipline `browser_challenges.kind` holds one rung over.
    // And `runtime_field` makes twenty-four (#139) — which self-declared runtime
    // fact a history row is about. An enum although both fields hold free text,
    // and the two are not in tension: which field was written is the Colony's own
    // vocabulary and is closed, while what a vendor calls its model is not.
    expect(afterFirst.enums).toBe('24')
    // The deferred double-entry constraint trigger, on ledger_entries.
    expect(afterFirst.triggers).toBe('1')

    await expect(migrate(db, { migrationsFolder: MIGRATIONS_FOLDER })).resolves.not.toThrow()
    expect(await objectCounts()).toEqual(afterFirst)
  })
})
