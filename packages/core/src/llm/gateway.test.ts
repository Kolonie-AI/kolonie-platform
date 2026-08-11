import { describe, expect, it } from 'vitest'
import { createLog, type LogRecord } from '../log/log.js'
import {
  GATEWAY_BASE_URL_VAR,
  GATEWAY_MODEL_VAR,
  GATEWAY_USER_AGENT,
  gatewayFromEnvironment,
  gatewayRoutedFetch,
  routeOf,
} from './gateway.js'

const GATEWAY = { baseUrl: 'https://gateway.invalid/v1', apiKey: 'gw-key', model: 'gateway-model' }

const CHAT = 'https://openrouter.ai/api/v1/chat/completions'

const completion = (content: string): string =>
  JSON.stringify({ model: 'openrouter-model', choices: [{ message: { content } }] })

const ok = (body: string): Response =>
  new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })

/** A `fetch` that records what it was asked and answers from a queue. */
function transport(...answers: (Response | Error)[]): {
  fetch: typeof fetch
  calls: { url: string; init: RequestInit | undefined }[]
} {
  const calls: { url: string; init: RequestInit | undefined }[] = []
  let index = 0

  const impl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init })
    const answer = answers[Math.min(index++, answers.length - 1)]
    if (answer instanceof Error) throw answer
    return answer!
  }

  return { fetch: impl, calls }
}

/** A logger whose lines a test can read back, as the runners' would be written. */
function collecting(): { log: ReturnType<typeof createLog>; records: LogRecord[] } {
  const records: LogRecord[] = []
  const log = createLog({
    service: 'test',
    write: (line) => records.push(JSON.parse(line) as LogRecord),
  })
  return { log, records }
}

const post = (body: unknown, url = CHAT): [string, RequestInit] => [
  url,
  {
    method: 'POST',
    headers: { authorization: 'Bearer openrouter-key', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  },
]

describe('reading the gateway out of the environment', () => {
  it('needs the address, the key and the model together', () => {
    const complete = {
      [GATEWAY_BASE_URL_VAR]: 'https://gateway.invalid/v1',
      LLM_GATEWAY_API_KEY_MODERATION: 'k',
      [GATEWAY_MODEL_VAR]: 'm',
    }

    expect(gatewayFromEnvironment('LLM_GATEWAY_API_KEY_MODERATION', complete)).toEqual({
      baseUrl: 'https://gateway.invalid/v1',
      apiKey: 'k',
      model: 'm',
    })

    for (const missing of Object.keys(complete)) {
      expect(
        gatewayFromEnvironment('LLM_GATEWAY_API_KEY_MODERATION', { ...complete, [missing]: '' }),
      ).toBeUndefined()
    }
  })

  /**
   * The way a service is put back on OpenRouter: the issue's own acceptance
   * criterion, and it must cost nobody a deploy of new code.
   */
  it('is not configured when only that service’s key is removed', () => {
    const env = {
      [GATEWAY_BASE_URL_VAR]: 'https://gateway.invalid/v1',
      [GATEWAY_MODEL_VAR]: 'm',
      LLM_GATEWAY_API_KEY_MODERATION: 'k',
    }

    expect(gatewayFromEnvironment('LLM_GATEWAY_API_KEY_MODERATION', env)).toBeDefined()
    expect(gatewayFromEnvironment('LLM_GATEWAY_API_KEY_VERIFIER', env)).toBeUndefined()
  })

  it('forgives a trailing slash on the address', () => {
    expect(
      gatewayFromEnvironment('K', {
        [GATEWAY_BASE_URL_VAR]: 'https://gateway.invalid/v1/',
        [GATEWAY_MODEL_VAR]: 'm',
        K: 'k',
      })?.baseUrl,
    ).toBe('https://gateway.invalid/v1')
  })
})

describe('a chat completion with a gateway configured', () => {
  it('goes to the gateway, with the gateway’s key and the gateway’s model', async () => {
    const under = transport(ok(completion('{"verdict":"pass"}')))
    const routed = gatewayRoutedFetch(GATEWAY, { fetch: under.fetch })

    const response = await routed(...post({ model: 'anthropic/claude-3', messages: [] }))

    expect(under.calls).toHaveLength(1)
    expect(under.calls[0]!.url).toBe('https://gateway.invalid/v1/chat/completions')
    expect(new Headers(under.calls[0]!.init!.headers).get('authorization')).toBe('Bearer gw-key')
    expect(JSON.parse(String(under.calls[0]!.init!.body)).model).toBe('gateway-model')
    expect(routeOf(response).route).toBe('gateway')
    expect(await response.json()).toEqual({
      model: 'openrouter-model',
      choices: [{ message: { content: '{"verdict":"pass"}' } }],
    })
  })

  /**
   * The header exists because the edge in front of the gateway refuses some
   * default client signatures outright (`#728`), so the assertion is that the
   * call names itself — and that the fallback is left as the caller wrote it,
   * since a refusal there would be ours to explain rather than the edge's.
   */
  it('names itself to the gateway, and leaves the fallback’s request alone', async () => {
    const under = transport(new Error('gateway down'), ok(completion('ok')))
    const routed = gatewayRoutedFetch(GATEWAY, { fetch: under.fetch })

    await routed(...post({ model: 'anthropic/claude-3', messages: [] }))

    expect(new Headers(under.calls[0]!.init!.headers).get('user-agent')).toBe(GATEWAY_USER_AGENT)
    expect(new Headers(under.calls[1]!.init!.headers).get('user-agent')).toBeNull()
  })

  /**
   * The prohibition the issue states outright, and the reason it is a path check
   * rather than a flag: the gateway has no `/embeddings` endpoint, so a request
   * that reached it would be a 404 and then a fallback on every single call.
   */
  it('never routes an embedding, and never falls one back', async () => {
    const under = transport(ok(JSON.stringify({ data: [{ embedding: [0.1] }] })))
    const routed = gatewayRoutedFetch(GATEWAY, { fetch: under.fetch })

    const response = await routed(
      ...post(
        { model: 'openai/text-embedding-3-small', input: 'x' },
        'https://openrouter.ai/api/v1/embeddings',
      ),
    )

    expect(under.calls).toHaveLength(1)
    expect(under.calls[0]!.url).toBe('https://openrouter.ai/api/v1/embeddings')
    expect(new Headers(under.calls[0]!.init!.headers).get('authorization')).toBe(
      'Bearer openrouter-key',
    )
    expect(routeOf(response).route).toBe('openrouter')
  })

  it('leaves anything that is not a POSTed chat completion alone', async () => {
    const under = transport(ok('[]'))
    const routed = gatewayRoutedFetch(GATEWAY, { fetch: under.fetch })

    await routed('https://openrouter.ai/api/v1/models')
    await routed(CHAT, { method: 'GET' })
    await routed(CHAT, { method: 'POST', body: 'not json' })
    await routed(CHAT, { method: 'POST', body: JSON.stringify({ messages: [] }) })

    expect(under.calls.map((call) => call.url)).toEqual([
      'https://openrouter.ai/api/v1/models',
      CHAT,
      CHAT,
      CHAT,
    ])
  })
})

describe('with no gateway configured', () => {
  /**
   * Identity, and the same function object rather than a wrapper that behaves
   * like one: a service put back on OpenRouter should carry no routing code on
   * its path at all.
   */
  it('is the transport it was given', () => {
    const under = transport(ok('{}'))
    expect(gatewayRoutedFetch(undefined, { fetch: under.fetch })).toBe(under.fetch)
  })
})

describe('when the gateway does not answer', () => {
  const gatewayThen = (first: Response | Error) =>
    transport(first, ok(completion('{"verdict":"pass"}')))

  it('replays the original request against OpenRouter, unrewritten', async () => {
    const under = gatewayThen(new Error('connect ECONNREFUSED'))
    const routed = gatewayRoutedFetch(GATEWAY, { fetch: under.fetch })

    const response = await routed(...post({ model: 'anthropic/claude-3', messages: [] }))

    expect(under.calls).toHaveLength(2)
    expect(under.calls[1]!.url).toBe(CHAT)
    expect(new Headers(under.calls[1]!.init!.headers).get('authorization')).toBe(
      'Bearer openrouter-key',
    )
    // The caller's own model, not the gateway's: a fallback is the request the
    // caller made, going where it always went.
    expect(JSON.parse(String(under.calls[1]!.init!.body)).model).toBe('anthropic/claude-3')
    expect(response.status).toBe(200)
  })

  it('falls back on a status, and never on the caller’s behalf twice', async () => {
    const under = gatewayThen(new Response('busy', { status: 503 }))
    const routed = gatewayRoutedFetch(GATEWAY, { fetch: under.fetch })

    await routed(...post({ model: 'm', messages: [] }))

    expect(under.calls).toHaveLength(2)
  })

  /**
   * The condition worth building for. A 200 with a paragraph in it is the one
   * failure that looks like success all the way to the caller's parser.
   */
  it('falls back on a 200 that is prose where JSON was asked for', async () => {
    const under = gatewayThen(ok(completion('I think this submission is probably fine.')))
    const routed = gatewayRoutedFetch(GATEWAY, { fetch: under.fetch })

    const response = await routed(
      ...post({
        model: 'm',
        messages: [],
        response_format: { type: 'json_schema', json_schema: { name: 'verdict' } },
      }),
    )

    expect(under.calls).toHaveLength(2)
    expect(routeOf(response)).toEqual({
      route: 'openrouter',
      fallback: { route: 'gateway', reason: 'malformed' },
    })
  })

  it('accepts the same prose where no structure was asked for', async () => {
    const under = gatewayThen(ok(completion('I think this submission is probably fine.')))
    const routed = gatewayRoutedFetch(GATEWAY, { fetch: under.fetch })

    await routed(...post({ model: 'm', messages: [] }))

    expect(under.calls).toHaveLength(1)
  })

  it('accepts JSON the model wrapped in a fence', async () => {
    const under = gatewayThen(ok(completion('```json\n{"verdict":"pass"}\n```')))
    const routed = gatewayRoutedFetch(GATEWAY, { fetch: under.fetch })

    await routed(...post({ model: 'm', messages: [], response_format: { type: 'json_object' } }))

    expect(under.calls).toHaveLength(1)
  })

  it('falls back on an empty completion and on one that is not JSON at all', async () => {
    for (const bad of [ok(completion('   ')), ok('<html>gateway error</html>'), ok('{}')]) {
      const under = gatewayThen(bad)
      await gatewayRoutedFetch(GATEWAY, { fetch: under.fetch })(...post({ model: 'm' }))
      expect(under.calls).toHaveLength(2)
    }
  })

  /**
   * A model declining is the model answering. OpenRouter would decline the same
   * prompt for the same reason, so a fallback buys a second refusal at twice the
   * price.
   */
  it('treats a refusal as an answer', async () => {
    const under = gatewayThen(
      ok(JSON.stringify({ choices: [{ message: { refusal: 'I cannot help with that.' } }] })),
    )

    await gatewayRoutedFetch(GATEWAY, { fetch: under.fetch })(
      ...post({ model: 'm', response_format: { type: 'json_object' } }),
    )

    expect(under.calls).toHaveLength(1)
  })

  it('gives up on a gateway that stops answering, and says how long it waited', async () => {
    const under = transport(
      new Response(null, { status: 500 }), // never reached: the impl below overrides
      ok(completion('{"ok":true}')),
    )
    let calls = 0
    const hanging: typeof fetch = async (input, init) => {
      if (calls++ === 0) {
        await new Promise((resolve) => setTimeout(resolve, 50))
        // The wrapper's own abort arrives here as the transport rejecting.
        if (init?.signal?.aborted === true) throw new DOMException('aborted', 'AbortError')
      }
      return under.fetch(input, init)
    }

    const log = collecting()
    const response = await gatewayRoutedFetch(GATEWAY, {
      fetch: hanging,
      log: log.log,
      timeoutMs: 5,
    })(...post({ model: 'm' }))

    expect(routeOf(response).fallback?.reason).toBe('timeout')
    expect(log.records.some((record) => record['reason'] === 'timeout')).toBe(true)
  })

  /**
   * A fallback is a thing that did not work even though nothing downstream
   * noticed — so `warn`, and with the reason class on it, or *the gateway was
   * down for two hours* is a question nobody can answer afterwards.
   */
  it('warns, with the reason class and without the gateway’s address', async () => {
    const log = collecting()
    const under = gatewayThen(new Response('nope', { status: 502 }))

    await gatewayRoutedFetch(GATEWAY, { fetch: under.fetch, log: log.log })(...post({ model: 'm' }))

    const warned = log.records.find((record) => record['event'] === 'model.route.fallback')
    expect(warned?.level).toBe('warn')
    expect(warned?.['reason']).toBe('status')
    expect(JSON.stringify(warned)).not.toContain('gateway.invalid')
  })
})

describe('what a response says about the route that produced it', () => {
  it('reads a response from anywhere else as OpenRouter', () => {
    expect(routeOf(new Response('{}'))).toEqual({ route: 'openrouter' })
    expect(routeOf(undefined)).toEqual({ route: 'openrouter' })
  })
})
