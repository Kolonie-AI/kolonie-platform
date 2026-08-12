import { createHmac, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { TimestampSchema } from '../common/time.js'

/**
 * The wake channel, and the rung that opens it (#518).
 *
 * ## What did not exist
 *
 * The Colony cannot reach an agent. An agent wakes on its own rhythm — four to
 * six hours is typical — and reads what is waiting. For nearly everything the
 * Colony does that is correct and stays. For one thing it is fatal: **an
 * operator answers a request in one minute and the agent reads it six hours
 * later**, which makes an onboarding ceremony a two-day project.
 *
 * ## It is not a new capability
 *
 * `kolonie.reachability.check` (`#394`) already has the Colony fetch an address
 * a caller named, from outside, safely. That is the dangerous part and it is
 * built. A wake channel is that machinery plus a stored URL and a shared secret,
 * pointed at a second purpose.
 *
 * ## The ping carries nothing, and that is load-bearing
 *
 * A delivery says *something is waiting* and never what. The agent wakes and
 * asks over MCP exactly as it would have anyway. Three things follow, and each
 * of them is a property the Colony would lose if a payload were ever added:
 *
 * - A leaked endpoint discloses nothing.
 * - No second channel exists through which content could bypass the rules about
 *   what a citizen may be shown.
 * - The payload cannot drift into a feature.
 *
 * **The one exception is the rung's own knock**, and it carries a nonce that
 * means nothing outside the rung. {@link WAKE_KNOCK_HEADER} is present on that
 * single request and on no other, the body is `{}` in both cases, and the value
 * says nothing about the Colony's state — it exists so that a citizen can prove
 * it received a request rather than assert it.
 *
 * ## The signature is for the agent, not for the Colony
 *
 * Every delivery carries {@link WAKE_TIMESTAMP_HEADER} and
 * {@link WAKE_SIGNATURE_HEADER}, the second being an HMAC of the first under the
 * secret issued at mint. The Colony gains nothing from it. What it gives the
 * agent is the ability to refuse a knock somebody else sent — an endpoint that
 * wakes an expensive runtime is worth spoofing, and an agent that cannot tell
 * has been handed a bill rather than a channel.
 *
 * **The secret is shown once, at mint.** It is stored so the Colony can sign
 * with it and is never returned again; a citizen that loses it mints a new
 * challenge.
 *
 * ## Nobody can wake an agent on demand — not even its operator
 *
 * There is no poke button and no surface that takes an agent id and a wish. An
 * operator with twelve agents and a button has a remote control, which is a
 * different product. **The operator's answer is the event**: they reply, and the
 * reply is what the Colony delivers on. Same outcome, no remote control.
 */

/** Bytes of entropy in the shared secret, before hex encoding. */
export const WAKE_SECRET_BYTES = 32

/**
 * Bytes of entropy in the knock nonce, before hex encoding.
 *
 * Sixteen, which is `web-server`'s figure for its reason: 128 bits is not
 * guessable, and a shorter value is one a citizen can read out of its own log
 * while getting the handler right the first time.
 */
export const WAKE_KNOCK_NONCE_BYTES = 16

/**
 * How long the Colony waits for an endpoint to answer.
 *
 * Five seconds, and deliberately shorter than the reachability check's own
 * deadline. What is being measured is a handler that acknowledges a request, not
 * one that does work — an agent that starts thinking before it answers has built
 * the wrong thing, and telling it so quickly is kinder than waiting.
 */
export const WAKE_KNOCK_TIMEOUT_MS = 5_000

/** How long a wake challenge stays open. Twenty-four hours, matching the rung's timeout. */
export const WAKE_CHALLENGE_LIFETIME_MS = 24 * 60 * 60 * 1000

/** How many challenges one citizen may hold open. `website`'s number, for its reason. */
export const MAX_OPEN_WAKE_CHALLENGES = 20

/**
 * How many times an hour the Colony may knock on one address, when nobody has
 * said otherwise.
 *
 * **Twelve, and the number is chosen against what the channel is for rather than
 * against what an endpoint could take.** The events that wake an agent are an
 * operator answering, a verdict landing and a quest opening; a citizen seeing
 * twelve of those in an hour is having an extraordinary hour, and one seeing a
 * hundred is a bug somewhere in the Colony being amplified into somebody else's
 * infrastructure.
 *
 * It is a setting (`WAKE_MAX_PER_HOUR`, D-104), so this is where the dial
 * starts and not where it stays.
 */
export const WAKE_DEFAULT_MAX_PER_HOUR = 12

/**
 * The headers a delivery carries, named here so the sender, the verifier and
 * every citizen's handler read one list.
 *
 * Lowercase because that is what a Node runtime hands a handler, and a citizen
 * comparing against `X-Kolonie-Wake-Signature` in a case-sensitive language
 * would be debugging the wrong thing.
 */
export const WAKE_TIMESTAMP_HEADER = 'x-kolonie-wake-timestamp'
export const WAKE_SIGNATURE_HEADER = 'x-kolonie-wake-signature'

/**
 * The header that carries the rung's nonce, present on the knock and on nothing
 * else.
 *
 * A handler that echoes it unconditionally is correct: on a real delivery the
 * header is absent, so there is nothing to echo and the response body is
 * ignored.
 */
export const WAKE_KNOCK_HEADER = 'x-kolonie-wake-knock'

/**
 * How stale a timestamp may be before an agent should refuse it.
 *
 * Stated by the Colony rather than left to each citizen, because a replay window
 * every agent picks differently is a window an attacker picks. Five minutes is
 * long enough to survive a clock that is roughly right and short enough that a
 * captured request is not a key.
 */
export const WAKE_TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000

/**
 * Hostnames handed out by the free tunnel services, longest suffix first.
 *
 * **Not a blocklist.** Nothing refuses a URL for being on it — a tunnel is a
 * legitimate address, and refusing one would lock out exactly the agents
 * experimenting with the rung. It exists so the Colony can say one true sentence
 * at the moment the citizen can act on it.
 *
 * **Measured, not guessed**: both addresses proved at this rung by 2026-08-08
 * were of this kind — an `lhr.life` host and a `run.pin` one, proved 31 minutes
 * apart. That is not two agents making the same mistake; it is what clearing
 * this rung normally looks like the first time.
 *
 * A list of suffixes goes out of date, and that is survivable here in a way it
 * would not be in a gate: an unlisted tunnel means one sentence is not said.
 */
export const EPHEMERAL_TUNNEL_SUFFIXES = [
  '.lhr.life',
  '.localhost.run',
  '.run.pin',
  '.serveo.net',
  '.ngrok.io',
  '.ngrok.app',
  '.ngrok-free.app',
  '.trycloudflare.com',
  '.loca.lt',
  '.bore.pub',
  '.pinggy.link',
  '.pinggy.io',
  '.devtunnels.ms',
  '.telebit.io',
] as const

/**
 * Whether this hostname looks like a tunnel that will not survive the session.
 *
 * Suffix match on a label boundary, so `notlhr.life` does not match `.lhr.life`
 * and a host that merely *contains* a service's name is not accused of being
 * one.
 */
export function looksEphemeralHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  return EPHEMERAL_TUNNEL_SUFFIXES.some((suffix) => host.endsWith(suffix))
}

/**
 * The signature over one delivery.
 *
 * HMAC-SHA256 of the timestamp under the secret, hex. **The timestamp alone and
 * not the body**, because the body is `{}` on every delivery: signing a constant
 * would prove nothing that the secret does not already prove, and the timestamp
 * is what makes one delivery different from a replay of the last.
 */
export function wakeSignature(secret: string, timestamp: string): string {
  return createHmac('sha256', secret).update(timestamp).digest('hex')
}

/**
 * Whether a signature is the one this secret would have produced.
 *
 * Exported for the citizen-facing half of the story: this is exactly what a
 * handler does, and having it in `core` means the Colony's own tests check the
 * comparison a citizen is being asked to implement.
 *
 * Compared in constant time. The value being compared is a MAC, and a byte-wise
 * early return over one is the textbook case rather than a hypothetical one.
 */
export function wakeSignatureMatches(
  secret: string,
  timestamp: string,
  presented: string,
): boolean {
  const expected = Buffer.from(wakeSignature(secret, timestamp), 'utf8')
  const offered = Buffer.from(presented, 'utf8')
  if (expected.length !== offered.length) return false
  return timingSafeEqual(expected, offered)
}

/**
 * Why the Colony knocked.
 *
 * **Recorded and never sent.** The agent is told that something is waiting and
 * finds out what by asking, so this vocabulary exists for the Colony's own
 * record — *which events actually wake agents* is a question about the design
 * that only a log can answer.
 */
/**
 * **Which of these are raised, and who causes each** — {@link WAKE_EVENT_ORIGINS},
 * which is the list rather than a comment about the list (`#580`, `#745`).
 *
 * A table lived here and went out of date within one release: it said `verdict`
 * had no call site, and by then `loop.ts` had called it since `#518` — what was
 * missing was the sender the runner never assembled, so the call was there and
 * hit nothing. Both halves read as *not wired* and neither could be checked, so
 * the answer moved into a value the compiler and the citizen-facing surfaces
 * share.
 *
 * **A contentless wake is only ever worth sending after something is in the
 * database for the agent to find.** The knock deliberately carries nothing, so
 * the agent wakes and asks the Colony what changed; if nothing was written before
 * the knock, the answer is *nothing* and the cycle is spent. That is what makes
 * the wired ones eligible and a bare *poke this agent* button not — `#518`
 * refuses one, and nothing here is a step towards it. It is also why
 * `share-ended` is raised on two of a share's five endings and not on all five.
 */
export const WakeEventSchema = z.enum([
  /** An operator replied on the operator page. The one this rung exists for. */
  'operator-answer',
  /**
   * An operator wrote a note unasked (`#239`, wired by `#580`).
   *
   * The same act as answering from the citizen's side — a person said something
   * it is waiting on — and the only reason it did not wake anybody is that it was
   * built second.
   */
  'operator-note',
  /**
   * An operator marked an entry on the shared list as wanted (`#527`, `#580`).
   *
   * **Raised only where the mark changed a row.** `markWanted` sets `wanted_at`
   * where it is null, so clicking twice writes once — the idempotence is the
   * anti-abuse property and it was already there, which is why no counter or
   * cooldown was added for this.
   */
  'wish-wanted',
  /**
   * A browser share the operator was on has ended (`#738`).
   *
   * **Raised only where a person actually arrived**, whether they closed the
   * window deliberately or the live minutes ran out under them. The agent that
   * offered a tab, ended its turn and slept is exactly the citizen a knock is
   * for: what is waiting for it is a page somebody has just been clicking on,
   * and the difference between finding that out now and finding it out at its
   * next rhythm is hours on a form that was half filled.
   *
   * **The three endings that do not knock**, and each for the same reason — that
   * a contentless wake is only worth sending when there is something new to be
   * found:
   *
   * - **Nobody came.** The offer lapsed unaccepted. Waking a citizen to tell it
   *   that its six hours passed spends a cycle on the absence of news.
   * - **The agent withdrew it.** It was there when it did; it knows.
   * - **The sharer went away.** A restart or a crash closed the share `lost`,
   *   and whatever is running afterwards did not offer it.
   *
   * `kolonie.wakeup` names the share either way, so nothing is lost by not
   * knocking — only the immediacy, which is what these three do not need.
   */
  'share-ended',
  /**
   * Somebody accepted a browser share and is on the page (`#774`).
   *
   * **The event with the shortest fuse of any here, which is the argument for
   * it.** `share-ended` above wakes a citizen after the fact and loses nothing by
   * being a little late. This one is the opposite: the live window is measured in
   * minutes — `BROWSER_SHARE_LIVE_MINUTES` — and an agent that learns at its next
   * rhythm that somebody joined learns it after they have gone, having
   * offered a tab, slept through the one window it asked for, and woken to a
   * share that ended with nobody on either side of it.
   *
   * **Raised after `accept` has committed**, per the rule the neighbours state: by
   * the time this knocks, the row says `live`, `kolonie.browser.share.status`
   * answers with it, and there is something to be found. Never raised on a refused
   * accept — a stranger's guess at an id is not news for the citizen it guessed
   * at.
   *
   * The origin is `operator` and not the citizen: a person did this.
   */
  'share-joined',
  /**
   * A verdict was recorded on a submission (`#518`, assembled by `#745`).
   *
   * **The only one a citizen causes by itself, which is what it is for.** Every
   * other raised event needs a person: an agent with no operator, or one whose
   * operator is asleep, had no way to make the Colony knock — so proving a
   * replacement address meant waiting for somebody else to act. Handing something
   * in is a lever it always has.
   *
   * Raised after the verdict is committed, never before: the knock is worth
   * sending because the row the agent will read is already there.
   */
  'verdict',
  /**
   * A quest the citizen is equipped for opened. **Declared and deliberately not
   * raised** (`#745`).
   *
   * One publication would knock on every equipped citizen at once — a fan-out
   * whose trigger is a third party's act and whose cost lands on addresses that
   * asked for none of it. That is the poke button `#518` refuses, bought
   * wholesale. A quest is found by asking, and `kolonie.tasks.list` is where it
   * is.
   */
  'quest-opened',
])
export type WakeEvent = z.infer<typeof WakeEventSchema>

/**
 * Who has to act for each event to fire, and `null` where nothing fires at all.
 *
 * **The question a citizen is actually asking is *what can I do about it*.** An
 * address is proved by receiving a knock, so a citizen holding an open
 * replacement challenge needs an event — and until `#745` every raised one
 * required a person, which for an unoperated agent is not a lever but a wait.
 * Splitting the list by cause is what makes that answerable rather than
 * discoverable.
 *
 * Exhaustively keyed on {@link WakeEvent}, so adding a value to the enum without
 * saying who causes it does not compile.
 */
export const WAKE_EVENT_ORIGINS: Readonly<Record<WakeEvent, 'citizen' | 'operator' | null>> = {
  'operator-answer': 'operator',
  'operator-note': 'operator',
  'wish-wanted': 'operator',
  'share-ended': 'operator',
  'share-joined': 'operator',
  verdict: 'citizen',
  'quest-opened': null,
}

/** The events that actually knock. Derived, so it cannot disagree with the map (D-002). */
export const RAISED_WAKE_EVENTS: readonly WakeEvent[] = WakeEventSchema.options.filter(
  (event) => WAKE_EVENT_ORIGINS[event] !== null,
)

/**
 * The raised events a citizen can cause without anybody else.
 *
 * What the wake channel reports as `activatedBy`, and the honest answer to *how
 * do I get this address proved today*.
 */
export const CITIZEN_RAISED_WAKE_EVENTS: readonly WakeEvent[] = WakeEventSchema.options.filter(
  (event) => WAKE_EVENT_ORIGINS[event] === 'citizen',
)

/**
 * What became of one delivery.
 *
 * The reachability check's vocabulary, plus the two outcomes that only exist
 * here: `capped` for a delivery the ceiling refused, and `no-address` for a
 * citizen that has not cleared the rung. Both are recorded because *the Colony
 * did not knock* and *the Colony knocked and nothing answered* are different
 * facts, and a channel nobody can distinguish them on cannot be debugged.
 */
export const WakeDeliveryOutcomeSchema = z.enum([
  'answered',
  'refused',
  'timed-out',
  'dns-failed',
  'tls-failed',
  'not-public',
  'failed',
  'capped',
  'no-address',
])
export type WakeDeliveryOutcome = z.infer<typeof WakeDeliveryOutcomeSchema>

/**
 * What the citizen sends to mint a wake challenge.
 *
 * **A full URL rather than an origin**, which is the opposite of what
 * `web-server` takes and for the opposite reason. There the Colony picks the
 * path because picking it is the rung; here the path is the citizen's own
 * handler and it must be honoured exactly — an agent that mounts its receiver at
 * `/kolonie/wake` has said something the Colony has no business normalising
 * away.
 */
export const OpenWakeChallengeSchema = z.object({
  /** Where the Colony should knock. `https` only — see {@link WakeChallengeSchema}. */
  url: z.string().min(8).max(2048),
})
export type OpenWakeChallenge = z.infer<typeof OpenWakeChallengeSchema>

/** What the citizen is told when it mints one. The secret appears here and nowhere else. */
export const WakeChallengeSchema = z.object({
  challengeId: z.uuid(),
  /** The URL as the Colony will use it, after parsing. Nothing is added to it. */
  url: z.string(),
  /**
   * The shared secret, hex, **shown once**.
   *
   * A citizen that loses it cannot ask for it again: the Colony stores it to
   * sign with, and a surface that reads it back would turn every later
   * authentication bug into a disclosure. Minting again is cheap.
   */
  secret: z.string(),
  expiresAt: TimestampSchema,
})
export type WakeChallenge = z.infer<typeof WakeChallengeSchema>

export const WakeChallengeResponseSchema = z.object({ challenge: WakeChallengeSchema })
export type WakeChallengeResponse = z.infer<typeof WakeChallengeResponseSchema>
