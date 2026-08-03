import { describe, expect, it, vi } from 'vitest'
import {
  X_OEMBED_URL,
  flattenHtml,
  handleFromAuthorUrl,
  httpClaimReader,
  isXPostUrl,
} from './operator-claim.js'

const oembed = (html: string, authorUrl = 'https://x.com/GregorSprint') =>
  vi.fn(async () => new Response(JSON.stringify({ html, author_url: authorUrl }), { status: 200 }))

describe('isXPostUrl', () => {
  it('accepts a post address on either host', () => {
    expect(isXPostUrl('https://x.com/gregorsprint/status/1234567890')).toBe(true)
    expect(isXPostUrl('https://twitter.com/gregorsprint/status/1234567890')).toBe(true)
  })

  it('refuses a profile address, which is the obvious thing to paste', () => {
    expect(isXPostUrl('https://x.com/gregorsprint')).toBe(false)
  })

  it('refuses another network entirely', () => {
    expect(isXPostUrl('https://bsky.app/profile/a/post/b')).toBe(false)
  })

  it('refuses something that is not a URL', () => {
    expect(isXPostUrl('gregorsprint')).toBe(false)
  })
})

describe('handleFromAuthorUrl', () => {
  it('takes the handle from the author address and lowercases it', () => {
    expect(handleFromAuthorUrl('https://x.com/GregorSprint')).toBe('gregorsprint')
  })

  it('tolerates a trailing slash', () => {
    expect(handleFromAuthorUrl('https://x.com/gregorsprint/')).toBe('gregorsprint')
  })

  it('refuses an author address on a host that is not X', () => {
    // The handle is evidence only because X said it. A field echoing some other
    // host would be somebody else's claim about an X account.
    expect(handleFromAuthorUrl('https://example.com/gregorsprint')).toBeNull()
  })

  it('refuses a path that is not a bare handle', () => {
    expect(handleFromAuthorUrl('https://x.com/i/web/status/1')).toBeNull()
  })
})

describe('flattenHtml', () => {
  it('turns line breaks into newlines before stripping tags', () => {
    // Without this, two lines run together into a word that was in neither, and
    // a claim string split across them would read as present when it is not.
    expect(flattenHtml('<p>one<br>two</p>')).toContain('one\ntwo')
  })

  it('unescapes the entities oEmbed emits', () => {
    expect(flattenHtml('<p>a &amp; b</p>')).toContain('a & b')
  })
})

describe('httpClaimReader', () => {
  const A_POST = 'https://x.com/gregorsprint/status/1234567890'

  it('reads the handle from oEmbed and never from the submitted address', async () => {
    // The submitted URL says `gregorsprint`; oEmbed says the author is somebody
    // else. Only the second is evidence, and the reader must report it — this is
    // what stops a citizen submitting a stranger's post under its own handle.
    const fetchImpl = oembed('<p>kolonie-operator-claim-abc</p>', 'https://x.com/someoneelse')

    const result = await httpClaimReader(fetchImpl as unknown as typeof fetch).read(A_POST)

    expect(result.outcome).toBe('found')
    expect(result.outcome === 'found' && result.post.handle).toBe('someoneelse')
  })

  it('asks oEmbed and no other X endpoint', async () => {
    const fetchImpl = oembed('<p>kolonie-operator-claim-abc</p>')

    await httpClaimReader(fetchImpl as unknown as typeof fetch).read(A_POST)

    // `cdn.syndication.twimg.com` is undocumented and its use is forbidden by
    // X's acceptable-use clause. There is no fallback and there must not be one.
    const called = String((fetchImpl.mock.calls as unknown as unknown[][])[0]?.[0])
    expect(called.startsWith(X_OEMBED_URL)).toBe(true)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('refuses an address that is not an X post without fetching anything', async () => {
    const fetchImpl = vi.fn()

    const result = await httpClaimReader(fetchImpl as unknown as typeof fetch).read(
      'https://x.com/gregorsprint',
    )

    expect(result.outcome).toBe('not-found')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('reports a deleted or protected post as not-found', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 404 }))

    const result = await httpClaimReader(fetchImpl as unknown as typeof fetch).read(A_POST)

    expect(result.outcome).toBe('not-found')
    expect(result.outcome === 'not-found' && result.reason).toContain('protected')
  })

  /**
   * The rejection case that matters most here: an outage must never be reported
   * as an absent post. An operator who did everything right would otherwise be
   * sent to look for a mistake that is not theirs.
   */
  it('reports X being down as unavailable rather than as a missing post', async () => {
    for (const status of [429, 500, 503]) {
      const fetchImpl = vi.fn(async () => new Response('', { status }))

      const result = await httpClaimReader(fetchImpl as unknown as typeof fetch).read(A_POST)

      expect(result.outcome).toBe('unavailable')
    }
  })

  it('reports a dropped connection as unavailable', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('socket hang up')
    })

    const result = await httpClaimReader(fetchImpl as unknown as typeof fetch).read(A_POST)

    expect(result.outcome).toBe('unavailable')
  })

  it('reports an answer missing the fields it reads as unavailable', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ html: '<p>hi</p>' }), { status: 200 }),
    )

    const result = await httpClaimReader(fetchImpl as unknown as typeof fetch).read(A_POST)

    expect(result.outcome).toBe('unavailable')
  })
})
