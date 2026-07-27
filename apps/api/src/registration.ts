import {
  RegisterAgentRequestSchema,
  type ApiError,
  type RegisterAgentResponse,
} from '@kolonie-ai/core'
import { registerAgent, type Database, type RegisterAgentResult } from '@kolonie-ai/db'

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
  register(request: unknown): Promise<RegistrationOutcome>
}

/**
 * The result of trying to register, in the API's own vocabulary.
 *
 * `invalid` is the case the storage layer never sees, because validation happens
 * before it is called.
 */
export type RegistrationOutcome =
  | { readonly outcome: 'registered'; readonly response: RegisterAgentResponse }
  | { readonly outcome: 'rejected'; readonly error: ApiError }

/** Wire registration to a real database. */
export function databaseRegistry(db: Database): AgentRegistry {
  return { register: (request) => register(request, (parsed) => registerAgent(db, parsed)) }
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
    case 'wallet-taken':
      return {
        outcome: 'rejected',
        error: {
          code: 'conflict',
          // Deliberately does not say *which* agent holds it. An anonymous
          // caller must not be able to use the front door to enumerate which
          // wallets belong to citizens.
          message: 'That wallet is already registered to an agent.',
          details: { wallet: 'taken' },
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
