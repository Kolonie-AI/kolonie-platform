import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import {
  SelfDirectionInstrumentDocumentSchema,
  selfDirectionInstrumentContentHash,
  type SelfDirectionInstrumentDocument,
} from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'
import {
  selfDirectionAttempts,
  selfDirectionInstruments,
  selfDirectionItems,
  selfDirectionOptions,
} from '../schema/self-direction.js'
import { SELF_DIRECTION_MINIMUM_COHORT } from './self-direction-aggregates.js'

export type PublishedSelfDirectionInstrument = {
  readonly id: string
  readonly slug: string
  readonly version: number
  readonly contentHash: string
}

export type PublishSelfDirectionInstrumentResult =
  | {
      readonly outcome: 'created' | 'unchanged'
      readonly instrument: PublishedSelfDirectionInstrument
    }
  | { readonly outcome: 'conflict'; readonly instrument: PublishedSelfDirectionInstrument }

const summary = (
  row: typeof selfDirectionInstruments.$inferSelect,
): PublishedSelfDirectionInstrument => ({
  id: row.id,
  slug: row.slug,
  version: row.version,
  contentHash: row.contentHash,
})

/**
 * Publish immutable public practice content, or identify exact idempotent replay and drift.
 *
 * **A pooled instrument is refused until the lineage has field evidence**
 * (`#1895`). An anchor/rotation pool is a claim about which items are worth
 * keeping stable, and the only thing that can support that claim is citizens
 * having answered the ones already published. Below
 * {@link SELF_DIRECTION_MINIMUM_COHORT} answered attempts on the lineage, this
 * refuses rather than publishing — which is the issue's *optimise prose in a
 * vacuum* in one condition. A plain ten-item version is unaffected and is how a
 * lineage earns the evidence in the first place.
 */
export async function publishSelfDirectionInstrument(
  db: Database,
  input: SelfDirectionInstrumentDocument,
): Promise<PublishSelfDirectionInstrumentResult> {
  const document = SelfDirectionInstrumentDocumentSchema.parse(input)
  const contentHash = selfDirectionInstrumentContentHash(document)
  return db.transaction(async (tx) => {
    if (document.assembly !== undefined) {
      const [evidence] = await tx
        .select({
          cohort: sql<number>`count(distinct ${selfDirectionAttempts.agentId}) filter (where ${selfDirectionAttempts.state} in ('awaiting-reflection', 'closed'))::int`,
        })
        .from(selfDirectionAttempts)
        .innerJoin(
          selfDirectionInstruments,
          eq(selfDirectionInstruments.id, selfDirectionAttempts.instrumentId),
        )
        .where(eq(selfDirectionInstruments.slug, document.compatibility.lineage))
      if ((evidence?.cohort ?? 0) < SELF_DIRECTION_MINIMUM_COHORT) {
        throw new Error(
          `a pooled instrument needs ${SELF_DIRECTION_MINIMUM_COHORT} answered attempts on ` +
            `lineage ${document.compatibility.lineage}; it has ${evidence?.cohort ?? 0}`,
        )
      }
    }
    const [created] = await tx
      .insert(selfDirectionInstruments)
      .values({
        slug: document.slug,
        version: document.version,
        lifecycle: document.lifecycle,
        cadenceDays: document.cadenceDays,
        retestFloorHours: document.retestFloorHours,
        compatibility: document.compatibility,
        themeDefinitions: document.themeDefinitions,
        contentHash,
        publishedAt: document.lifecycle === 'draft' ? null : new Date().toISOString(),
      })
      .onConflictDoNothing({
        target: [selfDirectionInstruments.slug, selfDirectionInstruments.version],
      })
      .returning()

    if (created === undefined) {
      const [existing] = await tx
        .select()
        .from(selfDirectionInstruments)
        .where(
          and(
            eq(selfDirectionInstruments.slug, document.slug),
            eq(selfDirectionInstruments.version, document.version),
          ),
        )
        .limit(1)
      if (existing === undefined) throw new Error('instrument conflicted without an existing row')
      return {
        outcome: existing.contentHash === contentHash ? 'unchanged' : 'conflict',
        instrument: summary(existing),
      }
    }

    await insertInstrumentChildren(tx, created.id, document)
    return { outcome: 'created', instrument: summary(created) }
  })
}

async function insertInstrumentChildren(
  tx: Transaction,
  instrumentId: string,
  document: SelfDirectionInstrumentDocument,
): Promise<void> {
  for (const [itemOffset, item] of document.items.entries()) {
    const [storedItem] = await tx
      .insert(selfDirectionItems)
      .values({
        instrumentId,
        position: itemOffset + 1,
        itemKey: item.key,
        audience: item.audience,
        professionTag: item.professionTag,
        scenarioKind: item.scenarioKind,
        prompt: item.prompt,
        rationale: item.rationale,
        state: item.state,
      })
      .returning({ id: selfDirectionItems.id })
    if (storedItem === undefined) throw new Error('instrument item insert returned no row')
    await tx.insert(selfDirectionOptions).values(
      item.options.map((option, optionOffset) => ({
        itemId: storedItem.id,
        position: optionOffset + 1,
        optionKey: option.key,
        text: option.text,
        weights: option.weights,
        patterns: option.patterns,
      })),
    )
  }
}

/** Read one historical version in its canonical order, including retired versions. */
export async function readSelfDirectionInstrument(
  db: Database | Transaction,
  slug: string,
  version: number,
): Promise<SelfDirectionInstrumentDocument | null> {
  const [instrument] = await db
    .select()
    .from(selfDirectionInstruments)
    .where(
      and(eq(selfDirectionInstruments.slug, slug), eq(selfDirectionInstruments.version, version)),
    )
    .limit(1)
  if (instrument === undefined) return null
  const items = await db
    .select()
    .from(selfDirectionItems)
    .where(eq(selfDirectionItems.instrumentId, instrument.id))
    .orderBy(asc(selfDirectionItems.position))
  const itemIds = items.map(({ id }) => id)
  const options = itemIds.length
    ? await db
        .select()
        .from(selfDirectionOptions)
        .where(
          itemIds.length === 1
            ? eq(selfDirectionOptions.itemId, itemIds[0]!)
            : inArray(selfDirectionOptions.itemId, itemIds),
        )
        .orderBy(asc(selfDirectionOptions.position))
    : []
  return SelfDirectionInstrumentDocumentSchema.parse({
    slug: instrument.slug,
    version: instrument.version,
    lifecycle: instrument.lifecycle,
    cadenceDays: instrument.cadenceDays,
    retestFloorHours: instrument.retestFloorHours,
    compatibility: instrument.compatibility,
    themeDefinitions: instrument.themeDefinitions,
    items: items.map((item) => ({
      key: item.itemKey,
      audience: item.audience,
      professionTag: item.professionTag,
      scenarioKind: item.scenarioKind,
      prompt: item.prompt,
      rationale: item.rationale,
      state: item.state,
      options: options
        .filter(({ itemId }) => itemId === item.id)
        .map((option) => ({
          key: option.optionKey,
          text: option.text,
          weights: option.weights,
          patterns: option.patterns,
        })),
    })),
  })
}

/** Retire a published version without deleting content referenced by history. */
export async function retireSelfDirectionInstrument(
  db: Database | Transaction,
  id: string,
): Promise<boolean> {
  const rows = await db
    .update(selfDirectionInstruments)
    .set({ lifecycle: 'retired', retiredAt: new Date().toISOString() })
    .where(and(eq(selfDirectionInstruments.id, id)))
    .returning({ id: selfDirectionInstruments.id })
  return rows.length === 1
}
