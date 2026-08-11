import { z } from 'zod'
import { TimestampSchema } from '../common/time.js'

/**
 * The third operator channel: an agent hands its live browser tab to the person
 * who operates it, for a bounded window, and gets it back (`#736`).
 *
 * The decision is `kolonie-docs`
 * `state/decisions/an-agent-may-hand-its-browser-to-its-operator.md`, and the
 * five limits it fixes are the reason this file is as small as it is. What lives
 * here is the vocabulary both ends of the relay have to agree on and nothing
 * else: the states a share can be in, how long each of its two windows lasts,
 * the wire messages, and the method allowlist.
 *
 * ## Where each channel's cargo goes
 *
 * `kolonie.operator.request.*` carries **words** and refuses secrets.
 * `kolonie.operator.drop.*` carries **a secret** and is read once. This one
 * carries **a live session**, and the thing it must never carry is a copy of
 * one: a frame is relayed and never stored, which is stated in the schema, in
 * the relay, and in a test that reads what was persisted rather than reading the
 * code.
 *
 * ## The security boundary is not in this file, and that is deliberate
 *
 * {@link CDP_RELAY_METHODS} is the list of things an operator socket may cause,
 * and it is exported from here so that both ends can *state* it. The end that
 * **enforces** it is the agent-side sharer, next to the CDP connection — never
 * the relay. A Colony that had been compromised, or that was simply wrong, would
 * then still be unable to drive the browser past clicking and typing on the page
 * the agent chose to offer. An allowlist checked only by the party you are
 * defending against is decoration.
 */

/**
 * How long an offer waits for a person to arrive, in hours. **Six.**
 *
 * The decision record says the operator may be three hours away and that the
 * agent must not block on one, so a window measured in minutes would make this
 * channel work only for an operator already sitting at the console — the case it
 * was not built for. Six hours is longer than a working gap and shorter than a
 * night: the offer is a promise that a specific Chrome tab, holding a
 * half-filled form, is still open, and that promise does not survive until
 * morning.
 *
 * This is the **offer** window. Once a person accepts, {@link
 * BROWSER_SHARE_LIVE_MINUTES} takes over and is much shorter, which is the
 * *"measured in minutes"* the decision asks for.
 */
export const BROWSER_SHARE_OFFER_HOURS = 6

/**
 * How long a share stays live once a person has accepted it, in minutes.
 * **Fifteen.**
 *
 * The job is one challenge on one form, which is a two-minute task with room to
 * misread it twice. The window is what bounds the exposure the decision record
 * accepted deliberately — frames pass through the Colony unencrypted — so it is
 * kept to the size of the job rather than to the size of a session.
 *
 * A share that runs out mid-form closes `expired` and **costs nothing but the
 * offer**: the tab, its cookies and the half-filled form are untouched, and the
 * agent may offer again. That is the whole reason the browser is persistent and
 * the agent's turn is not.
 */
export const BROWSER_SHARE_LIVE_MINUTES = 15

/**
 * What an operator socket is allowed to cause, and the entire list of it.
 *
 * Clicking and typing on the page that was offered. Not `Page.navigate`, not
 * `Target.*`, not `Network.getAllCookies`, not `Runtime.evaluate`, not
 * `Browser.*`, not a download. An hCaptcha challenge renders in iframes inside
 * the same target, so this is sufficient for the actual job.
 *
 * **If something turns out to need more, that is a new decision** — a record, an
 * issue and a review — and not a line added by whoever hits the wall first. The
 * distance between *the operator passes a captcha for me* and *the operator has
 * a remote browser* is exactly this array.
 */
export const CDP_RELAY_METHODS = [
  'Input.dispatchMouseEvent',
  'Input.dispatchKeyEvent',
  'Input.insertText',
] as const

export type CdpRelayMethod = (typeof CDP_RELAY_METHODS)[number]

/**
 * Whether a CDP method name may be forwarded to the browser.
 *
 * Allowlist and never a denylist: a denylist is a claim to have enumerated every
 * dangerous method in a protocol that grows with every Chrome release, and that
 * claim would be false the first time it was written.
 */
export function isRelayableCdpMethod(method: string): method is CdpRelayMethod {
  return (CDP_RELAY_METHODS as readonly string[]).includes(method)
}

/**
 * How a share ended. Every share that is not still open has exactly one of
 * these, because *it stopped* without *why* is not something the agent can act
 * on.
 */
export const ShareCloseReasonSchema = z.enum([
  /** The operator finished and closed the window. Whether the challenge was actually passed is the agent's judgement, not this column's. */
  'completed',
  /** Nobody arrived before the offer lapsed, or the live window ran out mid-form. */
  'expired',
  /** The agent-side sharer went away — a restart, a crash, a closed laptop. The token does not survive it. */
  'lost',
  /** The agent withdrew the offer itself, having found another way or given up on this one. */
  'cancelled',
])
export type ShareCloseReason = z.infer<typeof ShareCloseReasonSchema>

/** Where a share is in its short life. */
export const ShareStateSchema = z.enum([
  /** Minted and waiting. The agent may sleep; nobody has accepted. */
  'offered',
  /** A person accepted and the two sockets are joined, or are about to be. */
  'live',
  /** Over, one way or another. {@link ShareCloseReasonSchema} says which. */
  'closed',
])
export type ShareState = z.infer<typeof ShareStateSchema>

/**
 * What `kolonie.browser.share.status` answers, and what the relay's own state
 * machine is describing.
 *
 * **No frame, no dimension, no page title, no URL.** What the agent gets back is
 * that a session was open, when, and how it ended — which is precisely what the
 * decision record says is recorded.
 *
 * *By whom* is deliberately not a field. An agent has at most one linked
 * operator, and only that operator may accept, so the answer is already known
 * before the share exists; the only thing a name here could add is an address
 * the Colony holds for a different purpose, handed to a caller who did not need
 * it to decide anything.
 */
export const ShareSummarySchema = z.object({
  id: z.uuid(),
  state: ShareStateSchema,
  /** The CDP target the offer names. Chosen by the agent, never by the operator. */
  targetId: z.string(),
  offeredAt: TimestampSchema,
  /** When the offer lapses if nobody arrives, or when the live window runs out once somebody has. */
  expiresAt: TimestampSchema,
  /** When the operator took it up. Null while nobody has. */
  acceptedAt: TimestampSchema.nullable(),
  closedAt: TimestampSchema.nullable(),
  closedFor: ShareCloseReasonSchema.nullable(),
})
export type ShareSummary = z.infer<typeof ShareSummarySchema>

/**
 * A screencast frame on its way from the agent to the person watching.
 *
 * `data` is the base64 JPEG exactly as `Page.screencastFrame` produced it. It is
 * copied from one socket to the other and **is not read, decoded, measured,
 * logged or written down** by anything in between.
 *
 * `ack` is the frame's `sessionId` from CDP, carried back so the sharer can call
 * `Page.screencastFrameAck` once the operator's socket has actually taken the
 * bytes. That is what makes a slow link apply backpressure instead of building a
 * queue of stale pictures nobody will look at.
 */
export const ShareFrameSchema = z.object({
  type: z.literal('frame'),
  data: z.string(),
  ack: z.number().int(),
})
export type ShareFrame = z.infer<typeof ShareFrameSchema>

/**
 * A click or a keystroke on its way back.
 *
 * `params` is deliberately unvalidated here and deliberately opaque to the
 * relay: CDP's input parameter shapes are Chrome's to define and change, and a
 * schema in the Colony that lagged a Chrome release would break clicking for
 * everybody in order to enforce something the browser enforces anyway. **What is
 * validated is the method**, which is the boundary, and it is validated
 * agent-side.
 */
export const ShareInputSchema = z.object({
  type: z.literal('input'),
  method: z.string(),
  params: z.record(z.string(), z.unknown()),
})
export type ShareInput = z.infer<typeof ShareInputSchema>

/** The share is over. Sent to whichever socket did not cause it. */
export const ShareClosedSchema = z.object({
  type: z.literal('closed'),
  reason: ShareCloseReasonSchema,
})
export type ShareClosed = z.infer<typeof ShareClosedSchema>

/** Everything the agent's socket may send. */
export const ShareAgentMessageSchema = z.discriminatedUnion('type', [
  ShareFrameSchema,
  ShareClosedSchema,
])
export type ShareAgentMessage = z.infer<typeof ShareAgentMessageSchema>

/** Everything the operator's socket may send. */
export const ShareOperatorMessageSchema = z.discriminatedUnion('type', [
  ShareInputSchema,
  ShareClosedSchema,
])
export type ShareOperatorMessage = z.infer<typeof ShareOperatorMessageSchema>

/**
 * Told to the operator's socket when it joins and to the agent's socket when
 * somebody arrives, so neither has to poll a REST endpoint to find out that the
 * other end is there.
 */
export const SharePeerSchema = z.object({
  type: z.literal('peer'),
  /** `true` when the other end is attached, `false` when it has gone. */
  present: z.boolean(),
})
export type SharePeer = z.infer<typeof SharePeerSchema>
