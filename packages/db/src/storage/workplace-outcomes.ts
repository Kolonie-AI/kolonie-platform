import { and, gte, lte } from 'drizzle-orm'
import type { Database, Transaction } from '../client.js'
import { workplaceOutcomeEvents } from '../schema/index.js'

export type WorkplaceOutcomeBucket =
  | {
      readonly period: 'week'
      readonly start: string
      readonly suppressed: true
    }
  | {
      readonly period: 'week'
      readonly start: string
      readonly suppressed: false
      readonly shipped: number
      readonly failedExperiment: number
      readonly abandoned: number
      readonly superseded: number
      readonly evidencePresent: number
      readonly initialClosings: number
      readonly closureRevisions: number
    }

export type WorkplaceOutcomeMetricsResult =
  | {
      readonly outcome: 'reported'
      readonly from: string
      readonly to: string
      readonly buckets: readonly WorkplaceOutcomeBucket[]
    }
  | { readonly outcome: 'invalid-range' }

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const MIN_DAYS = 28
const MAX_DAYS = 366
const K_ANONYMITY_THRESHOLD = 10

function parseUtcDate(dateStr: string): Date | null {
  if (!DATE_PATTERN.test(dateStr)) return null
  const [y, m, d] = dateStr.split('-').map(Number)
  const date = new Date(Date.UTC(y!, m! - 1, d!))
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m! - 1 || date.getUTCDate() !== d) {
    return null
  }
  return date
}

function formatUtcDate(date: Date): string {
  const y = date.getUTCFullYear().toString().padStart(4, '0')
  const m = (date.getUTCMonth() + 1).toString().padStart(2, '0')
  const d = date.getUTCDate().toString().padStart(2, '0')
  return `${y}-${m}-${d}`
}

/**
 * Returns the Monday 00:00:00.000 UTC on or before the given date.
 */
function isoMondayOnOrBefore(date: Date): Date {
  const day = date.getUTCDay()
  // Sunday is 0 -> 6 days back; Monday is 1 -> 0 days back
  const diff = (day + 6) % 7
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - diff))
}

/**
 * Maintainer-internal storage and reporting function for outcome telemetry (`#1944`).
 *
 * Enforces:
 * - from <= to, UTC calendar dates.
 * - Range duration: 28 to 366 days inclusive.
 * - ISO Monday UTC weekly buckets covering the requested range.
 * - Boundary weeks counted only inside the requested inclusive range.
 * - Low-volume weeks (< 10 initialClosings inside range) suppressed with no count fields.
 */
export async function workplaceOutcomeMetrics(
  db: Database | Transaction,
  input: {
    readonly from: string
    readonly to: string
  },
): Promise<WorkplaceOutcomeMetricsResult> {
  const fromDate = parseUtcDate(input.from)
  const toDate = parseUtcDate(input.to)
  if (fromDate === null || toDate === null) {
    return { outcome: 'invalid-range' }
  }
  if (fromDate.getTime() > toDate.getTime()) {
    return { outcome: 'invalid-range' }
  }

  const daysInclusive =
    Math.round((toDate.getTime() - fromDate.getTime()) / (24 * 60 * 60 * 1000)) + 1
  if (daysInclusive < MIN_DAYS || daysInclusive > MAX_DAYS) {
    return { outcome: 'invalid-range' }
  }

  // The range query is bounded by the inclusive UTC start and end
  const fromIso = `${input.from}T00:00:00.000Z`
  const toIso = `${input.to}T23:59:59.999Z`

  const rows = await db
    .select({
      result: workplaceOutcomeEvents.result,
      evidencePresent: workplaceOutcomeEvents.evidencePresent,
      isRevision: workplaceOutcomeEvents.isRevision,
      at: workplaceOutcomeEvents.at,
    })
    .from(workplaceOutcomeEvents)
    .where(and(gte(workplaceOutcomeEvents.at, fromIso), lte(workplaceOutcomeEvents.at, toIso)))

  // Generate all Monday UTC week starts from the week of fromDate up to toDate
  const firstMonday = isoMondayOnOrBefore(fromDate)
  const buckets: WorkplaceOutcomeBucket[] = []

  let currentMonday = new Date(firstMonday.getTime())
  while (currentMonday.getTime() <= toDate.getTime()) {
    const mondayStr = formatUtcDate(currentMonday)
    const nextMonday = new Date(currentMonday.getTime() + 7 * 24 * 60 * 60 * 1000)

    // Events falling in [currentMonday 00:00:00Z, nextMonday 00:00:00Z)
    // AND already constrained to [fromIso, toIso] by the SQL query
    const weekEvents = rows.filter((row) => {
      const t = new Date(row.at).getTime()
      return t >= currentMonday.getTime() && t < nextMonday.getTime()
    })

    let initialClosings = 0
    let closureRevisions = 0
    let evidencePresent = 0
    let shipped = 0
    let failedExperiment = 0
    let abandoned = 0
    let superseded = 0

    for (const event of weekEvents) {
      if (event.isRevision) {
        closureRevisions += 1
      } else {
        initialClosings += 1
      }
      if (event.evidencePresent) {
        evidencePresent += 1
      }
      if (event.result === 'shipped') shipped += 1
      else if (event.result === 'failed_experiment') failedExperiment += 1
      else if (event.result === 'abandoned') abandoned += 1
      else if (event.result === 'superseded') superseded += 1
    }

    if (initialClosings < K_ANONYMITY_THRESHOLD) {
      buckets.push({
        period: 'week',
        start: mondayStr,
        suppressed: true,
      })
    } else {
      buckets.push({
        period: 'week',
        start: mondayStr,
        suppressed: false,
        shipped,
        failedExperiment,
        abandoned,
        superseded,
        evidencePresent,
        initialClosings,
        closureRevisions,
      })
    }

    currentMonday = nextMonday
  }

  return {
    outcome: 'reported',
    from: input.from,
    to: input.to,
    buckets,
  }
}
