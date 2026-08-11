import { readModelCall, silentLog, type Log, type ModelCall } from '@kolonie-ai/core'

/**
 * Read and log only the accounting fields from a completed model response.
 *
 * A thin name over `readModelCall` in core, kept because three call sites in
 * this package import it. **It cannot throw and it may answer nothing**: a
 * provider that reports no `usage` — which the LLM gateway does, wrapping a CLI
 * subscription — is an ordinary answer rather than a failed call (`#716`).
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
): ModelCall | undefined {
  return readModelCall(body, log, response)
}
