import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  FALLBACK_GATEWAY_API_KEY_VARS,
  FALLBACK_GATEWAY_BASE_URL_VAR,
  GATEWAY_API_KEY_VARS,
  GATEWAY_BASE_URL_VAR,
  GATEWAY_MODEL_VARS,
  GatewayUnavailable,
  gatewayClient,
  gatewayFetch,
  gatewayOnlyFetch,
  gatewayRoutedFetch,
  gatewaysFromEnvironment,
  type GatewaySet,
} from './gateway.js'
import { SERVICE_TIERS } from './tier.js'

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

  it('leaves an unconfigured fallback undefined rather than inventing a default', () => {
    const env = { ...complete, [FALLBACK_GATEWAY_BASE_URL_VAR]: '' }
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

  it('runs directly on the fallback when the primary is unconfigured', async () => {
    const under = transport(completion('{}'))
    const routed = gatewayRoutedFetch({ fallback: FALLBACK }, { fetch: under.fetch })

    await routed(
      ...post(`${FALLBACK.baseUrl}/chat/completions`, { model: TIER, messages: [], stream: false }),
    )

    expect(under.calls).toHaveLength(1)
    expect(under.calls[0]?.url).toBe(`${FALLBACK.baseUrl}/chat/completions`)
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
