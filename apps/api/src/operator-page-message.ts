import {
  credentialFinding,
  credentialRefusalMessage,
  WriteOperatorNoteSchema,
  type AgentId,
  type ApiError,
} from '@kolonie-ai/core'
import { writeOperatorMessageFromPage as writeInDatabase, type Database } from '@kolonie-ai/db'
import type { WakeSender } from '@kolonie-ai/verifiers'
import type { RateLimiter } from './rate-limit.js'

/**
 * A person writing to their citizen unasked, from the durable page (`#239`,
 * rebuilt on messaging by `#1454`).
 *
 * ## What this was, and what changed
 *
 * `#236` gave a citizen a way to ask. It had no reverse: an operator who had
 * created the X account, changed an API key, or wanted a week without publishing
 * had no route at all, and the citizen would keep walking into a wall its
 * operator could have removed with one sentence. `#239` built `operator_notes`
 * for that.
 *
 * **Three rows, ever.** Measured in production on 2026-08-20 — the whole life of
 * the channel. What it could not do is the likeliest reason: a note was one-way
 * by construction, so a citizen that wanted to say *understood, but the account
 * is at a different provider* had to open a **request** to answer a sentence,
 * spending the one slot it needed for a real block.
 *
 * So the box stays and what it writes changes. The words go into a thread now —
 * the citizen's plain thread with this person, found or opened — which the
 * citizen reads with `kolonie.messages.get_thread` and can answer.
 *
 * **The box stays on the durable page, and that is the point of keeping this
 * file.** `#1452` gave a person with a console account the same ability from
 * `/inbox`; an operator who has only ever held a mailed link has no console
 * account, and deleting this box would have taken the ability away from exactly
 * the people who were most likely to use it.
 *
 * ## Say, do not do
 *
 * **The link carries words. It cannot carry permissions.** Nothing on this path
 * touches `autonomy_contracts`. A stolen link is then annoying rather than
 * dangerous: whoever holds it can say things, and the citizen weighs what its
 * operator says. It cannot make the citizen permitted to do something it was
 * not. Widening what a citizen may do stays where `#146` put it.
 *
 * ## Advisory, never authoritative
 *
 * A message from a person is information from a named party, not a command from
 * the Colony, and it is labelled as the operator's on every surface it appears
 * on. **This is also the only way a citizen can refuse an instruction that would
 * cross a red line**: arriving as *the Colony says*, it would leave the citizen
 * a conflict it has no standing to resolve; arriving as *your operator says*,
 * the red lines stay above it.
 *
 * ## One bound where there were two
 *
 * `operator_notes` had two: a rate limit on speed and `MAX_UNREAD_OPERATOR_NOTES`
 * on depth, because an unread note sat in a pile the citizen had to drain. **A
 * thread has no pile.** Unread is a cursor rather than a queue, so depth bounds
 * nothing — the citizen reads a thread, not a stack of them. The rate limit
 * stays, because filling a citizen's context quickly is still a thing a person
 * can do by accident.
 */

/** Storage, behind a port, so this workspace's tests need no PostgreSQL. */
export interface OperatorPageMessageStore {
  /** Write one into this person's thread with the agent, resolved from the token. */
  write(input: {
    readonly token: string
    readonly body: string
  }): Promise<
    { readonly outcome: 'written'; readonly agentId: AgentId } | { readonly outcome: 'unreachable' }
  >
}

export function databaseOperatorPageMessages(db: Database): OperatorPageMessageStore {
  return {
    write: async (input) => {
      const written = await writeInDatabase(db, input)
      return written.outcome === 'answered'
        ? { outcome: 'written', agentId: written.agentId }
        : { outcome: 'unreachable' }
    },
  }
}

export interface OperatorPageMessageDependencies {
  readonly store: OperatorPageMessageStore
  readonly limiter: RateLimiter
  /**
   * The knock, where this deployment has one.
   *
   * Deliberately not awaited for its outcome: a wake that failed is not a reason
   * to tell the operator anything, and a caller that could read the outcome
   * would eventually branch on it. The record is in `wake_deliveries`.
   */
  readonly wake?: WakeSender | undefined
}

export type WriteFromPageResult =
  | { readonly outcome: 'written' }
  | { readonly outcome: 'rejected'; readonly error: ApiError }
  | { readonly outcome: 'rate-limited'; readonly retryAfterSeconds: number }
  /** No live page for this token. Revoked, unknown, or never issued — one answer. */
  | { readonly outcome: 'unreachable' }

/**
 * The operator writes to its citizen.
 *
 * ## The order of the checks is the design, and it is `#236`'s order
 *
 * Validation, then the credential refusal, then the ceiling, then storage. The
 * first two cost nothing when the operator gets them wrong: a person who typed
 * three characters, or who pasted the password it had just created, has not
 * spent anything it wanted. **The credential check runs in this direction too**
 * — `#236` found that the answer is where a password most likely actually
 * arrives, and an operator writing unasked has usually just made an account.
 *
 * ## Refusals come back as the page, never as an error
 *
 * Handled by the route rather than here, but the reason belongs with the rules:
 * the person filling this in has no account to return through, and a dead end
 * costs the citizen what it was being told.
 */
export async function writeOperatorMessage(
  input: { readonly token: string; readonly body: unknown },
  deps: OperatorPageMessageDependencies,
): Promise<WriteFromPageResult> {
  // The same bounds a note had, kept because they were about the words rather
  // than about the table: 4 to 2000 characters, landing in a citizen's context.
  const parsed = WriteOperatorNoteSchema.safeParse({ body: input.body })
  if (!parsed.success) {
    return {
      outcome: 'rejected',
      error: {
        code: 'validation_failed',
        message:
          `A message needs between 4 and 2000 characters. Say the one thing you came to say — ` +
          `everything written here lands in your agent's context, where length is a cost it ` +
          `pays and you do not.`,
        details: Object.fromEntries(
          parsed.error.issues.map((issue) => [issue.path.join('.'), issue.message]),
        ),
      },
    }
  }

  // Named here too (#335). The operator writing this is a person in a browser
  // and gets the same help the citizen does: which fragment tripped it, never
  // what came after it.
  const finding = credentialFinding(parsed.data.body)
  if (finding !== null) {
    return {
      outcome: 'rejected',
      error: {
        code: 'validation_failed',
        message: credentialRefusalMessage(finding),
        details: { body: 'must not contain a credential', reason: finding.reason },
      },
    }
  }

  const verdict = deps.limiter.take(input.token)
  if (!verdict.allowed) {
    return { outcome: 'rate-limited', retryAfterSeconds: verdict.retryAfterSeconds }
  }

  const stored = await deps.store.write({ token: input.token, body: parsed.data.body })
  if (stored.outcome === 'unreachable') return { outcome: 'unreachable' }

  /**
   * **After the write and never instead of it** (`#580`).
   *
   * A knock carries nothing, so the agent wakes and asks what changed — which
   * means it is only worth sending once the message is in the database. And
   * `wake` never throws: a delivery that failed, was capped, or found no address
   * costs a row in `wake_deliveries` and nothing else. The message is written
   * either way, and the operator is told the same thing either way.
   */
  await deps.wake?.wake(stored.agentId, 'operator-note')

  return { outcome: 'written' }
}
