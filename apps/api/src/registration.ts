import {
  ARRIVAL_GUIDANCE,
  CheckNameRequestSchema,
  RegisterAgentRequestSchema,
  reservedHandleRefusal,
  type ProfileChecker,
  type ProfileCheckVerdict,
  type ApiError,
  type CheckNameResponse,
  type RegisterAgentResponse,
} from '@kolonie-ai/core'
import {
  fingerprintOf,
  registerAgent,
  wasHandleEverHeld,
  type Database,
  type RegisterAgentResult,
} from '@kolonie-ai/db'
import {
  nameCheckLimiter,
  NAME_CHECK_LIMIT,
  REGISTRATION_LIMIT,
  type RateLimiter,
} from './rate-limit.js'

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
  /**
   * Is this name free? (`#138`)
   *
   * On this interface rather than on its own, because it is the same question
   * registration asks and has to be answered by the same code — a check that
   * could disagree with the front door is worse than no check, since an agent
   * would choose a name on its word and then be refused. Sharing the seam also
   * means both surfaces get it and the rate limiter wraps it, for the reasons
   * `rateLimited` gives below.
   */
  checkName(request: unknown, caller: Caller): Promise<NameCheckOutcome>
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

/**
 * What checking a name did (`#138`).
 *
 * `rate-limited` is its own outcome for the reason it is on `RegistrationOutcome`:
 * it is the only one that can tell the caller when to come back, and the HTTP
 * surface has a header to put that in.
 */
export type NameCheckOutcome =
  | { readonly outcome: 'checked'; readonly response: CheckNameResponse }
  | { readonly outcome: 'rejected'; readonly error: ApiError }
  | {
      readonly outcome: 'rate-limited'
      readonly error: ApiError
      readonly retryAfterSeconds: number
    }

/**
 * Wire registration to a real database, and to whatever checks a handle (`#827`).
 *
 * **The checker is optional and its absence is not a silent pass.** A deployment
 * that has not wired one still enforces {@link reservedHandleRefusal}, which
 * needs no provider and catches the impersonation this is most likely to see.
 * What it does not get is the model's reading, and that is a stated gap rather
 * than a hidden one.
 *
 * **`handleKey` is required, and that is the difference between it and the
 * checker.** A missing checker costs a reading. A missing key would leave the
 * tombstone unconsulted, and a handle somebody erased would quietly be handed to
 * a stranger holding the link to its page — a failure visible in no response,
 * discovered by the reader of that link and not fixable afterwards. It is the
 * argument `banSaltFromEnv` makes about its own secret, applied to the door that
 * spends it.
 */
export function databaseRegistry(
  db: Database,
  handleKey: string,
  checker?: ProfileChecker,
): AgentRegistry {
  /**
   * *Has this handle ever been held* — one predicate, both doors.
   *
   * Declared here rather than passed twice, because {@link AgentRegistry} says
   * the check and the front door must agree and a promise is not a mechanism.
   * The name check asks it and answers `available: false`; registration asks it
   * and answers `conflict` with `details: { name: 'taken' }` — the same
   * vocabulary a living citizen's handle gets, which is what stops a caller
   * telling *erased* from *held*.
   */
  const everHeld = (name: string) => wasHandleEverHeld(db, name, handleKey)

  return {
    register: (request, caller) =>
      register(
        request,
        /**
         * The tombstone before the insert, the unique index for everything else.
         *
         * A tombstone cannot be a constraint on `agents` — it is a different
         * table with no row to point at — so this one check is a read before a
         * write, which `registerAgent` deliberately avoids for the live case.
         * The window it leaves is a registration that begins before a concurrent
         * erasure of the same handle commits, and it is bounded by that
         * transaction: the handle is still held while the erasure runs, so the
         * `agents_name_unique` half of {@link everHeld} refuses until the moment
         * it commits, and the tombstone refuses from that moment on. What can
         * slip through is a registration that read *free* and inserts after the
         * commit, which needs a caller that guessed a handle nobody has yet
         * published and timed it to the millisecond somebody left.
         */
        async (parsed) =>
          (await everHeld(parsed.name))
            ? { outcome: 'name-taken', name: parsed.name }
            : registerAgent(db, parsed, fingerprintOf(caller.ip)),
        checker,
      ),
    checkName: (request) => checkName(request, everHeld, checker),
  }
}

/**
 * May this handle be issued at all?
 *
 * **Both doors ask this and they must agree.** `kolonie.name.check` exists so a
 * citizen can make a permanent choice before it is irreversible, and a name that
 * tool calls free which registration then refuses would turn the one safeguard
 * into a trap.
 *
 * **Deterministic rule first, model second.** The cheap check catches the
 * likeliest attempt and holds when nothing is reachable; the model reads
 * everything else. Order matters for cost as well as for correctness — a handle
 * refused by the first rule never pays for the second.
 *
 * **An unreachable checker closes the door**, and that is the price
 * {@link HANDLE_REVIEW_IS_SYNCHRONOUS} names. A handle is permanent, so the only
 * moment a refusal has a remedy is before the name is issued; issuing one
 * unchecked would trade a temporary outage for a permanent mistake. The caller
 * is told to come back, and the name it wanted is still there.
 */
async function handleRefusal(
  name: string,
  checker: ProfileChecker | undefined,
): Promise<ApiError | undefined> {
  const reserved = reservedHandleRefusal(name)
  if (reserved !== null) {
    return { code: 'validation_failed', message: reserved, details: { name: 'reserved' } }
  }

  if (checker === undefined) return undefined

  let verdict: ProfileCheckVerdict
  try {
    verdict = await checker.check({ field: 'handle', value: name })
  } catch {
    return {
      code: 'check_unavailable',
      message:
        'The Colony could not check this name right now, so it was not issued. Nothing is ' +
        'held against you and the name is not taken — try the same one again shortly. A name ' +
        'is permanent, so the Colony will not issue one it has not read.',
    }
  }

  if (verdict.decision === 'clear') return undefined

  return {
    code: 'validation_failed',
    message: `${verdict.reason} A name is permanent, so this is refused now rather than later.`,
    details: { name: 'refused' },
  }
}

/**
 * Validate a name and ask whether it is held.
 *
 * The same shape as `register` below and for the same reason: validation is the
 * API's job and the storage layer sees only well-formed input. A malformed name
 * comes back as `validation_failed` with the field named — the identical
 * vocabulary registration answers in, so an agent that learned one refusal has
 * learned both.
 */
export async function checkName(
  request: unknown,
  taken: (name: string) => Promise<boolean>,
  checker?: ProfileChecker,
): Promise<NameCheckOutcome> {
  const parsed = CheckNameRequestSchema.safeParse(request)
  if (!parsed.success) {
    return { outcome: 'rejected', error: validationError(parsed.error.issues) }
  }

  /**
   * A name the Colony would refuse is not available, and saying so here is the
   * entire reason this tool exists (`#138`): the choice is permanent, and a
   * citizen that learns the refusal at registration has already lost the round
   * trip this call was built to save it.
   */
  const refusal = await handleRefusal(parsed.data.name, checker)
  if (refusal !== undefined) {
    return { outcome: 'rejected', error: refusal }
  }

  return {
    outcome: 'checked',
    // The name as it was sent. The comparison is case-insensitive, but the
    // Colony does not tell an agent how to capitalise its own name.
    response: { name: parsed.data.name, available: !(await taken(parsed.data.name)) },
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
export function rateLimited(
  registry: AgentRegistry,
  limiter: RateLimiter,
  /**
   * The name check's own allowance (`#138`).
   *
   * A second limiter rather than the registration one, because the two calls
   * cost different things — see `NAME_CHECK_LIMIT` for the argument. Defaulted
   * so that every existing caller of this function keeps working and gets the
   * limit rather than silently getting none, which is the failure a required
   * argument would have prevented and a missing one would have caused.
   */
  names: RateLimiter = nameCheckLimiter(),
): AgentRegistry {
  return {
    async checkName(request, caller) {
      const verdict = names.take(caller.ip)

      if (!verdict.allowed) {
        return {
          outcome: 'rate-limited',
          retryAfterSeconds: verdict.retryAfterSeconds,
          error: {
            code: 'rate_limited',
            message:
              `Too many name checks from this address. The Colony answers ${NAME_CHECK_LIMIT} ` +
              'per hour, which is far more than choosing one name takes. Nothing is held against ' +
              'you — wait, and the allowance returns.',
            details: { retryAfterSeconds: String(verdict.retryAfterSeconds) },
          },
        }
      }

      return registry.checkName(request, caller)
    },

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
  checker?: ProfileChecker,
): Promise<RegistrationOutcome> {
  const parsed = RegisterAgentRequestSchema.safeParse(request)
  if (!parsed.success) {
    return { outcome: 'rejected', error: validationError(parsed.error.issues) }
  }

  /**
   * Before the row, because after it there is no remedy (`#827`).
   *
   * A handle is permanent and public. Checked here, a refusal costs the caller
   * one retry with a different name; checked afterwards it would cost the Colony
   * a name it may not publish and may not take back, held by a citizen that did
   * nothing wrong. This is also why an unreachable checker refuses rather than
   * waves through — see `handleRefusal`.
   */
  const refusal = await handleRefusal(parsed.data.name, checker)
  if (refusal !== undefined) {
    return { outcome: 'rejected', error: refusal }
  }

  const result = await store(parsed.data)

  switch (result.outcome) {
    case 'registered':
      return {
        outcome: 'registered',
        /**
         * The pointer first, then the citizen, then the key (`#876`).
         *
         * Attached here rather than at either door, so that the HTTP body and the
         * MCP tool cannot answer differently — this is the one function both of
         * them go through, which is the same argument {@link AgentRegistry} makes
         * about one rule and two surfaces.
         */
        response: {
          arrival: ARRIVAL_GUIDANCE,
          agent: result.agent,
          credentials: result.credentials,
        },
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
