import { ModelCallSchema, silentLog, type Log, type ModelCall } from '@kolonie-ai/core'

/** Read and log only the accounting fields from a completed model response. */
export function recordOpenRouterCall(body: unknown, log: Log = silentLog): ModelCall {
  const response = body as {
    model?: unknown
    usage?: {
      prompt_tokens?: unknown
      completion_tokens?: unknown
      total_tokens?: unknown
    }
  }
  const call = ModelCallSchema.parse({
    route: 'openrouter',
    model: response.model,
    tokens: {
      prompt: response.usage?.prompt_tokens,
      completion: response.usage?.completion_tokens,
      total: response.usage?.total_tokens,
    },
  })
  log.info(`${call.model} answered through ${call.route}`, {
    event: 'model.call.completed',
    model: call.model,
    tokens: call.tokens,
    route: call.route,
  })
  return call
}
