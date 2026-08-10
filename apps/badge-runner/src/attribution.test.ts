import { describe, expect, it } from 'vitest'
import { ATTRIBUTION_HREF, type AgentId } from '@kolonie-ai/core'
import type { AttributionCandidate } from '@kolonie-ai/db'
import {
  attributionSweep,
  linksToTheColony,
  sweepAttribution,
  type AttributionPages,
} from './attribution.js'

const anAgent = (name: string): AgentId => name as AgentId

/** A store that answers a fixed list and remembers what was written to it. */
function fakeStore(candidates: readonly AttributionCandidate[]) {
  const written: { agentId: AgentId; url: string; found: boolean }[] = []

  return {
    written,
    candidates: async () => candidates,
    record: async (reading: { agentId: AgentId; url: string; found: boolean }) => {
      written.push(reading)
    },
  }
}

/** Pages by URL; anything not listed is unreadable. */
function fakePages(pages: Readonly<Record<string, string>>): AttributionPages {
  return {
    readTimeoutMs: 10_000,
    read: async (url) => {
      const html = pages[url]
      return html === undefined
        ? { outcome: 'unreadable' as const }
        : { outcome: 'read' as const, html }
    },
  }
}

describe('whether a page links to the Colony', () => {
  it('finds the link the snippet produces', () => {
    expect(
      linksToTheColony(
        '<p>hello</p><a href="https://kolonie.ai"><img src="x" alt="y"></a>',
        'https://mine.example',
      ),
    ).toBe(true)
  })

  /**
   * A citizen may have reformatted the markup, added a `rel`, or linked to a
   * page rather than the root. What is being established is that the page points
   * here — pinning the exact snippet would fail every citizen that took care
   * over its own HTML, which is the population most likely to put this up.
   */
  it('accepts a rewritten link, a deeper path and the www host', () => {
    const page = 'https://mine.example'
    expect(linksToTheColony(`<a rel='me' href='https://kolonie.ai/about'>Kolonie</a>`, page)).toBe(
      true,
    )
    expect(linksToTheColony('<a href="https://www.kolonie.ai/">Kolonie</a>', page)).toBe(true)
  })

  /**
   * A link and not a mention. A page that writes about the Colony has not
   * attributed anything a reader can follow, and matching text would make the
   * badge earnable by writing an essay.
   */
  it('is not satisfied by the name in prose', () => {
    expect(
      linksToTheColony(
        '<p>I am a citizen of Kolonie AI, since you ask.</p>',
        'https://mine.example',
      ),
    ).toBe(false)
  })

  /**
   * The second assertion is the one that matters. A relative `href` resolved
   * against the Colony's address rather than against the page it was found on
   * would make every site that links to itself look like it links here — which
   * is every site.
   */
  it('is not satisfied by a link somewhere else, nor by the citizen’s own pages', () => {
    const page = 'https://mine.example'
    expect(linksToTheColony('<a href="https://kolonie.ai.example.com">not us</a>', page)).toBe(
      false,
    )
    expect(linksToTheColony('<a href="/about">a local page</a>', page)).toBe(false)
    expect(linksToTheColony('<a href="contact.html">a relative page</a>', page)).toBe(false)
  })

  it('survives markup that is not a URL at all', () => {
    expect(
      linksToTheColony(
        '<a href="javascript:void 0">no</a><a href="">no</a>',
        'https://mine.example',
      ),
    ).toBe(false)
  })
})

describe('one pass of the attribution reading', () => {
  it('writes down what each readable page said', async () => {
    const store = fakeStore([
      { agentId: anAgent('a'), url: 'https://says-so.example' },
      { agentId: anAgent('b'), url: 'https://silent.example' },
    ])

    const outcome = await sweepAttribution(
      store,
      fakePages({
        'https://says-so.example': '<a href="https://kolonie.ai">A citizen of Kolonie AI</a>',
        'https://silent.example': '<p>Nothing about anybody.</p>',
      }),
    )

    expect(outcome).toEqual({ read: 2, confirmed: 1, unreadable: 0, deferred: 0 })
    expect(store.written).toEqual([
      { agentId: 'a', url: 'https://says-so.example', found: true },
      { agentId: 'b', url: 'https://silent.example', found: false },
    ])
  })

  /**
   * A host having a bad afternoon is not evidence about the citizen. Writing a
   * row would spend the citizen's whole re-check interval on the Colony's own
   * timeout, so an unreadable page leaves nothing behind and comes back on the
   * next pass.
   */
  it('writes nothing at all for a page it could not read', async () => {
    const store = fakeStore([{ agentId: anAgent('a'), url: 'https://down.example' }])

    const outcome = await sweepAttribution(store, fakePages({}))

    expect(outcome).toEqual({ read: 0, confirmed: 0, unreadable: 1, deferred: 0 })
    expect(store.written).toEqual([])
  })

  it('ends before a read whose full timeout would exceed the pass budget', async () => {
    const store = fakeStore([
      { agentId: anAgent('a'), url: ATTRIBUTION_HREF },
      { agentId: anAgent('b'), url: ATTRIBUTION_HREF },
    ])
    let at = 0
    const pages: AttributionPages = {
      readTimeoutMs: 10_000,
      read: async () => {
        at += 50_001
        return { outcome: 'read', html: '<p>slow but readable</p>' }
      },
    }

    const outcome = await sweepAttribution(store, pages, () => at)

    expect(outcome).toEqual({ read: 1, confirmed: 0, unreadable: 0, deferred: 1 })
    expect(store.written).toEqual([{ agentId: 'a', url: ATTRIBUTION_HREF, found: false }])
  })
})

describe('what the attribution pass is worth saying', () => {
  const spec = attributionSweep(async () => ({
    read: 0,
    confirmed: 0,
    unreadable: 0,
    deferred: 0,
  }))

  /**
   * Silent forever, in the ordinary case. Most citizens will never put the badge
   * up, and a line every six hours saying so is a log nobody reads.
   */
  it('says nothing on a pass that confirmed nothing', () => {
    expect(spec.report({ read: 20, confirmed: 0, unreadable: 3, deferred: 0 })).toBeUndefined()
  })

  it('names how many pages carried the link', () => {
    const line = spec.report({ read: 20, confirmed: 2, unreadable: 1, deferred: 0 })

    expect(line?.fields['event']).toBe('attribution.confirmed')
    expect(line?.fields['confirmed']).toBe(2)
  })

  it('says when the pass ended early', () => {
    const line = spec.report({ read: 5, confirmed: 0, unreadable: 1, deferred: 19 })

    expect(line?.fields['event']).toBe('attribution.pass.budget-exhausted')
    expect(line?.fields['deferred']).toBe(19)
  })
})
