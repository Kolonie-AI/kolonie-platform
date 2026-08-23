import {
  PROVIDER_ICON_MAX_FETCH_BYTES,
  PROVIDER_ICON_MAX_HTML_BYTES,
  providerIconCandidates,
  sanitiseAvatar,
  type AvatarFormat,
} from '@kolonie-ai/core'
import { AddressRefused, safeFetch } from './website-verify.js'

/**
 * Taking one icon from a provider's own host (`#1405`).
 *
 * ## Everything `avatar-fetch.ts` argued, inherited rather than restated
 *
 * That file is the worked example and this is the second caller of the same
 * three rules: the address guard is `safeFetch` and never a second copy of the
 * private-range list, the ceiling is enforced **while reading** rather than from
 * `content-length`, and there is a deadline because a host that accepts a
 * connection and then says nothing would otherwise hold this open forever.
 *
 * **It lives here rather than in `apps/api` because the caller is the sweep.**
 * `avatar-fetch.ts` sits in the API because a citizen is waiting on the answer
 * to its own `PATCH`; nothing is waiting on this one, and the process that runs
 * it is `apps/verifier-runner`. Two apps cannot import each other, so the shared
 * home is the package that already owns `safeFetch`.
 *
 * ## What is different, and it is one thing
 *
 * **This makes two requests rather than one.** A homepage is read for its
 * declared icons, then one of the candidates is fetched. Both are bounded, both
 * go through the same guard, and the whole of it shares a single deadline — a
 * provider that is slow twice does not get twice as long.
 */

/** What {@link expiry} resolves to, distinguishable from any read result. */
const TIMED_OUT = Symbol('provider icon fetch deadline')

function expiry(deadline: AbortSignal): Promise<typeof TIMED_OUT> {
  if (deadline.aborted) return Promise.resolve(TIMED_OUT)
  return new Promise((resolve) => {
    deadline.addEventListener('abort', () => resolve(TIMED_OUT), { once: true })
  })
}

/**
 * How long one provider gets, in total, across both requests and every redirect.
 *
 * Shorter than the avatar's ten seconds because nobody is waiting: a provider
 * that is slow costs the sweep a slot it could have spent on a provider that is
 * not, and it will be asked again in seven days. **A tick that spends its whole
 * budget on four hosts that never answer is the failure this number prevents.**
 */
export const PROVIDER_ICON_TIMEOUT_MS = 6_000

/** How many candidates are tried before the Colony gives up on a provider. */
export const PROVIDER_ICON_MAX_CANDIDATES = 4

/** What came back, or the slug saying why nothing did. */
export type ProviderIconFetch =
  | {
      readonly outcome: 'icon'
      readonly bytes: Uint8Array
      readonly format: AvatarFormat
      readonly width: number
      readonly height: number
      readonly sourceUrl: string
    }
  | { readonly outcome: 'none'; readonly absence: 'unreachable' | 'no-candidate' | 'refused' }

/**
 * Fetch one provider's icon, or say which kind of nothing there was.
 *
 * `fetcher` is injected so every branch below is a test rather than a hope — a
 * homepage that declares nothing, a candidate that 404s, a body that lies about
 * its length, a redirect into a private range.
 *
 * **The three absences are distinct because they mean different things to
 * whoever reads the sweep's numbers.** `unreachable` is the provider's host
 * being down or refusing, and it may well work next week. `no-candidate` is a
 * page that declared no icon and has no `/favicon.ico`. `refused` is bytes that
 * arrived and were not something the Colony will serve — an SVG, a GIF, an ICO
 * container, something over the ceiling — and that one will not fix itself.
 */
export async function fetchProviderIcon(
  homepage: string,
  fetcher: (url: string) => Promise<Response> = (target) => safeFetch(target),
  timeoutMs: number = PROVIDER_ICON_TIMEOUT_MS,
): Promise<ProviderIconFetch> {
  let base: URL
  try {
    base = new URL(homepage)
  } catch {
    return { outcome: 'none', absence: 'no-candidate' }
  }

  /**
   * **`https` only**, and an `http` homepage is `no-candidate` rather than
   * `unreachable`: nothing is wrong at the far end, the Colony simply will not
   * re-serve bytes that crossed a plaintext hop somebody else could rewrite.
   */
  if (base.protocol !== 'https:') return { outcome: 'none', absence: 'no-candidate' }

  const deadline = AbortSignal.timeout(timeoutMs)

  const page = await read(base.href, fetcher, deadline, PROVIDER_ICON_MAX_HTML_BYTES)
  /**
   * **A homepage that will not load still gets `/favicon.ico` tried.** A host
   * answering 403 to a bare GET while serving its icon happily is common enough
   * that giving up here would cost real providers their mark; the root fallback
   * is one more bounded request against a host the guard has already resolved.
   */
  const candidates =
    page.outcome === 'read'
      ? providerIconCandidates(new TextDecoder().decode(page.bytes), base.href)
      : providerIconCandidates('', base.href)

  if (candidates.length === 0) {
    return { outcome: 'none', absence: page.outcome === 'read' ? 'no-candidate' : 'unreachable' }
  }

  /**
   * Whether anything at all answered, across every candidate.
   *
   * It is what separates *this host is down* from *this host serves things that
   * are not images*: a provider where four candidates each 404 is reachable and
   * has no icon, and calling that `unreachable` would have the sweep reporting an
   * outage that is not one.
   */
  let answered = page.outcome === 'read'

  for (const candidate of candidates.slice(0, PROVIDER_ICON_MAX_CANDIDATES)) {
    const body = await read(candidate, fetcher, deadline, PROVIDER_ICON_MAX_FETCH_BYTES)
    if (body.outcome !== 'read') continue

    answered = true

    /**
     * **`sanitiseAvatar` decides, and it reads the bytes** (`#823`). A `type=`
     * attribute or a `.png` in a path is the page's claim about itself; the
     * magic number is the fact. This is also where SVG is refused, with the
     * reason that file already gives — it can carry scripts and external
     * references, and the Colony will not serve those from its own domain.
     */
    const image = sanitiseAvatar(body.bytes)
    if (image.outcome !== 'ok') continue

    return {
      outcome: 'icon',
      bytes: image.bytes,
      format: image.format,
      width: image.width,
      height: image.height,
      sourceUrl: candidate,
    }
  }

  return { outcome: 'none', absence: answered ? 'refused' : 'unreachable' }
}

/** Read one address up to a ceiling, or say that nothing usable came back. */
async function read(
  url: string,
  fetcher: (url: string) => Promise<Response>,
  deadline: AbortSignal,
  ceiling: number,
): Promise<{ outcome: 'read'; bytes: Uint8Array } | { outcome: 'nothing' }> {
  if (deadline.aborted) return { outcome: 'nothing' }

  let response: Response
  try {
    response = await fetcher(url)
  } catch (error) {
    /**
     * **The address guard's refusal is not treated differently here**, and that
     * is the opposite call from `avatar-fetch.ts`. There, a citizen typed the
     * URL and has to be told it pointed at the metadata service; here nobody
     * typed anything, nobody is waiting, and a provider whose homepage resolves
     * somewhere the Colony will not go simply has no icon. The `instanceof`
     * stays so the distinction is visible to the next reader rather than
     * accidental.
     */
    void (error instanceof AddressRefused)
    return { outcome: 'nothing' }
  }

  if (!response.ok || response.body === null) {
    /**
     * A body left unread is a connection left open. `#1405`'s own acceptance
     * criterion is *fetch timeouts bounded*, and a socket held by a response
     * nobody consumed outlives every timeout in this file.
     */
    void response.body?.cancel()
    return { outcome: 'nothing' }
  }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0

  try {
    for (;;) {
      const next = await Promise.race([reader.read(), expiry(deadline)])

      if (next === TIMED_OUT) {
        void reader.cancel()
        return { outcome: 'nothing' }
      }

      const { done, value } = next
      if (done) break
      if (value === undefined) continue

      total += value.length
      if (total > ceiling) {
        await reader.cancel()
        /**
         * **What arrived before the ceiling is kept for the homepage and
         * discarded for the icon**, and the difference is what each is for. A
         * truncated homepage still has its `<head>` in it, which is the only
         * part `providerIconCandidates` reads. A truncated image is not an
         * image, and handing half a PNG to the sanitiser would refuse it a
         * sentence later with less to say.
         */
        if (ceiling !== PROVIDER_ICON_MAX_HTML_BYTES) return { outcome: 'nothing' }
        break
      }

      chunks.push(value)
    }
  } catch {
    return { outcome: 'nothing' }
  }

  const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0))
  let at = 0
  for (const chunk of chunks) {
    bytes.set(chunk, at)
    at += chunk.length
  }

  return { outcome: 'read', bytes }
}
