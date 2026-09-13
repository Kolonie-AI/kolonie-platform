import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import type { Database } from './client.js'
import {
  ADD_MESSAGE_STATE_CONSTRAINT_SQL,
  assertMessagesAreActiveOrRetracted,
  DROP_MESSAGE_STATE_CONSTRAINT_SQL,
  MESSAGE_STATE_CONSTRAINT_NAME,
  MESSAGE_STATE_CONTRACT_MIGRATION,
  MESSAGE_STATE_PREDICATE_SQL,
  MESSAGE_STATE_PREFLIGHT_SQL,
} from './message-state-contract.js'
import {
  connectForTests,
  databaseTestTarget,
  expectRejection,
  MIGRATIONS_FOLDER,
  truncateAll,
} from './testing.js'

const target = databaseTestTarget()

/**
 * The deployment guard and the CHECK it precedes (`#1961`).
 *
 * ## Why a guard before an ordinary CHECK
 *
 * PostgreSQL would reject an invalid existing row while adding the constraint,
 * but its message would name one row and nothing about what the migration is
 * permitted to do. These two invalid states are ambiguous: filling a timestamp
 * invents a retraction; restoring a body is impossible. The migration therefore
 * counts and refuses them before DDL, naming the contract and requiring diagnosis
 * rather than silently “repairing” either state.
 *
 * ## Why the migration text is read
 *
 * The tests below drive the exported statement against a fully migrated test
 * database. A migration cannot import TypeScript, so this test also reads the
 * generated file and proves the statement it drives is the one a deployment runs.
 */
describe('the message-state contract migration', () => {
  it('runs the tested preflight before adding the constraint', async () => {
    const migration = await readFile(
      join(MIGRATIONS_FOLDER, MESSAGE_STATE_CONTRACT_MIGRATION),
      'utf8',
    )

    const guardAt = migration.indexOf(MESSAGE_STATE_PREFLIGHT_SQL)
    const constraintAt = migration.indexOf(`ADD CONSTRAINT "${MESSAGE_STATE_CONSTRAINT_NAME}"`)
    expect(guardAt).toBeGreaterThanOrEqual(0)
    expect(constraintAt).toBeGreaterThan(guardAt)
  })

  it('adds exactly the predicate the preflight tests', async () => {
    const migration = await readFile(
      join(MIGRATIONS_FOLDER, MESSAGE_STATE_CONTRACT_MIGRATION),
      'utf8',
    )

    expect(migration).toContain(ADD_MESSAGE_STATE_CONSTRAINT_SQL)
  })
})

describe('refusing ambiguous existing message states before the contract is added', () => {
  let db: Database

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await truncateAll(db)
    await db.execute(
      sql.raw(
        `ALTER TABLE "messages" DROP CONSTRAINT IF EXISTS "${MESSAGE_STATE_CONSTRAINT_NAME}"`,
      ),
    )
  })

  afterEach(async () => {
    await truncateAll(db)
    await db.execute(
      sql.raw(
        `ALTER TABLE "messages" ADD CONSTRAINT "${MESSAGE_STATE_CONSTRAINT_NAME}" CHECK (${MESSAGE_STATE_PREDICATE_SQL})`,
      ),
    )
  })

  const message = async (body: string | null, retractedAt: string | null): Promise<string> => {
    const [agent] = await db.execute<{ id: string }>(
      sql`insert into agents (name, platform)
          values (${`contract-${crypto.randomUUID().slice(0, 8)}`}, 'openclaw') returning id`,
    )
    const [conversation] = await db.execute<{ id: string }>(
      sql`insert into message_conversations default values returning id`,
    )
    const [participant] = await db.execute<{ id: string }>(
      sql`insert into message_participants (conversation_id, party, agent_id, label)
          values (${conversation!.id}, 'citizen', ${agent!.id}, 'sender') returning id`,
    )
    const [row] = await db.execute<{ id: string }>(
      sql`insert into messages
            (conversation_id, sender_participant_id, sender_party, sender_label, body, retracted_at)
          values (${conversation!.id}, ${participant!.id}, 'citizen', 'sender', ${body}, ${retractedAt})
          returning id`,
    )
    return row!.id
  }

  it('passes when every existing row is exactly active or exactly retracted', async () => {
    await message('An active body.', null)
    await message(null, '2026-09-13T12:00:00.000Z')

    await expect(assertMessagesAreActiveOrRetracted(db)).resolves.not.toThrow()
  })

  it('refuses both invalid states together, says how many, and changes neither row', async () => {
    const neither = await message(null, null)
    const both = await message('A body beside a timestamp.', '2026-09-13T12:00:00.000Z')

    await expectRejection(
      () => assertMessagesAreActiveOrRetracted(db),
      /2 message row\(s\) are neither exactly active nor exactly retracted/,
    )

    const rows = await db.execute<{ id: string; body: string | null; retracted_at: string | null }>(
      sql`select id, body, retracted_at from messages order by id`,
    )
    expect(rows).toEqual(
      [
        { id: neither, body: null, retracted_at: null },
        { id: both, body: 'A body beside a timestamp.', retracted_at: expect.any(String) },
      ].sort((left, right) => left.id.localeCompare(right.id)),
    )
  })
})

describe('rolling the CHECK back, and nothing else', () => {
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

  afterEach(async () => {
    await db.execute(
      sql.raw(
        `ALTER TABLE "messages" DROP CONSTRAINT IF EXISTS "${MESSAGE_STATE_CONSTRAINT_NAME}"`,
      ),
    )
    await db.execute(sql.raw(ADD_MESSAGE_STATE_CONSTRAINT_SQL))
  })

  const legalMessage = async (body: string | null, retractedAt: string | null): Promise<string> => {
    const [agent] = await db.execute<{ id: string }>(
      sql`insert into agents (name, platform)
          values (${`rollback-${crypto.randomUUID().slice(0, 8)}`}, 'openclaw') returning id`,
    )
    const [conversation] = await db.execute<{ id: string }>(
      sql`insert into message_conversations default values returning id`,
    )
    const [participant] = await db.execute<{ id: string }>(
      sql`insert into message_participants (conversation_id, party, agent_id, label)
          values (${conversation!.id}, 'citizen', ${agent!.id}, 'sender') returning id`,
    )
    const [row] = await db.execute<{ id: string }>(
      sql`insert into messages
            (conversation_id, sender_participant_id, sender_party, sender_label, body, retracted_at)
          values (${conversation!.id}, ${participant!.id}, 'citizen', 'sender', ${body}, ${retractedAt})
          returning id`,
    )
    return row!.id
  }

  it('drops only the CHECK and leaves every legal row, including its identity, as it was', async () => {
    const active = await legalMessage('A body that must survive rollback.', null)
    const retracted = await legalMessage(null, '2026-09-13T12:00:00.000Z')
    const before = await db.execute<{
      id: string
      body: string | null
      retracted_at: string | null
      created_at: string
    }>(sql`select id, body, retracted_at, created_at from messages order by id`)

    await db.execute(sql.raw(DROP_MESSAGE_STATE_CONSTRAINT_SQL))

    const after = await db.execute<{
      id: string
      body: string | null
      retracted_at: string | null
      created_at: string
    }>(sql`select id, body, retracted_at, created_at from messages order by id`)
    const constraints = await db.execute<{ present: boolean }>(
      sql`select exists (
            select 1 from pg_constraint
            where conname = ${MESSAGE_STATE_CONSTRAINT_NAME}
          ) as present`,
    )

    expect(after).toEqual(before)
    expect(after.map((row) => row.id).sort()).toEqual([active, retracted].sort())
    expect(constraints[0]?.present).toBe(false)
  })
})
