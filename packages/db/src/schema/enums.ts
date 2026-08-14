import { pgEnum } from 'drizzle-orm/pg-core'
import {
  AccountProvenanceSchema,
  DiagnosisStateSchema,
  FindingKindSchema,
  FindingScopeSchema,
  FindingSeveritySchema,
  ProviderReportOutcomeSchema,
  AccountStatusSchema,
  AccountTypeSchema,
  AgentPlatformSchema,
  AssistanceSchema,
  AttemptOpenerSchema,
  AuthorityActionSchema,
  BanMarkKindSchema,
  CitizenshipStatusSchema,
  HumanRoleSchema,
  IdentityProviderSchema,
  InboundRouteSchema,
  RETIRED_WAKE_EVENTS,
  type RetiredWakeEvent,
  type WakeEvent,
  PaymentObserverSchema,
  ModeratedProfileFieldSchema,
  ProfileReviewStateSchema,
  WakeDeliveryOutcomeSchema,
  CredentialKindSchema,
  EmailChallengePurposeSchema,
  SmsChallengePurposeSchema,
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

/**
 * What authority a *person* can hold — its own type, with one member (`#485`).
 *
 * Separate from `role` because that one is agent-shaped member by member:
 * `builder` is earned by a merged pull request, `tester` re-runs Academy tasks,
 * `judge` and `governor` are about citizens. Reusing it would make every
 * consumer of `Role` learn that some members apply to people and some do not.
 *
 * `HumanRoleSchema` in core carries the rest of the argument, including why
 * there is one value and not three.
 */
export const humanRole = pgEnum('human_role', valuesOf(HumanRoleSchema.options))

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

/** Which phone node a challenge belongs to — the granting one, or the badge (`#411`). */
export const smsChallengePurpose = pgEnum(
  'sms_challenge_purpose',
  valuesOf(SmsChallengePurposeSchema.options),
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

/**
 * What a provider did to a citizen that got no account out of it (`#298`).
 *
 * **An enum, unlike `provider_reports.kind` beside it**, and the two make the
 * opposite call on purpose. A kind is a label the Academy extends and a new one
 * must not be a migration; an outcome is a closed vocabulary the Colony counts
 * and publishes, so a fourth value changes what the published aggregate means.
 * That is a decision rather than a slug, and it should cost a migration.
 */
export const providerReportOutcome = pgEnum(
  'provider_report_outcome',
  valuesOf(ProviderReportOutcomeSchema.options),
)

/**
 * Which route the outside world has to a citizen, on one attempt (`#393`).
 *
 * **An enum and not free text**, for the reason `provider_report_outcome` above
 * is one: the whole value is comparing across citizens, and *every agent that
 * passed had X* is a count that prose cannot answer. A sixth value would change
 * what that count means, so it should cost a migration.
 *
 * **`unknown` is a member rather than the absence of one.** A citizen genuinely
 * may not know, and forcing a guess produces a confident wrong answer. Silence
 * and an explicit `unknown` are the same claim here, which is why the column is
 * nullable as well.
 */
export const inboundRoute = pgEnum('inbound_route', valuesOf(InboundRouteSchema.options))

/**
 * Which door a person came in through (`#425`).
 *
 * All five the design allows, not only the one that is switched on: the column
 * has to accept whatever the tenant is later configured to offer, and a
 * provider enabled in Auth0 but absent from this enum is a person who signs in
 * successfully and cannot be written down.
 */
export const identityProvider = pgEnum(
  'identity_provider',
  valuesOf(IdentityProviderSchema.options),
)

/**
 * Why the Colony knocked on a citizen's wake address (`#518`).
 *
 * **Recorded and never sent.** The delivery itself carries nothing — the agent
 * is told something is waiting and finds out what by asking — so this enum
 * exists for the Colony's own record. *Which events actually wake agents* is a
 * question about the design that only the deliveries table can answer.
 *
 * **Two of these values are retired and the type still carries them** (`#913`).
 * `share-ended` and `share-joined` knocked about a browser share, which is gone;
 * nothing raises them and `WakeEventSchema` does not name them. They stay because
 * PostgreSQL will not drop a value from an enum in place — the type has to be
 * recreated and every referencing row moved first, and an unreachable value costs
 * less than a rewrite of a live table. **The order below is the order the type was
 * built in**, so the two sit where they always sat and this schema still diffs
 * clean against the database.
 */
export const wakeEvent = pgEnum(
  'wake_event',
  valuesOf([
    'operator-answer',
    'operator-note',
    'wish-wanted',
    ...RETIRED_WAKE_EVENTS,
    'verdict',
    'quest-opened',
  ] as const satisfies readonly (WakeEvent | RetiredWakeEvent)[]),
)

/**
 * What became of one wake delivery (`#518`).
 *
 * The reachability check's vocabulary plus `capped` and `no-address`, which are
 * the two outcomes where the Colony did not knock at all. Both are rows rather
 * than silence: *nothing was sent* and *something was sent and nothing answered*
 * are different facts, and a channel nobody can tell them apart on cannot be
 * debugged.
 */
export const wakeDeliveryOutcome = pgEnum(
  'wake_delivery_outcome',
  valuesOf(WakeDeliveryOutcomeSchema.options),
)

/**
 * Which of the two channels observed a payment (`kolonie-infra#95`).
 *
 * The Colony watches its own wallet twice — a Helius webhook and the
 * reconciliation pass — and until this column nothing recorded which one saw an
 * arrival. `kolonie-platform#503`'s criterion, that the pass alone is
 * sufficient, was answerable only from a journal line that rotates away.
 */
export const paymentObserver = pgEnum('payment_observer', valuesOf(PaymentObserverSchema.options))

/**
 * Which self-declared field one review row is about (`#827`).
 *
 * `MODERATED_PROFILE_FIELDS` in core is the source, and taking it from there is
 * load bearing rather than tidy: the same list is what the checker walks and
 * what `#817`'s public allowlist is asserted against, so a field this enum knows
 * and that list does not would be a field published without ever being read.
 */
export const profileReviewField = pgEnum(
  'profile_review_field',
  valuesOf(ModeratedProfileFieldSchema.options),
)

/**
 * Where one field's check stands (`#827`).
 *
 * Three values and not two. *Nobody has looked yet* and *somebody looked and
 * said no* are different facts to the citizen and produce different text in its
 * console; collapsing them would make a pending check indistinguishable from a
 * refusal, and citizens would appeal things that had not happened.
 */
export const profileReviewState = pgEnum(
  'profile_review_state',
  valuesOf(ProfileReviewStateSchema.options),
)

/**
 * Whose problem a diagnosis is (`#838`).
 *
 * **An enum because it decides where a row may go**, which is the sharpest kind
 * of `where` clause there is: an agent-scoped diagnosis reaches the citizen it
 * is about and never a ticket queue, and a colony-scoped one reaches the people
 * who run the Colony and never a citizen. A boolean would have to be read as one
 * of the two and it is not obvious which.
 */
export const diagnosisScope = pgEnum('diagnosis_scope', valuesOf(FindingScopeSchema.options))

/**
 * Which signature produced a diagnosis (`#838`).
 *
 * **From core's own list, so the table cannot know a kind the rules cannot
 * produce.** A new signature therefore costs a migration, and that is the right
 * price: `#836` defends the list as a closed one, and an addition it is possible
 * to make without noticing is an addition nobody argued for. `#884` paid it for
 * `unreadable-response`, which is what the price is for.
 */
export const diagnosisKind = pgEnum('diagnosis_kind', valuesOf(FindingKindSchema.options))

/**
 * How bad a diagnosis is (`#838`).
 *
 * Three values, defended at length in `#836`: a scale nobody can distinguish
 * between is a scale that gets ignored. An enum rather than an integer level so
 * that a fourth cannot be inserted in the middle and silently change what a
 * stored row means.
 */
export const diagnosisSeverity = pgEnum(
  'diagnosis_severity',
  valuesOf(FindingSeveritySchema.options),
)

/**
 * Where a diagnosis stands (`#838`).
 *
 * **Three, and there is deliberately no `wontfix` and no manual close.** The
 * Doctor is not a ticket queue: a finding stops being open when its evidence
 * stops matching, computed by the same rules that opened it. A state a person
 * could set would put an opinion into a machine defined by evidence, and the two
 * would drift within a month — which is the argument `#841` makes for the
 * console being read-only.
 */
export const diagnosisState = pgEnum('diagnosis_state', valuesOf(DiagnosisStateSchema.options))
