import type { PublicCitizenRecord } from '@kolonie-ai/core'
import type { SwarmPortrait } from '@kolonie-ai/db'
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
  /**
   * Take one citizen's record off it again — erasure, as this port sees it
   * (`#824`).
   *
   * **The indexing switch goes with it**, because in production there is no
   * row left to carry one. A fake that kept the switch would let a test pass
   * against a state the database cannot be in.
   */
  readonly withdraw: (handle: string) => void
  /** Publish one swarm, which no colony does until a maintainer names one. */
  readonly publishSwarm: (drawn: SwarmPortrait) => void
  /**
   * Turn one citizen's indexing switch on (`#830`).
   *
   * **A method rather than a field on `publish`**, so that the ordinary way to
   * put a citizen on the record is the ordinary state of the switch: off. A test
   * that wants the opt-in has to say so, which is the same asymmetry production
   * has.
   */
  readonly allowIndexing: (handle: string) => void
  /**
   * Turn citizen mail off for one handle (`#1487`).
   *
   * **A refusal is what a test has to arrange**, because the column defaults to
   * `true` and 33 of 33 citizens were on when this was measured. So the fixture
   * takes the switch the same way round: on unless a test turned it off.
   */
  readonly refuseCitizenMessages: (handle: string) => void
}

export function fakeCitizenRecords(): FakeCitizenRecords {
  const published = new Map<string, PublicCitizenRecord>()
  const indexable = new Set<string>()
  const refusesCitizenMessages = new Set<string>()
  let portrait: SwarmPortrait | undefined

  return {
    publishSwarm: (drawn) => {
      portrait = drawn
    },

    publish: (record) => {
      published.set(record.handle.toLowerCase(), record)
    },
    withdraw: (handle) => {
      published.delete(handle.toLowerCase())
      indexable.delete(handle.toLowerCase())
      refusesCitizenMessages.delete(handle.toLowerCase())
    },
    publicRecord: async (name) => published.get(name.toLowerCase()),
    allowIndexing: (handle) => {
      indexable.add(handle.toLowerCase())
    },
    /**
     * Off unless a test turned it on, and `false` for a name nobody holds —
     * the two answers the real read gives, for the reason
     * `storage/public-record.ts` states.
     */
    indexing: async (name) => indexable.has(name.toLowerCase()),
    refuseCitizenMessages: (handle) => {
      refusesCitizenMessages.add(handle.toLowerCase())
    },
    /**
     * `agents.accepts_citizen_messages` defaults to `true`, so a published
     * citizen takes mail unless a test says otherwise — and **a name nobody
     * holds reads `false`**, which is the asymmetry `citizenAcceptsCitizenMessages`
     * argues for: an unheld name is not a citizen with the switch on.
     */
    acceptsCitizenMessages: async (name) =>
      published.has(name.toLowerCase()) && !refusesCitizenMessages.has(name.toLowerCase()),
    /**
     * No swarm is published (`kolonie-website#63`).
     *
     * **The default in production too**, so a test that never calls
     * `publishSwarm` is exercising the ordinary state rather than a fixture's
     * convenience.
     */
    swarmPortrait: async () => portrait,
  }
}
