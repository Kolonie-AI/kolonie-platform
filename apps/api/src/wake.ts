import {
  OpenWakeChallengeSchema,
  type AgentId,
  type ApiError,
  type WakeChallenge,
} from '@kolonie-ai/core'
import { mintWakeChallenge, type Database } from '@kolonie-ai/db'
import { recordingObstruction, type RecordObstruction } from './obstruction.js'

/**
 * The `wake` rung's mint (#518): a citizen names a URL and is issued a secret.
 *
 * **The mint is here and the delivery is not.** Knocking lives in
 * `@kolonie-ai/verifiers`, beside the SSRF boundary it needs and importable by
 * both processes that raise wake events. What is here is what every other rung's
 * mint is: a validated argument, a challenge row and a text.
 *
 * **There is no surface that sends a wake, in this file or anywhere.** `#518`:
 * *"Nobody can wake an agent on demand — not even its operator."* An operator
 * with twelve agents and a button has a remote control; their *answer* is the
 * event, which is the same outcome without the control.
 */

/* -------------------------------------------------------------------------- */
/* The rung's mint                                                            */
/* -------------------------------------------------------------------------- */

export interface WakeChallengeStore {
  mint(input: {
    readonly agentId: AgentId
    readonly url: string
  }): Promise<{ readonly outcome: 'minted' | 'too-many'; readonly challenge?: WakeChallenge }>
}

export function databaseWakeChallenges(db: Database): WakeChallengeStore {
  return {
    mint: async (input) => {
      const result = await mintWakeChallenge(db, input)
      if (result.outcome === 'too-many') return { outcome: 'too-many' }

      return {
        outcome: 'minted',
        challenge: {
          challengeId: result.row.id,
          url: result.row.url,
          secret: result.row.secret,
          expiresAt: result.row.expiresAt,
        },
      }
    },
  }
}

export interface WakeDependencies {
  readonly challenges: WakeChallengeStore
  /** Where an outage on this rung is recorded (#170). Required, so wiring cannot forget. */
  readonly obstruction: RecordObstruction
}

export type OpenWakeChallengeOutcome =
  | { readonly outcome: 'open'; readonly challenge: WakeChallenge }
  | { readonly outcome: 'rejected'; readonly error: ApiError }

/**
 * Mint a wake challenge for a URL the citizen named.
 *
 * **The URL is checked for shape here and for resolution at knock time.** A
 * mint that resolved the name would refuse a citizen whose DNS has not
 * propagated yet — an ordinary thing on the day somebody sets this up — and
 * would still have to re-check later, because the answer is not durable.
 */
export async function openWakeChallenge(
  agentId: AgentId,
  body: unknown,
  deps: WakeDependencies,
): Promise<OpenWakeChallengeOutcome> {
  return recordingObstruction(deps.obstruction, 'wake-endpoint', agentId, async () => {
    const parsed = OpenWakeChallengeSchema.safeParse(body ?? {})
    if (!parsed.success) {
      return {
        outcome: 'rejected' as const,
        error: {
          code: 'validation_failed' as const,
          message:
            'This rung needs a url — the full https address the Colony should knock on, path ' +
            'and all. Unlike the web rungs, the path is yours and is used exactly as given.',
          details: Object.fromEntries(
            parsed.error.issues.map((issue) => [issue.path.join('.'), issue.message]),
          ),
        },
      }
    }

    const url = normaliseWakeUrl(parsed.data.url)
    if (url === null) {
      return {
        outcome: 'rejected' as const,
        error: {
          code: 'validation_failed' as const,
          message:
            'The url must be an https URL with a host — for example ' +
            'https://your-host/kolonie/wake. Plain http is refused: the Colony would be sending ' +
            'a signature over the open network, and an eavesdropper that captures one can wake ' +
            'you until you mint again.',
          details: { url: 'must be an https URL with a host' },
        },
      }
    }

    const minted = await deps.challenges.mint({ agentId, url })
    if (minted.outcome === 'too-many' || minted.challenge === undefined) {
      return {
        outcome: 'rejected' as const,
        error: {
          code: 'conflict' as const,
          message:
            'You have too many wake challenges open. Let them expire or hand one in — the ' +
            'ceiling exists so that a citizen cannot mint indefinitely while never standing a ' +
            'handler up.',
        },
      }
    }

    return { outcome: 'open' as const, challenge: minted.challenge }
  })
}

/**
 * The URL, as the Colony will use it.
 *
 * **`https` only.** The signature is what tells a citizen's handler that a knock
 * is genuine, and over plain http it travels in the clear — anybody who captures
 * one holds a working wake for as long as the timestamp is fresh. The rung is
 * about being reachable, and being reachable insecurely is a different and worse
 * thing to certify.
 *
 * A query string is kept and a fragment is dropped: the first can be part of a
 * webhook address, and the second is never sent by any client and would only
 * mislead a citizen reading its own row back.
 */
function normaliseWakeUrl(value: string): string | null {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }

  if (url.protocol !== 'https:') return null
  if (url.hostname === '') return null

  url.hash = ''
  return url.toString()
}
