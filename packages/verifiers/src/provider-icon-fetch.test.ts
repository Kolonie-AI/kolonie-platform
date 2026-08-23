import { describe, expect, it } from 'vitest'
import { AddressRefused } from './website-verify.js'
import { fetchProviderIcon } from './provider-icon-fetch.js'

/**
 * Taking one icon from a provider's host (`#1405`).
 *
 * **Every branch here is a way the far end can be wrong**, which is the point of
 * injecting the fetcher: a host that lies about its length, one that never
 * answers, one that serves an SVG and one that resolves into a private range are
 * all things this has to survive, and none of them can be staged against a real
 * network.
 */

/**
 * A valid 16×16 RGBA PNG — the smallest thing `sanitiseAvatar` accepts.
 *
 * **Sixteen and not one, and that floor is a feature here rather than an
 * inherited inconvenience.** `AVATAR_MIN_DIMENSION` exists because a 1×1 image
 * is not an avatar; it is also, at a provider, exactly the shape of a tracking
 * pixel dressed as a favicon. Sixteen is the smallest real favicon anybody
 * ships, so the sanitiser's existing floor lands in the right place for this
 * surface without being told about it.
 */
const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x10, 0x00, 0x00, 0x00, 0x10, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0xf3, 0xff,
  0x61, 0x00, 0x00, 0x00, 0x19, 0x49, 0x44, 0x41, 0x54, 0x78, 0xda, 0x63, 0x70, 0x68, 0x38, 0xf0,
  0x9f, 0x12, 0xcc, 0x30, 0x6a, 0xc0, 0xa8, 0x01, 0xa3, 0x06, 0x0c, 0x17, 0x03, 0x00, 0x09, 0x8f,
  0x7f, 0x1f, 0xca, 0xd7, 0xb9, 0x3e, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42,
  0x60, 0x82,
])

const HOMEPAGE = 'https://example.test/'

function body(bytes: Uint8Array | string, status = 200): Response {
  const data = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes
  return new Response(status === 200 ? data : null, { status })
}

/** A fetcher that answers from a map and 404s anything it does not know. */
function serving(pages: Readonly<Record<string, Uint8Array | string>>) {
  return async (url: string): Promise<Response> => {
    const page = pages[url]
    return page === undefined ? body('', 404) : body(page)
  }
}

describe('fetchProviderIcon', () => {
  it('takes the icon a homepage declares', async () => {
    const fetched = await fetchProviderIcon(
      HOMEPAGE,
      serving({
        [HOMEPAGE]: '<link rel="icon" href="/mark.png">',
        'https://example.test/mark.png': PNG,
      }),
    )

    expect(fetched).toMatchObject({
      outcome: 'icon',
      format: 'png',
      sourceUrl: 'https://example.test/mark.png',
    })
  })

  it('falls back to the root favicon when the page declares none', async () => {
    const fetched = await fetchProviderIcon(
      HOMEPAGE,
      serving({ [HOMEPAGE]: '<html></html>', 'https://example.test/favicon.ico': PNG }),
    )

    expect(fetched).toMatchObject({
      outcome: 'icon',
      sourceUrl: 'https://example.test/favicon.ico',
    })
  })

  /**
   * A host answering 403 to a bare GET while serving its icon happily is common
   * enough that giving up on the homepage would cost real providers their mark.
   */
  it('still tries the root favicon when the homepage will not load', async () => {
    const fetched = await fetchProviderIcon(
      HOMEPAGE,
      serving({ 'https://example.test/favicon.ico': PNG }),
    )

    expect(fetched).toMatchObject({ outcome: 'icon' })
  })

  it('moves past a candidate that is not an image and takes the next one', async () => {
    const fetched = await fetchProviderIcon(
      HOMEPAGE,
      serving({
        [HOMEPAGE]: '<link rel="apple-touch-icon" href="/mark.svg"><link rel="icon" href="/m.png">',
        'https://example.test/mark.svg': '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
        'https://example.test/m.png': PNG,
      }),
    )

    expect(fetched).toMatchObject({ outcome: 'icon', sourceUrl: 'https://example.test/m.png' })
  })

  /**
   * The three absences mean different things to whoever reads the sweep's
   * numbers, and this is where that stops being a comment.
   */
  it('says refused when the host answered and served nothing usable', async () => {
    const fetched = await fetchProviderIcon(
      HOMEPAGE,
      serving({
        [HOMEPAGE]: '<link rel="icon" href="/mark.svg">',
        'https://example.test/mark.svg': '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
      }),
    )

    expect(fetched).toEqual({ outcome: 'none', absence: 'refused' })
  })

  it('says unreachable when nothing answered at all', async () => {
    const fetched = await fetchProviderIcon(HOMEPAGE, serving({}))

    expect(fetched).toEqual({ outcome: 'none', absence: 'unreachable' })
  })

  it('says unreachable when the host refuses the connection', async () => {
    const fetched = await fetchProviderIcon(HOMEPAGE, async () => {
      throw new Error('ECONNREFUSED')
    })

    expect(fetched).toEqual({ outcome: 'none', absence: 'unreachable' })
  })

  /**
   * The address guard is `safeFetch`'s and this only has to not crash on its
   * refusal: nobody typed this URL and nobody is waiting to be told about it.
   */
  it('treats a private address as nothing rather than as an error', async () => {
    const fetched = await fetchProviderIcon(HOMEPAGE, async () => {
      throw new AddressRefused('refused')
    })

    expect(fetched).toEqual({ outcome: 'none', absence: 'unreachable' })
  })

  it('refuses an http homepage without fetching anything', async () => {
    let asked = 0
    const fetched = await fetchProviderIcon('http://example.test/', async () => {
      asked++
      return body(PNG)
    })

    expect(fetched).toEqual({ outcome: 'none', absence: 'no-candidate' })
    expect(asked).toBe(0)
  })

  it('refuses a homepage that is not a URL', async () => {
    const fetched = await fetchProviderIcon('not a url', async () => body(PNG))

    expect(fetched).toEqual({ outcome: 'none', absence: 'no-candidate' })
  })

  /**
   * `content-length` is the far end's claim about itself. The ceiling is
   * enforced against what actually arrives, which is the rule `avatar-fetch.ts`
   * states at length and this file inherits.
   */
  it('abandons a candidate that is larger than the ceiling', async () => {
    const enormous = new Uint8Array(512 * 1024)
    enormous.set(PNG)

    const fetched = await fetchProviderIcon(
      HOMEPAGE,
      serving({
        [HOMEPAGE]: '<link rel="icon" href="/huge.png">',
        'https://example.test/huge.png': enormous,
      }),
    )

    expect(fetched).toEqual({ outcome: 'none', absence: 'refused' })
  })

  /**
   * The case the deadline exists for: a host that accepts the connection and
   * then says nothing.
   *
   * **Asserted against a body that never finishes rather than against a tiny
   * timeout**, because those are different claims and only this one is the
   * promise. A request that has already come back costs nothing however short
   * the deadline was — what the timeout bounds is *waiting*, and the race inside
   * the read loop is the thing that has to be right. A check between reads would
   * never run again once `read()` went pending, which is the failure mode
   * `avatar-fetch.ts` calls *armed and silent*.
   */
  it('stops waiting on a host that opens a body and never sends', async () => {
    const started = Date.now()
    const fetched = await fetchProviderIcon(
      HOMEPAGE,
      async () =>
        new Response(
          new ReadableStream({
            start() {
              /* Accepted, and nothing will ever arrive. */
            },
          }),
        ),
      120,
    )

    expect(fetched).toEqual({ outcome: 'none', absence: 'unreachable' })
    expect(Date.now() - started).toBeLessThan(5_000)
  })
})
