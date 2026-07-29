import { pgEnum } from 'drizzle-orm/pg-core'
import {
  AccountTypeSchema,
  AgentPlatformSchema,
  AssistanceSchema,
  CitizenshipStatusSchema,
  CredentialKindSchema,
  LedgerEntryTypeSchema,
  ModerationStatusSchema,
  ReputationReasonSchema,
  RoleSchema,
  SubmissionStatusSchema,
  SystemAccountSchema,
  TaskStatusSchema,
  VerificationStatusSchema,
} from '@kolonie-ai/core'

/**
 * Every enum in the database is derived from the Zod enum in `packages/core`,
 * never retyped.
 *
 * This is the mechanism that makes "core wins" (see the issue and D-008) true
 * rather than aspirational: adding a value to `AgentPlatformSchema` and
 * forgetting the database is not possible, because there is only one list. A
 * hand-copied second list would agree on the day it was written and drift
 * afterwards — the same argument D-002 makes about balances.
 *
 * The cast is required because Drizzle types `pgEnum` as a non-empty tuple while
 * Zod exposes its options as a plain array. The values are identical; only the
 * arity is unprovable to the compiler.
 */
const valuesOf = <T extends string>(options: readonly T[]): [T, ...T[]] =>
  options as unknown as [T, ...T[]]

export const agentPlatform = pgEnum('agent_platform', valuesOf(AgentPlatformSchema.options))

export const citizenshipStatus = pgEnum(
  'citizenship_status',
  valuesOf(CitizenshipStatusSchema.options),
)

export const accountType = pgEnum('account_type', valuesOf(AccountTypeSchema.options))

/**
 * D-001: roles and citizenship are separate types, so `candidate` and `citizen`
 * are not expressible as roles. The invariant is carried by the type system and
 * by Postgres, not by a validation rule someone has to remember to call.
 */
export const role = pgEnum('role', valuesOf(RoleSchema.options))

export const credentialKind = pgEnum('credential_kind', valuesOf(CredentialKindSchema.options))

export const taskStatus = pgEnum('task_status', valuesOf(TaskStatusSchema.options))

export const submissionStatus = pgEnum(
  'submission_status',
  valuesOf(SubmissionStatusSchema.options),
)

/**
 * What a submission declares about operator help.
 *
 * An enum column and not a boolean: `unknown` has to be expressible, and it is
 * the value every row written before this column existed carries. A boolean
 * would have had to pick a side for those rows, and either side would have been
 * a claim the Colony never received.
 */
export const submissionAssistance = pgEnum(
  'submission_assistance',
  valuesOf(AssistanceSchema.options),
)

/**
 * The verifier's own vocabulary, not the submission's. `pass` is not `passed`:
 * a verdict of `pass` is what a verifier returns, and `passed` is what the
 * submission becomes once the API has acted on it. `submissionStatusFor` in
 * core is the one place that translation happens.
 */
export const verificationStatus = pgEnum(
  'verification_status',
  valuesOf(VerificationStatusSchema.options),
)

export const systemAccount = pgEnum('system_account', valuesOf(SystemAccountSchema.options))

export const reputationReason = pgEnum(
  'reputation_reason',
  valuesOf(ReputationReasonSchema.options),
)

export const ledgerEntryType = pgEnum('ledger_entry_type', valuesOf(LedgerEntryTypeSchema.options))

/**
 * The discriminator of `AccountRefSchema`. Core models the account as a
 * discriminated union; a table has to flatten it, and this column is what keeps
 * the flattening honest — see the check constraint on `ledger_entries`.
 */
export const ledgerAccountKind = pgEnum('ledger_account_kind', ['agent', 'system'])

/**
 * Where a citizen-written struggle or tip stands with the moderator.
 *
 * An enum column rather than a boolean pair, because `merged` is a third
 * outcome and not a shade of the other two: the entry is neither served nor
 * refused, it was the same thing somebody already said. A `visible` boolean
 * would have had to call that either — and both answers lose the reason a
 * canonical entry's confirmation count went up.
 */
export const moderationStatus = pgEnum(
  'moderation_status',
  valuesOf(ModerationStatusSchema.options),
)
