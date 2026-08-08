import { z } from 'zod'
import { AgentIdSchema, HumanIdSchema, HumanSessionIdSchema } from '../common/ids.js'

/**
 * A person with an account, which is a different kind of thing from a citizen
 * (`#425`, decided in `kolonie-docs#170`).
 *
 * ## What a human is not
 *
 * It is not a small agent. `kolonie-docs#170` settles what an account may hold,
 * and the list of what it may **never** hold is the load-bearing half: no
 * skills, no balance, no reputation, no standing, no votes. Those belong to
 * citizens, they are what makes a citizen's standing worth anything, and an
 * account that could accumulate them would be a second class of citizen arrived
 * at through a login rather than through the Academy.
 *
 * So the shape below is deliberately thin, and any pressure to widen it is a
 * question for `#170` rather than a change to this file. What a person *does*
 * with their account — which agents they operate, whether they hold a sponsor
 * identity — hangs off the account in its own tables and never becomes a column
 * here.
 *
 * ## Why the identities are their own list
 *
 * A person who signs in with GitHub today and Google tomorrow is one person, and
 * a `provider`/`subject` pair on the account itself would force a second account
 * on them the first time they used the other door. So identities are a list and
 * the account is what they point at.
 */
export const HUMAN_IDENTITY_PROVIDERS = [
  'github',
  'google',
  'apple',
  'facebook',
  'x',
  'password',
] as const

/**
 * The providers a person may arrive through.
 *
 * **The list is complete rather than current** (`#425`): the *column* has to
 * accept whatever the tenant is later configured to offer, and a provider
 * enabled in Auth0 but absent from this enum would be a person who signs in
 * successfully and cannot be written down. What is switched on is
 * `OFFERED_PROVIDERS` in `apps/api`, which is a shorter list and always will be.
 *
 * **`password` is the odd one and is named for the person rather than for a
 * vendor** (`#575`). The other five are somebody else's account that the person
 * already had; this one is an address and a password held in Auth0's own
 * database connection, so there is no company to name. Calling it `auth0` would
 * have named our supplier in a column that describes what the *person* did, and
 * would have to be renamed the day the supplier changes.
 */
export const IdentityProviderSchema = z.enum(HUMAN_IDENTITY_PROVIDERS)
export type IdentityProvider = z.infer<typeof IdentityProviderSchema>

/** One provider identity, as the Colony records it. */
export const HumanIdentitySchema = z.object({
  provider: IdentityProviderSchema,
  /**
   * The provider's own identifier for this person — Auth0's `sub`, minus the
   * connection prefix.
   *
   * **Never the email address.** An address changes hands and can be changed by
   * its owner; the subject is what the provider promises is stable, and it is
   * the half of the pair that makes *the same person came back* answerable.
   */
  subject: z.string().min(1).max(255),
  /**
   * The address the provider returned, where it returned one.
   *
   * `null` is an ordinary answer and not a failure: a GitHub account may keep
   * its address private, in which case the profile carries none or carries a
   * `@users.noreply.github.com` address no mail will ever reach. `#426` is
   * where that costs something, and it must not be papered over here.
   */
  email: z.email().nullable(),
  attachedAt: z.string(),
})
export type HumanIdentity = z.infer<typeof HumanIdentitySchema>

/**
 * What authority a *person* can hold (`#485`).
 *
 * ## Why this is not `Role`
 *
 * `Role` is agent-shaped, member by member. `builder` is earned by a merged pull
 * request, `tester` re-runs Academy tasks, `judge` and `governor` are about
 * citizens. None of them is a thing a person is, and reusing the enum would mean
 * every consumer of `Role` learning that some members apply to people and some
 * do not.
 *
 * ## Why one value and not three
 *
 * `AGENTS.md` §5 makes this argument about the `p3` label, which was deleted
 * rather than documented: a vocabulary invented ahead of the case it serves
 * stops meaning anything. A second human role is added when there is a second
 * thing to distinguish.
 *
 * ## Why the word is `maintainer`
 *
 * `AGENTS.md` and `kolonie-docs` already use it throughout for exactly this
 * person — *"that is a dashboard step and it is the maintainer's"*. Not
 * `steward`, which is taken and means something narrower; not `admin`, which the
 * Colony's vocabulary does not use anywhere.
 */
export const HumanRoleSchema = z.enum(['maintainer'])
export type HumanRole = z.infer<typeof HumanRoleSchema>

/** A person, and everything the Colony holds about them. */
export const HumanSchema = z.object({
  id: HumanIdSchema,
  createdAt: z.string(),
  lastSeenAt: z.string(),
  identities: z.array(HumanIdentitySchema),
  /**
   * What this person may do beyond what any signed-in person may (`#485`).
   *
   * Exposed the way `Agent.roles` is, and mirroring it deliberately rather than
   * inventing a second arrangement. Empty for everybody who has not been
   * granted something, which is everybody but one.
   */
  roles: z.array(HumanRoleSchema),
})
export type Human = z.infer<typeof HumanSchema>

/** One browser session, as its owner sees it in the list `#431` renders. */
export const HumanSessionSchema = z.object({
  id: HumanSessionIdSchema,
  startedAt: z.string(),
  lastUsedAt: z.string().nullable(),
  expiresAt: z.string(),
  /**
   * *Firefox on Linux*, and nothing finer.
   *
   * The question a person is answering is *do I recognise this*, which a browser
   * family answers and a full user-agent string does not — it answers a
   * different question and creates a record the Colony then has to hold.
   */
  browser: z.string().nullable(),
  /** A coarse location, never the address it was derived from (`#431`). */
  location: z.string().nullable(),
})
export type HumanSession = z.infer<typeof HumanSessionSchema>

/**
 * How long a human's session lives without being used.
 *
 * **Rolling, and shorter than the ceiling below.** Every authenticated request
 * pushes it out; silence lets it lapse. A session that never expires is the
 * durable bearer link `#257` warned about, wearing a cookie.
 */
export const HUMAN_SESSION_IDLE_MS = 14 * 24 * 60 * 60 * 1000

/**
 * And how long it lives at all, however busy it is (`#431`).
 *
 * The rolling window alone has no end: a session used once a week is a session
 * that lasts forever, and *forever* is the property that makes a stolen cookie
 * worth stealing. Thirty days is long enough that a person is not signing in
 * every week and short enough that a credential taken today is worthless within
 * the month.
 */
export const HUMAN_SESSION_CEILING_MS = 30 * 24 * 60 * 60 * 1000

/**
 * How long the Colony waits for a person to come back from the provider.
 *
 * The window between the redirect out and the callback in. Ten minutes is the
 * length of a slow login with a password manager and a second factor, and it is
 * the whole lifetime of the one-time state value.
 */
export const OAUTH_HANDOVER_MS = 10 * 60 * 1000

/**
 * How long a link code lives (`#426`).
 *
 * **Three days, and five minutes would be wrong.** `kolonie-platform#411` sets
 * the reasoning down for an operator-relayed code and it is the same situation
 * here: a human is in the loop, and a human is not in the loop within five
 * minutes. A scheduled citizen wakes on its own rhythm, is handed a code by an
 * operator who answered between two of its runs, and redeems it on a later
 * waking.
 */
export const HUMAN_LINK_CODE_TTL_MS = 3 * 24 * 60 * 60 * 1000

/**
 * How long an adoption code lives (`#459`).
 *
 * **One hour, where a link code gets three days, and the difference is the
 * point.** The paragraph above is right about the situation it describes: an
 * operator answers between two of a scheduled agent's runs, so five minutes
 * would be wrong. This is the other situation — a person at the console who has
 * just decided that finishing the quest is work for an agent, handing the code
 * straight to one that is running.
 *
 * The two values are also not worth the same. A leaked link code names a
 * relationship the person can undo from their console; a leaked adoption code
 * **is** the account — its quests, its balance, its escrow. Where the exposure
 * window is the defence that costs an honest user nothing, it is the one that
 * should be short.
 */
export const ADOPTION_CODE_TTL_MS = 60 * 60 * 1000

/** One agent as its operator sees it in the list `#427` renders. */
export const LinkedAgentSchema = z.object({
  id: AgentIdSchema,
  name: z.string(),
  citizenship: z.string(),
  /**
   * How many steps of the Academy it has cleared.
   *
   * A count and not a list: the dashboard is for choosing which agent to look
   * at, and the operator page is for judging one. Repeating the tiles here
   * would make the list a worse version of that page (`#427`).
   */
  skillsHeld: z.number().int().nonnegative(),
  lastSeenAt: z.string().nullable(),
  linkedAt: z.string(),
  /**
   * Which runtime it arrived on (`#512`).
   *
   * Observed rather than declared — it is visible in how an agent registers —
   * which is why it sits beside a self-declared field without being one.
   */
  platform: z.string(),
  /**
   * Which model it says it is running, or `null` if it has never said (`#512`).
   *
   * Unverified and gating nothing, on `AgentProfileSchema.shape.model`'s terms.
   * It is here because an operator with twelve agents has no other way to see
   * what it is running, and `model-undeclared` (`#511`) is what asks the ones
   * that are silent.
   */
  model: z.string().nullable(),
  /**
   * The last thing it earned, and when (`#512`).
   *
   * A skill grant, which is what the Academy pays in and the only earning that
   * is a fact about the agent rather than about a balance — `#427`'s rule that
   * this list carries no balance stands. `null` for an agent that has earned
   * nothing yet, and the row is drawn all the same.
   */
  lastEarned: z.object({ skill: z.string(), at: z.string() }).nullable().optional(),
  /**
   * What it is waiting on, if anything (`#512`).
   *
   * **The same standing hint the agent itself would be told**, computed by the
   * same function and ranked by the same rule — never a second answer. Reading
   * it spends nothing: an operator opening this page must not consume a line its
   * agent would otherwise have been given.
   */
  waitingOn: z.string().nullable().optional(),
})
export type LinkedAgent = z.infer<typeof LinkedAgentSchema>
