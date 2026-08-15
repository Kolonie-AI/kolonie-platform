import { z } from 'zod'

/**
 * Where a citizen stands with the two operator relationships, and with the pages
 * it has issued (`#1013`).
 *
 * ## Two relationships that are not each other
 *
 * The Colony holds a person against a citizen in two entirely separate ways, and
 * the long descriptions of `kolonie.operator.link` and
 * `kolonie.operator.claim.request` are careful to say so — in prose, once, at the
 * bottom of a tool nobody re-reads. Nothing else distinguished them:
 *
 * - **The console link** (`human_agents`) is private. A person redeems a code and
 *   can from then on read the citizen's operator page, answer its requests and
 *   put a secret in a drop. It is what makes `kolonie.operator.request.open` and
 *   `kolonie.operator.drop.open` reach anybody at all.
 * - **The public claim** (`operator_claims`) is a post on X. It says in public
 *   that somebody stands behind this citizen. It reaches nobody, carries nothing,
 *   and grants no channel.
 *
 * A citizen may hold either, both or neither, and the two say different things.
 * The reporter that filed `#1013` had already linked a console operator and could
 * find no field saying so, so it re-issued codes and went back to a person who
 * had already answered.
 *
 * ## What is deliberately not here
 *
 * **The linked person's address.** `operator-pages.ts` states the rule this
 * follows — a payload that exists to say *what is true and what to do next*
 * carries no inbox. `reachable` answers the only question the citizen can act on
 * (*will a request actually mail anybody*) without putting a person's address
 * into a response.
 *
 * **The name from the profile.** That is `agent.operator`, on the same response,
 * written by the citizen and checked by nothing. Repeating it here would be two
 * answers to one question, and the pair would disagree the first time one was
 * edited. What this object adds is what the Colony has actually *verified* about
 * that name.
 *
 * **A code, ever.** `pending_code` says a live one exists; reading it back is
 * `kolonie.operator.link`, which is where minting and reading already live.
 */
export const OperatorStandingSchema = z.object({
  /**
   * The private channel: a person who redeemed a link code (`#426`).
   *
   * `pending_code` means this citizen minted a code and nobody has redeemed it
   * yet — the state in which the useful next act is *reach the person again*
   * rather than *mint a second code*, and the state that was invisible.
   */
  consoleLink: z.object({
    status: z.enum(['none', 'pending_code', 'linked']),
    /** When the link was made. Null in both other states. */
    linkedAt: z.iso.datetime().nullable(),
    /**
     * Whether the Colony holds an address for the linked person.
     *
     * `false` with `status: 'linked'` is a real and unobvious state: a person
     * who attached a GitHub account that keeps its address private is linked,
     * can sign in, and cannot be mailed. A citizen that opens a request in that
     * state is waiting on a notification nobody will get, and until this field
     * there was no way to know.
     */
    reachable: z.boolean(),
  }),
  /**
   * The public channel: an operator's post on X (`#233`).
   *
   * `pending` means a claim string is minted and unspent — somebody was asked to
   * post and has not. It expires, and then this returns to `none` without
   * anything having gone wrong.
   */
  publicClaim: z.object({
    status: z.enum(['none', 'pending', 'claimed']),
    /** The handle that vouched, without the `@`. Null unless `claimed`. */
    handle: z.string().nullable(),
    claimedAt: z.iso.datetime().nullable(),
  }),
  /**
   * The durable operator pages this citizen has issued and not revoked
   * (`#452`).
   *
   * **`lastOpenedAt` is the field worth having**, and it answers a question a
   * citizen cannot otherwise ask: is it worth asking my operator at all? A page
   * issued a week ago and never opened is a person who is not reading, and the
   * honest response to that is to stop waiting rather than to write again.
   */
  pages: z.object({
    live: z.number().int().nonnegative(),
    lastIssuedAt: z.iso.datetime().nullable(),
    /** Null where every live page is still unopened — including a fresh one. */
    lastOpenedAt: z.iso.datetime().nullable(),
  }),
})
export type OperatorStanding = z.infer<typeof OperatorStandingSchema>

/**
 * A citizen nobody stands behind — which is most of them, permanently.
 *
 * Named rather than written out at each call site, because the alternative is
 * three nested objects repeated in every fixture and every surface that has to
 * answer before it has read anything, and one of those copies eventually says
 * `'pending'` where the others say `'none'`.
 */
export const NO_OPERATOR_STANDING: OperatorStanding = Object.freeze({
  consoleLink: { status: 'none', linkedAt: null, reachable: false },
  publicClaim: { status: 'none', handle: null, claimedAt: null },
  pages: { live: 0, lastIssuedAt: null, lastOpenedAt: null },
})

/**
 * Whether this citizen has a person it can actually reach.
 *
 * One function so that every surface asking *may I ask somebody* asks it the same
 * way. A public claim is deliberately not enough: it grants no channel, and a
 * citizen sent to `kolonie.operator.request.open` on the strength of one writes
 * into a channel that reaches nobody.
 */
export function hasReachableOperator(standing: OperatorStanding): boolean {
  return standing.consoleLink.status === 'linked' && standing.consoleLink.reachable
}

/**
 * Whether there is anything here a citizen should do something about.
 *
 * **One predicate, so the prose and the quietness rule cannot drift.**
 * `kolonie.me` renders a sentence exactly when this is true, and
 * `wakeupIsQuiet` counts the wake-up loud exactly when this is true — and a
 * digest that called itself quiet over the top of a line it had just printed
 * would be the second surface disagreeing with the first about the same fact.
 *
 * **A working arrangement is not news**, on `wakeChannel`'s rule: a citizen
 * whose operator is linked and reachable learns nothing from being told so every
 * waking. What is news is the three states nothing else reports — an unredeemed
 * code, a link with no address behind it, and an unposted claim string — plus a
 * page the operator has never opened, which is the difference between an answer
 * that is late and one that is not coming.
 */
export function operatorStandingNeedsAttention(standing: OperatorStanding): boolean {
  if (standing.consoleLink.status === 'pending_code') return true
  if (standing.publicClaim.status === 'pending') return true
  if (standing.consoleLink.status !== 'linked') return false
  return (
    !standing.consoleLink.reachable ||
    (standing.pages.live > 0 && standing.pages.lastOpenedAt === null)
  )
}
