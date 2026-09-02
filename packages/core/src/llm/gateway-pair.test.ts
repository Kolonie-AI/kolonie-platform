import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  FALLBACK_GATEWAY_API_KEY_VARS,
  FALLBACK_GATEWAY_BASE_URL_VAR,
  GATEWAY_API_KEY_VARS,
  GATEWAY_BASE_URL_VAR,
  GATEWAY_MODEL_VAR,
  GATEWAY_MODEL_VARS,
  GatewayUnavailable,
  gatewayClient,
  gatewayFetch,
  gatewayOnlyFetch,
  gatewayRoutedFetch,
  gatewaysFromEnvironment,
  type GatewaySet,
} from './gateway.js'
import { CAPABILITY_TIERS, SERVICE_TIERS } from './tier.js'

const TIER = '@preset/tier-2'
const PRIMARY = { baseUrl: 'https://primary.invalid/v1', apiKey: 'primary-key', model: TIER }
const FALLBACK = { baseUrl: 'https://fallback.invalid/v1', apiKey: 'fallback-key', model: TIER }
const GATEWAYS: GatewaySet = { primary: PRIMARY, fallback: FALLBACK }

const completion = (content: string): Response =>
  new Response(
    JSON.stringify({
      model: 'model-that-answered',
      choices: [{ message: { content }, finish_reason: 'stop' }],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )

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

const post = (url: string, body: unknown): [string, RequestInit] => [
  url,
  {
    method: 'POST',
    headers: { authorization: `Bearer ${FALLBACK.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  },
]

describe('the two configured gateways', () => {
  const complete = {
    [GATEWAY_BASE_URL_VAR]: `${PRIMARY.baseUrl}/`,
    [GATEWAY_API_KEY_VARS.moderation]: PRIMARY.apiKey,
    [FALLBACK_GATEWAY_BASE_URL_VAR]: `${FALLBACK.baseUrl}/`,
    [FALLBACK_GATEWAY_API_KEY_VARS.moderation]: FALLBACK.apiKey,
    [GATEWAY_MODEL_VARS.moderation]: TIER,
  }

  it('builds primary and fallback from the environment only', () => {
    expect(gatewaysFromEnvironment('moderation', complete)).toEqual(GATEWAYS)
  })

  it('ignores invalid shared and service overrides for every gateway service', () => {
    for (const service of Object.keys(SERVICE_TIERS) as (keyof typeof SERVICE_TIERS)[]) {
      for (const variable of [GATEWAY_MODEL_VARS[service], GATEWAY_MODEL_VAR]) {
        for (const override of ['', 'tier-1', 'model-v1', 'provider/model-v1']) {
          const gateways = gatewaysFromEnvironment(service, {
            [GATEWAY_BASE_URL_VAR]: PRIMARY.baseUrl,
            [GATEWAY_API_KEY_VARS[service]]: PRIMARY.apiKey,
            [FALLBACK_GATEWAY_BASE_URL_VAR]: FALLBACK.baseUrl,
            [FALLBACK_GATEWAY_API_KEY_VARS[service]]: FALLBACK.apiKey,
            [variable]: override,
          })

          expect(gateways.primary?.model).toBe(SERVICE_TIERS[service])
          expect(gateways.fallback?.model).toBe(SERVICE_TIERS[service])
        }
      }
    }
  })

  it.each(CAPABILITY_TIERS)('preserves a canonical service tier override: %s', (tier) => {
    const gateways = gatewaysFromEnvironment('moderation', {
      ...complete,
      [GATEWAY_MODEL_VARS.moderation]: tier,
    })

    expect(gateways.primary?.model).toBe(tier)
    expect(gateways.fallback?.model).toBe(tier)
  })

  it.each(CAPABILITY_TIERS)('preserves a canonical shared tier override: %s', (tier) => {
    const gateways = gatewaysFromEnvironment('moderation', {
      ...complete,
      [GATEWAY_MODEL_VARS.moderation]: '',
      [GATEWAY_MODEL_VAR]: tier,
    })

    expect(gateways.primary?.model).toBe(tier)
    expect(gateways.fallback?.model).toBe(tier)
  })

  it('leaves an unconfigured fallback undefined rather than inventing a default', () => {
    const env = { ...complete, [FALLBACK_GATEWAY_BASE_URL_VAR]: '' }
    expect(gatewaysFromEnvironment('moderation', env)).toEqual({ primary: PRIMARY })
  })

  it.each(['', '/v1'])('refuses a missing or relative primary gateway origin: %j', (baseUrl) => {
    const env = { ...complete, [GATEWAY_BASE_URL_VAR]: baseUrl }
    expect(gatewaysFromEnvironment('moderation', env)).toEqual({ fallback: FALLBACK })
  })

  it.each(['', '/v1'])('refuses a missing or relative fallback gateway origin: %j', (baseUrl) => {
    const env = { ...complete, [FALLBACK_GATEWAY_BASE_URL_VAR]: baseUrl }
    expect(gatewaysFromEnvironment('moderation', env)).toEqual({ primary: PRIMARY })
  })

  it('leaves an unconfigured primary undefined and can run on the fallback alone', () => {
    const env = { ...complete, [GATEWAY_BASE_URL_VAR]: '' }
    expect(gatewaysFromEnvironment('moderation', env)).toEqual({ fallback: FALLBACK })
  })

  it('refuses each partial gateway independently', () => {
    expect(
      gatewaysFromEnvironment('moderation', {
        ...complete,
        [GATEWAY_API_KEY_VARS.moderation]: '',
        [FALLBACK_GATEWAY_API_KEY_VARS.moderation]: '',
      }),
    ).toEqual({})
  })

  it('uses the same service model for both gateways', () => {
    const gateways = gatewaysFromEnvironment('moderation', complete)
    expect(gateways.primary?.model).toBe(TIER)
    expect(gateways.fallback?.model).toBe(TIER)
  })

  it('names one primary and one fallback key for every service', () => {
    expect(Object.keys(FALLBACK_GATEWAY_API_KEY_VARS).sort()).toEqual(
      Object.keys(GATEWAY_API_KEY_VARS).sort(),
    )
  })

  it('assigns moderation and worker to tier-1 and every other service to tier-2', () => {
    expect(SERVICE_TIERS).toEqual({
      moderation: '@preset/tier-1',
      worker: '@preset/tier-1',
      verifier: '@preset/tier-2',
      triage: '@preset/tier-2',
      doctor: '@preset/tier-2',
      reviewer: '@preset/tier-2',
    })
  })

  it('gives a caller the fallback when both are configured', () => {
    expect(gatewayClient(GATEWAYS)).toBe(FALLBACK)
  })

  it('gives a caller whichever one exists', () => {
    expect(gatewayClient({ primary: PRIMARY })).toBe(PRIMARY)
    expect(gatewayClient({ fallback: FALLBACK })).toBe(FALLBACK)
    expect(gatewayClient({})).toBeUndefined()
  })

  it('builds a direct fallback transport for model clients', async () => {
    const under = transport(completion('{}'))
    const direct = gatewayFetch(FALLBACK, under.fetch)

    await direct('/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: TIER, messages: [], stream: false }),
    })

    expect(under.calls[0]?.url).toBe(`${FALLBACK.baseUrl}/chat/completions`)
    expect(new Headers(under.calls[0]?.init?.headers).get('authorization')).toBe(
      `Bearer ${FALLBACK.apiKey}`,
    )
  })
})

describe('the same request over either gateway', () => {
  it('sends the tier unchanged to the primary', async () => {
    const under = transport(completion('{"ok":true}'))
    const routed = gatewayRoutedFetch(GATEWAYS, { fetch: under.fetch })

    await routed(
      ...post(`${FALLBACK.baseUrl}/chat/completions`, { model: TIER, messages: [], stream: false }),
    )

    expect(under.calls).toHaveLength(1)
    expect(under.calls[0]?.url).toBe(`${PRIMARY.baseUrl}/chat/completions`)
    expect(new Headers(under.calls[0]?.init?.headers).get('authorization')).toBe(
      `Bearer ${PRIMARY.apiKey}`,
    )
    expect(JSON.parse(String(under.calls[0]?.init?.body))['model']).toBe(TIER)
  })

  it('replays the identical tier against the configured fallback', async () => {
    const under = transport(new Error('primary unavailable'), completion('{"ok":true}'))
    const routed = gatewayRoutedFetch(GATEWAYS, { fetch: under.fetch })

    await routed(
      ...post(`${FALLBACK.baseUrl}/chat/completions`, { model: TIER, messages: [], stream: false }),
    )

    expect(under.calls).toHaveLength(2)
    expect(under.calls[1]?.url).toBe(`${FALLBACK.baseUrl}/chat/completions`)
    expect(new Headers(under.calls[1]?.init?.headers).get('authorization')).toBe(
      `Bearer ${FALLBACK.apiKey}`,
    )
    expect(JSON.parse(String(under.calls[1]?.init?.body))['model']).toBe(TIER)
  })

  it('still sends chat to the primary when the fallback is unconfigured', async () => {
    const under = transport(completion('{}'))
    const routed = gatewayRoutedFetch({ primary: PRIMARY }, { fetch: under.fetch })

    await routed(...post('/chat/completions', { model: TIER, messages: [], stream: false }))

    expect(under.calls).toHaveLength(1)
    expect(under.calls[0]?.url).toBe(`${PRIMARY.baseUrl}/chat/completions`)
  })

  /**
   * **The failure `#1726` was filed for**, reproduced at the seam that produced
   * it. Since `#1695` a caller hands the transport `/chat/completions` and the
   * transport supplies the origin. The primary leg does; the OpenRouter replay
   * underneath it did not, so a gateway that stopped answering turned every tick
   * into `Failed to parse URL from /chat/completions` / `ERR_INVALID_URL` —
   * measured in `moderation-runner` on 2026-08-27, 112 lines in one hour.
   *
   * Every URL this transport issues has to be one `new URL` accepts, whichever
   * leg issued it.
   */
  it('never issues a relative URL, on either leg', async () => {
    const under = transport(new Error('primary unavailable'), completion('{}'))
    const routed = gatewayRoutedFetch(GATEWAYS, { fetch: under.fetch })

    await routed(...post('/chat/completions', { model: TIER, messages: [], stream: false }))

    expect(under.calls).toHaveLength(2)
    for (const call of under.calls) expect(() => new URL(call.url)).not.toThrow()
    expect(under.calls.map((call) => call.url)).toEqual([
      `${PRIMARY.baseUrl}/chat/completions`,
      `${FALLBACK.baseUrl}/chat/completions`,
    ])
  })

  /**
   * The production configuration exactly: a primary that has stopped answering
   * and no second origin configured to replay against.
   *
   * **There is nowhere to send it, so nothing is sent.** A named
   * `GatewayUnavailable` says so; the alternative is the request that cannot be
   * addressed being issued anyway, which is what `ERR_INVALID_URL` was.
   */
  it('refuses to replay a relative path it has no origin for', async () => {
    const under = transport(new Error('primary unavailable'), completion('{}'))
    const routed = gatewayRoutedFetch({ primary: PRIMARY }, { fetch: under.fetch })

    await expect(
      routed(...post('/chat/completions', { model: TIER, messages: [], stream: false })),
    ).rejects.toBeInstanceOf(GatewayUnavailable)

    expect(under.calls).toHaveLength(1)
    expect(under.calls[0]?.url).toBe(`${PRIMARY.baseUrl}/chat/completions`)
  })

  /** An absolute caller URL is still replayed as it always was. */
  it('replays an absolute caller URL against the provider that supplied it', async () => {
    const under = transport(new Error('primary unavailable'), completion('{}'))
    const routed = gatewayRoutedFetch({ primary: PRIMARY }, { fetch: under.fetch })

    await routed(
      ...post(`${FALLBACK.baseUrl}/chat/completions`, { model: TIER, messages: [], stream: false }),
    )

    expect(under.calls).toHaveLength(2)
    expect(under.calls[1]?.url).toBe(`${FALLBACK.baseUrl}/chat/completions`)
  })

  it('runs directly on the fallback when the primary is unconfigured', async () => {
    const under = transport(completion('{}'))
    const routed = gatewayRoutedFetch({ fallback: FALLBACK }, { fetch: under.fetch })

    await routed(
      ...post(`${FALLBACK.baseUrl}/chat/completions`, { model: TIER, messages: [], stream: false }),
    )

    expect(under.calls).toHaveLength(1)
    expect(under.calls[0]?.url).toBe(`${FALLBACK.baseUrl}/chat/completions`)
  })

  it('leaves no client key for a relative-only gateway, as it does for a missing key', () => {
    const gateways = gatewaysFromEnvironment('moderation', {
      [GATEWAY_BASE_URL_VAR]: '/v1',
      [GATEWAY_API_KEY_VARS.moderation]: PRIMARY.apiKey,
    })

    expect(gateways).toEqual({})
    expect(gatewayClient(gateways)?.apiKey ?? '').toBe('')
  })
})

describe('the two D-122 exclusions', () => {
  it('hands embeddings to the fallback even while the primary is configured', async () => {
    const under = transport(completion('{}'))
    const routed = gatewayRoutedFetch(GATEWAYS, { fetch: under.fetch })

    await routed(...post('/embeddings', { model: 'embedding-from-configuration', input: ['x'] }))

    expect(under.calls).toHaveLength(1)
    expect(under.calls[0]?.url).toBe(`${FALLBACK.baseUrl}/embeddings`)
    expect(new Headers(under.calls[0]?.init?.headers).get('authorization')).toBe(
      `Bearer ${FALLBACK.apiKey}`,
    )
  })

  it('does not touch the primary while an embedding call succeeds on the fallback', async () => {
    const under = transport(
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const routed = gatewayRoutedFetch(GATEWAYS, { fetch: under.fetch })

    await routed(...post('/embeddings', { model: 'embedding-from-configuration', input: ['x'] }))

    expect(under.calls.map((call) => call.url)).toEqual([`${FALLBACK.baseUrl}/embeddings`])
  })

  it('throws rather than replaying quest moderation on the fallback', async () => {
    const under = transport(new Error('primary unavailable'), completion('{}'))
    const only = gatewayOnlyFetch(GATEWAYS, { fetch: under.fetch })

    await expect(
      only(
        ...post(`${FALLBACK.baseUrl}/chat/completions`, {
          model: '@preset/tier-1',
          messages: [],
          stream: false,
        }),
      ),
    ).rejects.toBeInstanceOf(GatewayUnavailable)
    expect(under.calls).toHaveLength(1)
    expect(under.calls[0]?.url).toBe(`${PRIMARY.baseUrl}/chat/completions`)
  })
})

describe('provider hosts stay inside the gateway module', () => {
  const root = fileURLToPath(new URL('../../../../', import.meta.url))
  const trees = ['packages/core/src', 'packages/verifiers/src', 'apps']

  function sourceFiles(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = `${directory}/${entry.name}`
      if (entry.isDirectory()) {
        return entry.name === '__fixtures__' ||
          entry.name === 'dist' ||
          entry.name === 'node_modules'
          ? []
          : sourceFiles(path)
      }
      if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) return []
      return [path]
    })
  }

  it('finds no provider hostname outside gateway.ts', () => {
    const providerHost = ['openrouter', '.', 'ai'].join('')
    const found = trees.flatMap((tree) =>
      sourceFiles(`${root}${tree}`)
        .filter((path) => !path.endsWith('/packages/core/src/llm/gateway.ts'))
        .filter((path) => !path.endsWith('.test.ts'))
        .filter((path) => readFileSync(path, 'utf8').toLowerCase().includes(providerHost))
        .map((path) => path.slice(root.length)),
    )
    expect(found).toEqual([])
  })
})
