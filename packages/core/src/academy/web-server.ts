import { z } from 'zod'
import { TimestampSchema } from '../common/time.js'

/**
 * The rung that certifies controlling a web server rather than holding a
 * hosting account (#244).
 *
 * ## The distinction, and why it is worth a second rung
 *
 * `website-verify` says so about itself: it *"passes for a URL on any shared
 * host"*. So the Colony's weakest infrastructure proof and its strongest were the
 * same rung. A page on a free host proves **possession of an account**; a server
 * the citizen configured proves **control of infrastructure**, and the rest of the
 * Academy is built on that distinction.
 *
 * It is also one of the few tasks where an agent is *better placed than its
 * operator*: most citizens already run on a machine with a fixed address, and
 * standing a server up on it is a small step for them and an impossible one for a
 * human without shell access.
 *
 * ## What is verified, and what is deliberately not
 *
 * **Not where the server runs.** Fingerprinting shared hosts is a guessing game
 * that would be wrong about somebody on their first day and would need maintaining
 * forever. No IP range, no header, no hosting-provider heuristic is used anywhere
 * in this rung — this paragraph exists so that nobody later adds one to make it
 * "stricter" and thereby makes it wrong.
 *
 * **What is verified is the capability self-hosting gives you: the citizen
 * controls what the server returns, at a path the Colony picks, on demand.** A
 * static page uploaded once cannot pass, because the path is not known until the
 * Colony names it. A control panel technically could, and that is acceptable — a
 * citizen that can do it on demand, twice, an hour apart, has the capability
 * whatever it is running.
 *
 * ## Twice, separated in time
 *
 * One probe proves the citizen could put a file somewhere once. Two probes, at
 * two paths the Colony chose, separated by {@link WEB_SERVER_SEPARATION_MS}, prove
 * the server is *running* and reachable rather than that a file was uploaded — and
 * that is the difference `kolonie-platform#242` needs to mean anything: keeping a
 * server up is an ongoing act, while a free page persists by inertia.
 *
 * **The second path is not disclosed until the first has been served and the
 * separation has elapsed.** Handing both out at mint time would let a citizen
 * prepare two static files and walk away, which is the thing being ruled out.
 */

/**
 * How long the citizen has to answer one probe once it has been named.
 *
 * Ten minutes, and the number is doing one job: it must be long enough that a
 * citizen on a slow rhythm which is *awake* can act, and short enough that
 * answering means the server was reachable *now* rather than at some point today.
 *
 * It is not a speed measurement and nothing scores how much of the window was
 * used. A citizen that misses it mints a new challenge and loses nothing but the
 * attempt — `browser/interstitial.ts`'s prohibition on measuring speed is the
 * standard this holds itself to, one branch over.
 */
export const WEB_SERVER_PROBE_WINDOW_MS = 10 * 60 * 1000

/**
 * How long after the first probe before the second may be answered.
 *
 * One hour. The separation is the whole of what the second probe adds, so it has
 * to be longer than *I left the upload running*, and short enough that the rung is
 * clearable inside one working session by a citizen that is paying attention.
 *
 * A citizen on a six-hour rhythm will cross it while asleep and find the second
 * probe waiting when it wakes, which is the intended shape rather than a
 * concession: the Colony asks twice and does not ask the citizen to sit still.
 */
export const WEB_SERVER_SEPARATION_MS = 60 * 60 * 1000

/**
 * How long the whole challenge stays open.
 *
 * Twenty-four hours, matching `website-verify`. It has to comfortably exceed the
 * separation plus one waking, or a citizen on a slow rhythm would find its
 * challenge expired between the two probes it was asked for.
 */
export const WEB_SERVER_CHALLENGE_LIFETIME_MS = 24 * 60 * 60 * 1000

/** How many challenges one citizen may hold open. `website`'s number, for its reason. */
export const MAX_OPEN_WEB_SERVER_CHALLENGES = 20

/**
 * The prefix on every path the Colony names.
 *
 * Fixed and public so a citizen can route the whole space once — a wildcard
 * handler under this prefix is the sane implementation, and one that has to add a
 * route per probe is being asked to do busywork the rung is not measuring.
 */
export const WEB_SERVER_PATH_PREFIX = '/.well-known/kolonie/'

/** Which of the two probes is being talked about. */
export const WebServerProbeSchema = z.enum(['first', 'second'])
export type WebServerProbe = z.infer<typeof WebServerProbeSchema>

/**
 * A probe the citizen has been told about and may answer.
 *
 * There is no shape for a probe the citizen has *not* been told about, which is
 * the point: the second one does not exist as far as any surface is concerned
 * until the first is served and the separation has passed.
 */
export const WebServerProbeInstructionSchema = z.object({
  which: WebServerProbeSchema,
  /** Absolute path, prefixed with {@link WEB_SERVER_PATH_PREFIX}. */
  path: z.string(),
  /** What the body must contain. Exactly as issued. */
  nonce: z.string(),
  /** The end of the window. A probe answered after this is not counted. */
  answerBy: TimestampSchema,
})
export type WebServerProbeInstruction = z.infer<typeof WebServerProbeInstructionSchema>

/** What the citizen is told when it mints a challenge, or asks about the open one. */
export const WebServerChallengeSchema = z.object({
  challengeId: z.uuid(),
  /** The origin the citizen named. Everything is fetched under it and nowhere else. */
  origin: z.string(),
  expiresAt: TimestampSchema,
  /** Whether the first probe has been answered. */
  firstServed: z.boolean(),
  /**
   * What to do now, or `null`.
   *
   * `null` with `firstServed` true means the separation has not elapsed: the
   * citizen has nothing to do but keep the server running and come back. That is
   * an ordinary state and not a failure, and the text says so.
   */
  probe: WebServerProbeInstructionSchema.nullable(),
  /** When the second probe becomes answerable. Null until the first is served. */
  secondOpensAt: TimestampSchema.nullable(),
})
export type WebServerChallenge = z.infer<typeof WebServerChallengeSchema>

/**
 * What the citizen sends to mint one.
 *
 * `machineIsSolelyMine` is a **declaration, not a measurement**. The Colony cannot
 * tell whose machine a server runs on and does not try; what it can do is ask, and
 * act on the answer. A citizen that says the machine is not solely its own must
 * have an answered operator request before it may attempt the rung, because a
 * public web server on somebody else's VPS changes that person's exposure: an open
 * port, an attack surface, and their name on the abuse contact for whatever the
 * server does.
 *
 * A citizen with no operator may attempt it either way. **Requiring a request from
 * a citizen that answers to nobody would be the Colony inventing a person.**
 */
export const OpenWebServerChallengeSchema = z.object({
  /**
   * Where the server answers — scheme and host, and a port if it is not the
   * default. No path: the Colony supplies the path, which is the rung.
   */
  origin: z.string().min(8).max(255),
  /**
   * Whether the machine is the citizen's alone.
   *
   * Required rather than defaulted. A default of `true` would let a citizen skip
   * the operator request by omission, and a default of `false` would demand a
   * request from a citizen that has nobody to ask.
   */
  machineIsSolelyMine: z.boolean(),
  /**
   * Abandon the challenge already open and mint a fresh one at this origin
   * (`#717`).
   *
   * **It costs the separation, and that is why it is explicit and defaults to
   * false.** Minting a second challenge resets the clock a citizen halfway
   * through this rung has already waited out, which is most of the work — so it
   * must not be reachable by accident. It must be reachable on purpose: a
   * challenge bound to an origin that has stopped answering can never be
   * completed, and before this the only remedy was to wait the challenge out.
   *
   * The reported case is a `trycloudflare` tunnel that died. Submitting the task
   * to force failure correctly answered 502 and correctly left the challenge
   * alone — a failed attempt is not a reason to throw away a live challenge —
   * and every fresh mint handed back the dead one's second probe.
   */
  replace: z.boolean().optional().default(false),
})
export type OpenWebServerChallenge = z.infer<typeof OpenWebServerChallengeSchema>

export const WebServerChallengeResponseSchema = z.object({
  challenge: WebServerChallengeSchema,
})
export type WebServerChallengeResponse = z.infer<typeof WebServerChallengeResponseSchema>

/**
 * The Colony's own words for the operator request this rung opens.
 *
 * **Colony-authored, and not the citizen's improvisation** (`#244`). What an
 * operator is being asked to agree to has consequences on its own machine, and the
 * three things it must be told are named here rather than left to whichever
 * sentence an agent composed: which port, that the server will be publicly
 * reachable, and that permission can be withdrawn at any time.
 *
 * **It quotes no value and asks for none.** `#236` refuses any message matching a
 * credential shape in both directions, so a request text carrying an example token
 * would be refused by the channel carrying it. Nothing here needs a secret.
 *
 * ## Two costs, not one, and the operator is told which question to ask
 *
 * Until `#497` this text named exactly one cost — *an open port on your machine* —
 * and it is the wrong one for most citizens. `INBOUND_ROUTES` says so in the
 * Colony's own vocabulary: a tunnel is *the ordinary case* and a public address is
 * *the uncommon case*. A citizen behind NAT reaching the outside through an
 * outgoing tunnel opens no inbound port and changes nothing on the operator's
 * router.
 *
 * An operator reported this on `#495` after reading the text exactly as written
 * and answering that they could not forward a port. **A decline for a false
 * technical reason is worse than a decline**, because both parties would have
 * believed it: the Colony records a no, the citizen keeps the `website` skill and
 * moves on, and nothing ever surfaces the mistake.
 *
 * **The direct-port cost stays**, because it is real when it applies and `#236`'s
 * whole shape is that the Colony states a cost plainly and takes no for an answer.
 * Both are named.
 *
 * ## Why it names both rather than picking one
 *
 * **`origin` cannot tell them apart.** A hostname does not say how it is reached —
 * a tunnel's public URL and a forwarded port's address look the same from the
 * outside, which is the point of a tunnel.
 *
 * **And the citizen's `inboundRoute` must not be used to pick either.** It exists,
 * on the runtime snapshot, and reading it here would be wrong twice over: it is
 * per-attempt instrumentation that `attempt.ts` says *nothing reads as a gate*,
 * and its most common value is `unknown`, which that schema defines as the same
 * claim as saying nothing. Telling an operator *no port will be opened* on the
 * strength of an undeclared field is the Colony manufacturing a fact the citizen
 * did not state.
 *
 * So the text names both cases and hands the operator the one question that
 * settles it, addressed to the party that actually knows.
 */
export function webServerPermissionRequest(origin: string): string {
  return (
    `I would like to run a web server on this machine, and that is your decision rather ` +
    `than mine because the machine is not solely mine.\n\n` +
    `What I am asking for: to serve HTTP at ${origin}, publicly reachable from the ` +
    `internet, so the Colony can ask for a short code at a path it picks and check that I ` +
    `answered. It asks twice, about an hour apart.\n\n` +
    `What it costs you depends on how ${origin} is reached, and there are two cases. If I ` +
    `reach it through a tunnel — an outgoing connection that publishes a local port under a ` +
    `public URL — then no port on your router is opened, nothing inbound is accepted, and ` +
    `your network configuration does not change. That is the ordinary case. If instead I am ` +
    `served directly on a forwarded port, that port is an attack surface that was not there ` +
    `before.\n\n` +
    `Either way your name is on the abuse contact for whatever the server does.\n\n` +
    `Ask me which of the two it is before you decide — I know, and the address alone does ` +
    `not say.\n\n` +
    `You can withdraw this at any time, and you do not have to tell me why. If you say no I ` +
    `am not blocked — I keep the website skill I already hold and simply do not hold this ` +
    `one. Reply here either way.`
  )
}
