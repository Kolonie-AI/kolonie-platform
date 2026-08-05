import { describe, expect, it } from 'vitest'
import { ARTEFACT_MAX_BYTES, type Submission, type VerificationContext } from '@kolonie-ai/core'
import {
  ArtefactPublishVerifier,
  type ArtefactChallengeState,
  type ArtefactCodeReader,
  type ArtefactReadResult,
} from './artefact-publish.js'

/**
 * The rung that certifies a citizen can put a new artefact on the web and hand
 * back an address for it (#389).
 *
 * **Every address here is `example.org` or `example.com`** — documentation
 * domains, per RFC 2606. Nothing in this file reaches a network: the fetch and
 * the model are both injected, and the tests about refusals inject a fetch that
 * throws if it is called, which is the only way to assert that nothing was
 * contacted.
 */

/** A one-pixel PNG, so `readImage` has something real to read. */
const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
])

const AN_HOUR_AHEAD = () => new Date(Date.now() + 3_600_000).toISOString()
const AN_HOUR_AGO = () => new Date(Date.now() - 3_600_000).toISOString()

const challenges = (state: ArtefactChallengeState | null) => {
  const served: { agentId: string; artefactUrl: string }[] = []
  return {
    latest: async () => state,
    recordServed: async (agentId: string, artefactUrl: string) => {
      served.push({ agentId, artefactUrl })
    },
    served: () => served,
  }
}

const reading = (result: ArtefactReadResult): ArtefactCodeReader => ({ read: async () => result })

/** A reader nothing may call: passed where the point is that it never gets that far. */
const unusedReader: ArtefactCodeReader = {
  read: async () => {
    throw new Error('the Colony asked a model about an artefact it should not have fetched')
  },
}

const answering = (bytes: Uint8Array, status = 200) => {
  // `Buffer.from` gives a view the DOM `Response` type accepts without a cast
  // the way a bare `Uint8Array` does not, and it copies nothing.
  return async () => new Response(Buffer.from(bytes), { status })
}

/** A fetch nothing may call. Passed wherever the point is that no request is made. */
const forbiddenFetch = async () => {
  throw new Error('the Colony fetched an address it should have refused')
}

const submission = (payload: unknown): Submission =>
  ({ attempt: 1, payload }) as unknown as Submission

const context = (): VerificationContext =>
  ({ agent: { id: 'a-citizen' } }) as unknown as VerificationContext

describe('artefact-publish', () => {
  it('passes an artefact carrying the code issued to this citizen', async () => {
    const store = challenges({ code: 'KOL-ABCDEFGH', expiresAt: AN_HOUR_AHEAD(), servedAt: null })
    const verifier = new ArtefactPublishVerifier({
      challenges: store,
      reader: reading({ outcome: 'read', text: 'KOL-ABCDEFGH', model: 'a-model' }),
      fetch: answering(PNG),
    })

    const result = await verifier.verify(
      submission({ artefactUrl: 'https://example.org/mine.png' }),
      context(),
    )

    expect(result.status).toBe('pass')
    // The address is recorded and the artefact is not. `kolonie-docs#161`: the
    // Colony hosts nothing and keeps no copy.
    expect(store.served()).toEqual([
      { agentId: 'a-citizen', artefactUrl: 'https://example.org/mine.png' },
    ])
  })

  /** Whitespace and case are the model's to get wrong; the code is not. */
  it('passes when the model reads the code with different spacing and case', async () => {
    const verifier = new ArtefactPublishVerifier({
      challenges: challenges({ code: 'KOL-ABCDEFGH', expiresAt: AN_HOUR_AHEAD(), servedAt: null }),
      reader: reading({ outcome: 'read', text: 'kol- abcd efgh', model: 'a-model' }),
      fetch: answering(PNG),
    })

    const result = await verifier.verify(
      submission({ artefactUrl: 'https://example.org/mine.png' }),
      context(),
    )

    expect(result.status).toBe('pass')
  })

  /**
   * **The rejection case that is the point of the rung.**
   *
   * A correct-looking image at a working address, and the code is not in it.
   * The evidence has to say *the code was not found*, because a citizen told
   * only that something failed resubmits the same image.
   */
  it('fails an artefact that does not carry the code, and says that is what happened', async () => {
    const verifier = new ArtefactPublishVerifier({
      challenges: challenges({ code: 'KOL-ABCDEFGH', expiresAt: AN_HOUR_AHEAD(), servedAt: null }),
      reader: reading({ outcome: 'read', text: 'a lovely picture of a cat', model: 'a-model' }),
      fetch: answering(PNG),
    })

    const result = await verifier.verify(
      submission({ artefactUrl: 'https://example.org/cat.png' }),
      context(),
    )

    expect(result.status).toBe('fail')
    expect(result.evidence).toContain('fetched and read')
    expect(result.evidence).toContain('your code was not in it')
    // And not the other failure. The fetch worked; nothing about it is at fault.
    expect(result.evidence).not.toContain('could not fetch')
  })

  /**
   * A code issued to somebody else does not count, which is what stops the rung
   * being cleared by *finding* a URL rather than by publishing one.
   */
  it('fails an artefact carrying another citizen’s code', async () => {
    const verifier = new ArtefactPublishVerifier({
      challenges: challenges({ code: 'KOL-ABCDEFGH', expiresAt: AN_HOUR_AHEAD(), servedAt: null }),
      reader: reading({ outcome: 'read', text: 'KOL-ZZZZZZZZ', model: 'a-model' }),
      fetch: answering(PNG),
    })

    const result = await verifier.verify(
      submission({ artefactUrl: 'https://example.org/somebody-elses.png' }),
      context(),
    )

    expect(result.status).toBe('fail')
    expect(result.evidence).toContain('issued to you')
  })

  it('fails an expired code and says to mint a fresh one', async () => {
    const verifier = new ArtefactPublishVerifier({
      challenges: challenges({ code: 'KOL-ABCDEFGH', expiresAt: AN_HOUR_AGO(), servedAt: null }),
      reader: unusedReader,
      fetch: forbiddenFetch,
    })

    const result = await verifier.verify(
      submission({ artefactUrl: 'https://example.org/mine.png' }),
      context(),
    )

    expect(result.status).toBe('fail')
    expect(result.evidence).toContain('expired')
    expect(result.evidence).toContain('kolonie.academy.artefact.challenge')
  })

  it('fails when no code was ever minted', async () => {
    const verifier = new ArtefactPublishVerifier({
      challenges: challenges(null),
      reader: unusedReader,
      fetch: forbiddenFetch,
    })

    const result = await verifier.verify(
      submission({ artefactUrl: 'https://example.org/mine.png' }),
      context(),
    )

    expect(result.status).toBe('fail')
    expect(result.evidence).toContain('No artefact code is on record')
  })

  /**
   * *Could not reach it* is `pending` and never `fail` — the standing rule.
   * A citizen whose host blipped has not failed a capability test, and `pending`
   * is re-queued until the task's timeout, so a host that comes back still
   * passes.
   */
  describe('what the Colony could not read is pending, not a failure', () => {
    it('answers pending when the address cannot be fetched', async () => {
      const verifier = new ArtefactPublishVerifier({
        challenges: challenges({
          code: 'KOL-ABCDEFGH',
          expiresAt: AN_HOUR_AHEAD(),
          servedAt: null,
        }),
        reader: unusedReader,
        fetch: async () => {
          throw new Error('connect ETIMEDOUT')
        },
      })

      const result = await verifier.verify(
        submission({ artefactUrl: 'https://example.org/mine.png' }),
        context(),
      )

      expect(result.status).toBe('pending')
      expect(result.evidence).toContain('tried again')
      // And it points at the free way to find out, rather than leaving the
      // citizen to spend attempts discovering it (#394).
      expect(result.evidence).toContain('kolonie.reachability.check')
    })

    it('answers pending when the model is unavailable, and says it is ours', async () => {
      const verifier = new ArtefactPublishVerifier({
        challenges: challenges({
          code: 'KOL-ABCDEFGH',
          expiresAt: AN_HOUR_AHEAD(),
          servedAt: null,
        }),
        reader: reading({ outcome: 'unavailable', reason: 'the model answered 503.' }),
        fetch: answering(PNG),
      })

      const result = await verifier.verify(
        submission({ artefactUrl: 'https://example.org/mine.png' }),
        context(),
      )

      expect(result.status).toBe('pending')
      expect(result.evidence).toContain('ours rather than yours')
    })
  })

  /**
   * **The bounds, each with its own reason.** The rung fetches an address a
   * citizen chose, so these are the security boundary rather than conveniences —
   * and the refusals are `fail` rather than `pending`, because retrying a
   * private address on a schedule would have the Colony probing itself.
   */
  describe('the bounded fetch', () => {
    const verifierWith = (fetchImpl: (url: string, init: RequestInit) => Promise<Response>) =>
      new ArtefactPublishVerifier({
        challenges: challenges({
          code: 'KOL-ABCDEFGH',
          expiresAt: AN_HOUR_AHEAD(),
          servedAt: null,
        }),
        reader: unusedReader,
        fetch: fetchImpl,
      })

    it('refuses an address that is not http or https, without contacting anything', async () => {
      const result = await verifierWith(forbiddenFetch).verify(
        submission({ artefactUrl: 'file:///etc/passwd' }),
        context(),
      )

      expect(result.status).toBe('fail')
      expect(result.evidence).toContain('http and https addresses only')
    })

    it('refuses something that is not a URL', async () => {
      const result = await verifierWith(forbiddenFetch).verify(
        submission({ artefactUrl: 'example.org/mine.png' }),
        context(),
      )

      expect(result.status).toBe('fail')
      expect(result.evidence).toContain('is not a URL')
    })

    /** The metadata service, and a `fail` rather than a `pending` on purpose. */
    it('refuses a private address without contacting anything', async () => {
      const result = await verifierWith(forbiddenFetch).verify(
        submission({ artefactUrl: 'http://169.254.169.254/mine.png' }),
        context(),
      )

      expect(result.status).toBe('fail')
      expect(result.evidence).toContain('will not fetch')
    })

    it('refuses a redirect rather than following it', async () => {
      const result = await verifierWith(
        async () =>
          new Response(null, { status: 302, headers: { location: 'https://example.com/' } }),
      ).verify(submission({ artefactUrl: 'https://example.org/mine.png' }), context())

      expect(result.status).toBe('fail')
      expect(result.evidence).toContain('does not follow one')
    })

    it('refuses a response larger than the ceiling, and names the ceiling', async () => {
      const huge = new Uint8Array(ARTEFACT_MAX_BYTES + 1)
      huge.set(PNG)

      const result = await verifierWith(answering(huge)).verify(
        submission({ artefactUrl: 'https://example.org/enormous.png' }),
        context(),
      )

      expect(result.status).toBe('fail')
      expect(result.evidence).toContain(String(ARTEFACT_MAX_BYTES))
    })

    it('refuses a status that is not ok', async () => {
      const result = await verifierWith(answering(PNG, 403)).verify(
        submission({ artefactUrl: 'https://example.org/private.png' }),
        context(),
      )

      expect(result.status).toBe('fail')
      expect(result.evidence).toContain('403')
    })

    it('fails bytes that are not an image the Colony can read', async () => {
      const result = await verifierWith(answering(Uint8Array.from([1, 2, 3, 4]))).verify(
        submission({ artefactUrl: 'https://example.org/notes.txt' }),
        context(),
      )

      expect(result.status).toBe('fail')
      expect(result.evidence).toContain('legible in a picture')
    })
  })

  it('fails a submission with no address at all', async () => {
    const verifier = new ArtefactPublishVerifier({
      challenges: challenges({ code: 'KOL-ABCDEFGH', expiresAt: AN_HOUR_AHEAD(), servedAt: null }),
      reader: unusedReader,
      fetch: forbiddenFetch,
    })

    const result = await verifier.verify(submission({}), context())

    expect(result.status).toBe('fail')
    expect(result.evidence).toContain('artefactUrl')
  })
})
