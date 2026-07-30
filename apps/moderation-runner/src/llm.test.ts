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
    // Named rather than merely equal to the constant: a test that only compared
    // it to the export would pass whatever the export said.
    expect(MODERATION_MODEL).toBe('deepseek/deepseek-v4-flash')
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
   * **The credential never reaches the error, whatever the vendor put in it.**
   *
   * A vendor's error body can echo the request back, and the request carries the
   * key. The fields the diagnosis reads are whitelisted, which is a claim about a
   * shape somebody else controls — so the key is substituted out of the result as
   * well. A credential in a log survives every rotation of the log.
   */
  it('does not put the key in the error it throws, even when the vendor echoes it', async () => {
    const { impl } = stubFetch({ error: { message: 'bad key a-key-in-the-echo' } }, 401)

    const call = openRouterModel('a-key', { fetch: impl }).classify({
      system: 's',
      user: 'u',
      choices: ['approve'],
    })

    await expect(call).rejects.toThrow(/answered 401/)
    await expect(call).rejects.toThrow(/\[redacted\]/)
    await call.catch((error: Error) => {
      expect(error.message).not.toContain('a-key-in')
    })
  })

  /**
   * **The status alone was not enough, and finding that out cost an hour.**
   *
   * Four briefing syntheses failed against `OpenRouter answered 429`, which reads
   * as ordinary rate limiting. The body said the model was rate-limited *upstream*
   * from a shared free pool — which is a fact about what the Colony's moderation
   * depends on, and no log line carried it. It took a hand-built probe against
   * production to see it.
   */
  it('carries the provider’s own explanation into the error', async () => {
    const { impl } = stubFetch(
      {
        error: {
          message: 'Provider returned error',
          metadata: {
            provider_name: 'SomeProvider',
            limit_source: 'upstream_provider_shared_pool',
            raw: 'the model is temporarily rate-limited upstream',
          },
        },
      },
      429,
    )

    const call = openRouterModel('a-key', { fetch: impl }).classify({
      system: 's',
      user: 'u',
      choices: ['approve'],
    })

    await expect(call).rejects.toThrow(/answered 429/)
    await expect(call).rejects.toThrow(/provider SomeProvider/)
    await expect(call).rejects.toThrow(/limit upstream_provider_shared_pool/)
    await expect(call).rejects.toThrow(/rate-limited upstream/)
  })

  /** A body that is not JSON must not replace the error it was trying to explain. */
  it('still reports the status when the body cannot be read', async () => {
    const impl = (async () =>
      ({
        ok: false,
        status: 502,
        json: async () => {
          throw new Error('not json')
        },
      }) as unknown as Response) as unknown as typeof fetch

    await expect(
      openRouterModel('a-key', { fetch: impl }).classify({
        system: 's',
        user: 'u',
        choices: ['approve'],
      }),
    ).rejects.toThrow(/answered 502/)
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

describe('marking', () => {
  it('offers the labels as a schema enum and asks for an array', async () => {
    const { impl, sent } = stubFetch(aVerdict('{"spans":[]}'))

    await openRouterModel('a-key', { fetch: impl }).mark({
      system: 'you find what identifies the author',
      user: 'some report',
      kinds: ['mailbox', 'host'],
    })

    const body = JSON.parse(String(sent[0]?.init?.body)) as Record<string, unknown>
    const format = body.response_format as {
      json_schema: {
        strict: boolean
        schema: { properties: { spans: { items: { properties: { kind: { enum: string[] } } } } } }
      }
    }
    expect(format.json_schema.strict).toBe(true)
    expect(format.json_schema.schema.properties.spans.items.properties.kind.enum).toEqual([
      'mailbox',
      'host',
    ])
    expect(body.temperature).toBe(0)
  })

  it('returns the spans it was given', async () => {
    const { impl } = stubFetch(
      aVerdict('{"spans":[{"text":"scout-77@example.invalid","kind":"mailbox"}]}'),
    )

    const spans = await openRouterModel('a-key', { fetch: impl }).mark({
      system: 's',
      user: 'u',
      kinds: ['mailbox'],
    })

    expect(spans).toEqual([{ text: 'scout-77@example.invalid', kind: 'mailbox' }])
  })

  /**
   * Nothing found is the ordinary answer for a well-written report, so it has to
   * be an empty list rather than an error — a transport that treated it as a
   * malformed reply would fail every clean entry in the corpus.
   */
  it('accepts an empty list as an answer', async () => {
    const { impl } = stubFetch(aVerdict('{"spans":[]}'))

    const spans = await openRouterModel('a-key', { fetch: impl }).mark({
      system: 's',
      user: 'u',
      kinds: ['mailbox'],
    })

    expect(spans).toEqual([])
  })

  /** The same rule `classify` follows: a strict schema is the vendor's promise, not ours. */
  it('refuses a kind that was not on offer', async () => {
    const { impl } = stubFetch(aVerdict('{"spans":[{"text":"x","kind":"invented"}]}'))

    await expect(
      openRouterModel('a-key', { fetch: impl }).mark({
        system: 's',
        user: 'u',
        kinds: ['mailbox'],
      }),
    ).rejects.toThrow(/not on offer/)
  })
})

describe('composing', () => {
  const aBriefing = (claims: string) => aVerdict(`{"claims":[${claims}]}`)

  it('returns the claims it was given', async () => {
    const { impl } = stubFetch(
      aBriefing('{"section":"wall","text":"A provider asks for a phone number.","sources":["a"]}'),
    )

    const claims = await openRouterModel('a-key', { fetch: impl }).compose({
      system: 's',
      user: 'u',
      sections: ['wall', 'route', 'unsolved'],
      sourceIds: ['a'],
      maxClaimLength: 400,
    })

    expect(claims).toEqual([
      { section: 'wall', text: 'A provider asks for a phone number.', sources: ['a'] },
    ])
  })

  /**
   * **A malformed claim must not cost the good ones beside it.**
   *
   * This threw on the first claim missing a field, discarding the whole reply —
   * and at `temperature: 0` a reply malformed once is malformed every time, so
   * the task retried every ten minutes forever instead of publishing what the
   * model got right. Found in production, twice, before it was understood.
   */
  it('drops a malformed claim and keeps the rest', async () => {
    const { impl } = stubFetch(
      aBriefing(
        '{"section":"wall","text":"A real wall.","sources":["a"]},' +
          '{"section":"wall"},' +
          '{"text":"No section on this one.","sources":["a"]},' +
          '{"section":"invented","text":"Bad section.","sources":["a"]},' +
          '{"section":"route","text":"A real route.","sources":["a"]}',
      ),
    )

    const claims = await openRouterModel('a-key', { fetch: impl }).compose({
      system: 's',
      user: 'u',
      sections: ['wall', 'route', 'unsolved'],
      sourceIds: ['a'],
      maxClaimLength: 400,
    })

    expect(claims.map((claim) => claim.text)).toEqual(['A real wall.', 'A real route.'])
  })

  /** Missing sources is survivable — `synthesise` drops a claim that cites nothing. */
  it('keeps a claim whose sources are missing, with none cited', async () => {
    const { impl } = stubFetch(aBriefing('{"section":"wall","text":"No sources given."}'))

    const claims = await openRouterModel('a-key', { fetch: impl }).compose({
      system: 's',
      user: 'u',
      sections: ['wall'],
      sourceIds: ['a'],
      maxClaimLength: 400,
    })

    expect(claims).toEqual([{ section: 'wall', text: 'No sources given.', sources: [] }])
  })

  /**
   * **The bound that stops a runaway**, and the reason it is in the schema rather
   * than in the prompt.
   *
   * Given one short tip, the model wrote a correct opening sentence and then
   * degenerated into `(1 local) (1 immediate) (1 one shot) …` until it exhausted
   * `max_tokens`. The reply was cut off *inside* `text`, so `sources` never
   * arrived — and a claim citing nothing is dropped downstream, which is how one
   * runaway produced an empty briefing over a corpus that had something in it.
   *
   * The prompt already asked for one or two sentences. A length a model is asked
   * to respect is a length it sometimes respects.
   */
  it('bounds a claim’s text in the schema it sends', async () => {
    const { impl, sent } = stubFetch(aBriefing(''))

    await openRouterModel('a-key', { fetch: impl }).compose({
      system: 's',
      user: 'u',
      sections: ['wall'],
      sourceIds: ['a'],
      maxClaimLength: 400,
    })

    const body = JSON.parse(String(sent[0]?.init?.body)) as Record<string, unknown>
    const format = body.response_format as {
      json_schema: {
        schema: {
          properties: { claims: { items: { properties: { text: { maxLength: number } } } } }
        }
      }
    }
    expect(format.json_schema.schema.properties.claims.items.properties.text.maxLength).toBe(400)
  })

  /** A reply with no claims array at all is unusable, and that still throws. */
  it('refuses a reply that carries no claims array', async () => {
    const { impl } = stubFetch(aVerdict('{"notclaims":[]}'))

    await expect(
      openRouterModel('a-key', { fetch: impl }).compose({
        system: 's',
        user: 'u',
        sections: ['wall'],
        sourceIds: ['a'],
        maxClaimLength: 400,
      }),
    ).rejects.toThrow(/without a claims array/)
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
