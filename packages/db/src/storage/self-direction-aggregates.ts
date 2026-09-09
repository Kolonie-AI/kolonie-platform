import { and, count, eq, sql } from 'drizzle-orm'
import type { Database, Transaction } from '../client.js'
import {
  selfDirectionAttempts,
  selfDirectionInstruments,
  selfDirectionItems,
  selfDirectionOptions,
  selfDirectionResponses,
} from '../schema/self-direction.js'

/**
 * The frozen minimum cohort, below which no item statistic is served (`#1895`).
 *
 * **Frozen means it does not move down.** A threshold a reader may lower is not
 * a threshold: the whole protection is that nobody can ask a narrower question
 * than this until enough citizens have answered. Thirty is the number `#1895`
 * proposed and it is written here once rather than passed in, so there is no
 * argument to tamper with and no call site that gets its own.
 */
export const SELF_DIRECTION_MINIMUM_COHORT = 30

/** What an item statistic can say about itself; never a verdict, never an action. */
export const SELF_DIRECTION_ITEM_FLAGS = [
  'one-option-dominates',
  'option-never-chosen',
  'no-longitudinal-movement',
] as const
export type SelfDirectionItemFlag = (typeof SELF_DIRECTION_ITEM_FLAGS)[number]

export type SelfDirectionItemStatistic = {
  readonly itemKey: string
  readonly responses: number
  readonly options: readonly {
    readonly optionKey: string
    readonly chosen: number
    readonly share: number
  }[]
  /**
   * How many citizens answered this item on more than one attempt, and how many
   * of them ever changed their answer. `null` until somebody has returned.
   */
  readonly longitudinal: { readonly returning: number; readonly moved: number } | null
  readonly flags: readonly SelfDirectionItemFlag[]
}

export type SelfDirectionInstrumentStatistic = {
  readonly slug: string
  readonly version: number
  readonly lifecycle: string
  /** How many citizens have a scored or closed attempt against this version. */
  readonly cohort: number
  readonly expiryRate: number | null
  /** True when the cohort is below the frozen minimum, in which case items are empty. */
  readonly suppressed: boolean
  readonly flags: readonly string[]
  readonly items: readonly SelfDirectionItemStatistic[]
}

export type SelfDirectionItemReport = {
  readonly minimumCohort: number
  readonly instruments: readonly SelfDirectionInstrumentStatistic[]
}

const HIGH_EXPIRY = 0.4
const DOMINANT_SHARE = 0.9

/**
 * Aggregate item statistics, per instrument version, for a maintainer (`#1895`).
 *
 * **k-anonymity is structural rather than a filter at the end.** An instrument
 * version whose cohort is under {@link SELF_DIRECTION_MINIMUM_COHORT} returns no
 * items at all — not zeroed items, not rounded ones — so there is no shape left
 * to reason backwards from. The cohort itself is reported, because *how far off
 * the threshold this version is* is the one thing a maintainer needs and it says
 * nothing about any citizen.
 *
 * **Versions never merge.** Each row is one slug and one version, and no field
 * subtracts one version from another: published prose and weights never mutate,
 * so two versions are two instruments that happen to share a lineage, and a
 * delta across that boundary would be arithmetic on incomparable things.
 *
 * **It flags and never acts.** Every flag here is a sentence a maintainer reads
 * before deciding; nothing in this module writes, retires or revises anything.
 * D-152 puts the deliverable in citizen behaviour, and an item statistic that
 * retired its own questions would be the measurement apparatus taking over the
 * thing it measures.
 *
 * **No citizen appears, at any cohort size.** No agent id, no handle, no
 * attempt id and no per-citizen answer: the query groups before it returns, so
 * there is no row here that belongs to anybody.
 */
export async function readSelfDirectionItemStatistics(
  db: Database | Transaction,
): Promise<SelfDirectionItemReport> {
  const instruments = await db
    .select({
      id: selfDirectionInstruments.id,
      slug: selfDirectionInstruments.slug,
      version: selfDirectionInstruments.version,
      lifecycle: selfDirectionInstruments.lifecycle,
    })
    .from(selfDirectionInstruments)
    .orderBy(selfDirectionInstruments.slug, selfDirectionInstruments.version)

  const reported: SelfDirectionInstrumentStatistic[] = []
  for (const instrument of instruments) {
    const [counted] = await db
      .select({
        cohort: sql<number>`count(distinct ${selfDirectionAttempts.agentId}) filter (where ${selfDirectionAttempts.state} in ('awaiting-reflection', 'closed'))::int`,
        attempts: count(),
        expired: sql<number>`count(*) filter (where ${selfDirectionAttempts.state} = 'expired')::int`,
      })
      .from(selfDirectionAttempts)
      .where(eq(selfDirectionAttempts.instrumentId, instrument.id))

    const cohort = counted?.cohort ?? 0
    const attempts = counted?.attempts ?? 0
    const expiryRate = attempts === 0 ? null : (counted?.expired ?? 0) / attempts
    const flags: string[] = []
    if (expiryRate !== null && expiryRate >= HIGH_EXPIRY) flags.push('high-expiry')

    if (cohort < SELF_DIRECTION_MINIMUM_COHORT) {
      reported.push({
        slug: instrument.slug,
        version: instrument.version,
        lifecycle: instrument.lifecycle,
        cohort,
        expiryRate,
        suppressed: true,
        flags,
        items: [],
      })
      continue
    }

    const rows = await db
      .select({
        itemKey: selfDirectionResponses.itemKey,
        optionKey: selfDirectionResponses.optionKey,
        chosen: count(),
      })
      .from(selfDirectionResponses)
      .innerJoin(
        selfDirectionAttempts,
        eq(selfDirectionAttempts.id, selfDirectionResponses.attemptId),
      )
      .where(eq(selfDirectionAttempts.instrumentId, instrument.id))
      .groupBy(selfDirectionResponses.itemKey, selfDirectionResponses.optionKey)

    /**
     * Every published option, so an option nobody chose is a reported zero
     * rather than an absent row — *inert* is exactly what this report is for,
     * and a missing key reads as a question nobody was asked.
     */
    const publishedRows = await db
      .select({
        itemKey: selfDirectionItems.itemKey,
        optionKey: selfDirectionOptions.optionKey,
        itemPosition: selfDirectionItems.position,
        optionPosition: selfDirectionOptions.position,
      })
      .from(selfDirectionItems)
      .innerJoin(selfDirectionOptions, eq(selfDirectionOptions.itemId, selfDirectionItems.id))
      .where(
        and(
          eq(selfDirectionItems.instrumentId, instrument.id),
          eq(selfDirectionItems.state, 'active'),
        ),
      )
      .orderBy(selfDirectionItems.position, selfDirectionOptions.position)
    const published = [...new Set(publishedRows.map(({ itemKey }) => itemKey))].map((itemKey) => ({
      itemKey,
      options: publishedRows
        .filter((row) => row.itemKey === itemKey)
        .map(({ optionKey }) => optionKey),
    }))

    /**
     * Whether the same citizen ever answers an item differently on a later
     * attempt against this same version (`#1895`). An item nobody's answer ever
     * moves on is measuring a fixed trait or nothing at all, and either way it
     * is not telling a returning citizen anything new.
     *
     * **Counted per item over citizens with more than one attempt**, and left
     * `null` where nobody has returned yet — which is the honest answer during a
     * pilot and is not the same as *nothing moved*.
     */
    const movement = await db.execute<{
      item_key: string
      returning: number
      moved: number
    }>(sql`
      with answered as (
        select a.agent_id, r.item_key, count(distinct r.option_key)::int as distinct_options
        from self_direction_responses r
        join self_direction_attempts a on a.id = r.attempt_id
        where a.instrument_id = ${instrument.id}
        group by a.agent_id, r.item_key
        having count(*) > 1
      )
      select item_key,
             count(*)::int as returning,
             count(*) filter (where distinct_options > 1)::int as moved
      from answered
      group by item_key
    `)

    const items = published.map((item) => {
      const forItem = rows.filter((row) => row.itemKey === item.itemKey)
      const responses = forItem.reduce((sum, row) => sum + row.chosen, 0)
      const options = item.options.map((optionKey) => {
        const chosen = forItem.find((row) => row.optionKey === optionKey)?.chosen ?? 0
        return { optionKey, chosen, share: responses === 0 ? 0 : chosen / responses }
      })
      const itemFlags: SelfDirectionItemFlag[] = []
      if (options.some((option) => option.share >= DOMINANT_SHARE)) {
        itemFlags.push('one-option-dominates')
      }
      if (responses > 0 && options.some((option) => option.chosen === 0)) {
        itemFlags.push('option-never-chosen')
      }
      const returned = movement.find((row) => row.item_key === item.itemKey)
      const longitudinal =
        returned === undefined || returned.returning === 0
          ? null
          : { returning: Number(returned.returning), moved: Number(returned.moved) }
      if (longitudinal !== null && longitudinal.moved === 0) {
        itemFlags.push('no-longitudinal-movement')
      }
      return { itemKey: item.itemKey, responses, options, longitudinal, flags: itemFlags }
    })

    reported.push({
      slug: instrument.slug,
      version: instrument.version,
      lifecycle: instrument.lifecycle,
      cohort,
      expiryRate,
      suppressed: false,
      flags,
      items,
    })
  }

  return { minimumCohort: SELF_DIRECTION_MINIMUM_COHORT, instruments: reported }
}
