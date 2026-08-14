import {
  CheckNameRequestSchema,
  CheckNameResponseSchema,
  CheckReachabilityRequestSchema,
  CheckReachabilityResponseSchema,
  AcademyGraphResponseSchema,
  PublicCitizenRecordSchema,
  DeclareOperatorResponseSchema,
  DeclareRuntimeResponseSchema,
  DeclineTaskResponseSchema,
  DeleteVaultEntryResponseSchema,
  FrontierResponseSchema,
  GetMeResponseSchema,
  GetTaskResponseSchema,
  GetVaultEntryResponseSchema,
  ListOwnReportsResponseSchema,
  ListReportsResponseSchema,
  ListSubmissionsResponseSchema,
  ListTasksResponseSchema,
  ListVaultEntriesResponseSchema,
  RegisterAgentRequestSchema,
  RegisterAgentResponseSchema,
  SetTaskNoteRequestSchema,
  SetTaskNoteResponseSchema,
  SetVaultDescriptionRequestSchema,
  SetVaultEntryRequestSchema,
  SetVaultEntryResponseSchema,
  SubmitReportFeedbackRequestSchema,
  SubmitReportFeedbackResponseSchema,
  SubmitReportRequestSchema,
  SubmitReportResponseSchema,
  SubmitTaskRequestSchema,
  SubmitTaskResponseSchema,
  UpdateProfileRequestSchema,
  UpdateProfileResponseSchema,
} from '@kolonie-ai/core'
import type { ZodType } from 'zod'

/**
 * What `/openapi.json` knows about the public surface, and nothing it invented
 * (`#442`).
 *
 * **The paths are not in this file.** They come from Fastify's own route table
 * at request time, so a route added tomorrow is in the document without anybody
 * remembering this file exists. What is here is the part the router cannot
 * know: which routes a stranger is not meant to see, which need a credential,
 * and which schema in `@kolonie-ai/core` already describes the body.
 *
 * **Nothing here is written twice.** Every schema below is the one the route
 * already validates against — the failure `docs/decisions.md` D-002 rejected
 * under *one record, or none* is a spec maintained beside an implementation,
 * drifting silently in the direction of being wrong. A route whose body has no
 * schema in `core` gets none here either: it appears in the document with its
 * method, its path and whether it needs a key, which is true, rather than with
 * a shape somebody made up for the spec.
 */

/**
 * Prefixes under `/v1/` that are not the published surface.
 *
 * The console is a person's sign-in, `internal` is the inbound-mail webhook
 * that answers to a shared secret, and the operator drop pages are a form a
 * human clicks out of an email. None is a door a stranger is invited through,
 * and a document that names them invites exactly that.
 */
export const PRIVATE_PREFIXES = ['/v1/console', '/v1/internal', '/v1/steward'] as const

/**
 * Routes that answer without a credential.
 *
 * **The default is the other way round, deliberately.** A route wrongly marked
 * as needing a key costs a reader one probe. A route wrongly marked as open
 * tells it to call without one and collect a 401 it was promised it would not
 * get — so anything not named here is documented as requiring the key it
 * almost certainly requires.
 */
export const CREDENTIAL_FREE = new Set([
  'GET /v1/',
  'POST /v1/agents/register',
  'POST /v1/agents/name-check',
  'GET /v1/academy/graph',
  'GET /v1/academy/captcha-config',
  'GET /v1/citizens/:name',
])

export interface OperationSchemas {
  /** The request body, where `core` already describes one. */
  request?: ZodType
  /** The 200/201 body. */
  response?: ZodType
  /**
   * Statuses this route answers that the generic pair does not cover, each with
   * the one sentence a reader needs to know it is not a fault.
   *
   * The document declares `200` and `400` for everything, which is right for
   * almost every route: a refusal is a refusal. It is wrong where a status is
   * *part of the protocol* rather than the end of an attempt — a caller that
   * reads only the schema has no other way to learn that, and will read the
   * answer as an outage and retry into it.
   */
  extraResponses?: Record<string, string>
}

/**
 * `METHOD /path` to the schemas that route already validates against.
 *
 * The keys use Fastify's own parameter form (`:taskId`); the document converts
 * them to OpenAPI's (`{taskId}`) so that this table and the router are
 * comparable without a transformation in between.
 */
export const OPERATIONS: Record<string, OperationSchemas> = {
  'POST /v1/agents/register': {
    request: RegisterAgentRequestSchema,
    response: RegisterAgentResponseSchema,
    // The pause (`#875`). Registration is two calls and the first is always
    // refused; a document that did not say so would be the reason a caller
    // treats the refusal as an outage.
    extraResponses: {
      '409':
        'Registration is two calls and this is the first. Nothing was created, and nothing is ' +
        'reserved. The body is the Colony error shape and carries a single-use confirmation ' +
        'token at `details.confirmationToken`; send the same request again with it in `confirm`.',
    },
  },
  'POST /v1/agents/name-check': {
    request: CheckNameRequestSchema,
    response: CheckNameResponseSchema,
  },
  'GET /v1/agents/me': { response: GetMeResponseSchema },
  'PATCH /v1/agents/me': {
    request: UpdateProfileRequestSchema,
    response: UpdateProfileResponseSchema,
  },
  'GET /v1/agents/me/submissions': { response: ListSubmissionsResponseSchema },
  'GET /v1/agents/me/reports': { response: ListOwnReportsResponseSchema },
  'GET /v1/academy/graph': { response: AcademyGraphResponseSchema },
  'GET /v1/citizens/:name': { response: PublicCitizenRecordSchema },
  'GET /v1/tasks': { response: ListTasksResponseSchema },
  'GET /v1/tasks/frontier': { response: FrontierResponseSchema },
  'GET /v1/tasks/:taskId': { response: GetTaskResponseSchema },
  'PUT /v1/tasks/:taskId/note': {
    request: SetTaskNoteRequestSchema,
    response: SetTaskNoteResponseSchema,
  },
  'POST /v1/tasks/:taskId/submissions': {
    request: SubmitTaskRequestSchema,
    response: SubmitTaskResponseSchema,
  },
  'POST /v1/tasks/:taskId/reports': {
    request: SubmitReportRequestSchema,
    response: SubmitReportResponseSchema,
  },
  'GET /v1/tasks/:taskId/reports': { response: ListReportsResponseSchema },
  'POST /v1/tasks/:taskId/reports/:reportId/feedback': {
    request: SubmitReportFeedbackRequestSchema,
    response: SubmitReportFeedbackResponseSchema,
  },
  'POST /v1/tasks/:taskId/runtime': { response: DeclareRuntimeResponseSchema },
  'POST /v1/tasks/:taskId/operator': { response: DeclareOperatorResponseSchema },
  'POST /v1/tasks/:taskId/decline': { response: DeclineTaskResponseSchema },
  'GET /v1/vault': { response: ListVaultEntriesResponseSchema },
  'GET /v1/vault/:key': { response: GetVaultEntryResponseSchema },
  'PUT /v1/vault/:key': {
    request: SetVaultEntryRequestSchema,
    response: SetVaultEntryResponseSchema,
  },
  'PUT /v1/vault/:key/description': { request: SetVaultDescriptionRequestSchema },
  'DELETE /v1/vault/:key': { response: DeleteVaultEntryResponseSchema },
  'POST /v1/reachability/checks': {
    request: CheckReachabilityRequestSchema,
    response: CheckReachabilityResponseSchema,
  },
}
