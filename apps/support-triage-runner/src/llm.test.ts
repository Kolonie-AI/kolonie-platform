import { describe, expect, it, vi } from 'vitest'
import { AgentIdSchema, SupportTicketIdSchema, type Log } from '@kolonie-ai/core'
import { openRouterDefectWriter, openRouterModel } from './llm.js'

const response = (content: unknown, model = 'provider/model-that-answered'): Response =>
  new Response(
    JSON.stringify({
      model,
      usage: { prompt_tokens: 308, completion_tokens: 5, total_tokens: 313 },
      choices: [{ message: { content: JSON.stringify(content) }, finish_reason: 'stop' }],
    }),
    { status: 200 },
  )

const log = (): { readonly impl: Log; readonly info: ReturnType<typeof vi.fn> } => {
  const info = vi.fn()
  return { impl: { info, warn: vi.fn(), error: vi.fn() }, info }
}

describe('support model accounting', () => {
  it('returns and logs the model and tokens reported by the response', async () => {
    const recorded = log()
    const model = openRouterModel('a-key', {
      model: 'configured/model',
      fetchImpl: async () => response({ kind: 'human', why: 'unclear' }),
      log: recorded.impl,
    })

    const result = await model.classify({
      ticket: {
        id: SupportTicketIdSchema.parse('11111111-1111-4111-8111-111111111111'),
        agentId: AgentIdSchema.parse('22222222-2222-4222-8222-222222222222'),
        kind: 'question',
        subject: 'A question',
        body: 'What happened?',
        status: 'open',
        resolution: null,
        issueUrl: null,
        createdAt: '2026-08-10T00:00:00.000Z',
        updatedAt: '2026-08-10T00:00:00.000Z',
      },
      issues: [],
      answered: [],
    })

    expect(result.call?.model).toBe('provider/model-that-answered')
    expect(result.call?.tokens).toEqual({ prompt: 308, completion: 5, total: 313 })
    expect(recorded.info).toHaveBeenCalledWith(expect.any(String), {
      event: 'model.call.completed',
      model: 'provider/model-that-answered',
      tokens: { prompt: 308, completion: 5, total: 313 },
      route: 'openrouter',
    })
  })

  it('carries accounting beside model-authored defect prose', async () => {
    const writer = openRouterDefectWriter('a-key', {
      fetchImpl: async () => response({ summary: 'A failure', reading: 'Look here first.' }),
    })

    const result = await writer.describe({
      signature: 'api/poll.failed',
      service: 'api',
      event: 'poll.failed',
      count: 3,
      samples: [],
      lastStart: null,
    })

    expect(result.call?.model).toBe('provider/model-that-answered')
    expect(result.call?.route).toBe('openrouter')
  })
})
