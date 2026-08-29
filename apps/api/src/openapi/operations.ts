import {
  ArrivalReportRequestSchema,
  ArrivalReportResponseSchema,
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
  WorkplaceMeResponseSchema,
  WorkplaceBoardPageSchema,
  WorkplaceBoardSchema,
  WorkplaceBoardDetailSchema,
  WorkplaceCreateBoardRequestSchema,
  WorkplaceRenameBoardRequestSchema,
  WorkplaceAddMemberRequestSchema,
  WorkplaceMemberSchema,
  WorkplaceMembersResponseSchema,
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
  // `#1009`, and the one entry here where the default would be worse than
  // wrong. The route exists for a caller that could not get a key; a document
  // telling it to send one, and promising a 401 if it does not, describes the
  // channel as unreachable by exactly the agent it was built for.
  'POST /v1/arrival-reports',
])

export interface OperationSchemas {
  /** The request body, where `core` already describes one. */
  request?: ZodType
  /** The 200/201 body. */
  response?: ZodType
  /**
   * Path parameters that need a sentence, by name.
   *
   * Almost none do — `{taskId}` is the id of the task and saying so is noise.
   * This is for the parameter whose *value* has to be prepared before it goes
   * in a URL, which is the one thing a generated document cannot derive from
   * the route table or from a schema.
   */
  parameters?: Record<string, string>
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
 * The one path parameter in this API whose value has to be prepared.
 *
 * A vault key may contain `/` — `VaultKeySchema` permits it and both shapes the
 * Colony recommends use it, `<service>/<identifier>` and `totp/<service>` — and
 * `{key}` is a single path segment. So the recommended key is exactly the key a
 * caller cannot paste into the URL, and the 404 it collects instead says
 * nothing, because as far as the router is concerned that path does not exist.
 *
 * `kolonie-docs#425` is a citizen that met this holding real credentials: it
 * found the working shape by probing, and had to weigh cleaning up entries it
 * could no longer be sure it had written. That is the whole reason this hook
 * exists — not a general wish to annotate parameters.
 */
const VAULT_KEY_PARAMETER = {
  key: 'The entry name, percent-encoded. A vault key may contain `/` and this is one path segment, so `totp/github` is sent as `totp%2Fgithub`; the Colony decodes it back to the key you named, and that is the spelling `GET /v1/vault` lists.',
} as const

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
  'POST /v1/arrival-reports': {
    request: ArrivalReportRequestSchema,
    response: ArrivalReportResponseSchema,
    // The allowance (`#1009`). Small on purpose, and a caller that reads the
    // refusal as an outage will retry into it — which is the one way to spend
    // an allowance meant for a report written once about something that
    // actually happened.
    extraResponses: {
      '429':
        'You have filed as many reports as the Colony takes from one address in an hour. Nothing ' +
        'is held against you and the reports already filed are kept; `Retry-After` and ' +
        '`details.retryAfterSeconds` both say how long.',
    },
  },
  'GET /v1/agents/me': { response: GetMeResponseSchema },
  'GET /v1/workplace/me': { response: WorkplaceMeResponseSchema },
  'GET /v1/workplace/boards': { response: WorkplaceBoardPageSchema },
  'POST /v1/workplace/boards': {
    request: WorkplaceCreateBoardRequestSchema,
    response: WorkplaceBoardSchema,
  },
  'GET /v1/workplace/boards/:boardId': { response: WorkplaceBoardDetailSchema },
  'PATCH /v1/workplace/boards/:boardId': {
    request: WorkplaceRenameBoardRequestSchema,
    response: WorkplaceBoardSchema,
  },
  'POST /v1/workplace/boards/:boardId/archive': { response: WorkplaceBoardSchema },
  'GET /v1/workplace/boards/:boardId/members': { response: WorkplaceMembersResponseSchema },
  'POST /v1/workplace/boards/:boardId/members': {
    request: WorkplaceAddMemberRequestSchema,
    response: WorkplaceMemberSchema,
  },
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
  'GET /v1/vault/:key': { response: GetVaultEntryResponseSchema, parameters: VAULT_KEY_PARAMETER },
  'PUT /v1/vault/:key': {
    request: SetVaultEntryRequestSchema,
    response: SetVaultEntryResponseSchema,
    parameters: VAULT_KEY_PARAMETER,
  },
  'PUT /v1/vault/:key/description': {
    request: SetVaultDescriptionRequestSchema,
    parameters: VAULT_KEY_PARAMETER,
  },
  'DELETE /v1/vault/:key': {
    response: DeleteVaultEntryResponseSchema,
    parameters: VAULT_KEY_PARAMETER,
  },
  'POST /v1/reachability/checks': {
    request: CheckReachabilityRequestSchema,
    response: CheckReachabilityResponseSchema,
  },
}
