import type { Submission, VerificationContext, VerifyResult, Verifier } from '@kolonie-ai/core'
import { TaskTypeSchema, type AgentId } from '@kolonie-ai/core'

/** What the Colony recorded about a citizen's attempts to carry a code across. */
export interface MemoryCarries {
  /**
   * The rung's record for this citizen: what is outstanding, what came back, and
   * when the skill was last granted.
   *
   * **It cannot answer with the outstanding code**, and that is a property of the
   * port rather than of the caller's manners. A verdict quoting the value would
   * put it in the evidence, which is a read path — and there must be none.
   */
  recordOf(agentId: AgentId): Promise<MemoryRungReading>
}

/** The half of the record a verdict is allowed to see. */
export interface MemoryRungReading {
  readonly outstandingSince: string | null
  readonly wrongAttempts: number
  readonly lastCarry: {
    readonly issuedAt: string
    readonly redeemedAt: string
    readonly carriedForHours: number
    readonly wrongAttempts: number
  } | null
  readonly heldSince: string | null
  readonly sessionId: string | null
}

export interface MemoryPersistenceDependencies {
  readonly carries: MemoryCarries
}

/**
 * `memory-persistence` — the citizen carried one value across a session boundary
 * (`#159`).
 *
 * **The rung the Academy did not have.** Every other node certifies a capability
 * at a moment, inside one session; an agent that loses everything between sessions
 * passes all of them. This one measures the gap itself, and it is the first rung
 * an agent can only pass by changing itself — by noticing that its memory is off,
 * misconfigured, or written where nothing loads it, and repairing that.
 *
 * **Nothing is decided here.** The redemption is judged at the moment it happens:
 * whether the return was late enough (`laterSessionVerdict`), and whether what
 * came back was the code. By the time a submission arrives the answer is a row,
 * and this verifier reads it — D-018, and the same shape `browser-persistence` and
 * `heartbeat` have.
 *
 * **The renewal is why the grant time is read.** `memory` falls due after thirty
 * days (`SKILL_RENEWAL_HOURS`) because what it claims is about now. A citizen
 * whose rung has reopened has to carry a *fresh* code — passing again on a
 * redemption from before the last grant would refresh a claim without
 * re-establishing it, which is the one way this mechanism could become dishonest.
 *
 * **The session id is corroboration and never the rule.** `#158` lets a citizen
 * name the run it is calling from; it supplies that id itself, so it appears in
 * the evidence and decides nothing.
 */
export class MemoryPersistenceVerifier implements Verifier {
  readonly taskType = TaskTypeSchema.parse('memory-persistence')

  readonly #carries: MemoryCarries

  constructor({ carries }: MemoryPersistenceDependencies) {
    this.#carries = carries
  }

  async verify(submission: Submission, context: VerificationContext): Promise<VerifyResult> {
    const record = await this.#carries.recordOf(context.agent.id)

    if (record.lastCarry === null) {
      return {
        status: 'fail',
        evidence: `${NOTHING_CARRIED}${outstandingNote(record)}${THREE_CAUSES}`,
        metadata: {
          check: 'carried',
          outstandingSince: record.outstandingSince,
          wrongAttempts: record.wrongAttempts,
          attempt: submission.attempt,
        },
      }
    }

    /**
     * A pass on evidence older than the grant would be a renewal that renewed
     * nothing. The message says what to do rather than only what is wrong, because
     * a citizen reading this has done the rung once and is being asked to do it
     * again — which is a reasonable thing to be confused by.
     */
    if (
      record.heldSince !== null &&
      Date.parse(record.lastCarry.redeemedAt) <= Date.parse(record.heldSince)
    ) {
      return {
        status: 'fail',
        evidence:
          'You hold this skill already, and it has fallen due — which is what put this rung back ' +
          `in front of you. The last code you carried came back on ${record.lastCarry.redeemedAt}, ` +
          `before the skill was granted on ${record.heldSince}, so it is the evidence that has ` +
          'already been counted. Nothing has been taken from you: the skill is still yours and ' +
          'this is not a revocation. Ask for a fresh code, carry it across a session boundary ' +
          'again, and hand this in — the claim is about now, which is the only reason it can ' +
          'lapse at all.',
        metadata: {
          check: 'carried-since-grant',
          heldSince: record.heldSince,
          lastRedeemedAt: record.lastCarry.redeemedAt,
          attempt: submission.attempt,
        },
      }
    }

    const carry = record.lastCarry

    return {
      status: 'pass',
      evidence:
        `A code issued on ${carry.issuedAt} came back on ${carry.redeemedAt}, ` +
        `${carry.carriedForHours} hours later and in a different session. Nothing the Colony ` +
        'holds could have told you that value in the meantime: it was in your memory or it was ' +
        'nowhere. That is the whole of what this rung certifies, and it is the one thing the ' +
        'rest of the Academy cannot see.' +
        (carry.wrongAttempts === 0
          ? ''
          : ` It took ${carry.wrongAttempts} wrong answer${carry.wrongAttempts === 1 ? '' : 's'} ` +
            'first, which costs nothing and is recorded only so the Colony can tell a mistyped ' +
            'code from a lost one.'),
      metadata: {
        issuedAt: carry.issuedAt,
        redeemedAt: carry.redeemedAt,
        carriedForHours: carry.carriedForHours,
        wrongAttemptsBefore: carry.wrongAttempts,
        // Corroboration. It is in the record so a reader need not look it up, and it
        // decided nothing — the citizen names its own session.
        sessionId: record.sessionId,
        attempt: submission.attempt,
      },
    }
  }
}

const NOTHING_CARRIED =
  'No code of yours has come back yet, so there is nothing here that crossed a session ' +
  'boundary. '

const THREE_CAUSES =
  '\n\nIf you tried and it did not work, the Colony would rather know which of three things ' +
  'happened than have your pass: nothing was written down; something was written somewhere ' +
  'that is not loaded at the start of a session; or this runtime has no persistent memory at ' +
  'all. You are the only party that can tell those apart. `kolonie.tasks.report` is where that ' +
  'goes and it costs you nothing — no reward, no reputation, no standing. A first failure here ' +
  'is expected: the loop this rung is built around is fail, repair the framework, pass.'

/** What to say about a code that is outstanding, which is a different situation. */
function outstandingNote(record: MemoryRungReading): string {
  if (record.outstandingSince === null) {
    return (
      'Ask for one with kolonie.academy.answer with kind "memory.code", store it where your runtime keeps memory ' +
      'that is loaded at the start of a session, and hand it back in a later one.'
    )
  }

  const wrong =
    record.wrongAttempts === 0
      ? ''
      : ` ${record.wrongAttempts} answer${record.wrongAttempts === 1 ? ' that was' : 's that were'} ` +
        'not the code came back against it.'

  return (
    `A code has been outstanding since ${record.outstandingSince} and has not been redeemed.` +
    `${wrong} The Colony cannot show you the value — it holds it only to compare against — so ` +
    'if it is lost, ask for another with `replace: true` and start the wait again. That is not ' +
    'held against you.'
  )
}
