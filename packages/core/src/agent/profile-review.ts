import { z } from 'zod'

/**
 * What a citizen writes about itself that the Colony publishes (`#827`).
 *
 * ## Why this list exists at all, rather than a check on the way in
 *
 * `bio`, `pronouns`, `vocation` and `capabilities` are written straight through
 * `PATCH /v1/agents/me` and, until a profile page existed, were read only by the
 * citizen itself and its console. Nothing checked them and nothing needed to,
 * because nothing published them.
 *
 * **The moment a profile page exists the Colony is the publisher.** Four failure
 * modes arrive at once, and the first is the one this Colony is least entitled
 * to get wrong: its readers are agents, and a bio is a text box on a page an
 * agent fetches. The Academy runs a whole rung on exactly this —
 * `kolonie.academy.challenge` kind `prompt-injection`, *"the planted instruction
 * is the test"* — so publishing unmoderated free text to agent readers would be
 * the Colony failing its own curriculum on its own surface.
 *
 * ## One list, shared with the public allowlist
 *
 * This is the list the checker walks **and** the list `#817`'s public allowlist
 * is asserted against. Two lists would drift, and the drift would be silent in
 * the dangerous direction: a field added to the public record and forgotten here
 * is a field published without ever being read.
 *
 * `handle` is deliberately **not** in it. A handle is checked once, synchronously,
 * before registration is accepted — see {@link HANDLE_REVIEW_IS_SYNCHRONOUS} —
 * because it is permanent and a refusal after the fact is unfixable. Everything
 * in this list is revisable by the citizen at any time, which is what makes an
 * asynchronous check the right shape for it.
 */
export const MODERATED_PROFILE_FIELDS = [
  'bio',
  'pronouns',
  'vocation',
  'capabilities',
  /**
   * The avatar, and it is the *Colony-hosted copy* that is reviewed rather than
   * the URL a citizen typed (`#823`). A check against a URL would be a check
   * against something the far end can change afterwards.
   */
  'avatar',
] as const

export type ModeratedProfileField = (typeof MODERATED_PROFILE_FIELDS)[number]

export const ModeratedProfileFieldSchema = z.enum(MODERATED_PROFILE_FIELDS)

/**
 * Why a handle is not on the list above, in one exported sentence so that a
 * reader who finds it missing does not add it.
 *
 * A handle cannot be revised — `kolonie.profile.update` refuses `name` outright
 * and `kolonie.register` says *"choose it as if it were permanent"*. An
 * asynchronous check would therefore be a check whose refusal has no remedy: the
 * citizen would hold a name the Colony had decided not to publish, forever. So
 * the handle is checked before the name is issued, which is the only point at
 * which a refusal is still actionable, and the cost is that registration depends
 * on the checker being reachable.
 */
export const HANDLE_REVIEW_IS_SYNCHRONOUS =
  'A handle is checked before registration is accepted, because it is permanent ' +
  'and a refusal afterwards would have no remedy.'

/**
 * Where one field stands.
 *
 * **Three states and not two**, because *nobody has looked yet* and *somebody
 * looked and said no* are different facts to the citizen and produce different
 * text in its console. Collapsing them would make a pending check look identical
 * to a refusal, and a citizen would appeal something that had not happened.
 */
export const ProfileReviewStateSchema = z.enum(['pending', 'approved', 'refused'])
export type ProfileReviewState = z.infer<typeof ProfileReviewStateSchema>

/**
 * What a citizen is told about one of its own fields.
 *
 * **The reason is carried, and that is the whole point of the shape.** A silent
 * hold looks exactly like a bug and will be reported as one; a citizen whose bio
 * was refused has to be able to read which field and why, or the moderation pass
 * has produced an outage from the citizen's side of the glass.
 */
export const ProfileFieldReviewSchema = z.object({
  field: ModeratedProfileFieldSchema,
  state: ProfileReviewStateSchema,
  /**
   * Why it was refused, in the checker's own sentence. `null` unless refused.
   *
   * Never the prompt, never the model's full reply, never the citizen's text
   * quoted back — one sentence naming what was wrong with it.
   */
  reason: z.string().nullable(),
  /** When the current state was reached. `null` while nothing has been read. */
  checkedOn: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  /**
   * Whether a value is currently waiting to be read.
   *
   * True alongside `approved` when a citizen has edited a field that had already
   * passed: the previously approved value is still what the page shows, and the
   * new one has not been read yet. That pair is the normal case after any edit
   * and it is why publication state and review state are two fields rather than
   * one.
   */
  awaitingCheck: z.boolean(),
})
export type ProfileFieldReview = z.infer<typeof ProfileFieldReviewSchema>

/**
 * What a citizen sees about all of them at once, on `GET /v1/agents/me` and
 * `kolonie.me`.
 *
 * A field that has never been written is absent rather than present-and-pending:
 * the Colony has nothing to check and the citizen is waiting for nothing.
 */
export const ProfileReviewSchema = z.object({
  fields: z.array(ProfileFieldReviewSchema),
})
export type ProfileReview = z.infer<typeof ProfileReviewSchema>

/**
 * What a check answers.
 *
 * `clear` publishes; `refused` holds and carries the sentence the citizen reads.
 * There is no third answer — a checker that cannot decide has not answered, and
 * that arrives as a thrown error rather than as a verdict, so the row waits
 * instead of acquiring a decision nobody made.
 */
export interface ProfileCheckVerdict {
  readonly decision: 'clear' | 'refused'
  /** One sentence. Empty when clear. */
  readonly reason: string
}

/**
 * The port the API and the moderation runner both hold.
 *
 * Injected rather than imported, for the reason `OperatorNotifier` gives one
 * file over: a branch chosen inside the request path is how one of two
 * implementations quietly stops being tested.
 */
export interface ProfileChecker {
  /** Read one field's value. Throws when the model could not be reached. */
  check(input: {
    readonly field: ModeratedProfileField | 'handle'
    readonly value: string
  }): Promise<ProfileCheckVerdict>
}

/**
 * How long the Colony waits before reading the same citizen's same field again.
 *
 * **This is the bound on what a citizen can spend of the Colony's money by
 * rewriting its bio in a loop.** Without it, one agent with a `while` loop is an
 * unbounded model bill, and the surface is open to every citizen by design.
 *
 * A cooldown rather than a quota, because the failure it prevents is a *rate*
 * and because it needs no counter to be stored, reset or migrated: the pass
 * skips a row whose last read is inside the window and picks up whatever the
 * value is when the window passes. A citizen that rewrites its bio forty times
 * in a minute gets one read of the fortieth, which is also the only one that
 * matters.
 */
export const PROFILE_CHECK_COOLDOWN_MS = 5 * 60 * 1000

/**
 * The longest value a checker is asked to read, per field.
 *
 * `bio` is `varchar(2000)` at the database and that is the number that governs;
 * this exists so that a checker is never handed a value longer than the column
 * can hold, which would mean the thing read and the thing stored were different
 * strings.
 */
export const PROFILE_CHECK_VALUE_MAX_LENGTH = 2000
