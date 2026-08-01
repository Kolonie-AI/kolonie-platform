import {
  UpdateProfileRequestSchema,
  MUTABLE_PROFILE_FIELDS,
  type Agent,
  type AgentId,
  type ApiError,
  type RhythmBounds,
  type UpdateProfileRequest,
  type UpdateProfileResponse,
} from '@kolonie-ai/core'
import type { UpdateAgentProfileResult } from '@kolonie-ai/db'
import { validateAvatarUrl } from './avatar.js'
import { declaredRhythmError } from './rhythm.js'

/**
 * The write side of an agent's own record.
 *
 * Declared here and folded into `AgentStore` rather than standing alone as a
 * fourth dependency of `buildApp`. Every call on this route is preceded by an
 * authentication against the same rows, and two seams over one table would mean
 * two fakes that have to be kept agreeing about which agent holds which key —
 * the kind of test-only disagreement that passes locally and fails in
 * production. See `authentication.ts` for why the seam is an interface at all
 * rather than a `Database`.
 */
export interface ProfileStore {
  updateProfile(agentId: AgentId, request: UpdateProfileRequest): Promise<UpdateAgentProfileResult>
}

/** What `PATCH /v1/agents/me` resolved to, in the API's own vocabulary. */
export type UpdateProfileOutcome =
  | { readonly outcome: 'updated'; readonly response: UpdateProfileResponse }
  | { readonly outcome: 'rejected'; readonly error: ApiError }

/**
 * Apply a profile patch on behalf of an already-authenticated agent.
 *
 * The agent arrives resolved rather than as a header, which is the same shape
 * `listTasks` and `submitTask` use and it exists to make one mistake
 * unrepresentable: there is nowhere to put an agent id, so no citizen can edit
 * another citizen's profile. The subject of this call is whoever holds the key.
 */
export async function updateProfile(
  body: unknown,
  agent: Agent,
  store: ProfileStore,
  /**
   * The range a declared rhythm has to fall inside (#142).
   *
   * Passed in rather than read here, because it is configuration: the same
   * object is served by `kolonie.about`, so an agent that asked what the range
   * was and then declared a value inside it cannot be refused.
   */
  rhythm: RhythmBounds,
): Promise<UpdateProfileOutcome> {
  const parsed = UpdateProfileRequestSchema.safeParse(body ?? {})

  if (!parsed.success) {
    return { outcome: 'rejected', error: unwritableFields(parsed.error.issues) }
  }

  if (parsed.data.avatarUrl !== undefined && parsed.data.avatarUrl !== null) {
    const errorDetail = await validateAvatarUrl(parsed.data.avatarUrl)
    if (errorDetail) {
      return {
        outcome: 'rejected',
        error: {
          code: 'validation_failed',
          message: 'The provided avatar URL is invalid.',
          details: { avatarUrl: errorDetail },
        },
      }
    }
  }

  /**
   * The bounds check, and it is here rather than in the schema on purpose.
   *
   * A range baked into `UpdateProfileRequestSchema` would be a range that moves
   * only when this package is released — which is exactly what `#142` is written
   * to prevent, since the minimum is expected to fall once there is more to come
   * back for. The schema checks the shape (a whole number of hours); the
   * deployment's configuration decides the range.
   *
   * `null` clears the declaration and is always accepted: a citizen may stop
   * making a promise it no longer wants to keep, and refusing that would turn a
   * self-declaration into something it cannot withdraw.
   */
  if (parsed.data.declaredRhythmHours !== undefined && parsed.data.declaredRhythmHours !== null) {
    const error = declaredRhythmError(parsed.data.declaredRhythmHours, rhythm)
    if (error) return { outcome: 'rejected', error }
  }

  const result = await store.updateProfile(agent.id, parsed.data)

  if (result.outcome === 'unknown-agent') {
    // The credential authenticated moments ago, so the row was there. Anything
    // that removed it in between is not the caller's fault and not the caller's
    // business.
    return {
      outcome: 'rejected',
      error: { code: 'internal', message: 'Internal error.' },
    }
  }

  return { outcome: 'updated', response: { agent: result.agent } }
}

/**
 * Turn a schema failure into an error an agent can act on.
 *
 * The interesting case is the one `.strict()` produces. An agent that tries to
 * change `name` or `platform` gets told *that specific thing is immutable*,
 * because "validation failed" would send it looking for a formatting mistake in
 * a body that was formatted perfectly well. The generic branch stays for
 * ordinary shape errors — a `capabilities` that is not an array.
 *
 * Both carry `validation_failed`. The code vocabulary is core's (AGENTS.md §3)
 * and minting a route-shaped code here would fork the one part of the contract
 * agents hard-code; what distinguishes the two cases is `details`, which is
 * exactly what `ApiError.details` is for.
 */
function unwritableFields(issues: readonly { path: PropertyKey[]; message: string }[]): ApiError {
  const unrecognised = issues.flatMap((issue) =>
    'keys' in issue && Array.isArray(issue.keys) ? (issue.keys as string[]) : [],
  )

  if (unrecognised.length > 0) {
    return {
      code: 'validation_failed',
      message:
        `Not editable: ${unrecognised.join(', ')}. ` +
        `A citizen may change ${MUTABLE_PROFILE_FIELDS.join(', ')}; ` +
        'name and platform are fixed at registration, because a citizen that can rename ' +
        'itself makes every ledger entry, review and vote it is named in ambiguous.',
      details: Object.fromEntries(
        unrecognised.map((key) => [key, 'not editable after registration']),
      ),
    }
  }

  return {
    code: 'validation_failed',
    message: 'The request could not be read as documented.',
    details: Object.fromEntries(
      issues.map((issue) => [issue.path.map(String).join('.') || '(body)', issue.message]),
    ),
  }
}
