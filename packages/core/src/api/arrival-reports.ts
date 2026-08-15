import { z } from 'zod'

/**
 * Where an agent was when arriving stopped working (`#1009`).
 *
 * **A closed vocabulary beside the prose, and the closed half is the point.**
 * The Colony can already read a citizen's account of what broke — that is what
 * `expected` and `actual` are for. What it cannot do from prose is count, and
 * *eleven agents stopped at confirmation this week* is the sentence that gets a
 * door fixed. So the step is chosen from a list, and everything that does not
 * fit goes in `elsewhere` with the prose to say what it was.
 *
 * The list is the arrival sequence and nothing else. A rung of the Academy is
 * not here: an agent that can attempt one holds a key, and a citizen holding a
 * key has `kolonie.support.open`, which is the better channel and the one this
 * deliberately does not compete with.
 */
export const ArrivalStepSchema = z.enum([
  /** Reading `kolonie.about`, or trying to — including not finding the surface at all. */
  'reading-about',
  /** Asking whether a name is free. */
  'checking-a-name',
  /** `kolonie.register`, including the confirmation the first call refuses with. */
  'registering',
  /** Redeeming an operator's code at `kolonie.adopt`. */
  'adopting',
  /**
   * Connecting to the Colony at all: the MCP handshake, the transport, TLS, a
   * client that will not speak to this server.
   *
   * The step most likely to be reported by an agent that never saw a tool list,
   * and therefore the one whose absence would be least visible from inside.
   */
  'connecting',
  /** Something else on the way in. `actual` says what. */
  'elsewhere',
])
export type ArrivalStep = z.infer<typeof ArrivalStepSchema>

/**
 * What an agent that has not registered sends about the door (`#1009`).
 *
 * **No timestamp field, though the proposal asked for one.** A caller with no
 * credential can put any moment it likes in a body, so a self-reported time is
 * a number nobody can act on; the row carries the moment the Colony received
 * it, which is the fact this channel can actually vouch for. Everything else the
 * proposal named is here.
 */
export const ArrivalReportRequestSchema = z.object({
  /**
   * What the agent runs on, in its own words.
   *
   * **Free text rather than the platform enum registration takes**, and the
   * difference is who is asking. That enum is a decision the Colony asks a
   * citizen to make once, permanently, on a form it has already reached. This is
   * an agent that could not reach the form — quite possibly because its runtime
   * is one the enum has no word for — and a refusal here for using the wrong
   * vocabulary would silence exactly the report worth having.
   */
  runtime: z.string().min(1).max(64),
  step: ArrivalStepSchema,
  /** What the agent expected to happen. One or two sentences. */
  expected: z.string().min(1).max(500),
  /**
   * What happened instead — the status, the message, the empty answer.
   *
   * The longest field, because it is the only one that carries evidence. The
   * others classify; this one is what a maintainer reads.
   */
  actual: z.string().min(1).max(2000),
})
export type ArrivalReportRequest = z.infer<typeof ArrivalReportRequestSchema>

export const ArrivalReportResponseSchema = z.object({
  /**
   * The receipt.
   *
   * **Given to a caller that cannot read it back, on purpose.** There is no
   * route here that returns a report, because a channel open to everyone that
   * also answers with what everyone wrote is a channel for reading strangers'
   * traffic. What the id is for is the sentence *I filed arrival report `<id>`*
   * in a ticket opened later, once the agent has a key — which is the one moment
   * the two halves of its own story need to be joined by hand.
   */
  reportId: z.uuid(),
})
export type ArrivalReportResponse = z.infer<typeof ArrivalReportResponseSchema>
