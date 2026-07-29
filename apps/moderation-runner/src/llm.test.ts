import { describe, expect, it } from 'vitest'
import { openRouterModel, MODERATION_MODEL } from './llm.js'
import { cosine, SIMILARITY_THRESHOLD } from './dedup.js'

/** A `fetch` that answers with one canned body and records what it was sent. */
const stubFetch = (body: unknown, status = 200) => {
  const sent: { url: string; init: RequestInit | undefined }[] = []
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), init })
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as Response
  }) as unknown as typeof fetch
  return { impl, sent }
}

const aVerdict = (content: string) => ({ choices: [{ message: { content } }] })

describe('classifying', () => {
  it('sends the model the maintainer chose, and asks for a closed set of answers', async () => {
    const { impl, sent } = stubFetch(aVerdict('{"decision":"approve","reason":"concrete"}'))

    await openRouterModel('a-key', { fetch: impl }).classify({
      system: 'you moderate',
      user: 'some report',
      choices: ['approve', 'reject'],
    })

    const body = JSON.parse(String(sent[0]?.init?.body)) as Record<string, unknown>
    expect(body.model).toBe(MODERATION_MODEL)
    expect(body.temperature).toBe(0)

    // The answers reach the model as a schema enum rather than as a sentence in
    // the prompt, so an answer outside the set is impossible rather than handled.
    const format = body.response_format as {
      json_schema: { strict: boolean; schema: { properties: { decision: { enum: string[] } } } }
    }
    expect(format.json_schema.strict).toBe(true)
    expect(format.json_schema.schema.properties.decision.enum).toEqual(['approve', 'reject'])
  })

  it('returns the decision and the reason', async () => {
    const { impl } = stubFetch(aVerdict('{"decision":"reject","reason":"Nothing specific."}'))

    const verdict = await openRouterModel('a-key', { fetch: impl }).classify({
      system: 's',
      user: 'u',
      choices: ['approve', 'reject'],
    })

    expect(verdict).toEqual({ decision: 'reject', reason: 'Nothing specific.' })
  })

  /**
   * Strict schemas are the vendor's promise, not ours. If a provider ever
   * relaxes one, an answer outside the offered set has to fail loudly here —
   * the alternative is a string that is not `approve` being treated as one of
   * the branches by whatever compares it next.
   */
  it('refuses an answer that was not on offer', async () => {
    const { impl } = stubFetch(aVerdict('{"decision":"maybe","reason":"unsure"}'))

    await expect(
      openRouterModel('a-key', { fetch: impl }).classify({
        system: 's',
        user: 'u',
        choices: ['approve', 'reject'],
      }),
    ).rejects.toThrow('not on offer')
  })

  /**
   * The error carries the status and nothing else. A vendor's error body can
   * echo the request back, and the request carries the key.
   */
  it('does not put the vendor’s body in the error it throws', async () => {
    const { impl } = stubFetch({ error: { message: 'bad key a-key-in-the-echo' } }, 401)

    await expect(
      openRouterModel('a-key', { fetch: impl }).classify({
        system: 's',
        user: 'u',
        choices: ['approve'],
      }),
    ).rejects.toThrow(/answered 401/)
  })

  it('sends the key as a bearer credential and nowhere else', async () => {
    const { impl, sent } = stubFetch(aVerdict('{"decision":"approve","reason":"ok"}'))

    await openRouterModel('the-secret', { fetch: impl }).classify({
      system: 's',
      user: 'u',
      choices: ['approve'],
    })

    const headers = sent[0]?.init?.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer the-secret')
    expect(String(sent[0]?.url)).not.toContain('the-secret')
  })
})

describe('embedding', () => {
  it('returns one vector per input, in the order they were sent', async () => {
    const { impl } = stubFetch({
      data: [
        { index: 1, embedding: [0, 1] },
        { index: 0, embedding: [1, 0] },
      ],
    })

    const vectors = await openRouterModel('a-key', { fetch: impl }).embed(['first', 'second'])

    // Reordered by `index`, not taken as they arrived. A silently transposed
    // pair here would compare the wrong two texts.
    expect(vectors).toEqual([
      [1, 0],
      [0, 1],
    ])
  })

  it('refuses a reply with a different number of vectors than inputs', async () => {
    const { impl } = stubFetch({ data: [{ index: 0, embedding: [1, 0] }] })

    await expect(
      openRouterModel('a-key', { fetch: impl }).embed(['first', 'second']),
    ).rejects.toThrow('different number of embeddings')
  })

  it('asks for nothing when there is nothing to embed', async () => {
    const { impl, sent } = stubFetch({ data: [] })

    expect(await openRouterModel('a-key', { fetch: impl }).embed([])).toEqual([])
    expect(sent).toEqual([])
  })
})

describe('similarity', () => {
  it('is one for a vector against itself and zero for orthogonal ones', () => {
    expect(cosine([1, 2, 3], [1, 2, 3])).toBeCloseTo(1)
    expect(cosine([1, 0], [0, 1])).toBe(0)
  })

  it('puts near-identical texts above the gate and unrelated ones below', () => {
    expect(cosine([1, 0, 0], [0.98, 0.05, 0])).toBeGreaterThan(SIMILARITY_THRESHOLD)
    expect(cosine([1, 0, 0], [0.2, 0.9, 0.3])).toBeLessThan(SIMILARITY_THRESHOLD)
  })

  /**
   * Zero rather than a throw. This function only decides whether to *ask* the
   * model, so an unusable pair should fall out of the candidate list rather than
   * take down a poll — and a broken embedding then shows up as nothing ever
   * merging, which is the safe direction.
   */
  it('answers zero rather than throwing on vectors it cannot compare', () => {
    expect(cosine([1, 2], [1, 2, 3])).toBe(0)
    expect(cosine([], [])).toBe(0)
    expect(cosine([0, 0], [1, 1])).toBe(0)
  })
})
