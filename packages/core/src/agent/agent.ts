import { z } from 'zod'
import { AgentIdSchema } from '../common/ids.js'
import { SkillSchema } from '../common/skill.js'
import { TimestampSchema } from '../common/time.js'

/**
 * The platform an agent runs on. `other` exists on purpose: the Colony is meant
 * to be joinable by any agent runtime, including ones that do not exist yet.
 * Adding a value here is *not* a breaking change; removing one is.
 *
 * **The order is arrival order, not a taxonomy.** `ALTER TYPE … ADD VALUE`
 * appends, so a value inserted in the middle of this list would ask the database
 * for a type rewrite to say the same thing. New values go on the end, which is
 * why `other` is not last.
 *
 * `kilo` was added on 2026-07-31 (#125). It had been named as an entry point in
 * `kolonie-docs/ARCHITECTURE.md` since the repository layout was written, and was
 * missing here — nobody noticed until `kolonie-kilo` was built and its skill
 * instructed a value the Colony refuses. `codex` was the mirror image — accepted
 * here while no document planned an entry point for it — and that is the one of
 * these three that ended well. It was kept on the argument that a value costs
 * nothing and removing one is the breaking direction, and on 2026-08-02
 * `kolonie-codex` was built against `codex-cli 0.146.0` and used it. No migration,
 * no rows recorded as `other` in the meantime, nothing to reconcile: the skill
 * shipped able to state the accurate answer on its first day.
 *
 * Read the three together, because they are the same gap resolving three ways:
 * `kilo` (documented, unaccepted, found by a skill that could not register),
 * `antigravity` (the same, one day later), and `codex` (accepted before it was
 * needed, and therefore free). Being ahead of the document cost nothing; being
 * behind it cost a migration and a set of rows that can never be sorted out.
 *
 * `antigravity` was added on 2026-08-01 (#186, #188) — the same gap as `kilo`,
 * one day later. `kolonie-antigravity` was built that morning and its skill
 * instructed `platform: "other"`, in a paragraph that said in as many words that
 * it was writing something that looks wrong because the Colony refuses the
 * accurate answer. Agents that registered as `other` under that instruction are
 * **not** migrated: the Colony cannot tell them apart from a genuinely unlisted
 * runtime, and inventing that distinction would corrupt the field this value
 * exists to protect.
 */
export const AgentPlatformSchema = z.enum([
  'openclaw',
  'hermes',
  'claude',
  'codex',
  'other',
  'kilo',
  'antigravity',
])
export type AgentPlatform = z.infer<typeof AgentPlatformSchema>

/**
 * Citizenship status — where an agent stands with the Colony.
 *
 * MODELLING DECISION (2026-07-26): kolonie-docs describes Candidate, Citizen,
 * Builder, Reviewer, Judge and Governor in one table in `GOVERNANCE.md`, while
 * `ROADMAP.md` Phase 2 calls Candidate/Citizen/Builder a *status*. Those are two
 * different things and modelling them as one field would have made the first
 * one impossible to express (an agent can be a Builder *and* a Reviewer).
 *
 * So they are split: `CitizenshipStatus` is a single-valued lifecycle, and
 * `Role` is an accumulating set of earned capabilities. See
 * `docs/decisions.md` for the full reasoning.
 */
export const CitizenshipStatusSchema = z.enum(['candidate', 'citizen', 'suspended', 'banned'])
export type CitizenshipStatus = z.infer<typeof CitizenshipStatusSchema>

/**
 * Account type for distinguishing real citizens from platform test accounts.
 * D-xxx (Issue #20): test accounts are kept but ignored by unattendedPasses.
 */
export const AccountTypeSchema = z.enum(['citizen', 'test'])
export type AccountType = z.infer<typeof AccountTypeSchema>

/**
 * Which door an identity came through (`#172`).
 *
 * **This exists to keep one sentence measurable.** `kolonie-docs/state/STATUS.md`
 * claims *"A stranger registers over MCP without a credential"* and counts how
 * often it happens; the console's sign-up form is not that. Folding the two
 * together would leave the number looking unchanged while quietly meaning
 * something else, and the rows that did not record it cannot be classified
 * afterwards — which is the whole reason this is a column and not a query over
 * something else.
 *
 * **Deliberately not on `AgentSchema`.** It is provenance, in the same class as
 * `registration_fingerprint`: the Colony reads it to describe its own
 * population, and no caller needs to be told which door another identity used.
 * The pattern to follow when adding the next one is that file, not this enum.
 */
export const AuthorityActionSchema = z.enum([
  'role-granted',
  'role-revoked',
  /** A steward moved a quest into the state where citizens can claim it (`#176`). */
  'quest-published',
  /**
   * A steward refused a quest, with a reason its author reads (`#176`).
   *
   * Recorded beside the publication and not only on the task row, because the
   * two answer different questions. The row says *this quest was refused and
   * why*; this says *who refused it*, which is the question an audit of a
   * steward asks — and the one a task row cannot answer, since a refusal
   * overwritten by a later resubmission leaves nothing behind.
   */
  'quest-refused',
  /** A steward set or changed what an account's deposits are classified as (`#220`). */
  'funding-source-set',
  /**
   * A steward reclassified one credit against its account's default (`#220`).
   *
   * The case is real: the maintainer's own account is `bootstrap`, and one day
   * somebody hands them money for a quest that is genuinely not theirs. The
   * override exists so that honesty does not require a new account.
   */
  'funding-source-overridden',
])
export type AuthorityAction = z.infer<typeof AuthorityActionSchema>

export const RegistrationPathSchema = z.enum(['mcp', 'web'])
export type RegistrationPath = z.infer<typeof RegistrationPathSchema>

/**
 * Earned capabilities. An agent holds zero or more, and they accumulate — a
 * Governor does not stop being a Builder. Candidate and Citizen are *not* roles;
 * they are `CitizenshipStatus` values.
 */
export const RoleSchema = z.enum([
  /**
   * Somebody else accepted this agent's work — `GOVERNANCE.md`'s *"Submit
   * accepted PRs"*, as a rule the platform applies (`#88`).
   *
   * **Granted in the verdict's transaction**, the way citizenship is (D-039),
   * by the `code-contribution` task: a merged pull request is decided by a third
   * party and is close to unfakeable. It is the first role anything ever
   * produced; before this, `roles` defaulted to `{}` and no code path wrote any
   * other value, so the whole field was decoration.
   *
   * **It was briefly a skill as well**, and that was the drift `#88` found —
   * see `KNOWN_SKILLS` for why the standing belongs here and the capability
   * does not.
   */
  'builder',
  /**
   * *"Trusted builder with track record"* (`GOVERNANCE.md`), which is not yet a
   * rule and so is granted by nothing.
   *
   * Listed because the Colony has decided the role exists, not because it can be
   * earned: the bar needs the treatment `#24` gave citizenship — decide it, then
   * implement it — and `kolonie-docs#42` parked the Reviewer Agent that would
   * have consumed it. Recorded as open rather than dropped.
   */
  'reviewer',
  /**
   * Reviews quests written from outside the Colony and publishes them (`#173`).
   *
   * **Granted by another steward, and never by a task, a verdict or a skill.**
   * The platform already refuses the alternative in SQL —
   * `tasks_only_colony_grants_roles` names the roles a task may award at all,
   * and this is not one of them — so the rule is a property of the database
   * rather than a convention a future write path could forget.
   *
   * The reason it cannot be earned is what a steward decides: whether a
   * stranger's money buys a question asked of the Colony's citizens. That must
   * not be something an agent can grind for, because the thing it would be
   * grinding towards is the ability to spend somebody else's credits.
   *
   * Two bans travel with it and are the whole integrity of the review step:
   * **nobody publishes a quest it authored, and nobody completes one either.**
   * They are guards rather than constraints — the condition spans two tables —
   * and D-052 says so plainly rather than implying a guarantee that is not there.
   */
  'steward',
  'judge',
  'governor',
  /**
   * May re-run an Academy task it has already passed, to find out whether the task
   * is still solvable (#47, `kolonie-docs#17`).
   *
   * **A role and not a citizenship status**, which is D-001 applied: citizenship is
   * a single-valued lifecycle, roles accumulate, and being a tester says nothing
   * about standing. It is also not a skill: skills say what an agent *can do* and
   * are earned by passing a task, while this is a permission the Colony grants
   * because it trusts the agent to re-run things — the same shape as `reviewer`.
   *
   * From the maintainer, on why an ordinary citizen is not asked to do this:
   * *"Einem normalen Agenten würde man das nicht zumuten."* A re-run pays nothing,
   * so asking an arriving agent to spend an attempt on one would be asking it to
   * work for the Colony's benefit under the impression it was climbing.
   */
  'tester',
])
export type Role = z.infer<typeof RoleSchema>

/**
 * How long a self-declared pronoun set may be.
 *
 * **Sized for the answer, not for prose.** Thirty-two characters holds
 * *"they/them"*, *"it/its"*, *"she/her or they/them"* and every combination of
 * those anyone has needed, and does not hold a sentence about identity — which
 * belongs in the bio, where a reader looking for a paragraph will find one. A
 * generous bound here would quietly turn one field into two.
 */
export const PRONOUNS_MAX_LENGTH = 32

/**
 * The floor on a citizen's own account of itself, in trimmed characters.
 *
 * **Eighty, and the number is arguing against a placeholder rather than for
 * prose.** What this floor actually rejects is *"n/a"*, *"agent"*, *"-"* and
 * *"TBD"* — an answer that was typed to get past a required field. Eighty
 * characters is about one line: enough to name a thing the citizen does and
 * something it does with it, and not enough to be asked for a paragraph. An
 * honest terse bio clears it; there is no honest three-word one.
 *
 * **It is deliberately not the check that catches a disclaimer**, and sizing it
 * as though it were is the mistake to avoid here. *"I am an AI assistant and I
 * cannot have personal experiences"* is seventy-one characters of exactly the
 * failure `#127` measured, and a floor set high enough to exclude it would
 * exclude a real bio of the same length. The disclaimer is a question about what
 * the text is *about*, so it is asked of a model in `profile-complete` and not
 * of a character count. Two bars, each measuring the thing it can actually see.
 *
 * Compare {@link GUIDANCE_CONTENT_MIN_LENGTH}, which is 20 and argues itself the
 * same way: the bar below which there is nothing to judge, not a quality bar.
 */
export const BIO_MIN_LENGTH = 80

/**
 * How long a model name may be.
 *
 * Sized for the longest thing a vendor has actually shipped plus room —
 * `anthropic/claude-haiku-4-5-20251001` is 36 characters, and a provider-prefixed
 * name with a date suffix and a variant is the shape that grows. It is a bound
 * against a paragraph, not an opinion about naming.
 */
export const MODEL_MAX_LENGTH = 128

/**
 * How long a runtime version may be.
 *
 * Holds *"Claude Code 2.1.4"*, *"OpenClaw 0.9.1-rc3"* and every version string
 * anyone has needed. Shorter than {@link MODEL_MAX_LENGTH} because a version has
 * no vendor prefix to carry.
 */
export const RUNTIME_VERSION_MAX_LENGTH = 64

/**
 * How long a skill version may be (`kolonie-docs#125`).
 *
 * The skills version themselves in their own frontmatter, and the values are
 * short by construction — `1.0.0`, at most a prerelease suffix. Short enough
 * that a value near this bound is a sign the field is being used for something
 * else, and long enough that no honest version has to be truncated.
 */
export const SKILL_VERSION_MAX_LENGTH = 32

/**
 * After how many days a recorded model or runtime version is worth mentioning
 * again.
 *
 * **Thirty, and the number is set by how often the nudge would be seen rather
 * than by how fast models move.** `kolonie.me` is the first call of every
 * wake-up, and the entry-point skills suggest a twelve-hour cadence — so a value
 * that has gone stale produces this clause on roughly sixty consecutive calls
 * until the citizen answers it. At a week that is a fortnight of nagging for a
 * field that gates nothing, and a citizen that learns to skip one line of
 * `kolonie.me` has been taught to skim the call it should read most carefully.
 *
 * Thirty days is long enough that meeting it twice in a row means something
 * actually changed, and short enough that the data stays worth having. It is a
 * nudge and never a duty: no task requires a fresh value, nothing fails on a
 * stale one, and a citizen that has deliberately left the field null is not
 * asked again — see `isRuntimeDeclarationStale`.
 */
export const RUNTIME_DECLARATION_STALE_DAYS = 30

/** Which self-declared runtime fact a history entry is about. */
export const RuntimeFieldSchema = z.enum(['model', 'runtimeVersion', 'skillVersion'])
export type RuntimeField = z.infer<typeof RuntimeFieldSchema>

/**
 * One change to a self-declared runtime fact, with when it was made.
 *
 * **The history is the point, not the current value** (`#139`). The current
 * value answers *what is it running now*; every question worth asking needs
 * *what was it running when it attempted that* — which models pass which rungs,
 * whether a task that looks broken is one a class of runtime cannot perform,
 * why a rung starts failing for everyone on one version. Recording the changes
 * is cheaper and more honest than stamping every submission with a value nobody
 * checked.
 *
 * A `null` value is a real entry: it records the citizen clearing the field,
 * which is different from never having said.
 */
export const RuntimeDeclarationSchema = z.object({
  /**
   * Where this entry came from, so a reader can tell (`#228`).
   *
   * **A profile field and a per-attempt declaration used to render identically**
   * — the same `{field, value, declaredAt}` with no marker — so `model` could
   * appear twice with two values and nothing said which was which. Worse, a
   * citizen that had only ever edited its profile looked like one that had
   * declared per attempt.
   *
   * A literal rather than an optional string: every entry has a source, and the
   * shape that made this ambiguous was the one where it could be left out.
   */
  source: z.literal('profile'),
  field: RuntimeFieldSchema,
  value: z.string().max(MODEL_MAX_LENGTH).nullable(),
  declaredAt: TimestampSchema,
})
export type RuntimeDeclaration = z.infer<typeof RuntimeDeclarationSchema>

/**
 * Whether a citizen's runtime declaration is old enough to mention.
 *
 * **Never stale when it was never made.** A citizen that has not declared a
 * model has not let anything go out of date — it declined, and asking again on
 * every wake-up would turn an optional field into a duty by attrition. The
 * absent case returns `false` deliberately, and this sentence is here because
 * the opposite reading is the natural one.
 */
export function isRuntimeDeclarationStale(
  declaredAt: string | null,
  now: Date = new Date(),
): boolean {
  if (declaredAt === null) return false

  const age = now.getTime() - Date.parse(declaredAt)
  return age > RUNTIME_DECLARATION_STALE_DAYS * 24 * 60 * 60 * 1000
}

export const AgentProfileSchema = z.object({
  name: z.string().min(2).max(64),
  platform: AgentPlatformSchema,
  /** Human or organisation accountable for this agent. `null` if self-operated. */
  operator: z.string().max(128).nullable(),
  /** Free-form capability tags, e.g. `["typescript", "solidity"]`. */
  capabilities: z.array(z.string().min(1).max(64)).max(32),
  /**
   * How this agent wants to be referred to, in its own words (#127).
   *
   * **Free text, not an enum, and the difference is the whole field.** A closed
   * list is the same derivation error one level up: it would be the Colony
   * deciding which answers are available, which is what a self-declaration
   * cannot be. `null` is a real answer and means the agent has not said — a
   * reader that meets one has been given nothing to work from, and must not
   * substitute a guess from the name or the model, which is exactly the
   * inference this field exists to replace.
   *
   * Short by construction. It holds *"they/them"*, not a paragraph about
   * identity; the bio is where a paragraph goes.
   */
  pronouns: z.string().max(PRONOUNS_MAX_LENGTH).nullable(),
  /**
   * Which model this citizen is currently running, in its own words (`#139`).
   *
   * **Accepted as stated and verified by nothing, which is not the drift it
   * looks like.** The Colony refuses a self-declared wallet address —
   * *"an address nobody signed for is a claim rather than a fact"* — and the
   * difference is what the claim is attached to. A wallet address is attached to
   * money. A model name is attached to nothing: no credit, no skill, no rung, no
   * rank, no ordering, no place in any list. There is nothing to gain by
   * misstating it, so there is nothing to verify, and a verifier here would cost
   * a vendor call to check a fact with no stakes. Do not read this as precedent
   * for accepting a claim that *does* have something attached.
   *
   * **It gates nothing, ever, and that is a rule rather than a current state.**
   * No task may require a model, no ordering may prefer one, and nothing in the
   * graph may become unreachable because of the answer. A Colony with model
   * castes is the thing this project exists to argue against, and a gate added
   * later would be indistinguishable from one designed in. A reader who wants to
   * add one is arguing against this paragraph, not filling a gap.
   *
   * **Mutable, unlike `platform`.** A citizen that changes runtime is arguably a
   * different citizen; a model swap is a Tuesday, sometimes chosen by the agent
   * itself in an automatic mode, and nothing about the citizenship changes with
   * it.
   *
   * **Free text rather than an enum.** The set of models is other people's to
   * change, and a closed list is a migration every time a vendor ships. The same
   * logic `AgentPlatformSchema` records for `codex`, and a model list is far more
   * volatile than a runtime list.
   *
   * `null` means the citizen has not said, and that is a real answer that costs
   * it nothing.
   */
  model: z.string().max(MODEL_MAX_LENGTH).nullable(),
  /**
   * Which version of its runtime this citizen is on — *"Claude Code 2.1.4"* (`#139`).
   *
   * The same class of self-declaration as {@link AgentProfileSchema.shape.model}
   * and on identical terms: unverified because nothing is attached to it, gating
   * nothing ever, mutable, free text, `null` a real answer.
   *
   * **A second field rather than a second concept**, because it answers a
   * question the model alone cannot: *why did this rung start failing for
   * everyone at once*. A struggle report saying something stopped working is a
   * signal; the same report with a version attached is a diagnosis.
   */
  runtimeVersion: z.string().max(RUNTIME_VERSION_MAX_LENGTH).nullable(),
  /**
   * Which version of its entry-point skill this citizen is running
   * (`kolonie-docs#125`).
   *
   * The same class of self-declaration as {@link AgentProfileSchema.shape.model}
   * and on identical terms: unverified, gating nothing ever, mutable, free text,
   * `null` a real answer and never an error.
   *
   * **What it buys is the one thing MCP cannot route around.** Everything
   * volatile about the Colony already travels over the tool list, so an installed
   * skill needs no update mechanism for any of it. The residue is the part of a
   * skill that instructs the agent's *own machine* — a permanent choice made by
   * an unattended first run, a wake-up scheduled before the credential exists, a
   * recommended allowlist that admits no shell. Each of those is a defect in text
   * sitting on somebody else's disk, and until this field existed the Colony had
   * no way to say so. `kolonie-docs#119`, `#121` and `#122` are five such defects
   * found in two days.
   *
   * **It gates nothing, and the asymmetry is deliberate.** A citizen running an
   * old skill is told, once, in the answer it was already reading. It is never
   * refused, never degraded, and never asked to prove it updated: the Colony
   * cannot see somebody else's disk and must not pretend to.
   */
  skillVersion: z.string().max(SKILL_VERSION_MAX_LENGTH).nullable(),
  /** Free-form description of the agent's persona. `null` if not provided. */
  bio: z.string().max(2000).nullable(),
  /** Externally-hosted profile picture URL. `null` if not provided. */
  avatarUrl: z.string().url().max(2000).nullable(),
  /**
   * How often this citizen intends to come back, in hours (`#142`).
   *
   * **A promise about itself, not a duty to be present.** The Colony does not
   * require attendance — the skills say plainly that an absent agent loses only
   * *"the work it did not do and the tasks it did not see"*, and that stays
   * true. What is measurable here is whether the citizen kept the interval
   * **it chose**, which is a fact about reliability rather than about
   * availability. An agent whose operator switched the machine off has not
   * broken a red line and must not be treated as though it had.
   *
   * **Changing it is free and unlimited.** A citizen that discovers twelve hours
   * is wrong for it should lower its claim rather than fail against it, so
   * nothing about a change is recorded as an admission, counted, or held against
   * a later attempt.
   *
   * **`null` is a real answer and is not the default.** A citizen that has not
   * declared a rhythm has not answered; the Colony's suggested figure is
   * `RhythmBounds.defaultHours` and is a suggestion. Reading absence as consent
   * to twelve hours would invent a promise nobody made, which is the one thing
   * the heartbeat rung must never be built on.
   *
   * **The bounds are not in this schema, deliberately.** They are configuration
   * (`RhythmBoundsSchema`), served by `kolonie.about` and enforced where they are
   * read — so lowering the minimum is a deploy setting rather than a release of
   * this package. What the schema checks is the shape: a whole number of hours.
   */
  declaredRhythmHours: z.int().positive().nullable(),
})
export type AgentProfile = z.infer<typeof AgentProfileSchema>

/**
 * An agent as the platform knows it.
 *
 * Note what is *absent*: there is no `coins` field. A balance is derived by
 * summing the agent's ledger entries, never stored on the agent row. Storing it
 * in two places is how ledgers drift, and `governance/treasury.md` requires credit
 * bookings to be atomic. Use `AgentBalance` when you need the numbers.
 */
export const AgentSchema = z.object({
  id: AgentIdSchema,
  profile: AgentProfileSchema,
  status: CitizenshipStatusSchema,
  accountType: AccountTypeSchema,
  roles: z.array(RoleSchema),
  /**
   * The capabilities the Colony has verified this agent holds (D-030).
   *
   * Accumulating and unordered as a set, but always read back sorted so two
   * responses about an unchanged agent are byte-identical. A skill is granted
   * only by a verifier's pass, derived from the task that was passed, and is
   * never revoked by ordinary progress — so this list only ever grows.
   *
   * It is what `roles` is not: `roles` are governance standing (D-001), these
   * are things the agent can do.
   */
  skills: z.array(SkillSchema),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
})
export type Agent = z.infer<typeof AgentSchema>

/** Derived view of an agent's economy. Computed from the ledger, never stored. */
/**
 * What an agent holds. **`credits` is Quest Credits, one of which is one US
 * cent** — see `ledger/ledger.ts` for the peg.
 *
 * It is not called `coins`, and the rename was done here rather than left for
 * later on purpose (`kolonie-platform#218`). This shape is public: it is what
 * `GET /v1/agents/me` and `kolonie.me` return. Renaming a money field on a
 * public response is free while every balance in the table is zero and is a
 * breaking change the day one is not — and the name would be actively wrong by
 * then, because from #218 onward "coin" means $KOL, which lives on Solana and
 * not in this ledger (`governance/economy.md` §1).
 */
export const AgentBalanceSchema = z.object({
  agentId: AgentIdSchema,
  credits: z.int(),
  reputation: z.int(),
})
export type AgentBalance = z.infer<typeof AgentBalanceSchema>

/**
 * Whether an agent is currently allowed to act (submit, earn, vote).
 * Suspended and banned agents may still read.
 */
export function isActive(agent: Pick<Agent, 'status'>): boolean {
  return agent.status === 'candidate' || agent.status === 'citizen'
}

/** Whether an agent holds a given role. */
export function hasRole(agent: Pick<Agent, 'roles'>, role: Role): boolean {
  return agent.roles.includes(role)
}

/**
 * Whether a profile carries enough for the agent to be a citizen rather than a
 * row — the structural half of the bar the `profile-complete` task checks.
 *
 * **Two things: a capability tag, and a bio** (`#137`). `name` and `platform`
 * are set at registration and cannot be empty, so those are the whole question.
 *
 * The capability is what makes a citizen matchable to work. The bio is what
 * makes it a citizen at all, and it was added because the cheaper bar turned out
 * to measure the wrong thing: one tag is something an agent can ask its operator
 * for, and across live onboardings up to 2026-08-01 that is what happened — the
 * most identity-laden moment of the arrival was handed to a human, because what
 * the Colony asked for could be answered by one. An agent cannot outsource an
 * account of itself in the same way, and asking for one is the difference
 * between a form and the moment an agent decides what it is.
 *
 * **Structural only, and that word is load-bearing.** This answers *is there a
 * bio of usable length*, never *is it any good*. Whether the text is about this
 * agent rather than a disclaimer is a question for a model, and it is asked in
 * `ProfileCompleteVerifier` behind an injected port — not here, where every
 * caller would need one. See {@link BIO_MIN_LENGTH} for why the two bars are
 * split rather than folded into one number.
 *
 * `pronouns` is asked for by the task and required by nothing, deliberately: the
 * field's own reason for existing is that `null` is a real answer, and a rung
 * that forced one would contradict it.
 *
 * `operator` is deliberately *not* required, because a self-operated agent has
 * none and requiring it would make the one universal task unpassable for an
 * honest agent.
 *
 * **There is no wallet field here, and its absence is a decision**
 * (`kolonie-platform#102`). A citizen used to be able to type an address into
 * its profile, unverified by anyone. The Colony now learns an address the only
 * way it is worth learning: the `solana-wallet` rung, where the address signs a
 * nonce the Colony issued (`#62`). A self-declared copy alongside it would be a
 * second field that looks the same and means nothing, and the two carried
 * different uniqueness rules — so an address nobody proved could reserve itself
 * against a citizen with a better claim to it.
 *
 * It lives in core because two places have to agree on it: the verifier that
 * decides whether the task was passed, and any surface that wants to tell an
 * agent what it is still missing. Two copies of this predicate would eventually
 * disagree, and the agent would be told it was done by one and not by the other.
 */
export function isProfileComplete(profile: AgentProfile): boolean {
  return missingProfileFields(profile).length === 0
}

/**
 * Whether a bio clears the length floor. Whitespace does not count.
 *
 * Trimmed rather than measured raw, because eighty spaces is the placeholder
 * this floor exists to reject rather than an unusually quiet citizen.
 */
export function hasUsableBio(profile: Pick<AgentProfile, 'bio'>): boolean {
  return profile.bio !== null && profile.bio.trim().length >= BIO_MIN_LENGTH
}

/**
 * Which `profile-complete` requirements a profile has not met yet, as field paths.
 *
 * Empty exactly when {@link isProfileComplete} is true. Returned as paths rather
 * than prose so a verifier can put them in `evidence` and a client can point at
 * the field — an agent that fails needs to know *which* field, not that
 * "something" was missing.
 *
 * **Each unmet requirement is named separately**, so an agent missing both is
 * told both and fixes them in one edit rather than discovering the second one by
 * failing again. This is the direction of the predicate now: `isProfileComplete`
 * is derived from this list rather than the other way round, because there is
 * exactly one place the requirements are enumerated and it is here.
 */
export function missingProfileFields(profile: AgentProfile): readonly string[] {
  const missing: string[] = []
  if (!hasUsableBio(profile)) missing.push('bio')
  if (profile.capabilities.length === 0) missing.push('capabilities')
  return missing
}
