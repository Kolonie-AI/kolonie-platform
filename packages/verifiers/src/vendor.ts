/**
 * What a vendor's refusal means, and how much of it is safe to keep.
 *
 * **The classification is the defect this file exists for** (`#217`). Every
 * non-`ok` answer from the vision endpoint used to become `unavailable`, which
 * means *try again* — and a request the vendor calls malformed will be malformed
 * on every retry. One submission produced 1830 verification rows that way,
 * measured 2026-08-02 over the ten image submissions the Colony had received.
 *
 * Nothing here knows about images. It is shared by both model callers so that
 * the rule cannot drift between the rung that draws and the rung that generates.
 */

/**
 * How much of the vendor's answer is recorded.
 *
 * Enough to carry a provider's error object — OpenRouter's are a sentence and a
 * code — and short enough that a verification row stays readable. A body is
 * evidence about our own request, not a payload to archive.
 */
export const VENDOR_BODY_LIMIT = 500

/** What is put in place of anything that looked like a credential. */
export const REDACTED = '[redacted]'

/**
 * A vendor answer that will be the same on every retry.
 *
 * `status` and `body` are carried rather than folded into `reason` because the
 * record is the point: the Colony could not say *why* a 400 happened, because
 * the body was thrown away and only the number survived.
 */
export interface VendorRejection {
  readonly status: number
  /** The first {@link VENDOR_BODY_LIMIT} characters, with credentials removed. */
  readonly body: string
}

/**
 * Whether an HTTP status from a model vendor is permanent.
 *
 * **4xx is the vendor calling our request wrong, and three of them are not.**
 * `402` is out of credit and `429` is rate-limited — both are ours, both clear
 * on their own, and both were correctly retried before this existed. `408` is
 * the vendor timing itself out, which is the world being slow. Everything else
 * in the 4xx range says the request itself is unacceptable, and a request does
 * not become acceptable by being sent again.
 *
 * 5xx stays transient by construction: a server that is broken now may not be
 * broken in thirty seconds, and that is exactly what the backoff is for.
 */
export function isPermanentVendorStatus(status: number): boolean {
  return status >= 400 && status < 500 && status !== 402 && status !== 408 && status !== 429
}

/**
 * Read a refused response into something that can be written down.
 *
 * **Never throws.** It runs on the failure path, where a second failure would
 * replace a diagnosable fault with a mysterious one — a body that cannot be read
 * is recorded as saying nothing, which is true and is still better than the
 * number alone.
 *
 * `secrets` are the values this process sent. They are scrubbed because a
 * provider that echoes the request back is a normal thing for a provider to do,
 * and this string is about to be stored in a verification row that citizens and
 * agents can read.
 */
export async function readVendorRejection(
  response: Response,
  secrets: readonly (string | undefined)[] = [],
): Promise<VendorRejection> {
  let body: string
  try {
    body = await response.text()
  } catch {
    body = ''
  }

  return { status: response.status, body: redactSecrets(body, secrets).slice(0, VENDOR_BODY_LIMIT) }
}

/**
 * Remove anything credential-shaped from text that is about to be stored.
 *
 * Two passes, and both are needed. The **known** values are the ones this
 * process actually sent, and scrubbing them is the guarantee the tests assert.
 * The **shaped** pass catches a key we did not send and therefore cannot name —
 * a second account's key quoted in a provider's error, say — and is a net rather
 * than a promise: it is here because the cost of missing one is a leaked
 * credential in a row every agent in the Colony can read.
 *
 * Truncation is deliberately applied *after* this rather than before, so a
 * secret cannot be half-cut and survive as a recognisable prefix.
 */
export function redactSecrets(text: string, secrets: readonly (string | undefined)[]): string {
  let out = text

  for (const secret of secrets) {
    if (secret === undefined || secret.trim() === '') continue
    out = out.split(secret).join(REDACTED)
  }

  return out
    .replace(/\b(sk|ghp|gho|ghs|github_pat)[-_][A-Za-z0-9-_]{8,}/g, REDACTED)
    .replace(/\bBearer\s+[A-Za-z0-9\-._~+/]{8,}=*/gi, `Bearer ${REDACTED}`)
    .replace(/\beyJ[A-Za-z0-9-_]{8,}\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+/g, REDACTED)
}

/**
 * The sentence a citizen is shown when the Colony's own request was refused.
 *
 * Written once, here, because the two rungs that can hit it must not describe
 * the same event differently — and because what it has to establish is delicate:
 * the submission is over, nothing about it was judged, and none of it is the
 * citizen's fault.
 */
export function vendorFaultEvidence(rejection: VendorRejection, subject: string): string {
  return (
    `The Colony's own request to the model that ${subject} was refused: it answered ` +
    `${rejection.status}, which is a request the Colony built wrongly and would build wrongly ` +
    'again. So it is not being retried, and this is closed rather than left open pretending ' +
    'something is still happening.\n\n' +
    "Nothing here is your submission's fault. This does not count as an attempt, your " +
    'specification stays usable, and you can hand the same image in again — you are not being ' +
    'asked to make another one.' +
    (rejection.body === '' ? '' : `\n\nWhat the vendor said: ${rejection.body}`)
  )
}
