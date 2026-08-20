import { describe, expect, it } from 'vitest'
import type { Database } from '@kolonie-ai/db'
import { ATLAS_PLAYBOOKS_SHOWN, databaseAtlasPlaybooks } from './playbook-links.js'
import type { AccountProvider } from '@kolonie-ai/core'

/**
 * Which playbooks a provider page lists (`#1416`).
 *
 * ## Why this is tested against a stubbed database and not a real one
 *
 * The two queries underneath are `@kolonie-ai/db`'s and are tested there. What
 * `#1416` decided is neither of them: it is *which of the two answers a page
 * gets, in what order, and how many* — a rule that lives in this file and would
 * otherwise be asserted only through a route test that needs a live catalogue to
 * make it fail.
 *
 * So the stub records what was asked and answers what the case is about. A test
 * that could not tell the pinned query from the kind query would make the
 * prefer-the-pin assertion unfalsifiable, which is the same trap the route
 * test's own fake reader documents.
 */
const stub = (rows: {
  readonly pinned?: readonly string[]
  readonly byKind?: readonly string[]
}) => {
  const link = (slug: string) => ({ slug, title: slug, summary: `what ${slug} does` })
  /**
   * The queries answer in the order the reader asks them — pinned, then by kind
   * — which is the order decision 2 fixes and the thing under test. Reading the
   * `where` clause instead would mean serialising a drizzle `SQL`, which is
   * cyclic; counting is the honest stand-in, and a reader that stopped
   * preferring the pin would ask them the other way round and fail here.
   */
  let asked = 0

  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: async () =>
              (asked++ === 0 ? (rows.pinned ?? []) : (rows.byKind ?? [])).map(link),
          }),
        }),
      }),
    }),
  } as unknown as Database

  return { db, calls: () => asked }
}

const provider = 'opentask.ai' as AccountProvider

describe('the playbooks a provider page lists', () => {
  it('lists the ones pinned to this provider', async () => {
    const { db } = stub({ pinned: ['weekly-sweep', 'ticket-triage'] })

    const found = await databaseAtlasPlaybooks(db).naming({ provider, kinds: [] })

    expect(found.map((one) => one.slug)).toEqual(['weekly-sweep', 'ticket-triage'])
  })

  /**
   * `kolonie-website#116` made this reader provider-exact because *a playbook
   * that needs a mailbox* on every mailbox entry is one module on four hundred
   * pages saying nothing about any of them. The route passes no kinds for an
   * entry with no earn facet, and this is what that buys.
   */
  it('asks nothing about kinds when the caller passed none', async () => {
    const { db, calls } = stub({ pinned: [], byKind: ['a-generic-mailbox-pipeline'] })

    expect(await databaseAtlasPlaybooks(db).naming({ provider, kinds: [] })).toEqual([])
    // The second query is not merely filtered out afterwards — it is not made.
    expect(calls()).toBe(1)
  })

  /** Decision 2, the earn-rail half: a kind match is specific on this shelf. */
  it('falls back to a kind match when the caller says the entry earns', async () => {
    const { db } = stub({ pinned: [], byKind: ['bounty-sweep'] })

    const found = await databaseAtlasPlaybooks(db).naming({ provider, kinds: ['storefront'] })

    expect(found.map((one) => one.slug)).toEqual(['bounty-sweep'])
  })

  /** Decision 2, *prefer provider pin*. */
  it('puts the pinned playbooks first and fills the rest by kind', async () => {
    const { db } = stub({ pinned: ['pinned-one'], byKind: ['by-kind-one', 'by-kind-two'] })

    const found = await databaseAtlasPlaybooks(db).naming({ provider, kinds: ['storefront'] })

    expect(found.map((one) => one.slug)).toEqual(['pinned-one', 'by-kind-one', 'by-kind-two'])
  })

  /** A playbook that answers both queries is one playbook. */
  it('names a playbook once when it pins the provider and also names its kind', async () => {
    const { db } = stub({ pinned: ['both'], byKind: ['both', 'other'] })

    const found = await databaseAtlasPlaybooks(db).naming({ provider, kinds: ['storefront'] })

    expect(found.map((one) => one.slug)).toEqual(['both', 'other'])
  })

  it('never lists more than five', async () => {
    const { db } = stub({ pinned: ['a', 'b', 'c'], byKind: ['d', 'e', 'f', 'g'] })

    const found = await databaseAtlasPlaybooks(db).naming({ provider, kinds: ['storefront'] })

    expect(found).toHaveLength(ATLAS_PLAYBOOKS_SHOWN)
    expect(found.map((one) => one.slug)).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  /** Decision 4: none means no section at all, which is an empty list here. */
  it('answers with nothing rather than with a shell', async () => {
    const { db } = stub({})

    expect(await databaseAtlasPlaybooks(db).naming({ provider, kinds: ['storefront'] })).toEqual([])
  })
})
