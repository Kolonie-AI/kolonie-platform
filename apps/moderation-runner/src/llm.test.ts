import { describe, expect, it, vi } from 'vitest'
import {
  openRouterModel,
  ProviderUnreachable,
  BRIEFING_MAX_TOKENS,
  CEILING_ESCALATION,
  CLASSIFY_MAX_TOKENS,
  MARK_MAX_TOKENS,
  MODERATION_MODEL,
} from './llm.js'
import { cosine, SIMILARITY_THRESHOLD } from './dedup.js'

/** A `fetch` that answers with one canned body and records what it was sent. */
const stubFetch = (body: unknown, status = 200) => {
  const sent: { url: string; init: RequestInit | undefined }[] = []
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), init })
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => accounted(body),
    } as Response
  }) as unknown as typeof fetch
  return { impl, sent }
}

/** A `fetch` that returns each canned body once, then repeats the last. */
const stubFetchSequence = (...bodies: readonly unknown[]) => {
  const sent: { url: string; init: RequestInit | undefined }[] = []
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), init })
    const body = bodies[Math.min(sent.length - 1, bodies.length - 1)]
    return { ok: true, status: 200, json: async () => accounted(body) } as Response
  }) as unknown as typeof fetch
  return { impl, sent }
}

const accounted = (body: unknown): unknown =>
  typeof body === 'object' && body !== null
    ? {
        model: 'provider/model-that-answered',
        usage: { prompt_tokens: 308, completion_tokens: 5, total_tokens: 313 },
        ...body,
      }
    : body

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

    expect(verdict).toMatchObject({ decision: 'reject', reason: 'Nothing specific.' })
  })

  it('logs the model and tokens reported by the response', async () => {
    const info = vi.fn()
    const { impl } = stubFetch(aVerdict('{"decision":"approve","reason":"concrete"}'))

    await openRouterModel('a-key', {
      fetch: impl,
      log: { info, warn: vi.fn(), error: vi.fn() },
    }).classify({ system: 's', user: 'u', choices: ['approve', 'reject'] })

    expect(info).toHaveBeenCalledWith(expect.any(String), {
      event: 'model.call.completed',
      model: 'provider/model-that-answered',
      tokens: { prompt: 308, completion: 5, total: 313 },
      route: 'openrouter',
    })
  })

  /**
   * Strict schemas are the vendor's promise, not ours. If a provider ever
   * relaxes one, an answer outside the offered set has to fail loudly here —
   * the alternative is a string that is not `approve` being treated as one of
   * the branches by whatever compares it next.
   */
  /**
   * The failure `#716` was: the LLM gateway wraps a CLI subscription, bills
   * nothing per token and answers with no `usage` block at all. Accounting threw
   * on the way out of a call the model had answered correctly, and two wall
   * entries were retried into the ground for it. A verdict must survive its own
   * receipt going missing.
   */
  it('returns a verdict when the provider reported no token usage', async () => {
    const info = vi.fn()
    const impl = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({
          model: 'provider/subscription-model',
          choices: [{ message: { content: '{"decision":"approve","reason":"concrete"}' } }],
        }),
      }) as Response) as unknown as typeof fetch

    const verdict = await openRouterModel('a-key', {
      fetch: impl,
      log: { info, warn: vi.fn(), error: vi.fn() },
    }).classify({ system: 's', user: 'u', choices: ['approve', 'reject'] })

    expect(verdict).toMatchObject({ decision: 'approve', reason: 'concrete' })
    expect(verdict.call).toEqual({ route: 'openrouter', model: 'provider/subscription-model' })
    expect(info).toHaveBeenCalledWith(expect.any(String), {
      event: 'model.call.completed',
      model: 'provider/subscription-model',
      route: 'openrouter',
    })
  })

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
   * **A reply that is the enum value and nothing else is taken (`#408`).**
   *
   * On 2026-08-05 the model answered the seven characters `approve` — not JSON,
   * not quoted — and `JSON.parse` threw `Unexpected token 'a'`. At
   * `temperature: 0` a reply malformed once is malformed every time, so the
   * entry was retried on every poll rather than judged: the failure latched
   * instead of degrading, which is the thing `compose` already carries a comment
   * about one stage along.
   */
  it('takes a bare answer that is exactly one of the offered choices', async () => {
    const { impl } = stubFetch(aVerdict('approve'))

    const verdict = await openRouterModel('a-key', { fetch: impl }).classify({
      system: 's',
      user: 'u',
      choices: ['approve', 'reject'],
    })

    expect(verdict.decision).toBe('approve')
    // Stated rather than invented. The citizen reading the note learns the model
    // gave no reason, which is true and is more than it learns from an entry
    // that is never judged at all.
    expect(verdict.reason).toBe('the model answered without a reason')
  })

  it('takes a bare answer that arrived as a JSON string', async () => {
    // `"reject"` parses, and is still not the object the schema promised.
    const { impl } = stubFetch(aVerdict('"reject"'))

    const verdict = await openRouterModel('a-key', { fetch: impl }).classify({
      system: 's',
      user: 'u',
      choices: ['approve', 'reject'],
    })

    expect(verdict.decision).toBe('reject')
  })

  /**
   * **The tolerance above is equality and nothing wider, which is what keeps it
   * from being the prose-parsing this file warns against.**
   *
   * The warning in `MODERATION_MODEL`'s own comment is *"a moderator that will
   * eventually approve something because it wrote the word approve in an
   * explanation"*, and it still holds: a sentence containing `approve` is not
   * equal to `approve`.
   */
  it('refuses prose that merely contains an offered choice', async () => {
    const { impl } = stubFetch(aVerdict('I would approve this, it is concrete.'))

    await expect(
      openRouterModel('a-key', { fetch: impl }).classify({
        system: 's',
        user: 'u',
        choices: ['approve', 'reject'],
      }),
    ).rejects.toThrow('did not answer with JSON')
  })

  /**
   * **A missing answer says which kind of missing it was (`#408`).**
   *
   * `OpenRouter returned no message content` names the one thing that is not
   * there and none of the things that are. A model declining a structured output
   * fills in `refusal` instead of `content`, and `finish_reason` separates that
   * from an answer cut off at the token ceiling. Thirteen failures over
   * twenty-five minutes were read as an outage on the strength of the absence
   * alone.
   */
  it('says why the content was missing, when the reply says', async () => {
    const { impl } = stubFetch({
      choices: [{ message: { content: null, refusal: 'I cannot judge this text' } }],
    })

    await expect(
      openRouterModel('a-key', { fetch: impl }).classify({
        system: 's',
        user: 'u',
        choices: ['approve', 'reject'],
      }),
    ).rejects.toThrow('the model refused: I cannot judge this text')
  })

  it('names a truncated answer as truncated', async () => {
    const { impl } = stubFetch({ choices: [{ message: {}, finish_reason: 'length' }] })

    await expect(
      openRouterModel('a-key', { fetch: impl }).classify({
        system: 's',
        user: 'u',
        choices: ['approve', 'reject'],
      }),
    ).rejects.toThrow('finish_reason length')
  })

  /** `stop` with no answer is transient provider behaviour, not a model verdict. */
  it('retries once when a stopped completion contains no content', async () => {
    const { impl, sent } = stubFetchSequence(
      { choices: [{ message: { content: null }, finish_reason: 'stop' }] },
      aVerdict('{"decision":"approve","reason":"concrete"}'),
    )

    const verdict = await openRouterModel('a-key', { fetch: impl }).classify({
      system: 's',
      user: 'u',
      choices: ['approve', 'reject'],
    })

    expect(verdict).toMatchObject({ decision: 'approve', reason: 'concrete' })
    expect(sent).toHaveLength(2)
  })

  it('fails after one retry when stopped completions remain empty', async () => {
    const empty = { choices: [{ message: { content: null }, finish_reason: 'stop' }] }
    const { impl, sent } = stubFetchSequence(empty, empty)

    await expect(
      openRouterModel('a-key', { fetch: impl }).classify({
        system: 's',
        user: 'u',
        choices: ['approve', 'reject'],
      }),
    ).rejects.toThrow('finish_reason stop')
    expect(sent).toHaveLength(2)
  })

  /**
   * **The three failures `#437` was filed for, as three tests.**
   *
   * One advice entry failed to moderate three times between 01:24 and 01:26 on
   * 2026-08-06, twice with `finish_reason length` and no content and once with a
   * verdict carrying neither field. All three are one cause: `max_tokens` was
   * 400, sized for the sentence a citizen reads, while the reasoning tokens that
   * are charged against it never appear in the reply.
   */
  it('gives a verdict enough room for the reasoning, not just for the sentence', async () => {
    const { impl, sent } = stubFetch(aVerdict('{"decision":"approve","reason":"concrete"}'))

    await openRouterModel('a-key', { fetch: impl }).classify({
      system: 's',
      user: 'u',
      choices: ['approve', 'reject'],
    })

    const body = JSON.parse(String(sent[0]?.init?.body)) as { max_tokens: number }
    expect(body.max_tokens).toBe(CLASSIFY_MAX_TOKENS)
    // Named rather than merely equal to the export, which would pass whatever
    // the export said — and 400 is the number that produced the failure.
    expect(CLASSIFY_MAX_TOKENS).toBe(4000)
  })

  it('gives a marking pass the same room, for the same reason', async () => {
    const { impl, sent } = stubFetch(aVerdict('{"spans":[]}'))

    await openRouterModel('a-key', { fetch: impl }).mark({
      system: 's',
      user: 'u',
      kinds: ['struggle'],
    })

    const body = JSON.parse(String(sent[0]?.init?.body)) as { max_tokens: number }
    expect(body.max_tokens).toBe(MARK_MAX_TOKENS)
    expect(MARK_MAX_TOKENS).toBe(4000)
  })

  /**
   * **The ceiling is named in the refusal, which is the actionable half.**
   *
   * `finish_reason length` alone says the reply was interrupted. It does not say
   * by what, and the number is the thing somebody reading the line would change.
   * The briefing call has passed its ceiling through since `#416`; `classify` and
   * `mark` never did, which is why the logged line carried the symptom without
   * the fix.
   */
  it('names the ceiling it was cut off at, not only that it was cut off', async () => {
    const { impl } = stubFetch({ choices: [{ message: {}, finish_reason: 'length' }] })

    await expect(
      openRouterModel('a-key', { fetch: impl }).classify({
        system: 's',
        user: 'u',
        choices: ['approve', 'reject'],
      }),
    ).rejects.toThrow(
      // The raised one, because that is the budget the reply that failed came
      // back under. Naming the first would send a reader to change a number that
      // was no longer in force (`#1192`).
      `${CLASSIFY_MAX_TOKENS * CEILING_ESCALATION}-token ceiling`,
    )
  })

  /**
   * **The ceiling that was too low twice (`#437`, `#1192`).**
   *
   * `#437` raised this from 400 to 4000 and the same failure arrived at 4000 ten
   * days later, on a walk for `mailbox/resend.com`. How much a model reasons is a
   * property of the page and of a model somebody may swap under us, so the next
   * constant is a guess too. What can be fixed instead is the shape: at
   * `temperature: 0` a retry that changes nothing produces the same empty reply
   * for ever, so the retry raises the thing that ran out.
   */
  it('retries at a higher ceiling when the whole ceiling went on reasoning', async () => {
    const { impl, sent } = stubFetchSequence(
      { choices: [{ message: {}, finish_reason: 'length' }] },
      aVerdict('{"decision":"approve","reason":"concrete"}'),
    )

    const verdict = await openRouterModel('a-key', { fetch: impl }).classify({
      system: 's',
      user: 'u',
      choices: ['approve', 'reject'],
    })

    expect(verdict).toMatchObject({ decision: 'approve', reason: 'concrete' })
    expect(sent).toHaveLength(2)
    const first = JSON.parse(String(sent[0]?.init?.body)) as { max_tokens: number }
    const second = JSON.parse(String(sent[1]?.init?.body)) as { max_tokens: number }
    expect(first.max_tokens).toBe(CLASSIFY_MAX_TOKENS)
    expect(second.max_tokens).toBe(CLASSIFY_MAX_TOKENS * CEILING_ESCALATION)
  })

  /**
   * Once. A second interruption is no longer the anomaly this retry is for — it
   * is a page or a prompt that does not fit, and that is a fact for a person to
   * read rather than a cost the runner keeps paying every poll.
   */
  it('escalates once and no further', async () => {
    const spent = { choices: [{ message: {}, finish_reason: 'length' }] }
    const { impl, sent } = stubFetchSequence(spent, spent)

    await expect(
      openRouterModel('a-key', { fetch: impl }).classify({
        system: 's',
        user: 'u',
        choices: ['approve', 'reject'],
      }),
    ).rejects.toThrow('went on reasoning')
    expect(sent).toHaveLength(2)
  })

  /** The raise is visible, because a doubled bill nobody can explain is worse. */
  it('says it raised the ceiling, and by how much', async () => {
    const warn = vi.fn()
    const { impl } = stubFetchSequence(
      { choices: [{ message: {}, finish_reason: 'length' }] },
      aVerdict('{"decision":"approve","reason":"concrete"}'),
    )

    await openRouterModel('a-key', {
      fetch: impl,
      log: { info: vi.fn(), warn, error: vi.fn() },
    }).classify({ system: 's', user: 'u', choices: ['approve', 'reject'] })

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('on reasoning'),
      expect.objectContaining({
        event: 'model.ceiling.raised',
        ceiling: CLASSIFY_MAX_TOKENS,
        raised: CLASSIFY_MAX_TOKENS * CEILING_ESCALATION,
      }),
    )
  })

  /**
   * **A reply that was interrupted *with* content is a different event.** There
   * is something in it — a briefing's finished claims, a verdict to complain
   * about — and spending a second call to get a longer version of an answer we
   * already have is not what this retry is for.
   */
  it('does not retry a reply that was cut off with content in it', async () => {
    const { impl, sent } = stubFetch({
      choices: [{ message: { content: '{}' }, finish_reason: 'length' }],
    })

    await expect(
      openRouterModel('a-key', { fetch: impl }).classify({
        system: 's',
        user: 'u',
        choices: ['approve', 'reject'],
      }),
    ).rejects.toThrow('without a decision and a reason')
    expect(sent).toHaveLength(1)
  })

  /** The marking pass is the other half of what `walk-prose` needs (`#1192`). */
  it('gives a marking pass the same escalation', async () => {
    const { impl, sent } = stubFetchSequence(
      { choices: [{ message: {}, finish_reason: 'length' }] },
      aVerdict('{"spans":[]}'),
    )

    const spans = await openRouterModel('a-key', { fetch: impl }).mark({
      system: 's',
      user: 'u',
      kinds: ['struggle'],
    })

    expect(spans).toEqual([])
    const second = JSON.parse(String(sent[1]?.init?.body)) as { max_tokens: number }
    expect(second.max_tokens).toBe(MARK_MAX_TOKENS * CEILING_ESCALATION)
  })

  /**
   * **A truncated verdict said *the model answered badly*, and it had not.**
   *
   * The third logged failure. A reply cut off at the ceiling arrives here looking
   * like a model that returned the wrong shape — short, parseable, missing the
   * fields. Whether it is short because the model had nothing to say or because
   * it was interrupted is a fact only `finish_reason` holds, so it is read rather
   * than guessed at.
   */
  it('says a verdict missing its fields was truncated, when it was', async () => {
    const { impl } = stubFetch({
      choices: [{ message: { content: '{}' }, finish_reason: 'length' }],
    })

    await expect(
      openRouterModel('a-key', { fetch: impl }).classify({
        system: 's',
        user: 'u',
        choices: ['approve', 'reject'],
      }),
    ).rejects.toThrow('without a decision and a reason — the reply was cut off')
  })

  /** And does not say so when it was not: a genuinely malformed answer stays malformed. */
  it('does not blame the ceiling for a verdict the model simply got wrong', async () => {
    const { impl } = stubFetch({
      choices: [{ message: { content: '{"decision":"approve"}' }, finish_reason: 'stop' }],
    })

    await expect(
      openRouterModel('a-key', { fetch: impl }).classify({
        system: 's',
        user: 'u',
        choices: ['approve', 'reject'],
      }),
    ).rejects.toThrow(/without a decision and a reason$/)
  })

  /**
   * `#734`. **The headers arriving is not the answer arriving.**
   *
   * `fetch` resolves once the headers are in; the body is a stream that can
   * still die, and when it does undici rejects the `.json()` with `TypeError:
   * terminated` from `Fetch.onAborted`. That is a different call site from the
   * request itself, so it used to escape unclassified, reach `loop.ts` as an
   * ordinary error and be logged as `briefing.failed` at `error` — where the log
   * detector files one GitHub issue per signature and a dropped connection
   * arrives as a defect report.
   */
  it('treats a connection that dies while the body is read as unreachable', async () => {
    const impl = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => {
          throw new TypeError('terminated')
        },
      }) as unknown as Response) as unknown as typeof fetch

    const call = openRouterModel('a-key', { fetch: impl }).classify({
      system: 's',
      user: 'u',
      choices: ['approve'],
    })

    await expect(call).rejects.toBeInstanceOf(ProviderUnreachable)
    await expect(call).rejects.toThrow(/\/chat\/completions/)
    await expect(call).rejects.toThrow(/terminated/)
  })

  /**
   * The other half of the same boundary, and it is the half that keeps the first
   * one honest: bytes that arrived and were not JSON mean the provider answered
   * badly, which is about this call and belongs in a line a person reads. If
   * this were classified as unreachable, a provider returning HTML would be
   * retried in silence for ever.
   */
  it('does not call a malformed body unreachable', async () => {
    const impl = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError('Unexpected token < in JSON at position 0')
        },
      }) as unknown as Response) as unknown as typeof fetch

    const call = openRouterModel('a-key', { fetch: impl }).classify({
      system: 's',
      user: 'u',
      choices: ['approve'],
    })

    await expect(call).rejects.toBeInstanceOf(SyntaxError)
    await expect(call).rejects.not.toBeInstanceOf(ProviderUnreachable)
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

  /** A stopped response containing only JSON whitespace is the empty anomaly from #599. */
  it('retries once when a stopped briefing contains only whitespace', async () => {
    const { impl, sent } = stubFetchSequence(
      { choices: [{ message: { content: ' \n' }, finish_reason: 'stop' }] },
      aBriefing('{"section":"wall","text":"A real wall.","sources":["a"]}'),
    )

    const claims = await openRouterModel('a-key', { fetch: impl }).compose({
      system: 's',
      user: 'u',
      sections: ['wall'],
      sourceIds: ['a'],
      maxClaimLength: 400,
    })

    expect(claims).toEqual([{ section: 'wall', text: 'A real wall.', sources: ['a'] }])
    expect(sent).toHaveLength(2)
  })

  it('fails after one retry when stopped briefings remain blank', async () => {
    const blank = { choices: [{ message: { content: '\n\t' }, finish_reason: 'stop' }] }
    const { impl, sent } = stubFetchSequence(blank, blank)

    await expect(
      openRouterModel('a-key', { fetch: impl }).compose({
        system: 's',
        user: 'u',
        sections: ['wall'],
        sourceIds: ['a'],
        maxClaimLength: 400,
      }),
    ).rejects.toThrow('content was blank')
    expect(sent).toHaveLength(2)
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

  /**
   * **A briefing cut off at the ceiling keeps the claims that were finished
   * (`#416`).**
   *
   * `JSON.parse` throws on the whole string when a reply ends mid-object, so
   * every complete claim beside the fragment used to be discarded with it. At
   * `temperature: 0` the same corpus produces the same truncated reply on every
   * poll, so that is not a bad hour — it is a briefing that is never written
   * again. The rule the rest of the transport already follows is that the failure
   * degrades rather than latches.
   */
  it('keeps the complete claims out of a reply that was cut off', async () => {
    const { impl } = stubFetch({
      choices: [
        {
          message: {
            content:
              '{"claims":[{"section":"wall","text":"A provider asks for a phone number.","sources":["a"]},' +
              '{"section":"route","text":"The operator relays the code.","sources":["b"]},' +
              '{"section":"unsolved","text":"An agent with no oper',
          },
          finish_reason: 'length',
        },
      ],
    })

    const claims = await openRouterModel('a-key', { fetch: impl }).compose({
      system: 's',
      user: 'u',
      sections: ['wall', 'route', 'unsolved'],
      sourceIds: ['a', 'b'],
      maxClaimLength: 400,
    })

    // The two that were finished, and not the third. Nothing is repaired: no
    // brace is added and no string is closed, so a fragment cannot become a
    // claim the model did not write.
    expect(claims).toEqual([
      { section: 'wall', text: 'A provider asks for a phone number.', sources: ['a'] },
      { section: 'route', text: 'The operator relays the code.', sources: ['b'] },
    ])
  })

  /** A brace inside a claim's own text is text, and must not end the claim. */
  it('does not end a claim at a brace inside its text', async () => {
    const { impl } = stubFetch({
      choices: [
        {
          message: {
            content:
              '{"claims":[{"section":"wall","text":"The API answers {\\"error\\":\\"denied\\"} to an agent.","sources":["a"]},' +
              '{"section":"route","text":"cut off here',
          },
          finish_reason: 'length',
        },
      ],
    })

    const claims = await openRouterModel('a-key', { fetch: impl }).compose({
      system: 's',
      user: 'u',
      sections: ['wall', 'route'],
      sourceIds: ['a'],
      maxClaimLength: 400,
    })

    expect(claims).toEqual([
      { section: 'wall', text: 'The API answers {"error":"denied"} to an agent.', sources: ['a'] },
    ])
  })

  /**
   * The rejection case, and the one this issue was actually filed for: the
   * ceiling was spent before a single claim was complete, and there is nothing to
   * salvage. That throws, and the message carries the number a reader can change.
   */
  it('refuses a reply cut off before one claim was complete, and names the ceiling', async () => {
    const { impl } = stubFetch({
      choices: [{ message: { content: '{"claims":[{"section":"wa' }, finish_reason: 'length' }],
    })

    await expect(
      openRouterModel('a-key', { fetch: impl }).compose({
        system: 's',
        user: 'u',
        sections: ['wall'],
        sourceIds: ['a'],
        maxClaimLength: 400,
      }),
    ).rejects.toThrow(`cut off at the ${BRIEFING_MAX_TOKENS}-token ceiling`)
  })

  /**
   * **Only a reply the model said was cut off is salvaged.** Anything else that
   * will not parse is malformed rather than incomplete, and reading a malformed
   * reply optimistically is how a briefing ends up saying something nobody wrote.
   */
  it('does not salvage a reply the model did not say was cut off', async () => {
    const { impl } = stubFetch(
      aVerdict('{"claims":[{"section":"wall","text":"Complete.","sources":["a"]}'),
    )

    await expect(
      openRouterModel('a-key', { fetch: impl }).compose({
        system: 's',
        user: 'u',
        sections: ['wall'],
        sourceIds: ['a'],
        maxClaimLength: 400,
      }),
    ).rejects.toThrow(SyntaxError)
  })

  /**
   * The observed failure on 2026-08-05: `finish_reason length` with **no content
   * at all**, because reasoning tokens are charged against the same ceiling and
   * the model never reached the document. The error says so, with the number.
   */
  it('says the ceiling went on reasoning when nothing was written', async () => {
    const { impl } = stubFetch({ choices: [{ message: {}, finish_reason: 'length' }] })

    await expect(
      openRouterModel('a-key', { fetch: impl }).compose({
        system: 's',
        user: 'u',
        sections: ['wall'],
        sourceIds: ['a'],
        maxClaimLength: 400,
      }),
    ).rejects.toThrow(
      `the whole ${BRIEFING_MAX_TOKENS * CEILING_ESCALATION}-token ceiling went on reasoning`,
    )
  })

  it('asks for the briefing ceiling, not a verdict’s', async () => {
    const { impl, sent } = stubFetch(aBriefing(''))

    await openRouterModel('a-key', { fetch: impl }).compose({
      system: 's',
      user: 'u',
      sections: ['wall'],
      sourceIds: ['a'],
      maxClaimLength: 400,
    })

    const body = JSON.parse(String(sent[0]?.init?.body)) as { max_tokens: number }
    expect(body.max_tokens).toBe(BRIEFING_MAX_TOKENS)
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
