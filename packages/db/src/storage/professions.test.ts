import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import type { ProfessionDefinition } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { agents } from '../schema/agents.js'
import { humans } from '../schema/humans.js'
import { agentProfessions, professionVersions, professions } from '../schema/professions.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import {
  assignProfession,
  listActiveProfessions,
  listProfessionsForMaintainer,
  publishProfession,
  readProfession,
  retireProfession,
} from './professions.js'

const definition = (key = 'software-producer', version = 1): ProfessionDefinition => ({
  key,
  version,
  title: 'Software Producer',
  summary: 'Builds useful software.',
  vision: 'Useful software becomes durable.',
  mission: 'Find a real problem and ship a running solution.',
  intendedImpact: 'People solve a concrete problem.',
  audience: 'People with that problem.',
  successSignals: ['Independently observable use'],
  principles: ['Own the product lifecycle'],
  failureModes: ['A graveyard of demos'],
  boundaries: ['Use only authorised systems and data'],
  workplaceOrientation: 'Carry the current product bet on the citizen-owned board.',
})

const target = databaseTestTarget()

describe('profession registry', () => {
  let db: Database
  let publisherId: string

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })
  afterAll(async () => db?.close())
  beforeEach(async () => {
    await truncateAll(db)
    const [publisher] = await db.insert(humans).values({}).returning({ id: humans.id })
    publisherId = publisher!.id
  })

  it('lists only active profession summaries in stable-key order', async () => {
    await publishProfession(db, { expectedVersion: null, definition: definition(), publisherId })
    await publishProfession(db, {
      expectedVersion: null,
      definition: definition('citizen-mentor'),
      publisherId,
    })
    await publishProfession(db, {
      expectedVersion: null,
      definition: definition('retired-builder'),
      publisherId,
    })
    await retireProfession(db, { key: 'retired-builder', expectedVersion: 1 })

    expect(await listActiveProfessions(db)).toEqual([
      {
        key: 'citizen-mentor',
        title: 'Software Producer',
        summary: 'Builds useful software.',
        version: 1,
      },
      {
        key: 'software-producer',
        title: 'Software Producer',
        summary: 'Builds useful software.',
        version: 1,
      },
    ])
  })

  it('publishes immutable gap-free versions and resolves assignments through the current pointer', async () => {
    expect(
      await publishProfession(db, { expectedVersion: null, definition: definition(), publisherId }),
    ).toMatchObject({
      outcome: 'published',
      profession: { key: 'software-producer', lifecycle: 'active', currentVersion: 1 },
    })
    const [agent] = await db
      .insert(agents)
      .values({ name: 'producer', platform: 'claude' })
      .returning()
    expect(
      await assignProfession(db, {
        agentId: agent!.id,
        key: 'software-producer',
        expectedVersion: null,
      }),
    ).toMatchObject({
      outcome: 'assigned',
      assignment: { key: 'software-producer', assignmentVersion: 1 },
    })

    const second = { ...definition('software-producer', 2), summary: 'Builds software people use.' }
    expect(
      await publishProfession(db, { expectedVersion: 1, definition: second, publisherId }),
    ).toMatchObject({
      outcome: 'published',
      profession: { currentVersion: 2 },
    })
    expect((await readProfession(db, 'software-producer'))?.definition.summary).toBe(second.summary)
    expect((await readProfession(db, 'software-producer', 1))?.definition.summary).toBe(
      definition().summary,
    )
    const assignment = await db.select().from(agentProfessions)
    expect(assignment).toHaveLength(1)
    expect(assignment[0]).toMatchObject({
      professionKey: 'software-producer',
      assignmentVersion: 1,
    })
    expect(assignment[0]).not.toHaveProperty('definitionVersion')
  })

  it('returns the assignment and current definition from one atomic choice', async () => {
    await publishProfession(db, { expectedVersion: null, definition: definition(), publisherId })
    const [agent] = await db
      .insert(agents)
      .values({ name: 'resolved-choice', platform: 'claude' })
      .returning()

    expect(
      await assignProfession(db, {
        agentId: agent!.id,
        key: 'software-producer',
        expectedVersion: null,
      }),
    ).toMatchObject({
      outcome: 'assigned',
      definition: definition(),
      lifecycle: 'active',
    })
  })

  it('checks assignment concurrency before same-key idempotency and reads back a retired assignment', async () => {
    await publishProfession(db, { expectedVersion: null, definition: definition(), publisherId })
    const [agent] = await db
      .insert(agents)
      .values({ name: 'idempotent', platform: 'claude' })
      .returning()
    const first = await assignProfession(db, {
      agentId: agent!.id,
      key: 'software-producer',
      expectedVersion: null,
    })
    if (first.outcome !== 'assigned') throw new Error('fixture failed to assign profession')

    expect(
      await assignProfession(db, {
        agentId: agent!.id,
        key: 'software-producer',
        expectedVersion: null,
      }),
    ).toMatchObject({ outcome: 'conflict', assignmentVersion: 1 })

    const before = await db
      .select()
      .from(agentProfessions)
      .where(eq(agentProfessions.agentId, agent!.id))
    expect(
      await assignProfession(db, {
        agentId: agent!.id,
        key: 'software-producer',
        expectedVersion: 1,
      }),
    ).toEqual(first)
    expect(
      await db.select().from(agentProfessions).where(eq(agentProfessions.agentId, agent!.id)),
    ).toEqual(before)

    await retireProfession(db, { key: 'software-producer', expectedVersion: 1 })
    expect(
      await assignProfession(db, {
        agentId: agent!.id,
        key: 'software-producer',
        expectedVersion: 1,
      }),
    ).toMatchObject({
      outcome: 'assigned',
      assignment: first.assignment,
      definition: definition(),
      lifecycle: 'retired',
    })
  })

  it('guards assignment concurrency and never imports legacy prose', async () => {
    await publishProfession(db, { expectedVersion: null, definition: definition(), publisherId })
    const [agent] = await db
      .insert(agents)
      .values({ name: 'legacy', platform: 'claude', profession: 'Software Producer' })
      .returning()
    expect(await db.select().from(agentProfessions)).toHaveLength(0)
    await assignProfession(db, {
      agentId: agent!.id,
      key: 'software-producer',
      expectedVersion: null,
    })
    expect(
      await assignProfession(db, {
        agentId: agent!.id,
        key: 'software-producer',
        expectedVersion: null,
      }),
    ).toMatchObject({ outcome: 'conflict', assignmentVersion: 1 })
  })

  it('rejects stale, duplicate, skipped, and document identity mismatch without moving the pointer', async () => {
    await publishProfession(db, { expectedVersion: null, definition: definition(), publisherId })
    await expect(
      publishProfession(db, {
        expectedVersion: 0,
        definition: definition('software-producer', 2),
        publisherId,
      }),
    ).resolves.toMatchObject({ outcome: 'conflict' })
    await expect(
      publishProfession(db, {
        expectedVersion: 1,
        definition: definition('software-producer', 3),
        publisherId,
      }),
    ).resolves.toMatchObject({ outcome: 'invalid-version' })
    await expect(
      db.insert(professionVersions).values({
        professionKey: 'software-producer',
        version: 2,
        definition: definition('citizen-mentor', 2),
        publishedByHumanId: publisherId,
      }),
    ).rejects.toThrow()
    expect((await readProfession(db, 'software-producer'))?.profession.currentVersion).toBe(1)
    expect(
      await db
        .select()
        .from(professionVersions)
        .where(eq(professionVersions.professionKey, 'software-producer')),
    ).toHaveLength(1)
  })

  it('records the publisher and rejects an invalid key before any row is written', async () => {
    const published = await publishProfession(db, {
      expectedVersion: null,
      definition: definition(),
      publisherId,
    })
    expect(published.outcome).toBe('published')
    expect((await db.select().from(professionVersions))[0]?.publishedByHumanId).toBe(publisherId)
    expect((await readProfession(db, 'software-producer'))?.publication).toMatchObject({
      publishedByHumanId: publisherId,
      publishedAt: expect.any(String),
    })

    await expect(
      publishProfession(db, {
        expectedVersion: null,
        definition: definition('Invalid Key'),
        publisherId,
      }),
    ).rejects.toThrow()
    expect(await db.select().from(professions)).toHaveLength(1)
  })

  it('rejects a stale retirement without changing lifecycle or history', async () => {
    await publishProfession(db, { expectedVersion: null, definition: definition(), publisherId })

    expect(
      await retireProfession(db, { key: 'software-producer', expectedVersion: 2 }),
    ).toMatchObject({ outcome: 'conflict', currentVersion: 1 })
    expect(await readProfession(db, 'software-producer')).toMatchObject({
      profession: { lifecycle: 'active', currentVersion: 1, retiredAt: null },
    })
    expect(await db.select().from(professionVersions)).toHaveLength(1)
  })

  it('keeps immutable history when the publisher erases the human account', async () => {
    await publishProfession(db, { expectedVersion: null, definition: definition(), publisherId })

    await db.delete(humans).where(eq(humans.id, publisherId))

    expect(await readProfession(db, 'software-producer')).toMatchObject({
      definition: definition(),
      publication: { publishedAt: expect.any(String), publishedByHumanId: null },
    })
  })

  it('refuses direct mutation or deletion of an immutable published version', async () => {
    await publishProfession(db, { expectedVersion: null, definition: definition(), publisherId })

    await expect(
      db
        .update(professionVersions)
        .set({ definition: { ...definition(), summary: 'Rewritten history.' } })
        .where(eq(professionVersions.professionKey, 'software-producer')),
    ).rejects.toThrow('Failed query: update "profession_versions"')
    await expect(
      db
        .delete(professionVersions)
        .where(eq(professionVersions.professionKey, 'software-producer')),
    ).rejects.toThrow('Failed query: delete from "profession_versions"')
    expect((await readProfession(db, 'software-producer'))?.definition).toEqual(definition())
  })

  it('has one winner when two first publications race at the same key', async () => {
    const attempts = await Promise.allSettled([
      publishProfession(db, {
        expectedVersion: null,
        definition: definition('new-profession'),
        publisherId,
      }),
      publishProfession(db, {
        expectedVersion: null,
        definition: definition('new-profession'),
        publisherId,
      }),
    ])

    expect(
      attempts.filter(
        (attempt) => attempt.status === 'fulfilled' && attempt.value.outcome === 'published',
      ),
    ).toHaveLength(1)
    expect(
      attempts.filter(
        (attempt) =>
          attempt.status === 'rejected' ||
          (attempt.status === 'fulfilled' && attempt.value.outcome !== 'published'),
      ),
    ).toHaveLength(1)
    expect(
      await db
        .select()
        .from(professionVersions)
        .where(eq(professionVersions.professionKey, 'new-profession')),
    ).toHaveLength(1)
    expect((await readProfession(db, 'new-profession'))?.profession.currentVersion).toBe(1)
  })

  it('has one winner when two first assignments race for the same citizen', async () => {
    await publishProfession(db, { expectedVersion: null, definition: definition(), publisherId })
    await publishProfession(db, {
      expectedVersion: null,
      definition: definition('citizen-mentor'),
      publisherId,
    })
    const [agent] = await db
      .insert(agents)
      .values({ name: 'choosing', platform: 'claude' })
      .returning()

    const attempts = await Promise.all([
      assignProfession(db, {
        agentId: agent!.id,
        key: 'software-producer',
        expectedVersion: null,
      }),
      assignProfession(db, {
        agentId: agent!.id,
        key: 'citizen-mentor',
        expectedVersion: null,
      }),
    ])

    expect(attempts.filter((attempt) => attempt.outcome === 'assigned')).toHaveLength(1)
    expect(attempts.filter((attempt) => attempt.outcome === 'conflict')).toHaveLength(1)
    expect(await db.select().from(agentProfessions)).toHaveLength(1)
  })

  it('rolls back a failed current-pointer update', async () => {
    await db.execute(
      sql`create or replace function fail_profession_pointer() returns trigger language plpgsql as $$ begin if new.current_version = 2 then raise exception 'pointer failed'; end if; return new; end $$`,
    )
    await db.execute(
      sql`create trigger fail_profession_pointer before update on professions for each row execute function fail_profession_pointer()`,
    )
    try {
      await publishProfession(db, { expectedVersion: null, definition: definition(), publisherId })
      await expect(
        publishProfession(db, {
          expectedVersion: 1,
          definition: definition('software-producer', 2),
          publisherId,
        }),
      ).rejects.toThrow('Failed query: update "professions"')
      expect(
        await db
          .select()
          .from(professionVersions)
          .where(eq(professionVersions.professionKey, 'software-producer')),
      ).toHaveLength(1)
    } finally {
      await db.execute(sql`drop trigger if exists fail_profession_pointer on professions`)
      await db.execute(sql`drop function if exists fail_profession_pointer()`)
    }
  })

  it('retires once, preserves history, prevents new selection, and cascades the existing assignment on erasure', async () => {
    await publishProfession(db, { expectedVersion: null, definition: definition(), publisherId })
    const [assigned, unassigned] = await db
      .insert(agents)
      .values([
        { name: 'assigned', platform: 'claude' },
        { name: 'unassigned', platform: 'claude', profession: 'Software Producer' },
      ])
      .returning()
    await assignProfession(db, {
      agentId: assigned!.id,
      key: 'software-producer',
      expectedVersion: null,
    })
    expect(
      await retireProfession(db, { key: 'software-producer', expectedVersion: 1 }),
    ).toMatchObject({ outcome: 'retired' })
    expect(
      await retireProfession(db, { key: 'software-producer', expectedVersion: 1 }),
    ).toMatchObject({ outcome: 'invalid-transition' })
    expect(
      await assignProfession(db, {
        agentId: unassigned!.id,
        key: 'software-producer',
        expectedVersion: null,
      }),
    ).toMatchObject({ outcome: 'unavailable' })
    expect(await listProfessionsForMaintainer(db)).toMatchObject([{ priorVersions: [1] }])
    expect(
      await db.select().from(agentProfessions).where(eq(agentProfessions.agentId, unassigned!.id)),
    ).toHaveLength(0)
    await db.delete(agents).where(eq(agents.id, assigned!.id))
    expect(await db.select().from(agentProfessions)).toHaveLength(0)
    expect(await db.select().from(professions)).toHaveLength(1)
  })
})
