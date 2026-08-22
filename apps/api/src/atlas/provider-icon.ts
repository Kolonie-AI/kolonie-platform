import { AddressRefused, safeFetch } from '@kolonie-ai/verifiers'

/**
 * Finding a provider's own mark on its homepage (`#1405`).
 *
 * ## What this file does and what it deliberately does not
 *
 * It answers *which URLs might carry this provider's icon*, in the order
 * `#1405` decision 1 freezes: the `<link rel="icon">` family, then
 * `apple-touch-icon`, then `/favicon.ico`. **It fetches no image.** That is
 * `fetchAvatar`'s job and it is reused whole rather than rewritten — see below.
 *
 * ## The image path is `avatar-fetch.ts`, unchanged
 *
 * A favicon is a small image from a host somebody else controls, which is the
 * problem `#823` already solved: `fetchAvatar` refuses anything but `https`,
 * resolves the hostname and refuses every private, loopback and metadata address
 * *after each redirect*, holds a deadline, and enforces a byte ceiling **while
 * reading** rather than trusting `content-length`. Writing a second one of those
 * is how the copy that gets forgotten becomes the one that reaches the metadata
 * service.
 *
 * ## Two formats, and this is the security decision
 *
 * `sanitiseAvatar` accepts `png` and `jpeg` and rebuilds them from structurally
 * necessary bytes. **An SVG favicon is refused by that and must stay refused.**
 * The Colony re-serves what it fetches from its own origin, where the Atlas CSP
 * is `img-src 'self'` — so a third party's SVG would be a document from our own
 * domain, and SVG carries script. PNG and JPEG cannot.
 *
 * `.ico` is refused too, for a duller reason: it is not one of the two formats
 * the sanitiser rebuilds. A provider serving only `.ico` gets a monogram, which
 * is what most of them get anyway — measured 2026-08-22, two of eight sampled
 * providers had a homepage at all.
 *
 * ## Nothing here is a request from the reader's browser
 *
 * Decision 2 and the reason for it: the page points at the Colony's own cache,
 * never at the provider. A hotlinked icon would tell that provider who is
 * reading the Atlas and when, which is not a thing a catalogue may do to its
 * readers.
 */

/** How long the Colony waits for a homepage before giving up on its icon. */
export const ICON_PAGE_TIMEOUT_MS = 8_000

/**
 * A homepage is read for its `<head>` and nothing else, so it is bounded far
 * below a page fetch: 256 KB reaches the end of `<head>` on any document that
 * has one, and a host streaming a megabyte of body is not going to say anything
 * about its icon in the part that follows.
 */
export const ICON_PAGE_MAX_BYTES = 256 * 1024

export type IconCandidates =
  | { readonly outcome: 'candidates'; readonly urls: readonly string[] }
  | { readonly outcome: 'refused'; readonly reason: string }

/**
 * Every `<link rel="…icon…">` in the markup, with the `rel` it declared.
 *
 * **A regex over the head rather than a parser**, which is the same call
 * `extractTokens` makes in `website-verify.ts` and for the same reason: what is
 * wanted is one attribute off one element, the input is a stranger's markup, and
 * a DOM parser is a dependency plus a new class of input to be wrong about.
 */
function declaredIcons(html: string): readonly { rel: string; href: string }[] {
  const found: { rel: string; href: string }[] = []

  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = match[0]
    const rel = /\brel\s*=\s*["']?([^"'>]+)/i.exec(tag)?.[1]?.toLowerCase().trim()
    const href = /\bhref\s*=\s*["']?([^"'>\s]+)/i.exec(tag)?.[1]?.trim()

    if (rel === undefined || href === undefined || href === '') continue
    if (!rel.split(/\s+/).some((token) => token.endsWith('icon'))) continue

    found.push({ rel, href })
  }

  return found
}

/**
 * The order decision 1 freezes, and it is a preference rather than a ranking of
 * quality: `apple-touch-icon` is usually the largest and cleanest mark a site
 * has, so it goes first; a plain `icon` next; `/favicon.ico` last, because it is
 * the one that exists whether or not anybody chose it.
 */
function preferenceOf(rel: string): number {
  if (rel.includes('apple-touch-icon')) return 0
  if (rel.includes('mask-icon')) return 2
  return 1
}

/**
 * Where a provider's icon might be, best first.
 *
 * The homepage is fetched once. A homepage that cannot be read still yields
 * `/favicon.ico`, because that URL is a convention rather than something the
 * document has to declare — a site with no `<link>` at all usually still has one.
 */
export async function iconCandidates(
  homepage: string,
  fetcher: (url: string) => Promise<Response> = (target) => safeFetch(target),
  timeoutMs: number = ICON_PAGE_TIMEOUT_MS,
): Promise<IconCandidates> {
  let base: URL
  try {
    base = new URL(homepage)
  } catch {
    return { outcome: 'refused', reason: 'That homepage is not a URL the Colony can read.' }
  }

  if (base.protocol !== 'https:') {
    return {
      outcome: 'refused',
      reason:
        'An icon is taken from an https homepage only. The Colony re-serves the image from its ' +
        'own domain, and a plaintext hop is one somebody else can rewrite on the way.',
    }
  }

  /** The convention, always last and always present. */
  const fallback = new URL('/favicon.ico', base).href
  const absolute = (href: string): string | undefined => {
    try {
      const resolved = new URL(href, base)
      return resolved.protocol === 'https:' ? resolved.href : undefined
    } catch {
      return undefined
    }
  }

  let html: string
  try {
    html = await readHead(await fetcher(base.href), timeoutMs)
  } catch (error) {
    /**
     * **A homepage the Colony could not read is not a provider without an
     * icon.** `AddressRefused` is the SSRF guard and is the one case worth
     * naming: it means the host resolved somewhere the Colony will not go, and
     * trying `/favicon.ico` at the same host would resolve to the same place.
     */
    if (error instanceof AddressRefused) {
      return {
        outcome: 'refused',
        reason: `The Colony will not fetch from there: ${error.message}`,
      }
    }
    return { outcome: 'candidates', urls: [fallback] }
  }

  const declared = [...declaredIcons(html)]
    .sort((left, right) => preferenceOf(left.rel) - preferenceOf(right.rel))
    .map((one) => absolute(one.href))
    .filter((one): one is string => one !== undefined)

  /** Deduplicated, because a page declaring the same href twice is ordinary. */
  return { outcome: 'candidates', urls: [...new Set([...declared, fallback])] }
}

/**
 * The first {@link ICON_PAGE_MAX_BYTES} of a response, decoded as text.
 *
 * Bounded while reading rather than from `content-length`, for `avatar-fetch`'s
 * reason: the header is the far end's claim about itself, and a host that says
 * 2 KB and sends 20 MB is the obvious way to attack a service that believes it.
 */
async function readHead(response: Response, timeoutMs: number): Promise<string> {
  const body = response.body
  if (body === null) return ''

  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  const deadline = AbortSignal.timeout(timeoutMs)

  try {
    while (!deadline.aborted && total < ICON_PAGE_MAX_BYTES) {
      const { done, value } = await reader.read()
      if (done) break
      if (value === undefined) continue

      chunks.push(value)
      total += value.length
    }
  } finally {
    void reader.cancel().catch(() => undefined)
  }

  const joined = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) {
    joined.set(chunk, at)
    at += chunk.length
  }

  return new TextDecoder('utf-8', { fatal: false }).decode(joined)
}
