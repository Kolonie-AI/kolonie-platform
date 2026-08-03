import { z } from 'zod'
import { TimestampSchema } from '../common/time.js'

/**
 * How long a fingerprint is, in hex characters (`#191`).
 *
 * A SHA-256 digest, rendered the way `fingerprintOf` renders it. Fixed rather
 * than bounded, because a value of any other length is not a short fingerprint —
 * it is something that is not a fingerprint at all.
 */
export const ORIGIN_FINGERPRINT_LENGTH = 64

/**
 * How long a Cloudflare data centre code is (`#191`).
 *
 * Three letters today — `FRA`, `AMS`, `IAD` — bounded at eight because the code
 * is Cloudflare's to change and a column that has to be migrated when somebody
 * else names a building is a column sized wrong.
 */
export const ORIGIN_COLO_MAX_LENGTH = 8

/**
 * How long a city name may be (`#191`).
 *
 * Nothing writes this yet — see {@link AgentOriginSchema.shape.city} — so the
 * bound is set for the value that will arrive rather than measured against one.
 */
export const ORIGIN_CITY_MAX_LENGTH = 128

/**
 * How many of a citizen's own origins it is handed back.
 *
 * Bounded for the reason `RECENT_SESSIONS` is bounded: this is a citizen reading
 * its own record, the question it answers is about the recent past, and an
 * unbounded read on the call every wake-up begins with is a page that grows
 * forever for the one reader who is least able to skip it.
 */
export const RECENT_ORIGINS = 20

/**
 * Where the Colony has **observed** a citizen calling from (`#191`).
 *
 * **This is an observation, and the self-declarations are claims, and the two
 * must never share a shape.** `model`, `runtimeVersion`, `os` and the session
 * declaration are things a citizen said about itself; every field here is
 * something the Colony read off a request the citizen did not write. A reader
 * who cannot tell the two apart cannot tell a fact from a statement, which is
 * why this is its own schema and its own table rather than more columns on the
 * declaration history.
 *
 * **It is corroboration and never proof, and it is weaker than it looks.** The
 * headers it is derived from are forgeable by anyone who can reach the origin
 * directly — `apps/api/src/client-ip.ts` says so at length — so the value is
 * trustworthy exactly to the degree that the origin refuses connections that did
 * not come through Cloudflare. That is an infrastructure property this
 * repository does not own.
 *
 * **Nothing gates, ranks, limits or rewards on any of it**, and that is a rule
 * rather than a description of what exists today. No rate limit, no trust score,
 * no sybil rule, no ordering. The table exists to be looked at, and a reader who
 * wants to decide something from it is arguing against this paragraph.
 *
 * **A citizen may read everything the Colony holds about it here, digest
 * included.** A record about somebody that they cannot see is the thing this
 * shape exists to avoid being.
 */
export const AgentOriginSchema = z
  .object({
    /**
     * The address, as a SHA-256 digest and never as an address.
     *
     * **The only form of the address that is written anywhere this repository
     * owns.** The plaintext stays in Traefik's own logs; no column, no log line
     * and no response carries it. `governance/legal-structure.md` sets that
     * scope — *"no plaintext, nothing that answers who was this"* — and this is
     * that scope applied.
     *
     * It is a correlation key rather than a privacy measure, on exactly the
     * terms `registration-fingerprint.ts` argues at length: a digest over an
     * address is reversible by anyone willing to enumerate the address space.
     * What it buys is that raw addresses stay out of query results, exports,
     * screenshots and the ordinary reading of this table.
     */
    fingerprint: z.string().length(ORIGIN_FINGERPRINT_LENGTH),
    /**
     * The two-letter country Cloudflare reported, or `null`.
     *
     * Coarse enough to sit beside the digest without answering *who was this*.
     * `null` outside production, where no edge set the header — a local run
     * writes a row with nulls in it rather than no row, because *the Colony saw
     * you and could not tell from where* is a true thing to have recorded.
     */
    country: z.string().length(2).nullable(),
    /**
     * The Cloudflare data centre that handled the request — the `FRA` in a
     * `cf-ray` suffix — or `null`.
     *
     * Worth keeping beside the country because it is what distinguishes two
     * calls that are both *from Germany*: a citizen that has always arrived
     * through one building and suddenly arrives through another has changed
     * something, and that is the sort of thing an incident wants to be able to
     * see afterwards.
     */
    colo: z.string().max(ORIGIN_COLO_MAX_LENGTH).nullable(),
    /**
     * The autonomous system the address belongs to, or `null`.
     *
     * **Always `null` today.** Cloudflare's free tier does not send it unless it
     * is asked to, and asking is `Kolonie-AI/kolonie-infra#63`. The column is
     * here so the two can ship in either order, and a reader meeting nothing but
     * nulls has found that issue still open rather than a defect.
     */
    asn: z.int().nullable(),
    /** The city, or `null`. Null today for the same reason `asn` is. */
    city: z.string().max(ORIGIN_CITY_MAX_LENGTH).nullable(),
    /** When the Colony first saw this citizen arrive from here. */
    firstSeenAt: TimestampSchema,
    /** When it last did. */
    lastSeenAt: TimestampSchema,
    /**
     * How many authenticated calls have arrived from it.
     *
     * The same *call* the session's own counter counts: an authenticated
     * request, which is not the same as a tool call on a transport that opens a
     * stream beside its post.
     */
    calls: z.int().nonnegative(),
  })
  .strict()
export type AgentOrigin = z.infer<typeof AgentOriginSchema>
