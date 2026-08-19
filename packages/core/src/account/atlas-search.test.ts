import { describe, expect, it } from 'vitest'
import {
  ATLAS_ENTRIES_MAX_PAGE,
  ATLAS_QUERY_MAX_LENGTH,
  AtlasQuerySchema,
  atlasConditionsMatch,
  atlasHasDescription,
  atlasMatchesQuery,
  atlasPageOf,
  decodeAtlasCursor,
  encodeAtlasCursor,
  invalidAtlasCondition,
} from './atlas-search.js'

/**
 * Reading the Atlas at scale (`#1302`).
 *
 * **What is asserted here is that paging survives the catalogue moving under
 * it.** The order is recomputed from measurements on every read, so the
 * interesting cases are all *the shelf changed between two pages* — an offset
 * cursor would pass every other test in this file and lose an entry in exactly
 * those.
 */

const entry = (
  provider: string,
  over: Partial<{ title: string; description: string | null }> = {},
) => ({
  provider,
  title: over.title ?? provider,
  description: over.description === undefined ? null : over.description,
})

describe('matching an entry against a query', () => {
  it('matches the provider, the title and the description', () => {
    const one = entry('gmx.com', { title: 'GMX', description: 'A German mailbox provider.' })

    expect(atlasMatchesQuery(one, 'gmx')).toBe(true)
    expect(atlasMatchesQuery(one, 'German')).toBe(true)
    expect(atlasMatchesQuery(one, '.com')).toBe(true)
    expect(atlasMatchesQuery(one, 'proton')).toBe(false)
  })

  it('ignores case on both sides, because a provider is a domain', () => {
    expect(atlasMatchesQuery(entry('GitHub.com', { title: 'GitHub' }), 'github.COM')).toBe(true)
  })

  it('treats no query and an empty one as no filter at all', () => {
    /**
     * A caller that sent `q: ''` asked nothing, and answering it with an empty
     * catalogue would read as *the Atlas knows nothing* rather than as *you
     * filtered on nothing*.
     */
    expect(atlasMatchesQuery(entry('gmx.com'), undefined)).toBe(true)
    expect(atlasMatchesQuery(entry('gmx.com'), '   ')).toBe(true)
  })

  it('survives an entry with no description', () => {
    expect(atlasMatchesQuery(entry('gmx.com'), 'gmx')).toBe(true)
  })

  it('refuses a query longer than a name or a sentence', () => {
    expect(AtlasQuerySchema.safeParse('x'.repeat(ATLAS_QUERY_MAX_LENGTH)).success).toBe(true)
    expect(AtlasQuerySchema.safeParse('x'.repeat(ATLAS_QUERY_MAX_LENGTH + 1)).success).toBe(false)
  })
})

describe('the two condition filters', () => {
  const row = { cost: 'free', terms: 'agent-allowed' }

  it('keeps a row whose cost and terms were asked for', () => {
    expect(atlasConditionsMatch(row, { cost: ['free'], terms: ['agent-allowed'] })).toBe(true)
  })

  it('drops a row priced differently', () => {
    expect(atlasConditionsMatch(row, { cost: ['paid-only'] })).toBe(false)
  })

  it('does not fold `unknown` into any other answer', () => {
    /**
     * The row nobody has priced is the one a scout should go and price. Reading
     * it as free would be the catalogue claiming a measurement it does not have.
     */
    const unpriced = { cost: 'unknown', terms: 'unknown' }

    expect(atlasConditionsMatch(unpriced, { cost: ['free'] })).toBe(false)
    expect(atlasConditionsMatch(unpriced, { cost: ['unknown'] })).toBe(true)
  })

  it('takes several values as *any of these*', () => {
    expect(atlasConditionsMatch(row, { cost: ['free', 'card-to-sign-up'] })).toBe(true)
  })

  it('is no filter at all when the list is empty', () => {
    expect(atlasConditionsMatch(row, { cost: [] })).toBe(true)
  })

  it('names a value outside the vocabulary rather than dropping the filter', () => {
    expect(invalidAtlasCondition('cost', ['free'])).toBeNull()

    const refusal = invalidAtlasCondition('cost', ['gratis'])
    expect(refusal?.code).toBe('validation_failed')
    expect(refusal?.message).toContain('gratis')
    expect(refusal?.message).toContain('card-to-sign-up')

    expect(invalidAtlasCondition('terms', ['agents-welcome'])?.message).toContain('agent-allowed')
  })
})

describe('whether an entry says what the provider is', () => {
  it('reads a blank sentence as absent, because it renders as a gap', () => {
    expect(atlasHasDescription({ description: 'A mailbox.' })).toBe(true)
    expect(atlasHasDescription({ description: '   ' })).toBe(false)
    expect(atlasHasDescription({ description: null })).toBe(false)
    expect(atlasHasDescription({})).toBe(false)
  })
})

describe('paging the catalogue', () => {
  const shelf = (count: number) =>
    Array.from({ length: count }, (_, index) => entry(`provider-${String(index).padStart(3, '0')}`))

  it('hands back a page and a cursor, and null on the last one', () => {
    const all = shelf(5)

    const first = atlasPageOf(all, { limit: 2 })
    expect(first.entries.map((one) => one.provider)).toEqual(['provider-000', 'provider-001'])
    expect(first.total).toBe(5)
    expect(first.nextCursor).not.toBeNull()

    const cursor = decodeAtlasCursor(first.nextCursor as string)
    expect(cursor).not.toBe('invalid-cursor')

    const second = atlasPageOf(all, {
      limit: 2,
      cursor: cursor === 'invalid-cursor' ? undefined : cursor,
    })
    expect(second.entries.map((one) => one.provider)).toEqual(['provider-002', 'provider-003'])

    const third = atlasPageOf(all, {
      limit: 2,
      cursor: { after: 'provider-003', offset: 4 },
    })
    expect(third.entries.map((one) => one.provider)).toEqual(['provider-004'])
    expect(third.nextCursor).toBeNull()
  })

  it('resumes after the named provider when the shelf reordered underneath it', () => {
    /**
     * The whole reason the cursor names an entry. A walk landing between two
     * reads moves everything after it; an offset cursor would hand the reader
     * `provider-002` twice, or skip it.
     */
    const after = [entry('newcomer'), ...shelf(5)]

    const page = atlasPageOf(after, { limit: 2, cursor: { after: 'provider-001', offset: 2 } })

    expect(page.entries.map((one) => one.provider)).toEqual(['provider-002', 'provider-003'])
  })

  it('falls back to the offset when the provider it named has left the shelf', () => {
    const without = shelf(5).filter((one) => one.provider !== 'provider-001')

    const page = atlasPageOf(without, { limit: 2, cursor: { after: 'provider-001', offset: 2 } })

    expect(page.entries.map((one) => one.provider)).toEqual(['provider-003', 'provider-004'])
  })

  it('clamps rather than refusing an unreasonable limit', () => {
    expect(atlasPageOf(shelf(200), { limit: 5000 }).entries).toHaveLength(ATLAS_ENTRIES_MAX_PAGE)
    expect(atlasPageOf(shelf(10), { limit: 0 }).entries).toHaveLength(1)
  })

  it('is one empty page and not a cursor loop when nothing matched', () => {
    const page = atlasPageOf([], {})

    expect(page.entries).toEqual([])
    expect(page.total).toBe(0)
    expect(page.nextCursor).toBeNull()
  })

  it('never walks past the end when the offset is stale and too large', () => {
    const page = atlasPageOf(shelf(3), { cursor: { after: 'gone', offset: 900 } })

    expect(page.entries).toEqual([])
    expect(page.nextCursor).toBeNull()
  })
})

describe('the cursor itself', () => {
  it('round-trips', () => {
    const cursor = { after: 'gmx.com', offset: 12 }

    expect(decodeAtlasCursor(encodeAtlasCursor(cursor))).toEqual(cursor)
  })

  it('is opaque rather than the provider in the clear', () => {
    expect(encodeAtlasCursor({ after: 'gmx.com', offset: 1 })).not.toContain('gmx.com')
  })

  it('refuses anything that is not one of ours', () => {
    /**
     * A cursor is attacker-supplied. Answering the first page instead would be
     * worse than refusing: a caller paging through would silently start again.
     */
    expect(decodeAtlasCursor('not-a-cursor')).toBe('invalid-cursor')
    expect(decodeAtlasCursor(Buffer.from('{}', 'utf8').toString('base64url'))).toBe(
      'invalid-cursor',
    )
    expect(
      decodeAtlasCursor(Buffer.from('{"after":"x","offset":-1}', 'utf8').toString('base64url')),
    ).toBe('invalid-cursor')
  })
})
