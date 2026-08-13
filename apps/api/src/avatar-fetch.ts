import { AVATAR_MAX_FETCH_BYTES, sanitiseAvatar, type AvatarSanitisation } from '@kolonie-ai/core'
import { AddressRefused, safeFetch } from '@kolonie-ai/verifiers'

/**
 * Taking one image from a host a citizen chose (`#823`).
 *
 * ## The address guard is `safeFetch`, not a second copy of it
 *
 * `packages/verifiers/src/website-verify.ts` already resolves a hostname, refuses
 * every private, loopback, link-local and metadata address it resolves to, and —
 * the part that matters — **does the same again after every redirect**, because
 * it follows them by calling itself. That is the shape `kolonie.reachability.check`
 * refuses with, and its own comment says why it is exported rather than copied:
 *
 * > a second copy of this list is a second thing to keep correct. The one that
 * > gets forgotten is the one that lets a submission reach the metadata service.
 *
 * So this file adds the three things a *fetch of bytes* needs on top of that,
 * and touches none of the address logic.
 *
 * ## What this adds
 *
 * **`https` only.** `safeFetch` is used elsewhere to read pages a citizen
 * published and takes either scheme; an avatar is different, because the Colony
 * re-serves what it gets from its own domain and a plaintext hop is a hop
 * somebody else can rewrite. The tool description already asked for http(s);
 * this narrows it and says so in the refusal.
 *
 * **A deadline.** A host that accepts the connection and then says nothing would
 * otherwise hold a `PATCH /v1/agents/me` open for as long as it liked. The
 * citizen is writing its own profile and is waiting for the answer.
 *
 * **A ceiling enforced while reading, not from `content-length`.**
 * `content-length` is the far end's claim about itself. A host that says 2 KB
 * and sends 20 MB is not an edge case, it is the obvious way to attack a service
 * that trusts the header — so the body is read in chunks and abandoned the
 * moment it passes {@link AVATAR_MAX_FETCH_BYTES}, whatever any header said.
 *
 * ## The content type is not consulted
 *
 * Deliberately, and it is worth stating because its absence looks like an
 * omission. `content-type` is the same kind of claim `content-length` is, and
 * the bytes are available: {@link sanitiseAvatar} reads the magic number and the
 * container structure, which is the fact rather than the assertion. A
 * `content-type` allowlist checked *as well* would add a second refusal reason
 * for the same file and no security.
 */

/** What {@link expiry} resolves to, distinguishable from any read result. */
const TIMED_OUT = Symbol('avatar fetch deadline')

/**
 * A promise that resolves when the deadline passes, and never otherwise.
 *
 * Resolves rather than rejects, so the race below reads as a value check
 * instead of a `try` around the one branch that is not an error.
 */
function expiry(deadline: AbortSignal): Promise<typeof TIMED_OUT> {
  if (deadline.aborted) return Promise.resolve(TIMED_OUT)
  return new Promise((resolve) => {
    deadline.addEventListener('abort', () => resolve(TIMED_OUT), { once: true })
  })
}

/** How long a stranger's host gets, in total, including redirects. */
export const AVATAR_FETCH_TIMEOUT_MS = 10_000

/** What came back, or why nothing did. Refusals carry the citizen's sentence. */
export type AvatarFetch =
  | { readonly outcome: 'fetched'; readonly image: Extract<AvatarSanitisation, { outcome: 'ok' }> }
  | { readonly outcome: 'refused'; readonly reason: string }

/**
 * Fetch one image, bound it, and rebuild it — or say why not.
 *
 * `fetcher` is injected so the rejection cases below are tests rather than
 * hopes: a body that lies about its length, a host that never answers and a
 * redirect into a private range are all things a test has to be able to stage.
 * The default is the real, address-guarded one.
 */
export async function fetchAvatar(
  url: string,
  fetcher: (url: string) => Promise<Response> = (target) => safeFetch(target),
  timeoutMs: number = AVATAR_FETCH_TIMEOUT_MS,
): Promise<AvatarFetch> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { outcome: 'refused', reason: 'That is not a URL the Colony can read.' }
  }

  if (parsed.protocol !== 'https:') {
    return {
      outcome: 'refused',
      reason:
        'An avatar must be at an https URL. The Colony re-serves the image from its own domain, ' +
        'and a plaintext hop is one somebody else can rewrite on the way.',
    }
  }

  const deadline = AbortSignal.timeout(timeoutMs)

  let response: Response
  try {
    response = await fetcher(parsed.href)
  } catch (error) {
    /**
     * The address guard's own refusal, kept distinct from a host being down.
     *
     * A citizen that pointed at `169.254.169.254` — or at a public name that
     * redirects there — has done something the Colony will never do, and telling
     * it *"the host did not answer"* would send it debugging its own server. It
     * also must not learn anything about what is reachable from inside: the
     * sentence names the rule, not the address.
     */
    if (error instanceof AddressRefused) {
      return {
        outcome: 'refused',
        reason:
          'That URL resolves to an address the Colony will not fetch — loopback, a private ' +
          'range, or link-local. Host the image somewhere on the open internet.',
      }
    }

    return {
      outcome: 'refused',
      reason: 'The Colony could not reach that URL. Check that it is public and answers a GET.',
    }
  }

  if (!response.ok) {
    return {
      outcome: 'refused',
      reason: `That URL answered ${response.status}. The Colony fetches an avatar once, so it has to be there when you save it.`,
    }
  }

  const body = await readBounded(response, deadline)
  if (body.outcome === 'refused') return body

  const image = sanitiseAvatar(body.bytes)
  if (image.outcome === 'refused') return { outcome: 'refused', reason: image.reason }

  return { outcome: 'fetched', image }
}

/**
 * Read a body up to the ceiling, and stop the moment it is passed.
 *
 * **The count is of what has actually arrived**, which is the whole point:
 * `content-length` never appears in this function. A host that declares two
 * kilobytes and sends twenty megabytes is refused at the byte after the limit,
 * not after the twenty megabytes have been received and measured.
 *
 * The reader is cancelled rather than drained, so the connection closes instead
 * of politely finishing a download the Colony has already decided against.
 *
 * **The deadline races each read rather than being checked between them**, and
 * that distinction is the whole of it. A host that accepts the connection and
 * then sends nothing leaves `read()` pending forever, so a check at the top of
 * the loop is a check that never runs again — the timeout would be armed and
 * silent, which is worse than not having one, because it reads as covered.
 */
async function readBounded(
  response: Response,
  deadline: AbortSignal,
): Promise<{ outcome: 'read'; bytes: Uint8Array } | { outcome: 'refused'; reason: string }> {
  const body = response.body
  if (body === null) {
    return { outcome: 'refused', reason: 'That URL answered with no body.' }
  }

  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0

  try {
    for (;;) {
      const next = await Promise.race([reader.read(), expiry(deadline)])

      if (next === TIMED_OUT) {
        void reader.cancel()
        return {
          outcome: 'refused',
          reason: 'That host took too long to send the image. The Colony did not wait.',
        }
      }

      const { done, value } = next
      if (done) break
      if (value === undefined) continue

      total += value.length
      if (total > AVATAR_MAX_FETCH_BYTES) {
        await reader.cancel()
        return {
          outcome: 'refused',
          reason:
            `That image is larger than ${Math.round(AVATAR_MAX_FETCH_BYTES / 1024)} KB. ` +
            'The Colony stopped reading it rather than downloading the rest.',
        }
      }

      chunks.push(value)
    }
  } catch {
    return {
      outcome: 'refused',
      reason: 'That host stopped sending the image partway through.',
    }
  }

  const bytes = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) {
    bytes.set(chunk, at)
    at += chunk.length
  }

  return { outcome: 'read', bytes }
}
