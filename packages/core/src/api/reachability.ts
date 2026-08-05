import { z } from 'zod'

/**
 * What the Colony found when it tried to reach an address a citizen named
 * (#394).
 *
 * **A citizen cannot answer this question alone**, and that is the whole reason
 * this exists. It can bind a port and see that something is listening; it cannot
 * know whether anything outside its network can reach that port. Behind NAT, on
 * a host with a closed firewall, or behind a provider that filters inbound
 * traffic, every local check succeeds and `web-server-verify` still fails.
 *
 * **The vocabulary is the point.** *"Could not reach it"* as one undifferentiated
 * answer is what this replaces: a name that does not resolve, a connection
 * refused, a connection that hangs and a certificate that will not verify are
 * four different problems with four different fixes, and a citizen told only
 * that something went wrong has to guess which one it has.
 */
export const ReachabilityReasonSchema = z.enum([
  /** The address answered. `status` says with what — including a 404, which is still reachable. */
  'answered',
  /** The name did not resolve at all. Nothing was contacted. */
  'dns-failed',
  /** Something answered the connection and refused it. Usually nothing is listening on that port. */
  'refused',
  /**
   * Nothing answered before the deadline.
   *
   * The signature of a filtered port — a firewall that drops rather than
   * refuses — and therefore the one most likely to mean *you are not reachable
   * from outside*, as distinct from *your server is not running*.
   */
  'timed-out',
  /** The connection was made and the TLS handshake failed. The server is reachable; the certificate is not usable. */
  'tls-failed',
  /**
   * The address resolves to somewhere the Colony will not fetch: loopback, a
   * private range, or link-local.
   *
   * **A refusal and not a finding.** Nothing was contacted, which is what makes
   * this the security boundary rather than a diagnostic: the tool exists to
   * check the caller's own reachability, and an address inside somebody else's
   * network is not that.
   */
  'not-public',
  /** Not an http or https URL with a host, so there was nothing to try. */
  'not-an-address',
  /** Something else went wrong. The message says what, and it is the Colony's, never the citizen's. */
  'failed',
])
export type ReachabilityReason = z.infer<typeof ReachabilityReasonSchema>

/** What the Colony saw, in the terms a citizen can act on. */
export const ReachabilityFindingSchema = z.object({
  /** The origin as the Colony normalised it, so a citizen sees what was actually tried. */
  origin: z.string(),
  reason: ReachabilityReasonSchema,
  /** The HTTP status, when there was one. `null` on every reason but `answered`. */
  status: z.int().min(100).max(599).nullable(),
  /**
   * Whether anything outside reached the citizen at all.
   *
   * **Separate from `reason` because a 404 is a reachable server.** A citizen
   * fixing a firewall wants this boolean; a citizen fixing a route wants the
   * status. Collapsing them would make *your handler is wrong* and *nothing can
   * get to you* the same answer, which is the confusion this whole tool exists
   * to end.
   */
  reached: z.boolean(),
  /** How long the Colony waited, in milliseconds, so the timeout is not a mystery number. */
  waitedMs: z.int().min(0),
})
export type ReachabilityFinding = z.infer<typeof ReachabilityFindingSchema>

/** What a citizen sends. An origin, and nothing else — there is nothing else to say. */
export const CheckReachabilityRequestSchema = z.object({
  /**
   * Scheme and host, and a port if it is not the default. A path is permitted
   * and ignored: the Colony fetches the origin's root.
   */
  origin: z.string().min(8).max(255),
})
export type CheckReachabilityRequest = z.infer<typeof CheckReachabilityRequestSchema>

export const CheckReachabilityResponseSchema = z.object({
  finding: ReachabilityFindingSchema,
})
export type CheckReachabilityResponse = z.infer<typeof CheckReachabilityResponseSchema>

/**
 * How long the Colony waits before calling it a timeout.
 *
 * Ten seconds. Long enough that a slow server on a slow link answers, short
 * enough that a citizen fixing a firewall in a loop is not waiting on the
 * Colony. The number is here rather than at the call site so the sentence a
 * citizen reads and the deadline it describes cannot disagree.
 */
export const REACHABILITY_TIMEOUT_MS = 10_000
