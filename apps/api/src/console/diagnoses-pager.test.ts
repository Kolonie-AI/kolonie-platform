import { describe, expect, it } from 'vitest'
import { pager } from './diagnoses-section.js'

/**
 * A page turn keeps the view it was turning (`#1078`).
 *
 * The defect this file pins down was silent, which is why it survived: the one
 * caller smuggled the scope into the path, so the agent-scoped Next link came
 * out as `/backend/diagnoses?scope=agent?page=1`, the route read `scope` as the
 * string `agent?page=1`, the comparison failed, and the reader was returned to
 * the colony view at page zero. Nothing errored and nothing looked wrong — the
 * next page was simply a different list.
 *
 * **The assertions parse the href rather than matching it**, because a link is a
 * URL and not a string: `?scope=agent&page=1` and `?page=1&scope=agent` are the
 * same link, and a test written against the spelling would go red on a
 * reordering that changed nothing a reader can see.
 */
describe('the diagnoses pager', () => {
  /**
   * The hrefs, decoded.
   *
   * The renderer escapes an href, correctly, so the attribute holds `&amp;`
   * between pairs. A browser decodes that entity before it is a URL, so
   * decoding it here asserts on the link rather than on the encoding.
   */
  const hrefsIn = (html: readonly string[]): readonly string[] =>
    [...html.join('').matchAll(/href="([^"]+)"/g)].map((match) =>
      (match[1] as string).replaceAll('&amp;', '&'),
    )

  const paramsOf = (href: string) => new URL(href, 'https://example.invalid').searchParams

  it('carries the scope it was paging into the next page', () => {
    const html = pager('/backend/diagnoses', { scope: 'agent' }, 0, true)

    const hrefs = hrefsIn(html)
    expect(hrefs).toHaveLength(1)

    const params = paramsOf(hrefs[0] as string)
    // Exactly `agent`, which is the whole of the defect: `agent?page=1` is what
    // the route used to receive, and it is not equal to `agent`.
    expect(params.get('scope')).toBe('agent')
    expect(params.get('page')).toBe('1')
  })

  it('carries every pair it was given, not only the first', () => {
    const html = pager('/backend/diagnoses', { scope: 'agent', state: 'resolved' }, 2, true)

    const hrefs = hrefsIn(html)
    expect(hrefs).toHaveLength(2)

    const [previous, next] = hrefs.map((href) => paramsOf(href as string))

    expect(previous?.get('page')).toBe('1')
    expect(next?.get('page')).toBe('3')
    for (const params of [previous, next]) {
      expect(params?.get('scope')).toBe('agent')
      expect(params?.get('state')).toBe('resolved')
    }
  })

  /** The default view pages too, and its links carry a page and nothing else. */
  it('pages a view that has no pairs at all', () => {
    const hrefs = hrefsIn(pager('/backend/diagnoses', {}, 1, false))

    expect(hrefs).toHaveLength(1)
    expect(hrefs[0]).toBe('/backend/diagnoses?page=0')
  })

  /**
   * **Nothing rather than a paragraph of nothing.** A single page of results
   * gets no navigation at all, so the page does not carry an empty element that
   * a stylesheet would have to hide.
   */
  it('renders nothing when there is one page', () => {
    expect(pager('/backend/diagnoses', { scope: 'agent' }, 0, false)).toEqual([])
  })

  /**
   * **The rejection case.** `page` is the one pair this function owns. A caller
   * passing it as well would produce a URL with two of them, which most parsers
   * resolve by taking the last — so the reader would land on a page number
   * nobody chose and nothing anywhere would report a fault. Loud is the whole
   * point: the fault this file exists for was the quiet kind.
   */
  it('refuses a caller that passes a page of its own', () => {
    expect(() => pager('/backend/diagnoses', { page: '4' }, 0, true)).toThrow(/page pair/)
  })
})
