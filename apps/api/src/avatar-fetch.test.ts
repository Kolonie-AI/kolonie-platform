import { describe, expect, it } from 'vitest'
import { AddressRefused } from '@kolonie-ai/verifiers'
import { fetchAvatar } from './avatar-fetch.js'

/**
 * What the Colony will and will not pull from a host a citizen chose (`#823`).
 *
 * Every test here is a rejection case with its own distinct sentence, and that
 * is the requirement rather than a style: a citizen told *"that image could not
 * be used"* re-uploads the same file, and the difference between *not https*,
 * *too large* and *a private address* is three different next actions.
 *
 * The address guard itself is `safeFetch` in `packages/verifiers` and is tested
 * there. What is asserted here is that this path **carries its refusal through**
 * rather than reporting it as a host being down.
 */

const PNG = (() => {
  const magic = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  const header = new Uint8Array(13)
  new DataView(header.buffer).setUint32(0, 64)
  new DataView(header.buffer).setUint32(4, 64)
  header[8] = 8
  header[9] = 6

  const chunk = (type: string, body: Uint8Array) => {
    const length = new Uint8Array(4)
    new DataView(length.buffer).setUint32(0, body.length)
    return [
      ...length,
      ...[...type].map((character) => character.charCodeAt(0)),
      ...body,
      0,
      0,
      0,
      0,
    ]
  }

  return Uint8Array.from([
    ...magic,
    ...chunk('IHDR', header),
    ...chunk('IDAT', Uint8Array.from([1, 2, 3])),
    ...chunk('IEND', new Uint8Array(0)),
  ])
})()

/** A response whose body arrives in the chunks given, as a real stream. */
function streaming(chunks: readonly Uint8Array[], headers: Record<string, string> = {}): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })

  return new Response(body, { status: 200, headers })
}

const refusal = async (result: Awaited<ReturnType<typeof fetchAvatar>>) => {
  if (result.outcome !== 'refused') throw new Error('expected a refusal')
  return result.reason
}

describe('fetching one avatar', () => {
  it('takes an ordinary image and rebuilds it', async () => {
    const result = await fetchAvatar('https://example.test/a.png', async () => streaming([PNG]))

    expect(result.outcome).toBe('fetched')
    if (result.outcome !== 'fetched') throw new Error('expected an image')
    expect(result.image.format).toBe('png')
    expect(result.image.width).toBe(64)
  })

  it('refuses a plaintext URL, and says why the Colony insists', async () => {
    const reason = await refusal(
      await fetchAvatar('http://example.test/a.png', async () => streaming([PNG])),
    )

    expect(reason).toContain('https')
    expect(reason).toContain('re-serves the image from its own domain')
  })

  it('refuses something that is not a URL at all', async () => {
    expect(await refusal(await fetchAvatar('not a url', async () => streaming([PNG])))).toContain(
      'not a URL',
    )
  })

  /**
   * The refusal that must not be reported as a host being down. A citizen told
   * its server did not answer would go and debug a server that is working
   * perfectly; and the sentence names the rule rather than the address, so
   * nothing is learned about what is reachable from inside.
   */
  it('carries the address guard refusal through, distinctly', async () => {
    const reason = await refusal(
      await fetchAvatar('https://metadata.test/a.png', async () => {
        throw new AddressRefused('SSRF protection: Address 169.254.169.254 is blocked.')
      }),
    )

    expect(reason).toContain('an address the Colony will not fetch')
    expect(reason).toContain('link-local')
    expect(reason).not.toContain('169.254')
  })

  it('reports an unreachable host as an unreachable host', async () => {
    const reason = await refusal(
      await fetchAvatar('https://example.test/a.png', async () => {
        throw new Error('connect ECONNREFUSED')
      }),
    )

    expect(reason).toContain('could not reach')
  })

  it('refuses a URL that answers with an error status, and names it', async () => {
    const reason = await refusal(
      await fetchAvatar(
        'https://example.test/a.png',
        async () => new Response('nope', { status: 404 }),
      ),
    )

    expect(reason).toContain('404')
    expect(reason).toContain('fetches an avatar once')
  })

  /**
   * The assertion the ceiling exists for: `content-length` is the far end's
   * claim about itself, and a host that declares two kilobytes and sends twenty
   * megabytes is the obvious attack on a service that believes the header.
   */
  it('stops reading a body that lies about its length, at the limit', async () => {
    const megabyte = new Uint8Array(1024 * 1024)
    let sent = 0

    const reason = await refusal(
      await fetchAvatar('https://example.test/a.png', async () => {
        const body = new ReadableStream<Uint8Array>({
          pull(controller) {
            sent += 1
            controller.enqueue(megabyte)
            if (sent > 50) controller.close()
          },
        })
        return new Response(body, { status: 200, headers: { 'content-length': '2048' } })
      }),
    )

    expect(reason).toContain('larger than')
    // Read three megabytes at most against a stream willing to send fifty: the
    // limit stopped the download rather than measuring it afterwards.
    expect(sent).toBeLessThan(5)
  })

  it('refuses a body that stops partway through', async () => {
    const reason = await refusal(
      await fetchAvatar('https://example.test/a.png', async () => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(PNG.subarray(0, 8))
            controller.error(new Error('connection reset'))
          },
        })
        return new Response(body, { status: 200 })
      }),
    )

    expect(reason).toContain('stopped sending')
  })

  it('refuses a response with no body', async () => {
    const reason = await refusal(
      await fetchAvatar(
        'https://example.test/a.png',
        async () => new Response(null, { status: 200 }),
      ),
    )

    expect(reason).toContain('no body')
  })

  /**
   * A host may call a text file an image; the bytes are the fact. The content
   * type is never consulted, so this is refused by what arrived rather than by
   * what was claimed about it.
   */
  it('refuses a text file a host called an image', async () => {
    const text = new TextEncoder().encode('this is a sentence, not an image')

    const reason = await refusal(
      await fetchAvatar('https://example.test/a.png', async () =>
        streaming([text], { 'content-type': 'image/png' }),
      ),
    )

    expect(reason).toContain('not a PNG or a JPEG')
  })

  it('refuses an SVG a host called a PNG, naming the script risk', async () => {
    const svg = new TextEncoder().encode('<svg><script>fetch("//elsewhere")</script></svg>')

    const reason = await refusal(
      await fetchAvatar('https://example.test/a.png', async () =>
        streaming([svg], { 'content-type': 'image/png' }),
      ),
    )

    expect(reason).toContain('SVG is refused')
  })

  it('gives up on a host that never finishes', async () => {
    const reason = await refusal(
      await fetchAvatar(
        'https://example.test/a.png',
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              // Never enqueues and never closes.
              pull: () => new Promise(() => {}),
            }),
            { status: 200 },
          ),
        20,
      ),
    )

    expect(reason).toContain('too long')
  })
})
