import { silentLog, type Log } from '../log/log.js'

/**
 * The LLM gateway, and the fallback to OpenRouter behind it (`#674`).
 *
 * ## Why this is a `fetch` and not a client
 *
 * Ten call sites in four services POST a chat completion, and every one of them
 * has its own error vocabulary: the moderation runner throws
 * `ProviderUnreachable`, the vision checkers answer `unavailable` so a citizen is
 * never failed for our outage, the quest judge distinguishes a permanent vendor
 * rejection from a transient one. Those distinctions are the product of several
 * incidents each, and a client that owned the request would have to own them too
 * — or flatten them, which is the same thing done quietly.
 *
 * So the routing sits **underneath** all of it. What every one of those call
 * sites already takes is an injectable `fetch`; this wraps it. A gateway attempt
 * that goes wrong never reaches the caller at all — the original request is
 * replayed against OpenRouter and the caller sees whatever OpenRouter said,
 * exactly as it did before this existed.
 *
 * ## What is routed, and what is deliberately not
 *
 * **Only `POST …/chat/completions`.** Embeddings stay on OpenRouter permanently:
 * the gateway wraps CLI subscriptions and has no `/embeddings` endpoint at all —
 * it answers 404 — so `moderation-runner`'s briefing synthesis must pass straight
 * through. That is a fact about the gateway rather than a policy, which is why it
 * is a path check here and not a flag somebody can set.
 *
 * ## The three conditions
 *
 * A gateway attempt falls back on a transport failure, on a timeout, and on **a
 * reply that is 200 and unusable**. The third is the one worth building for: the
 * first two announce themselves, and the third returns success with prose in it.
 * A moderator that accepts prose has approved something nobody judged.
 *
 * What can be checked here is what the transport can see — that the reply carries
 * content at all, and that the content parses as JSON when the request asked for
 * a structured `response_format`. That is not the caller's own schema, and it is
 * not meant to be: the caller still validates, and a reply that gets past this
 * and fails there fails the way it always did.
 *
 * ## One retry, not a loop
 *
 * The same prompt runs at most twice — once per provider. A fallback that retried
 * within a provider before switching would turn one moderation into four calls.
 *
 * ## A fallback is not routine
 *
 * Every one is logged at `warn` with its reason class, so *the gateway was down
 * for two hours* is answerable afterwards rather than invisible.
 *
 * ## The two rules `#726` added, stated where the gateway is documented
 *
 * **1. The model is per service, not global.** `LLM_GATEWAY_MODEL` steers every
 * service that names no model of its own; `LLM_GATEWAY_MODEL_<SERVICE>` steers
 * one. The service token that resolves it is the same one that picks the API key,
 * so there is one list of services rather than two. A deployment setting none of
 * the per-service variables behaves exactly as it did before they existed.
 *
 * **2. A decision the Colony cannot take back does not fall back.** Since `#693`
 * a quest that clears moderation is published by that verdict, and the moderation
 * runner's OpenRouter model is a flash model — so the ordinary fallback composed
 * into *when the good model is down, publish quests judged by the weaker one
 * instead*. {@link gatewayOnlyFetch} is the client for that one call: it throws
 * where {@link gatewayRoutedFetch} replays, and the quest stays `pending_review`
 * for the next tick. Every other stage keeps the fallback, because being served
 * late by a weaker model beats not being served at all — which is true of
 * moderating an answer and false of publishing paid work.
 */

/** Where the gateway is. Never a literal: `AGENTS.md` §9, and it is a host of ours. */
export const GATEWAY_BASE_URL_VAR = 'LLM_GATEWAY_BASE_URL'

/**
 * Which model the gateway is asked for, overriding whatever the caller
 * configured — for **every** service that has no override of its own.
 *
 * See {@link GATEWAY_MODEL_VARS} for why one variable was not enough.
 */
export const GATEWAY_MODEL_VAR = 'LLM_GATEWAY_MODEL'

/**
 * One key per service, and the reason there are several rather than one.
 *
 * A single key would mean one service's runaway loop is billed, capped and
 * revoked together with the other three — so the moderation queue stops because
 * a verifier misbehaved. A key per service makes *whose traffic is this* answerable
 * at the gateway rather than only in our own logs, and lets one be revoked alone.
 *
 * Named here rather than at each service so the set is enumerable: the strings
 * have to match what is installed on the deployment, and one list is one thing to
 * reconcile. The Reviewer Agent's key is read by a workflow in
 * `Kolonie-AI/kolonie-docs` rather than by this repository; it is named here
 * anyway, because the point of the list is to be complete.
 */
export const GATEWAY_API_KEY_VARS = {
  verifier: 'LLM_GATEWAY_API_KEY_VERIFIER',
  moderation: 'LLM_GATEWAY_API_KEY_MODERATION',
  triage: 'LLM_GATEWAY_API_KEY_TRIAGE',
  reviewer: 'LLM_GATEWAY_API_KEY_REVIEWER',
  /**
   * The Doctor's sentences (`#840`).
   *
   * **A fifth key rather than reusing triage's**, on this list's own reasoning:
   * one key per service is what makes *whose traffic is this* answerable at the
   * gateway and lets one be revoked alone. The Doctor writes a sentence per new
   * finding across the whole Colony, which is a different volume and a different
   * blast radius from a support queue — and the two must not be capped together.
   *
   * **Unset is the ordinary state and means no prose at all**, which every layer
   * below is built to treat as complete rather than as broken.
   */
  doctor: 'LLM_GATEWAY_API_KEY_DOCTOR',
} as const

/** One of the four services the gateway knows by name. */
export type GatewayService = keyof typeof GATEWAY_API_KEY_VARS

/**
 * One model per service, overriding {@link GATEWAY_MODEL_VAR} for that one
 * (`#726`).
 *
 * **A single model variable across four services is wrong the moment two of them
 * want different models, and that moment has arrived.** The moderation runner
 * judges quests on the strongest model the Colony has, because since `#693` that
 * verdict *is* the publication. The verifier reads images and would be sent to a
 * text model by the same variable — silently, and on the day the gateway is
 * actually wired to it rather than on the day somebody changed a model.
 *
 * Resolved by the **same service token that picks the API key**, so there is one
 * list of services rather than two. A service named here and not there, or the
 * reverse, is a compile error rather than a variable nothing reads.
 *
 * Falls back to `LLM_GATEWAY_MODEL`, which falls back to no gateway at all —
 * which is the caller's own model on OpenRouter, exactly as before either
 * variable existed. **Nothing changes for a deployment that sets none of these.**
 */
export const GATEWAY_MODEL_VARS: Record<GatewayService, string> = {
  verifier: 'LLM_GATEWAY_MODEL_VERIFIER',
  moderation: 'LLM_GATEWAY_MODEL_MODERATION',
  triage: 'LLM_GATEWAY_MODEL_TRIAGE',
  reviewer: 'LLM_GATEWAY_MODEL_REVIEWER',
  doctor: 'LLM_GATEWAY_MODEL_DOCTOR',
} as const

/**
 * What a gateway call says it is, and why it is not cosmetic.
 *
 * **A request that does not name itself can be refused for the agent it fell back
 * on.** The gateway sits behind Cloudflare, and Cloudflare answers some default
 * client signatures with `403` and error code 1010 — a ban on the signature,
 * independent of address, credential and body. `Python-urllib/3.x` is one of
 * them: it cost the Reviewer Agent a week of silent fallbacks to OpenRouter
 * before `kolonie-platform#728` measured it, because a fallback that works hides
 * the refusal it is covering for.
 *
 * `fetch` sends something the edge accepts today, so this is prevention rather
 * than a fix — and prevention is the whole of the argument: the failure it avoids
 * is invisible, arrives without a deploy of ours, and is indistinguishable from
 * the gateway being down.
 *
 * **One agent for all four services, deliberately.** Whose traffic this is has an
 * answer already: the four keys. A per-service agent would be a second way to ask
 * the same question and a second thing to keep true.
 */
export const GATEWAY_USER_AGENT = 'Kolonie-Runner/1.0 (+https://github.com/Kolonie-AI)'

/** Everything needed to try the gateway. All three, or the gateway is not configured. */
export interface Gateway {
  readonly baseUrl: string
  readonly apiKey: string
  readonly model: string
}

/**
 * Why the gateway did not answer, in the four classes worth telling apart.
 *
 * `unreachable` and `timeout` are about the network between here and there;
 * `status` is the gateway answering badly; `malformed` is the 200 that is not an
 * answer. A count per class over a week says which of four quite different
 * things is wrong, and none of them is deducible from the others.
 */
export type FallbackReason = 'unreachable' | 'timeout' | 'status' | 'malformed'

/**
 * How long the gateway gets before the fallback is worth more than the wait.
 *
 * Generous, because these are reasoning models answering with documents and a
 * briefing synthesis has run for a minute. What this bounds is not slowness but
 * a connection that has stopped answering — and the cost of getting it wrong in
 * the other direction is one duplicate call to OpenRouter, not a lost verdict.
 */
export const GATEWAY_TIMEOUT_MS = 180_000

/**
 * The gateway as the environment describes it, or nothing.
 *
 * **All three or none**, and no partial configuration is honoured: a base URL
 * with no key is a service that would fall back on every call, which is the
 * expensive way to be switched off.
 *
 * A missing key is how a service is put back on OpenRouter **with no code
 * change**, which is the point of reading it here rather than deciding it in a
 * build.
 *
 * **The argument is the service and not the key variable** (`#726`). It was the
 * key variable, and then a second per-service variable appeared for the model —
 * at which point a caller passing a bare string would have had to pass two, and
 * nothing would have checked that the two named the same service. One token
 * picks both, and the compiler is what keeps them in step.
 */
export function gatewayFromEnvironment(
  service: GatewayService,
  env: Record<string, string | undefined> = process.env,
): Gateway | undefined {
  const baseUrl = (env[GATEWAY_BASE_URL_VAR] ?? '').trim()
  const apiKey = (env[GATEWAY_API_KEY_VARS[service]] ?? '').trim()
  // This service's model, then the one every service shares. An unset
  // per-service variable is inert rather than a model called the empty string,
  // which is what lets `#726` and the deploy that reads it land in either order.
  const model =
    (env[GATEWAY_MODEL_VARS[service]] ?? '').trim() || (env[GATEWAY_MODEL_VAR] ?? '').trim()

  if (baseUrl === '' || apiKey === '' || model === '') return undefined

  // Compose writes `${VAR:-}` for every optional variable, so unset arrives as an
  // empty string rather than as `undefined`; a trailing slash is the other way a
  // hand-edited `.env` differs from the one that was tested.
  return { baseUrl: baseUrl.replace(/\/+$/, ''), apiKey, model }
}

export interface RoutedFetchOptions {
  /** The transport underneath. Injectable so a test needs no network. */
  readonly fetch?: typeof fetch
  readonly log?: Log
  readonly timeoutMs?: number
}

/**
 * A `fetch` that tries the gateway for chat completions and OpenRouter otherwise.
 *
 * **With no gateway it is the transport it was given**, unchanged and not merely
 * equivalent — the same function object, so a service put back on OpenRouter
 * carries no routing code on its path at all.
 */
export function gatewayRoutedFetch(
  gateway: Gateway | undefined,
  options: RoutedFetchOptions = {},
): typeof fetch {
  const underlying = options.fetch ?? fetch
  if (gateway === undefined) return underlying

  const log = options.log ?? silentLog
  const timeoutMs = options.timeoutMs ?? GATEWAY_TIMEOUT_MS

  return async (input, init) => {
    const routed = gatewayRequest(gateway, input, init)
    if (routed === undefined) return underlying(input, init)

    const attempt = await tryGateway(underlying, routed, timeoutMs)
    if (attempt.response !== undefined) return attempt.response

    /**
     * **A `warn` and not an `info`.** The Colony is paying for the gateway; a
     * call that went to OpenRouter instead is a thing that did not work, even
     * though nothing downstream noticed. The URL is not in the line — it is a
     * host of ours — and the model is, because *which model was asked* is the
     * question a bill raises.
     */
    log.warn(`the gateway did not answer; ${gateway.model} was asked of OpenRouter instead`, {
      event: 'model.route.fallback',
      route: 'openrouter',
      from: 'gateway',
      reason: attempt.reason,
      model: gateway.model,
      ...(attempt.detail === undefined ? {} : { detail: attempt.detail }),
    })

    const response = await underlying(input, init)
    return stamp(response, 'openrouter', attempt.reason, attempt.detail)
  }
}

/**
 * A `fetch` that tries the gateway for chat completions and **fails rather than
 * falling back** (`#726`).
 *
 * For the one call whose answer is a decision the Colony cannot take back. Since
 * `#693` a quest that clears moderation is published by that verdict, and the
 * moderation runner's OpenRouter model is a flash model — so composed with
 * {@link gatewayRoutedFetch} the arrangement read as *when the good model is
 * down, publish quests judged by the weaker one instead.* Nobody decided that;
 * it is what the two behaviours did together.
 *
 * **Not a flag on a call**, because the fallback is a property of the `fetch` and
 * a `fetch` belongs to a whole client. A caller wanting both gets two clients,
 * which is also the honest shape: *these calls may be replayed and that one may
 * not* is a fact about the calls.
 *
 * The failure is a throw and not an unusable response, because every caller here
 * already distinguishes a provider that did not answer from one that answered
 * badly, and the first is what this is.
 *
 * **With no gateway it is the transport it was given**, exactly as
 * {@link gatewayRoutedFetch} is. There is nothing to fall back *from* on a
 * deployment that has no gateway, and refusing to run at all would take the stage
 * down rather than protect it.
 *
 * Requests it does not route — embeddings, anything that is not a chat
 * completion — pass through untouched, on {@link gatewayRequest}'s terms. The
 * gateway has no `/embeddings` endpoint, so routing them would be the failure
 * rather than the protection.
 */
export function gatewayOnlyFetch(
  gateway: Gateway | undefined,
  options: RoutedFetchOptions = {},
): typeof fetch {
  const underlying = options.fetch ?? fetch
  if (gateway === undefined) return underlying

  const log = options.log ?? silentLog
  const timeoutMs = options.timeoutMs ?? GATEWAY_TIMEOUT_MS

  return async (input, init) => {
    const routed = gatewayRequest(gateway, input, init)
    if (routed === undefined) return underlying(input, init)

    const attempt = await tryGateway(underlying, routed, timeoutMs)
    if (attempt.response !== undefined) return attempt.response

    /**
     * An `error` where {@link gatewayRoutedFetch} logs a `warn`, and the
     * difference is what happened next: there it is a call that cost more than
     * it should have, and here it is a call that did not happen.
     */
    log.error(`the gateway did not answer and this call may not fall back`, undefined, {
      event: 'model.route.refused',
      route: 'none',
      from: 'gateway',
      reason: attempt.reason,
      model: gateway.model,
      ...(attempt.detail === undefined ? {} : { detail: attempt.detail }),
    })

    throw new GatewayUnavailable(attempt.reason, attempt.detail)
  }
}

/**
 * The gateway did not answer a call that is not allowed to be replayed.
 *
 * A named class rather than a bare `Error` so a caller can tell it from a vendor
 * rejection: this one means *ask again later*, and a quest whose judgement hit it
 * is untouched and still `pending_review`.
 */
export class GatewayUnavailable extends Error {
  constructor(
    readonly reason: FallbackReason,
    detail?: string,
  ) {
    super(`the gateway did not answer (${reason}${detail === undefined ? '' : `: ${detail}`})`)
    this.name = 'GatewayUnavailable'
  }
}

/**
 * Which route answered, read back off a response this wrapper produced.
 *
 * **Headers rather than a return value**, because the seam is a `fetch` and a
 * `fetch` returns a `Response`. Everything that records a model call already has
 * one in hand at the point it reads `usage`, so nothing had to change shape to
 * carry this.
 *
 * A response from anywhere else — a real OpenRouter reply on a service with no
 * gateway, a fake in a test — carries no stamp and reads as `openrouter`, which
 * is what it is.
 */
export function routeOf(response: Response | undefined): {
  readonly route: 'gateway' | 'openrouter'
  readonly fallback?: {
    readonly route: 'gateway' | 'openrouter'
    readonly reason: string
    readonly status?: number
  }
} {
  // `headers` is read defensively rather than assumed. A `Response` always has
  // one; a test double standing in for a `Response` frequently does not, and a
  // reader that threw there would turn *which route answered* — a piece of
  // accounting — into a reason the call itself failed.
  const headers: Headers | undefined = response?.headers
  const route = headers?.get(ROUTE_HEADER) === 'gateway' ? 'gateway' : 'openrouter'
  const reason = headers?.get(FALLBACK_HEADER) ?? ''
  const status = Number(headers?.get(FALLBACK_STATUS_HEADER))

  if (reason === '') return { route }
  // The route that was *tried* and did not answer, which is the half a reader
  // needs: `route: openrouter, fallback: { route: gateway, reason: status }`
  // reads as one sentence.
  return {
    route,
    fallback: {
      route: 'gateway',
      reason,
      ...(Number.isInteger(status) && status >= 100 && status <= 599 ? { status } : {}),
    },
  }
}

const ROUTE_HEADER = 'x-kolonie-route'
const FALLBACK_HEADER = 'x-kolonie-fallback-reason'
const FALLBACK_STATUS_HEADER = 'x-kolonie-fallback-status'

/**
 * The same request aimed at the gateway, or nothing if it is not ours to route.
 *
 * **Every reason to decline is a fail-safe.** A request this cannot confidently
 * rewrite — a body that is not a JSON string, a path that is not a chat
 * completion, a method that is not POST — goes to OpenRouter untouched. The cost
 * of declining one is a call that does not use the subscription; the cost of
 * rewriting one wrongly is a request the vendor rejects for a reason nobody
 * traces back to here.
 */
function gatewayRequest(
  gateway: Gateway,
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1],
): { readonly url: string; readonly init: RequestInit } | undefined {
  if (typeof input !== 'string') return undefined
  if ((init?.method ?? 'GET').toUpperCase() !== 'POST') return undefined
  if (!input.endsWith('/chat/completions')) return undefined
  if (typeof init?.body !== 'string') return undefined

  let body: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(init.body)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    body = parsed as Record<string, unknown>
  } catch {
    return undefined
  }

  if (typeof body['model'] !== 'string') return undefined

  /**
   * The gateway's model replaces the caller's — this service's model, resolved
   * by {@link gatewayFromEnvironment} before it got here (`#726`).
   *
   * The *reply* still names what answered, and that is what gets recorded:
   * configuration says what was asked for and the `model_calls` row says what
   * did it.
   */
  const headers = new Headers(init.headers)
  headers.set('authorization', `Bearer ${gateway.apiKey}`)
  headers.set('content-type', 'application/json')
  // Set on the gateway leg only. The fallback replays the caller's own request
  // untouched, and OpenRouter is not the party that cares.
  headers.set('user-agent', GATEWAY_USER_AGENT)

  return {
    url: `${gateway.baseUrl}/chat/completions`,
    init: {
      ...init,
      method: 'POST',
      headers,
      body: JSON.stringify({ ...body, model: gateway.model }),
    },
  }
}

interface Attempt {
  readonly response?: Response
  readonly reason: FallbackReason
  readonly detail?: string
}

async function tryGateway(
  underlying: typeof fetch,
  routed: { readonly url: string; readonly init: RequestInit },
  timeoutMs: number,
): Promise<Attempt> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  let response: Response
  try {
    response = await underlying(routed.url, { ...routed.init, signal: controller.signal })
  } catch (error) {
    // An abort of ours and a connection that never opened arrive the same way and
    // are not the same problem: one is the gateway being slow, the other is it
    // being absent.
    return controller.signal.aborted
      ? { reason: 'timeout', detail: `no answer in ${timeoutMs}ms` }
      : { reason: 'unreachable', detail: describe(error) }
  } finally {
    clearTimeout(timer)
  }

  if (!response.ok) return { reason: 'status', detail: String(response.status) }

  /**
   * The body is read here and handed on as a new `Response`, because a stream
   * can only be consumed once and this has to look at it. The size is a chat
   * completion, which every caller was about to buffer anyway.
   */
  let text: string
  try {
    text = await response.text()
  } catch (error) {
    return { reason: 'malformed', detail: describe(error) }
  }

  const unusable = whyUnusable(text, routed.init.body)
  if (unusable !== undefined) return { reason: 'malformed', detail: unusable }

  const headers = new Headers(response.headers)
  headers.set(ROUTE_HEADER, 'gateway')
  return {
    response: new Response(text, {
      status: response.status,
      statusText: response.statusText,
      headers,
    }),
    reason: 'malformed',
  }
}

/**
 * What is wrong with a 200 that is not an answer, or nothing.
 *
 * Three checks, and no more: the reply is JSON, it carries content, and — **only
 * when the request asked for one** — that content is itself JSON. The last is the
 * condition the issue names: a model that ignores `response_format` answers 200
 * with a paragraph, and the paragraph is what a caller would then try to parse a
 * verdict out of.
 *
 * A `refusal` counts as content. A model declining to answer is the model
 * answering, and OpenRouter would decline the same prompt for the same reason —
 * falling back would buy a second refusal at twice the price.
 */
function whyUnusable(text: string, requestBody: unknown): string | undefined {
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return 'the reply was not JSON'
  }

  const choice = (
    body as {
      choices?: { message?: { content?: unknown; refusal?: unknown } }[]
    }
  ).choices?.[0]

  if (choice === undefined) return 'the reply carried no choices'

  const refusal = choice.message?.refusal
  if (typeof refusal === 'string' && refusal !== '') return undefined

  const content = choice.message?.content
  if (typeof content !== 'string' || content.trim() === '') return 'the reply carried no content'

  if (!askedForStructure(requestBody)) return undefined

  try {
    JSON.parse(stripFence(content))
  } catch {
    return 'a structured reply was asked for and prose came back'
  }

  return undefined
}

/** Whether the request asked for JSON at all. A prose answer is only wrong if it was. */
function askedForStructure(requestBody: unknown): boolean {
  if (typeof requestBody !== 'string') return false
  try {
    const format = (JSON.parse(requestBody) as { response_format?: { type?: unknown } })
      .response_format
    return format?.type === 'json_schema' || format?.type === 'json_object'
  } catch {
    return false
  }
}

/**
 * A fenced block is not a schema violation worth a second provider.
 *
 * `apps/support-triage-runner` already strips these because a model asked for
 * JSON usually returns JSON and *usually* is not a contract. Falling back on one
 * would spend a second call to reach an answer the caller was always going to
 * accept.
 */
function stripFence(text: string): string {
  const trimmed = text.trim()
  if (!trimmed.startsWith('```')) return trimmed
  return trimmed
    .replace(/^```[a-zA-Z]*\n?/, '')
    .replace(/```$/, '')
    .trim()
}

/** Everything the rejection says about itself, without the request that is in its cause. */
function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const code = (error as { code?: unknown }).code
  const cause = error.cause instanceof Error ? ` — caused by ${error.cause.message}` : ''
  return `${error.message}${typeof code === 'string' ? ` (${code})` : ''}${cause}`
}

/** A response OpenRouter produced, marked with the gateway attempt that preceded it. */
function stamp(
  response: Response,
  route: 'openrouter',
  reason: FallbackReason,
  detail?: string,
): Response {
  const headers = new Headers(response.headers)
  headers.set(ROUTE_HEADER, route)
  headers.set(FALLBACK_HEADER, reason)
  // Only an HTTP status is public accounting. Other details can contain
  // transport prose and remain in the structured service log instead.
  if (reason === 'status' && detail !== undefined) headers.set(FALLBACK_STATUS_HEADER, detail)
  // The body is untouched and unread — a stream that is still a stream, so a
  // caller that streams still can.
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}
