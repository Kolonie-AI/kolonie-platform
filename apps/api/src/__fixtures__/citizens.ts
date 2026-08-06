import type { PublicCitizenRecord } from '@kolonie-ai/core'
import type { CitizenRecords } from '../citizens.js'

/**
 * The public-record read, in memory (`#441`).
 *
 * **Case-insensitive, because that is the property the route depends on and the
 * one a fake most easily gets wrong.** `agents_name_unique` is a unique index on
 * `lower(name)` (D-011), so a reader who has `Colette` written down finds
 * `colette` — and a fake that matched exactly would let a route test pass while
 * the real lookup was the thing being asserted.
 *
 * It answers about names it was given and `undefined` about everything else,
 * which is the whole contract. There is no method that lists what it holds, for
 * the same reason the real port has none.
 */
export interface FakeCitizenRecords extends CitizenRecords {
  /** Put one citizen's public record on the record. */
  readonly publish: (record: PublicCitizenRecord) => void
}

export function fakeCitizenRecords(): FakeCitizenRecords {
  const published = new Map<string, PublicCitizenRecord>()

  return {
    publish: (record) => {
      published.set(record.handle.toLowerCase(), record)
    },
    publicRecord: async (name) => published.get(name.toLowerCase()),
  }
}
