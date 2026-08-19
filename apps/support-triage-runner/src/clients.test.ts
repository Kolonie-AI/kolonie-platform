import { describe, expect, it, vi } from 'vitest'
import { AgentIdSchema, SupportTicketIdSchema, gatewayRoutedFetch } from '@kolonie-ai/core'
import { modelClients, type ModelClients } from './clients.js'

const GATEWAY = {
  baseUrl: 'https://gateway.invalid',
  apiKey: 'gateway-key',
  model: 'gateway/model',
}

const OPENROUTER_COMPLETIONS = 'https://openrouter.ai/api/v1/chat/completions'

const answer = (content: unknown): Response =>
  new Response(
    JSON.stringify({
      model: 'provider/model-that-answered',
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      choices: [{ message: { content: JSON.stringify(content) }, finish_reason: 'stop' }],
    }),
    { status: 200 },
  )

/**
 * One call per client, and the record is what makes this test survive a fifth
 * one (`#780`).
 *
 * The defect this covers was a single missing argument at one of two call sites,
 * so a test naming that call site would pass again the moment somebody adds a
 * third client and forgets it in the same way. Keying the exercises by
 * `keyof ModelClients` means the compiler refuses a client with no call here,
 * and the assertion below refuses one that is never driven.
 */
const exercise: Record<keyof ModelClients, (clients: ModelClients) => Promise<unknown>> = {
  model: (clients) =>
    clients.model.classify({
      ticket: {
        id: SupportTicketIdSchema.parse('11111111-1111-4111-8111-111111111111'),
        agentId: AgentIdSchema.parse('22222222-2222-4222-8222-222222222222'),
        kind: 'question',
        // The queue this runner reads (`#1344`): a `desk` ticket never reaches it.
        route: 'colony',
        subject: 'A question',
        body: 'What happened?',
        status: 'open',
        resolution: null,
        issueUrl: null,
        aboutSubmissionId: null,
        aboutProvider: null,
        createdAt: '2026-08-10T00:00:00.000Z',
        updatedAt: '2026-08-10T00:00:00.000Z',
      },
      issues: [],
      answered: [],
    }),
  writer: (clients) =>
    clients.writer.describe({
      signature: 'api/poll.failed',
      service: 'api',
      event: 'poll.failed',
      count: 3,
      samples: [],
      lastStart: null,
    }),
}

const clientNames = Object.keys(exercise) as ReadonlyArray<keyof ModelClients>

const transport = (
  reply: (url: string) => Response,
): { readonly impl: typeof fetch; readonly urls: string[] } => {
  const urls: string[] = []
  return {
    impl: (async (input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      urls.push(url)
      return reply(url)
    }) as unknown as typeof fetch,
    urls,
  }
}

describe('every model client this runner builds', () => {
  it('exercises all of them here, so a fifth one cannot be added untested', () => {
    const clients = modelClients('a-key', { fetchImpl: async () => answer({}) })

    expect(clientNames.slice().sort()).toEqual(Object.keys(clients).sort())
  })

  it.each(clientNames)('routes %s through the gateway', async (name) => {
    const under = transport(() =>
      answer({ kind: 'human', why: 'unclear', summary: 'x', reading: 'y' }),
    )
    const clients = modelClients('a-key', {
      fetchImpl: gatewayRoutedFetch(GATEWAY, { fetch: under.impl }),
    })

    await exercise[name](clients)

    expect(under.urls).toEqual([`${GATEWAY.baseUrl}/chat/completions`])
  })

  /**
   * The rejection case. With no gateway configured `gatewayRoutedFetch` returns
   * the transport it was given — the same function object — so neither client
   * gains routing code on its path and both behave exactly as they did before
   * `#674`. Read together with the test above: one says the wiring reaches the
   * gateway, this one says it is the gateway's presence that decides, not a
   * branch inside a client.
   */
  it.each(clientNames)('leaves %s on OpenRouter when no gateway is configured', async (name) => {
    const under = transport(() =>
      answer({ kind: 'human', why: 'unclear', summary: 'x', reading: 'y' }),
    )
    const routed = gatewayRoutedFetch(undefined, { fetch: under.impl })

    expect(routed).toBe(under.impl)

    await exercise[name](modelClients('a-key', { fetchImpl: routed }))

    expect(under.urls).toEqual([OPENROUTER_COMPLETIONS])
  })

  /**
   * Embeddings are not this runner's — `apps/moderation-runner` buys them — and
   * they are asserted here anyway, because the fix above is *route the transport
   * everywhere* and the obvious over-reach of it is to route everything. The
   * gateway has no `/embeddings` endpoint, so a routed embedding is a 404 rather
   * than a saving.
   */
  it('does not route embeddings, whoever asks for them', async () => {
    const under = transport(() => new Response('{}', { status: 200 }))
    const routed = gatewayRoutedFetch(GATEWAY, { fetch: under.impl })

    await routed('https://openrouter.ai/api/v1/embeddings', {
      method: 'POST',
      body: JSON.stringify({ model: 'm', input: 'x' }),
    })

    expect(under.urls).toEqual(['https://openrouter.ai/api/v1/embeddings'])
  })

  it('asks nothing of anything with no key, and says the writer is unavailable', async () => {
    const under = transport(() => answer({}))
    const clients = modelClients('', {
      fetchImpl: under.impl,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    })

    expect(clients.writer.available).toBe(false)
    await expect(exercise.model(clients)).rejects.toThrow(/OPENROUTER_API_KEY/)
    await expect(exercise.writer(clients)).rejects.toThrow(/no model configured/)
    expect(under.urls).toEqual([])
  })
})
