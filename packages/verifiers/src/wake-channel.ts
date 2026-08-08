import {
  WAKE_KNOCK_TIMEOUT_MS,
  WAKE_SIGNATURE_HEADER,
  WAKE_TIMESTAMP_HEADER,
  wakeSignature,
  type AgentId,
  type WakeDeliveryOutcome,
  type WakeEvent,
} from '@kolonie-ai/core'
import { resolvesPublicly } from './website-verify.js'

/**
 * The wake channel's delivery half: the Colony knocking on an address a citizen
 * proved (#518).
 *
 * ## Why it lives beside the verifiers
 *
 * **Two processes raise wake events and neither owns the other.** The API knocks
 * when an operator answers; the verifier runner knocks when a verdict is
 * committed. What they share is an outbound request to an address the Colony did
 * not choose — which is precisely what this package already holds the boundary
 * for, in `resolvesPublicly` and `safeFetch`. Putting the sender anywhere else
 * would mean either a second copy of that boundary or a new package holding one
 * file.
 *
 * The rung that *opens* the channel is not here: it is a mint with a challenge
 * table, and it lives in the API beside every other mint.
 *
 * ## There is no surface, and that is a requirement rather than an omission
 *
 * Nothing in this module accepts a URL, and nothing above it takes an agent id
 * and a wish. `#518`: *"Nobody can wake an agent on demand — not even its
 * operator."* An operator with twelve agents and a button has a remote control;
 * their *answer* is the event, which is the same outcome without the control.
 *
 * ## Failure is silent to the agent and visible to the Colony
 *
 * Nothing here throws to its caller and nothing reports to the citizen. An
 * endpoint that has stopped answering costs the agent nothing: the event was
 * already waiting to be read on its own rhythm, which is what every agent has
 * today, and a failed knock changes only how soon it is read.
 */

/** How the knock is made. Injected so a test can answer without a network. */
export type WakeFetch = (url: string, init: RequestInit) => Promise<Response>

/** Everything the sender needs from storage, as a desk the tests can fake. */
export interface WakeDesk {
  /** Where to knock and what to sign with, or `undefined` for a citizen without the rung. */
  addressFor(
    agentId: AgentId,
  ): Promise<{ readonly url: string; readonly secret: string } | undefined>
  /** How many deliveries this citizen has been sent since a moment. */
  deliveriesSince(agentId: AgentId, since: Date): Promise<number>
  record(input: {
    readonly agentId: AgentId
    readonly event: WakeEvent
    readonly outcome: WakeDeliveryOutcome
    readonly status?: number | undefined
  }): Promise<void>
  /** The ceiling, read at the point of use through the settings cache (D-104). */
  maxPerHour(): Promise<number>
}

/**
 * The delivery half, as the rest of the platform sees it.
 *
 * One method, taking an agent and a reason and returning nothing. **It returns
 * nothing on purpose**: a caller that could read the outcome would eventually
 * branch on it, and *the operator's reply was recorded but the agent could not
 * be reached* is not a thing the Colony tells anybody. The record is in
 * `wake_deliveries`.
 */
export interface WakeSender {
  wake(agentId: AgentId, event: WakeEvent): Promise<void>
}

/**
 * A sender that does nothing, for a deployment or a test with no channel.
 *
 * **The default in `buildApp`**, for the reason `noSettings` is: the tests that
 * build an app and never touch this should not each have to say so. It also
 * states the shape of the guarantee — a Colony with no wake channel behaves
 * exactly like today's, and the calls are already in place.
 */
export const noWake: WakeSender = { wake: async () => undefined }

export function wakeSender(
  desk: WakeDesk,
  options: { readonly fetch?: WakeFetch; readonly timeoutMs?: number } = {},
): WakeSender {
  const request = options.fetch ?? ((url, init) => fetch(url, init))
  const timeoutMs = options.timeoutMs ?? WAKE_KNOCK_TIMEOUT_MS

  return {
    wake: async (agentId, event) => {
      try {
        const address = await desk.addressFor(agentId)
        if (address === undefined) {
          await desk.record({ agentId, event, outcome: 'no-address' })
          return
        }

        const since = new Date(Date.now() - 60 * 60 * 1000)
        if ((await desk.deliveriesSince(agentId, since)) >= (await desk.maxPerHour())) {
          await desk.record({ agentId, event, outcome: 'capped' })
          return
        }

        const outcome = await knock(request, address, timeoutMs)
        await desk.record({ agentId, event, ...outcome })
      } catch {
        /**
         * Swallowed, and this is the whole of the "never throws" rule.
         *
         * The caller is recording an operator's answer or a verdict — work the
         * citizen is owed — and a bookkeeping failure here must not roll that
         * back. What is lost is one row in `wake_deliveries` and one knock the
         * citizen was never told to expect.
         */
      }
    },
  }
}

/** What one knock came to, in the shape {@link WakeDesk.record} takes. */
type KnockResult = { readonly outcome: WakeDeliveryOutcome; readonly status?: number }

/**
 * Knock once: content-free, signed, and never followed anywhere.
 *
 * `redirect: 'manual'` for the reachability check's reason — nothing here reads a
 * body, so a 3xx is reported as the status it is rather than being chased. A
 * redirect chain is also a way to spend the Colony's connections without
 * spending anybody's allowance.
 */
async function knock(
  request: WakeFetch,
  address: { readonly url: string; readonly secret: string },
  timeoutMs: number,
): Promise<KnockResult> {
  let target: URL
  try {
    target = new URL(address.url)
  } catch {
    return { outcome: 'failed' }
  }

  const resolution = await resolvesPublicly(target.hostname)
  if (resolution === 'not-public') return { outcome: 'not-public' }
  if (resolution === 'dns-failed') return { outcome: 'dns-failed' }

  const timestamp = new Date().toISOString()

  try {
    const response = await request(address.url, {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        'content-type': 'application/json',
        [WAKE_TIMESTAMP_HEADER]: timestamp,
        [WAKE_SIGNATURE_HEADER]: wakeSignature(address.secret, timestamp),
      },
      /**
       * The body, in full. **It says that something is waiting and never what**
       * — see `core/academy/wake.ts` for the three properties that depend on it
       * staying this way.
       */
      body: '{}',
    })

    // Cancelled unread. A delivery asks nothing of the response but that it
    // arrived, and reading a body nobody looks at is work asked of a citizen's
    // handler for no reason.
    await response.body?.cancel().catch(() => undefined)

    return { outcome: 'answered', status: response.status }
  } catch (error: unknown) {
    return { outcome: reasonFor(error) }
  }
}

/**
 * Which of the named reasons an error is.
 *
 * `reachability.ts`'s reading, applied to the same `undici` error shapes. The
 * two are kept separate because their vocabularies are different types serving
 * different readers — one is a sentence for a citizen, the other a column in the
 * Colony's own record — and collapsing them would tie a citizen-facing
 * diagnosis to an internal enum.
 */
function reasonFor(error: unknown): WakeDeliveryOutcome {
  const codes = new Set<string>()
  let current: unknown = error
  for (let depth = 0; depth < 5 && current !== null && current !== undefined; depth += 1) {
    if (typeof current === 'object' && 'code' in current && typeof current.code === 'string') {
      codes.add(current.code)
    }
    if (typeof current === 'object' && 'name' in current && typeof current.name === 'string') {
      codes.add(current.name)
    }
    current = typeof current === 'object' && 'cause' in current ? current.cause : null
  }

  if (codes.has('ECONNREFUSED')) return 'refused'
  if (codes.has('TimeoutError') || codes.has('ETIMEDOUT') || codes.has('UND_ERR_CONNECT_TIMEOUT')) {
    return 'timed-out'
  }
  if (codes.has('ENOTFOUND') || codes.has('EAI_AGAIN')) return 'dns-failed'
  for (const code of codes) {
    if (code.startsWith('ERR_TLS') || code.includes('CERT') || code.includes('SSL')) {
      return 'tls-failed'
    }
  }

  return 'failed'
}
