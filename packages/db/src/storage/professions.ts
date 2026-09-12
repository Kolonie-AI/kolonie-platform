import { and, asc, eq, sql } from 'drizzle-orm'
import {
  ProfessionDefinitionSchema,
  type ProfessionAssignment,
  type ProfessionCatalogueSummary,
  type ProfessionDefinition,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { agentProfessions, professionVersions, professions } from '../schema/professions.js'

export type ProfessionPublication = {
  readonly profession: {
    readonly key: string
    readonly lifecycle: 'active' | 'retired'
    readonly currentVersion: number
    readonly publishedAt: string
    readonly retiredAt?: string | null
  }
  readonly definition: ProfessionDefinition
  readonly publication: {
    readonly publishedAt: string
    readonly publishedByHumanId: string | null
  }
}

export type PublishProfessionResult =
  | ({ readonly outcome: 'published' } & ProfessionPublication)
  | { readonly outcome: 'conflict'; readonly currentVersion: number | null }
  | { readonly outcome: 'invalid-version' }
  | { readonly outcome: 'invalid-transition' }

const publication = (
  profession: typeof professions.$inferSelect,
  version: typeof professionVersions.$inferSelect,
): ProfessionPublication => ({
  profession: {
    key: profession.key,
    lifecycle: profession.lifecycle as 'active' | 'retired',
    currentVersion: profession.currentVersion,
    publishedAt: version.publishedAt,
    retiredAt: profession.retiredAt,
  },
  definition: ProfessionDefinitionSchema.parse(version.definition),
  publication: {
    publishedAt: version.publishedAt,
    publishedByHumanId: version.publishedByHumanId,
  },
})

/** Publishes one complete next version and moves its pointer atomically. */
export async function publishProfession(
  db: Database,
  input: {
    readonly expectedVersion: number | null
    readonly definition: ProfessionDefinition
    readonly publisherId: string | null
  },
): Promise<PublishProfessionResult> {
  const definition = ProfessionDefinitionSchema.parse(input.definition)

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended('profession-publication:' || ${definition.key}, 0))`,
    )
    const [current] = await tx
      .select()
      .from(professions)
      .where(eq(professions.key, definition.key))
      .for('update')
      .limit(1)

    if ((current?.currentVersion ?? null) !== input.expectedVersion) {
      return { outcome: 'conflict', currentVersion: current?.currentVersion ?? null }
    }
    if (definition.version !== (input.expectedVersion ?? 0) + 1) {
      return { outcome: 'invalid-version' }
    }
    if (current?.lifecycle === 'retired') return { outcome: 'invalid-transition' }

    if (current === undefined) {
      await tx.insert(professions).values({
        key: definition.key,
        lifecycle: 'active',
        currentVersion: definition.version,
      })
    }
    const [version] = await tx
      .insert(professionVersions)
      .values({
        professionKey: definition.key,
        version: definition.version,
        definition,
        publishedByHumanId: input.publisherId,
      })
      .returning()
    if (version === undefined) throw new Error('profession version insert returned no row')

    const [updated] =
      current === undefined
        ? await tx.select().from(professions).where(eq(professions.key, definition.key)).limit(1)
        : await tx
            .update(professions)
            .set({ currentVersion: definition.version })
            .where(
              and(
                eq(professions.key, definition.key),
                eq(professions.currentVersion, input.expectedVersion!),
                eq(professions.lifecycle, 'active'),
              ),
            )
            .returning()
    if (updated === undefined) throw new Error('profession current pointer update returned no row')
    return { outcome: 'published', ...publication(updated, version) }
  })
}

/** Resolves either the current pointer or one immutable historical version. */
export async function readProfession(
  db: Database,
  key: string,
  version?: number,
): Promise<ProfessionPublication | null> {
  const [row] = await db
    .select({ profession: professions, version: professionVersions })
    .from(professions)
    .innerJoin(
      professionVersions,
      and(
        eq(professionVersions.professionKey, professions.key),
        eq(professionVersions.version, version ?? professions.currentVersion),
      ),
    )
    .where(eq(professions.key, key))
    .limit(1)
  return row === undefined ? null : publication(row.profession, row.version)
}

/** Lists the compact active catalogue without exposing full profession constitutions. */
export async function listActiveProfessions(db: Database): Promise<ProfessionCatalogueSummary[]> {
  const rows = await db
    .select({ profession: professions, version: professionVersions })
    .from(professions)
    .innerJoin(
      professionVersions,
      and(
        eq(professionVersions.professionKey, professions.key),
        eq(professionVersions.version, professions.currentVersion),
      ),
    )
    .where(eq(professions.lifecycle, 'active'))
    .orderBy(asc(professions.key))

  return rows.map(({ version }) => {
    const definition = ProfessionDefinitionSchema.parse(version.definition)
    return {
      key: definition.key,
      title: definition.title,
      summary: definition.summary,
      version: definition.version,
    }
  })
}

/** Lists full current definitions and numbered history for maintainers. */
export async function listProfessionsForMaintainer(db: Database) {
  const rows = await db
    .select({ profession: professions, version: professionVersions })
    .from(professions)
    .innerJoin(
      professionVersions,
      and(
        eq(professionVersions.professionKey, professions.key),
        eq(professionVersions.version, professions.currentVersion),
      ),
    )
    .orderBy(asc(professions.key))
  return Promise.all(
    rows.map(async (row) => ({
      ...publication(row.profession, row.version),
      priorVersions: (
        await db
          .select({ version: professionVersions.version })
          .from(professionVersions)
          .where(eq(professionVersions.professionKey, row.profession.key))
          .orderBy(asc(professionVersions.version))
      ).map((entry) => entry.version),
    })),
  )
}

/** Retires a key while preserving its last current definition for assignees. */
export async function retireProfession(
  db: Database,
  input: { readonly key: string; readonly expectedVersion: number },
): Promise<
  | { readonly outcome: 'retired'; readonly profession: ProfessionPublication['profession'] }
  | { readonly outcome: 'conflict'; readonly currentVersion: number | null }
  | { readonly outcome: 'invalid-transition' }
> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(professions)
      .where(eq(professions.key, input.key))
      .for('update')
      .limit(1)
    if (current === undefined || current.currentVersion !== input.expectedVersion) {
      return { outcome: 'conflict', currentVersion: current?.currentVersion ?? null }
    }
    if (current.lifecycle !== 'active') return { outcome: 'invalid-transition' }
    const retiredAt = new Date().toISOString()
    const [retired] = await tx
      .update(professions)
      .set({ lifecycle: 'retired', retiredAt })
      .where(and(eq(professions.key, input.key), eq(professions.lifecycle, 'active')))
      .returning()
    if (retired === undefined) throw new Error('profession retirement returned no row')
    const [version] = await tx
      .select()
      .from(professionVersions)
      .where(
        and(
          eq(professionVersions.professionKey, input.key),
          eq(professionVersions.version, retired.currentVersion),
        ),
      )
      .limit(1)
    if (version === undefined) throw new Error('profession current version is missing')
    return { outcome: 'retired', profession: publication(retired, version).profession }
  })
}

/** Writes one stable-key choice with optimistic assignment concurrency and resolves it atomically. */
export async function assignProfession(
  db: Database,
  input: {
    readonly agentId: string
    readonly key: string
    readonly expectedVersion: number | null
  },
): Promise<
  | {
      readonly outcome: 'assigned'
      readonly assignment: ProfessionAssignment
      readonly definition: ProfessionDefinition
      readonly lifecycle: 'active' | 'retired'
    }
  | { readonly outcome: 'conflict'; readonly assignmentVersion: number | null }
  | { readonly outcome: 'unavailable'; readonly reason: 'not-found' | 'inactive' }
> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended('profession-assignment:' || ${input.agentId}, 0))`,
    )
    const [current] = await tx
      .select()
      .from(agentProfessions)
      .where(eq(agentProfessions.agentId, input.agentId))
      .for('update')
      .limit(1)
    if ((current?.assignmentVersion ?? null) !== input.expectedVersion) {
      return { outcome: 'conflict', assignmentVersion: current?.assignmentVersion ?? null }
    }
    if (current?.professionKey === input.key) {
      const [profession] = await tx
        .select({ profession: professions, version: professionVersions })
        .from(professions)
        .innerJoin(
          professionVersions,
          and(
            eq(professionVersions.professionKey, professions.key),
            eq(professionVersions.version, professions.currentVersion),
          ),
        )
        .where(eq(professions.key, input.key))
        .for('update', { of: professions })
        .limit(1)
      if (profession === undefined) throw new Error('assigned profession is missing')
      return {
        outcome: 'assigned',
        assignment: {
          key: current.professionKey,
          chosenAt: current.chosenAt,
          assignmentVersion: current.assignmentVersion,
        },
        definition: ProfessionDefinitionSchema.parse(profession.version.definition),
        lifecycle: profession.profession.lifecycle as 'active' | 'retired',
      }
    }
    const [profession] = await tx
      .select({ profession: professions, version: professionVersions })
      .from(professions)
      .innerJoin(
        professionVersions,
        and(
          eq(professionVersions.professionKey, professions.key),
          eq(professionVersions.version, professions.currentVersion),
        ),
      )
      .where(eq(professions.key, input.key))
      .for('update', { of: professions })
      .limit(1)
    if (profession === undefined) return { outcome: 'unavailable', reason: 'not-found' }
    if (profession.profession.lifecycle !== 'active') {
      return { outcome: 'unavailable', reason: 'inactive' }
    }
    const [written] =
      current === undefined
        ? await tx
            .insert(agentProfessions)
            .values({ agentId: input.agentId, professionKey: input.key })
            .returning()
        : await tx
            .update(agentProfessions)
            .set({
              professionKey: input.key,
              chosenAt: new Date().toISOString(),
              assignmentVersion: current.assignmentVersion + 1,
            })
            .where(
              and(
                eq(agentProfessions.agentId, input.agentId),
                eq(agentProfessions.assignmentVersion, input.expectedVersion!),
              ),
            )
            .returning()
    if (written === undefined) throw new Error('profession assignment write returned no row')
    return {
      outcome: 'assigned',
      assignment: {
        key: written.professionKey,
        chosenAt: written.chosenAt,
        assignmentVersion: written.assignmentVersion,
      },
      definition: ProfessionDefinitionSchema.parse(profession.version.definition),
      lifecycle: 'active',
    }
  })
}
