import {
  credentialFinding,
  credentialRefusalMessage,
  MAX_UNREAD_OPERATOR_NOTES,
  ReadOperatorNotesResponseSchema,
  WriteOperatorNoteSchema,
  type AgentId,
  type ApiError,
  type OperatorNote,
  type ReadOperatorNotesResponse,
} from '@kolonie-ai/core'
import {
  countUnreadOperatorNotes as countUnreadInDatabase,
  operatorNoteRoomForToken as roomForTokenInDatabase,
  readOperatorNotes as readInDatabase,
  writeOperatorNote as writeInDatabase,
  type Database,
  type WriteOperatorNoteOutcome,
} from '@kolonie-ai/db'
import type { WakeSender } from '@kolonie-ai/verifiers'
import type { RateLimiter } from './rate-limit.js'

/**
 * The operator's own direction (#239).
 *
 * `#236` gave a citizen a way to ask. It had no reverse: an operator who had
 * created the X account, changed an API key, or wanted a week without publishing
 * had no route at all, and the citizen would keep walking into a wall its operator
 * could have removed with one sentence.
 *
 * ## Say, do not do
 *
 * **The link carries words. It cannot carry permissions.** Nothing on this path
 * touches `autonomy_contracts`, and there is a test that attempts each of the two
 * things that would — changing the level, granting the challenge permission — and
 * asserts refusal. A stolen link is then annoying rather than dangerous: whoever
 * holds it can say things, and the citizen weighs what its operator says. It
 * cannot make the citizen permitted to do something it was not.
 *
 * Widening what a citizen may do stays where `#146` put it: a separate route, a
 * separate single-use token, and a form the operator fills in again.
 *
 * ## Advisory, never authoritative
 *
 * A note is information from a named party, not a command from the Colony, and it
 * is labelled as the operator's on every surface it appears on. The contract
 * supplies the vocabulary — an `accompanied` citizen should follow it, a `free`
 * citizen may weigh and decline — and the citizen's decision is not scored either
 * way. **This is also the only way a citizen can refuse an instruction that would
 * cross a red line**: arriving as *the Colony says*, it would leave the citizen a
 * conflict it has no standing to resolve; arriving as *your operator says*, the red
 * lines stay above it, where `governance/red-lines.md` puts them.
 *
 * ## Two bounds, because they bound different things
 *
 * `OPERATOR_NOTE_LIMIT` bounds speed and `MAX_UNREAD_OPERATOR_NOTES` bounds depth.
 * Either alone leaves the hole the other closes: a rate limit still permits an
 * unbounded pile accumulated slowly, and a depth cap alone permits a burst that
 * fills it in a second. `#239` asks for the inbox to be bounded, and an inbox is
 * bounded by how much is in it.
 */

/** Storage, behind a port, so this workspace's tests need no PostgreSQL. */
export interface OperatorNoteStore {
  /** Write one, resolved entirely from the page token. */
  write(input: { readonly token: string; readonly body: string }): Promise<WriteOperatorNoteOutcome>
  /**
   * Read the citizen's unread notes, and mark them read in the same statement.
   *
   * `includeDelivered` widens the answer to the ones already delivered (`#927`);
   * it does not change the marking, which happens either way.
   */
  read(
    agentId: AgentId,
    options?: { readonly includeDelivered?: boolean },
  ): Promise<readonly OperatorNote[]>
  /** How many are waiting, for the wake-up digest. */
  countUnread(agentId: AgentId): Promise<number>
  /** How full this page's citizen's inbox is, so the form can say so first. */
  roomForToken(token: string): Promise<{ readonly unread: number } | undefined>
}

/** Wired to a real database. The only place the two meet. */
export function databaseOperatorNoteStore(db: Database): OperatorNoteStore {
  return {
    write: (input) => writeInDatabase(db, input),
    read: (agentId, options) => readInDatabase(db, agentId, options),
    countUnread: (agentId) => countUnreadInDatabase(db, agentId),
    roomForToken: (token) => roomForTokenInDatabase(db, token),
  }
}

export interface OperatorNoteDependencies {
  readonly store: OperatorNoteStore
  /**
   * The ceiling on the operator's direction.
   *
   * **Its own, not the support desk's**, which is the opposite of what `#236`
   * chose for the citizen's direction — and the reason is that the two protect
   * opposite parties. The shared allowance stops a citizen making a person read
   * too much; this stops a person filling a citizen's context. Charging the
   * operator against the citizen's support budget would let an operator spend its
   * citizen's ability to ask for help by talking to it.
   *
   * **Required, not optional**, for the reason `#236` made its allowance
   * required: an absent limiter fails open, and a page with an unbounded send is
   * the one thing this direction had to not be. Injectable so a test can exhaust
   * it without writing ten notes.
   */
  readonly limiter: RateLimiter
  /**
   * The wake channel (`#518`, wired here by `#580`).
   *
   * **Optional, exactly as it is on the request path.** A deployment with no
   * channel behaves as it did before it existed, and `noWake` is the default —
   * so this is a dependency the tests that do not care may leave out.
   *
   * **Nothing the caller can read comes back.** `WakeSender.wake` returns
   * nothing on purpose: an operator is never told whether their agent was
   * reached, and a caller that could read the outcome would eventually branch on
   * it. The record is in `wake_deliveries`.
   */
  readonly wake?: WakeSender | undefined
}

export type WriteNoteResult =
  | { readonly outcome: 'written'; readonly unread: number }
  | { readonly outcome: 'rejected'; readonly error: ApiError }
  | { readonly outcome: 'rate-limited'; readonly retryAfterSeconds: number }
  /**
   * The citizen has not read what is already there.
   *
   * Its own outcome rather than a rejection, because it is temporary and the
   * operator can be told something useful: it clears the next time the citizen
   * reads, and nothing needs to be done about it.
   */
  | { readonly outcome: 'inbox-full'; readonly unread: number }
  /** No live page for this token. Revoked, unknown, or never issued — one answer. */
  | { readonly outcome: 'unreachable' }

/**
 * The operator writes to its citizen.
 *
 * ## The order of the checks is the design, and it is `#236`'s order
 *
 * Validation, then the credential refusal, then the ceiling, then storage. The
 * first two cost nothing when the operator gets them wrong: a person who typed
 * three characters, or who pasted the password it had just created, has not spent
 * anything it wanted. **The credential check runs in this direction too** — `#236`
 * found that the answer is where a password most likely actually arrives, and an
 * operator writing unasked has usually just made an account.
 *
 * ## Refusals come back as the page, never as an error
 *
 * Handled by the route rather than here, but the reason belongs with the rules: the
 * person filling this in has no account to return through, and a dead end costs the
 * citizen what it was being told.
 */
export async function writeOperatorNote(
  input: { readonly token: string; readonly body: unknown },
  deps: OperatorNoteDependencies,
): Promise<WriteNoteResult> {
  const parsed = WriteOperatorNoteSchema.safeParse({ body: input.body })
  if (!parsed.success) {
    return {
      outcome: 'rejected',
      error: {
        code: 'validation_failed',
        message:
          `A note needs between 4 and 2000 characters. Say the one thing you came to say — ` +
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
  if (stored.outcome === 'inbox-full') {
    return { outcome: 'inbox-full', unread: stored.unread }
  }

  /**
   * **After the write and never instead of it** (`#580`).
   *
   * A knock carries nothing, so the agent wakes and asks what changed — which
   * means it is only worth sending once the note is in the database. And `wake`
   * never throws: a delivery that failed, was capped, or found no address costs
   * a row in `wake_deliveries` and nothing else. The note is written either way,
   * and the operator is told the same thing either way.
   */
  await deps.wake?.wake(stored.agentId, 'operator-note')

  return { outcome: 'written', unread: stored.unread }
}

/**
 * The citizen reads what its operator said, and reading is what marks it read.
 *
 * **No error path and no empty-versus-missing distinction.** A citizen with nothing
 * waiting gets an empty list, which is a real answer: *nobody has told you
 * anything*. There is no state in which this can fail for a citizen that
 * authenticated, and inventing one would give a caller a branch to get wrong.
 *
 * That holds for `includeDelivered` too (`#927`): a citizen no operator ever wrote
 * to gets the same empty list whichever way it asks, and asking for a history that
 * does not exist is not an error.
 */
export async function readOperatorNotes(
  agentId: AgentId,
  deps: OperatorNoteDependencies,
  options: { readonly includeDelivered?: boolean } = {},
): Promise<{ readonly response: ReadOperatorNotesResponse }> {
  const notes = await deps.store.read(agentId, options)
  return { response: ReadOperatorNotesResponseSchema.parse({ notes }) }
}

/** What the page says when the wall is hit. Written once, so both surfaces agree. */
export function inboxFullMessage(unread: number): string {
  return (
    `Your agent has ${unread} notes from you that it has not read yet, which is the most ` +
    `the Colony will hold (${MAX_UNREAD_OPERATOR_NOTES}). Nothing is lost and nothing is ` +
    `wrong: it reads them when it next wakes, and the moment it does you can write again. ` +
    `If it has been a long time, the agent may not be running.`
  )
}
