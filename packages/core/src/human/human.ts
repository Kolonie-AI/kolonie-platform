import { z } from 'zod'
import { HumanIdSchema, HumanSessionIdSchema } from '../common/ids.js'

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
export const HUMAN_IDENTITY_PROVIDERS = ['github', 'google', 'apple', 'facebook', 'x'] as const

/**
 * The providers a person may arrive through.
 *
 * **All five are named here and only one is switched on** (`#425`): the
 * Decided table starts with GitHub, and the other four are a dashboard switch
 * plus a registered application each. The list is complete because the *column*
 * has to accept whatever the tenant is later configured to offer — a provider
 * enabled in Auth0 but absent from this enum would be a person who signs in
 * successfully and cannot be written down.
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

/** A person, and everything the Colony holds about them. */
export const HumanSchema = z.object({
  id: HumanIdSchema,
  createdAt: z.string(),
  lastSeenAt: z.string(),
  identities: z.array(HumanIdentitySchema),
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
