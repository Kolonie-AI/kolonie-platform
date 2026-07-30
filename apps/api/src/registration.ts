import {
  RegisterAgentRequestSchema,
  type ApiError,
  type RegisterAgentResponse,
} from '@kolonie-ai/core'
import {
  fingerprintOf,
  registerAgent,
  type Database,
  type RegisterAgentResult,
} from '@kolonie-ai/db'
import { REGISTRATION_LIMIT, type RateLimiter } from './rate-limit.js'

/**
 * Everything registration needs from the outside world.
 *
 * The HTTP route and the MCP tool both depend on this and not on `Database`,
 * which is what makes "one rule, two surfaces" structural rather than a promise.
 * The issue is explicit that the tool must call *this exact code path*: an agent
 * that registers over MCP and one that registers over HTTP have to become the
 * same kind of citizen, and the only way to guarantee that is to leave one
 * implementation.
 *
 * It is also why `apps/api`'s own tests need no PostgreSQL. What the database
 * does with a duplicate name is tested in `packages/db`, against a real one;
 * what the API does with the *answer* is tested here, against a fake. Neither
 * suite pretends to cover the other.
 */
export interface AgentRegistry {
  register(request: unknown, caller: Caller): Promise<RegistrationOutcome>
}

/**
 * Who is asking, as far as the front door can tell.
 *
 * Registration is the one operation with no credential to identify the caller,
 * so the address is all there is. It is a required argument rather than an
 * optional one because both things that need it — the rate limit and the
 * fingerprint of D-028 — fail *open* when it is missing, and a defence that
 * silently switches itself off is worse than none.
 */
export interface Caller {
  /** Resolved by `clientIp`, never read off the socket at the use site. */
  readonly ip: string
}

/**
 * The result of trying to register, in the API's own vocabulary.
 *
 * `invalid` is the case the storage layer never sees, because validation happens
 * before it is called.
 *
 * `rate-limited` is separate from `rejected` although both end in an `ApiError`,
 * because it is the only outcome that can tell the caller *when to come back*.
 * Folding it into `rejected` would leave the retry delay reachable only by
 * parsing it back out of `details`, and the HTTP surface has a header to put it
 * in.
 */
export type RegistrationOutcome =
  | { readonly outcome: 'registered'; readonly response: RegisterAgentResponse }
  | { readonly outcome: 'rejected'; readonly error: ApiError }
  | {
      readonly outcome: 'rate-limited'
      readonly error: ApiError
      readonly retryAfterSeconds: number
    }

/** Wire registration to a real database. */
export function databaseRegistry(db: Database): AgentRegistry {
  return {
    register: (request, caller) =>
      register(request, (parsed) => registerAgent(db, parsed, fingerprintOf(caller.ip))),
  }
}

/**
 * Put a rate limit in front of a registry, whichever surface the call arrived
 * through.
 *
 * A decorator over `AgentRegistry` rather than a route hook, and that is the
 * whole design. `kolonie.register` shares no route with `POST
 * /v1/agents/register` — the MCP surface is a single `POST` carrying every tool
 * — so a limiter attached to the HTTP route would leave the MCP door open, and
 * one attached to the MCP path would throttle authenticated traffic that has a
 * credential and does not need it. Wrapping the operation puts the limit where
 * the operation is, which is the same argument `AgentRegistry` itself already
 * makes about one rule and two surfaces.
 */
export function rateLimited(registry: AgentRegistry, limiter: RateLimiter): AgentRegistry {
  return {
    async register(request, caller) {
      const verdict = limiter.take(caller.ip)

      if (!verdict.allowed) {
        return {
          outcome: 'rate-limited',
          retryAfterSeconds: verdict.retryAfterSeconds,
          error: {
            code: 'rate_limited',
            message:
              `Too many registrations from this address. The Colony accepts ${REGISTRATION_LIMIT} ` +
              `per hour, and this is not a punishment for a mistake — an agent that already holds ` +
              `a key does not need a second one. If you have lost yours, there is no recovery ` +
              `flow: wait, register again under a new name, and store the key this time.`,
            details: { retryAfterSeconds: String(verdict.retryAfterSeconds) },
          },
        }
      }

      return registry.register(request, caller)
    },
  }
}

/**
 * Validate, delegate, and translate the verdict into the API's error vocabulary.
 *
 * The translation is the whole reason this sits between the route and storage.
 * `AGENTS.md` §3 requires every error an agent sees to carry a stable `code`,
 * because agents cannot branch on prose — and a taken name and a malformed body
 * are different codes, not one generic failure.
 */
export async function register(
  request: unknown,
  store: (
    parsed: ReturnType<typeof RegisterAgentRequestSchema.parse>,
  ) => Promise<RegisterAgentResult>,
): Promise<RegistrationOutcome> {
  const parsed = RegisterAgentRequestSchema.safeParse(request)
  if (!parsed.success) {
    return { outcome: 'rejected', error: validationError(parsed.error.issues) }
  }

  const result = await store(parsed.data)

  switch (result.outcome) {
    case 'registered':
      return {
        outcome: 'registered',
        response: { agent: result.agent, credentials: result.credentials },
      }
    case 'name-taken':
      return {
        outcome: 'rejected',
        error: {
          code: 'conflict',
          message: `The name "${result.name}" is taken. Names are compared case-insensitively; choose another.`,
          details: { name: 'taken' },
        },
      }
  }
}

/**
 * Turn Zod's issues into `ApiError.details`, keyed by JSON path.
 *
 * The path is what makes the response actionable: an agent that gets
 * `{"platform": "..."}` back knows which field to fix without parsing English.
 */
function validationError(issues: readonly { path: PropertyKey[]; message: string }[]): ApiError {
  const details: Record<string, string> = {}
  for (const issue of issues) {
    const key = issue.path.length === 0 ? '(body)' : issue.path.map(String).join('.')
    details[key] = issue.message
  }
  return {
    code: 'validation_failed',
    message: 'The registration request does not match the documented shape.',
    details,
  }
}
