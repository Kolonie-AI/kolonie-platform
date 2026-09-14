import { z } from 'zod'

/**
 * All timestamps crossing a service boundary are ISO 8601 strings in UTC.
 *
 * We deliberately do not use `Date` in the domain model: `Date` does not survive
 * JSON serialisation, and every consumer (Postgres via the backend, React via
 * the frontend, verifier modules in the academy) would deserialise it slightly
 * differently. A string is unambiguous and comparable lexicographically.
 */
export const TimestampSchema = z.iso.datetime()
export type Timestamp = z.infer<typeof TimestampSchema>

/**
 * Normalises a timestamp-like boundary value without accepting an invalid instant (#1977).
 * Missing offsets mean UTC because storage timestamps describe instants, not local wall time;
 * an unparseable value stays unchanged so `TimestampSchema` remains the authority.
 */
export function toTimestamp(value: string | Date): string {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? String(value) : value.toISOString()
  }
  const withColonOffset = value
    .replace(/([+-])(\d{2})(\d{2})$/, '$1$2:$3')
    .replace(/([+-]\d{2})$/, '$1:00')
  const source = /(?:Z|[+-]\d{2}:\d{2})$/i.test(withColonOffset)
    ? withColonOffset
    : `${withColonOffset}Z`
  const date = new Date(source)
  return Number.isNaN(date.getTime()) ? value : date.toISOString()
}

/** Returns the current time as a domain `Timestamp`. */
export function now(): Timestamp {
  return new Date().toISOString()
}
