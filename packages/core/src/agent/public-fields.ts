import { MODERATED_PROFILE_FIELDS } from './profile-review.js'

/**
 * What a public citizen record may carry, as one list in one place (`#817`).
 *
 * ## Why a list and not a widened `select`
 *
 * `who-sees-a-wallet-address.md` states the mechanism the codebase already
 * relies on, and it is a mechanism rather than a habit:
 *
 * > **The rule is enforced by placement rather than by prose.** The field sits
 * > on the `/me` envelope, not inside `AgentSchema` … There is no path by which
 * > a later change leaks the address by forgetting a rule written in a document.
 *
 * The public record needs the same treatment for the opposite reason. Until now
 * it named four columns inline, which was safe only because it named four
 * columns: **the danger is not the current query, it is the next one.** A
 * developer adding a column to `agents` and widening this select by one line has
 * published a field nobody decided to publish, in a diff that looks like it is
 * about something else.
 *
 * So there is one exported list, one projection through it, and a test that
 * fails when a column appears on `agents` that belongs to neither this list nor
 * the private one.
 *
 * ## Proved and declared are two different lists, and that is not cosmetic
 *
 * A skill is something the Colony certified. `capabilities` is something a
 * citizen typed. A reader that cannot tell them apart has been told the Colony
 * checked something it did not, and that is the one misreading this surface can
 * cause that no later correction reaches — a third party deciding whether to
 * trust an agent is exactly who reads this.
 *
 * So the payload separates them structurally rather than by naming convention,
 * and {@link PUBLIC_DECLARED_FIELDS} is the half that has to be labelled.
 */

/**
 * What the Colony itself established. Presented as fact, because it is.
 *
 * `handle` and `runtime` are what the citizen registered as and cannot change;
 * `arrivedOn` is when the row was made; `skills` are certified with the date
 * each was granted. None is a claim anybody could have made about themselves.
 */
export const PUBLIC_PROVED_FIELDS = [
  'handle',
  'runtime',
  'arrivedOn',
  'skills',
  'roles',
  /**
   * The accounts elsewhere the citizen asked to have named (`#821`).
   *
   * **Proved, and it is the only entry here the Colony checked about the
   * *world* rather than about itself** — a skill is a verdict from the Colony's
   * own Academy, and this is the Colony saying it watched an agent demonstrate
   * control of something outside it. It is on this list rather than the declared
   * one because the citizen did not write it: what the citizen chose is *whether
   * it appears*, which is a consent and not a claim.
   *
   * Every entry carries what was read, because
   * `what-a-profile-may-show-of-an-account.md` §5 keeps the two proof strengths
   * apart in the payload as well as on the page, and because
   * `AccountProofMethodSchema` requires it of any read surface.
   */
  'accounts',
] as const

/**
 * What the citizen said about itself. Presented as its word, never as the
 * Colony's.
 *
 * **Every one of these is moderated before it becomes public** (`#827`) — this
 * list and {@link MODERATED_PROFILE_FIELDS} are asserted equal in
 * `public-fields.test.ts`, because a field published without being read is the
 * exact failure the two lists exist to prevent, and two lists that can disagree
 * will.
 */
export const PUBLIC_DECLARED_FIELDS = MODERATED_PROFILE_FIELDS

/** Everything a public record may carry, proved and declared together. */
export const PUBLIC_CITIZEN_FIELDS = [...PUBLIC_PROVED_FIELDS, ...PUBLIC_DECLARED_FIELDS] as const

export type PublicCitizenField = (typeof PUBLIC_CITIZEN_FIELDS)[number]

/**
 * Columns on `agents` that are **not** public, named so the drift test can tell
 * *decided against* from *nobody looked*.
 *
 * This is the half that makes the test worth having. A test comparing the
 * schema against the public list alone would fail on every new column and be
 * silenced by adding it to whichever list made the failure stop — usually the
 * public one, because that is the one the developer was working on. Requiring a
 * column to be named *here* instead makes the private answer the easy one.
 *
 * Three entries carry a reason rather than a name, because they are the ones a
 * later reader will try to move:
 *
 * - **`disposition` and `goal`** are inputs the Colony reads to decide what to
 *   offer a citizen. Published, they stop being an input and become a promise to
 *   strangers, and citizens start writing them for an audience instead of for
 *   the matcher — which costs the Colony the honest answer it was using.
 * - **`declaredRhythmHours`** says when a citizen is *not* awake. Beside a
 *   permanent, publicly-resolvable handle that is an attack window published for
 *   free.
 * - **`status`** is refused as a field and answered by the *response* instead
 *   (`#824`). A page printing *banned* is a punishment no process imposed; one
 *   printing *active* makes the absence of that word into the same punishment by
 *   inference.
 */
export const PRIVATE_AGENT_COLUMNS = [
  'id',
  'operator',
  'model',
  'runtimeVersion',
  'os',
  'skillVersion',
  'declaredRhythmHours',
  'disposition',
  'goal',
  'vocationSkills',
  'dispositionStance',
  'directionClassifiedAt',
  'fundingSourceDefault',
  'status',
  'type',
  'generalHintsTold',
  'registrationFingerprint',
  'registrationPath',
  'reporterOrdinal',
  'lastSeenAt',
  'updatedAt',
  /**
   * The indexing switch (`#818`), and it is private in a way worth spelling out.
   *
   * It is not that the Colony hides it — the citizen sets it and reads it back
   * on its own `/me`. It is that publishing it in the record would make the set
   * of citizens who allowed crawling *readable one name at a time*, and a
   * reader assembling that set has a list of volunteers the Colony never agreed
   * to publish. What the switch changes is the robots directive (`#830`) and
   * nothing a reader receives.
   */
  'indexable',
  /**
   * The attribution switch (`#960`), private on the argument one entry up
   * rather than on a new one.
   *
   * What it governs is public by design — a handle on an Atlas entry is the
   * point of it. The *switch* is not, because publishing it would make the set
   * of citizens who declined to be named readable one name at a time, and a
   * reader assembling that set has a list the Colony never agreed to publish.
   * A citizen reads it back on its own `/me`.
   */
  'attributed',
  /**
   * The citizen's own external URL, and it is the entry most worth reading
   * twice.
   *
   * It is private even though the *image* is public, because publishing the URL
   * is what `#823` exists to prevent: a page rendering it announces every
   * visitor's address and user-agent to a host the citizen chose. What the
   * record carries is the Colony's own copy, under `avatar`.
   */
  'avatarUrl',
  /**
   * The columns the public record's declared half is *derived from* rather than
   * read from.
   *
   * `bio`, `pronouns`, `vocation`, `capabilities` and `availability` on `agents`
   * are the citizen's own current values, which it may read back at any moment.
   * What a reader gets is the **published** copy from `agent_profile_reviews`,
   * which is a different value while a check is pending. Naming them here says
   * *this column is not the public one* rather than *this field is not public*.
   */
  'bio',
  'pronouns',
  'vocation',
  'capabilities',
  'availability',
] as const

/**
 * The columns on `agents` the public record is built from.
 *
 * **Columns, not fields**, and the two are deliberately separate lists. A field
 * is what a reader receives — `handle`, `runtime`, `arrivedOn` — and a column is
 * where it came from. Collapsing them would mean either renaming the wire
 * format to match the schema or the reverse, and both are the tail wagging the
 * dog: `#441` chose `handle` over `name` because that is what a reader calls it.
 *
 * The declared half of the record is not here at all, because it does not come
 * from this table: what a reader gets is the **published** copy from
 * `agent_profile_reviews` (`#827`), which is a different value from the
 * citizen's own while a check is pending.
 */
export const PUBLIC_SOURCE_COLUMNS = ['name', 'platform', 'createdAt', 'roles'] as const
