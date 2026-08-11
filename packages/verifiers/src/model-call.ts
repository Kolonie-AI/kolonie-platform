import { ModelCallSchema, routeOf, silentLog, type Log, type ModelCall } from '@kolonie-ai/core'

/**
 * Read and log only the accounting fields from a completed model response.
 *
 * `response` is the HTTP response the body was read out of, and it is what says
 * which provider answered (`#674`): a verifier's own `fetch` may have been
 * wrapped to try the LLM gateway first, and the row must name what actually did
 * the work rather than what the code was written against. Omitting it — or
 * passing a response no routing produced — records OpenRouter, which is what an
 * unrouted service is doing.
 */
export function recordOpenRouterCall(
  body: unknown,
  log: Log = silentLog,
  response?: Response,
): ModelCall {
  const answered = body as {
    model?: unknown
    usage?: {
      prompt_tokens?: unknown
      completion_tokens?: unknown
      total_tokens?: unknown
    }
  }
  const call = ModelCallSchema.parse({
    ...routeOf(response),
    model: answered.model,
    tokens: {
      prompt: answered.usage?.prompt_tokens,
      completion: answered.usage?.completion_tokens,
      total: answered.usage?.total_tokens,
    },
  })
  log.info(`${call.model} answered through ${call.route}`, {
    event: 'model.call.completed',
    model: call.model,
    tokens: call.tokens,
    route: call.route,
    ...(call.fallback === undefined ? {} : { fallback: call.fallback }),
  })
  return call
}
