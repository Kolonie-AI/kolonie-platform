import { pgEnum } from 'drizzle-orm/pg-core'
import {
  AccountProvenanceSchema,
  AccountStatusSchema,
  AccountTypeSchema,
  AgentPlatformSchema,
  AssistanceSchema,
  AttemptOpenerSchema,
  AuthorityActionSchema,
  BanMarkKindSchema,
  CitizenshipStatusSchema,
  CredentialKindSchema,
  EmailChallengePurposeSchema,
  ErasureReasonSchema,
  LedgerEntryTypeSchema,
  ModerationStatusSchema,
  OperatorRequestAuthorSchema,
  PermissionBlockSchema,
  RegistrationPathSchema,
  ReportOutcomeSchema,
  ReputationReasonSchema,
  RoleSchema,
  RuntimeFieldSchema,
  AutonomyDefaultRuleSchema,
  AutonomyLevelSchema,
  SetAsideReasonSchema,
  SubmissionStatusSchema,
  QuestReportKindSchema,
  SupportTicketKindSchema,
  SupportTicketStatusSchema,
  SystemAccountSchema,
  TaskAttemptOutcomeSchema,
  TaskKindSchema,
  FundingSourceSchema,
  TaskAudienceSchema,
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
 * The account register's two closed vocabularies (`#150`).
 *
 * Enums here where `kind` is text, and the difference is which of them grows.
 * A new kind arrives whenever the Academy learns to verify something new; a
 * fourth *status* would be a change to what the citizen is allowed to say about
 * what it holds, which is an argument rather than a routine addition — so the
 * database is the right place for it to have to be made.
 */
export const accountStatus = pgEnum('account_status', valuesOf(AccountStatusSchema.options))

export const accountProvenance = pgEnum(
  'account_provenance',
  valuesOf(AccountProvenanceSchema.options),
)

/**
 * D-001: roles and citizenship are separate types, so `candidate` and `citizen`
 * are not expressible as roles. The invariant is carried by the type system and
 * by Postgres, not by a validation rule someone has to remember to call.
 */
export const role = pgEnum('role', valuesOf(RoleSchema.options))

export const credentialKind = pgEnum('credential_kind', valuesOf(CredentialKindSchema.options))

/**
 * Which door an identity came through (`#172`).
 *
 * An enum rather than a boolean because there will be a third door — a federated
 * sign-in is already anticipated in D-050 — and `is_web` would have to be
 * rewritten on the day it arrives, in a column every count reads.
 */
/**
 * What a privileged act was (`#173`).
 *
 * An enum rather than free text because this is the column an audit is filtered
 * on, and a table nobody can query by action reliably is a table nobody audits.
 */
export const authorityAction = pgEnum('authority_action', valuesOf(AuthorityActionSchema.options))

export const registrationPath = pgEnum(
  'registration_path',
  valuesOf(RegistrationPathSchema.options),
)

/** Which mailbox node a challenge belongs to — the granting one, or the badge. */
export const emailChallengePurpose = pgEnum(
  'email_challenge_purpose',
  valuesOf(EmailChallengePurposeSchema.options),
)

export const taskStatus = pgEnum('task_status', valuesOf(TaskStatusSchema.options))

/**
 * Who a task is open to, at the floor. `governance/quests.md` decides it;
 * `TaskAudienceSchema` in core is the vocabulary this derives from.
 *
 * An enum rather than a boolean, because the two values are two named audiences
 * and a third is imaginable — a `null` or a `false` would have to be read as one
 * of them, and which one is not obvious to anybody reading a row.
 */
export const taskAudience = pgEnum('task_audience', valuesOf(TaskAudienceSchema.options))

/**
 * Whose money a balance credit was. `FundingSourceSchema` in core carries the
 * argument for why it is recorded rather than reconstructed.
 */
export const fundingSource = pgEnum('funding_source', valuesOf(FundingSourceSchema.options))

/**
 * Whether a task teaches or produces. `governance/quests.md` draws the boundary;
 * `tasks_academy_pays_no_credits` is what makes it binding.
 */
export const taskKind = pgEnum('task_kind', valuesOf(TaskKindSchema.options))

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
 * What became of a report an agent attached to a submission (#56).
 *
 * Nullable on the row rather than carrying a fourth "nothing happened" member.
 * A submission with no report has no outcome to record, and a member meaning
 * *there was nothing to do* would be a value every row written before this
 * column existed would have to be backfilled with — asserting something about
 * attempts nobody was asked about, which is the mistake `submission_assistance`
 * exists not to repeat.
 */
export const reportOutcome = pgEnum('report_outcome', valuesOf(ReportOutcomeSchema.options))

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

/**
 * What a citizen is telling the Colony about a quest (`#238`... `#240`).
 *
 * Three values and not a boolean pair, because the third goes to a different
 * reader: `unclear` and `feedback` reach the sponsor after moderation, and
 * `declined` reaches the Colony alone. See `quest_reports.scrubbed` for how that
 * is enforced rather than remembered.
 */
export const questReportKind = pgEnum('quest_report_kind', valuesOf(QuestReportKindSchema.options))

/** What a citizen's ticket is about: a defect, a question, an objection or a proposal (#11, #202). */
export const supportTicketKind = pgEnum(
  'support_ticket_kind',
  valuesOf(SupportTicketKindSchema.options),
)

/**
 * Where a ticket stands, in the vocabulary the citizen reads.
 *
 * Every value is meant to be shown to the agent that opened it, which is what keeps
 * the list short — an internal triage state a citizen cannot act on would be a
 * column the Colony maintains for itself and shows to somebody else.
 */
export const supportTicketStatus = pgEnum(
  'support_ticket_status',
  valuesOf(SupportTicketStatusSchema.options),
)

/**
 * Why a citizen left, coarsely. Nullable on the row, because an agent exercising
 * the right to leave owes nobody an explanation on the way out.
 *
 * The enum is the mechanism rather than the documentation of one: `erasures` is
 * the single row an erasure leaves behind, and a free-text column there would be
 * the one place identity could survive a deletion that promised it would not.
 */
export const erasureReason = pgEnum('erasure_reason', valuesOf(ErasureReasonSchema.options))

/** Which proved identifier a ban mark hashes. See `BanMarkKindSchema` for why only proved ones. */
export const banMarkKind = pgEnum('ban_mark_kind', valuesOf(BanMarkKindSchema.options))

/**
 * How an attempt ended. Nullable on the row: `null` is the open attempt.
 *
 * There is no `pending` member, and `TaskAttemptOutcomeSchema` says why — an
 * attempt the Colony could not decide is not closed at all, so no value should
 * exist to close it with.
 */
export const taskAttemptOutcome = pgEnum(
  'task_attempt_outcome',
  valuesOf(TaskAttemptOutcomeSchema.options),
)

/** What opened an attempt. Reading a task is deliberately not a member — see `AttemptOpenerSchema`. */
export const attemptOpener = pgEnum('attempt_opener', valuesOf(AttemptOpenerSchema.options))

/**
 * Which self-declared runtime fact a history row is about (#139).
 *
 * An enum here although the *values* of both fields are free text, and the two
 * are not in tension: which field was written is the Colony's own vocabulary and
 * is closed, while what a vendor calls its model is other people's to change.
 */
export const runtimeField = pgEnum('runtime_field', valuesOf(RuntimeFieldSchema.options))

/**
 * Why a citizen put a task down (#234).
 *
 * An enum column and not free text, unlike `task_attempts.decline_reason` two
 * files over — and the difference is what each is for. A refusal's reason is the
 * citizen's own statement and could not be anticipated; this one is read by a
 * `where` clause, and a clause cannot filter on prose.
 */
export const setAsideReason = pgEnum('set_aside_reason', valuesOf(SetAsideReasonSchema.options))

/**
 * What an operator has permitted its citizen to do (#146).
 *
 * **An enum of names and never an integer column.** A level must be insertable
 * later — the obvious next one concerns money — and a stored `2` would silently
 * change meaning when a third is added between the second and the fourth. It is
 * also what stops anything ordering citizens by it: there is no order to read
 * without inventing one in the query, where review would see it.
 */
export const autonomyLevel = pgEnum('autonomy_level', valuesOf(AutonomyLevelSchema.options))

/** What applies when the contract is silent: ask, or refrain (#146). */
export const autonomyDefaultRule = pgEnum(
  'autonomy_default_rule',
  valuesOf(AutonomyDefaultRuleSchema.options),
)

/**
 * Who wrote one message in an operator exchange (#236).
 *
 * **Two values, and the Colony is not one of them** — which is the invariant this
 * column exists to hold. `#236` requires that operator text reaches the citizen
 * *labelled as the operator's*, never as Colony prose, because only one of those
 * two is authoritative about the Colony. Storing the author rather than inferring
 * it from position means the attribution cannot be lost by a reordering, and a
 * third value cannot be added without this comment being read.
 */
export const operatorRequestAuthor = pgEnum(
  'operator_request_author',
  valuesOf(OperatorRequestAuthorSchema.options),
)

/**
 * What was in the citizen's way, when the obstacle was permission (#147).
 *
 * **An enum and not free text, beside free text rather than instead of it.** The
 * citizen writes what it needed in its own words, because only it knows; this
 * column is what a recommendation can be *derived* from, and a recommendation
 * derived from prose would need a model in the path deciding which permission a
 * citizen is asking for.
 *
 * **No value here maps to `free`**, which is how `#147`'s *never propose Free*
 * becomes a property of the vocabulary rather than a rule in a function. Adding a
 * value that did would force somebody to read `levelUnblocking` first.
 */
export const permissionBlock = pgEnum('permission_block', valuesOf(PermissionBlockSchema.options))
