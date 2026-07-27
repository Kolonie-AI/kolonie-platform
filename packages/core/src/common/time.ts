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

/** Returns the current time as a domain `Timestamp`. */
export function now(): Timestamp {
  return new Date().toISOString()
}
