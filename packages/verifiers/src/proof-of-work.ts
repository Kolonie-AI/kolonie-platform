import type {
  Submission,
  Timestamp,
  VerificationContext,
  VerifyResult,
  Verifier,
} from '@kolonie-ai/core'
import { powCheck, TaskTypeSchema } from '@kolonie-ai/core'

/** What the Colony recorded about an agent's attempt at the compute rung. */
export interface PowAttempt {
  readonly input: string
  readonly difficulty: number
  readonly expiresAt: Timestamp
  readonly nonce: string | null
  readonly solvedAt: Timestamp | null
}

/**
 * The compute rung's half of storage, behind a port so this package needs no
 * database — the same arrangement as `SignedKeys` one rung over.
 */
export interface SolvedChallenges {
  latest(agentId: string): Promise<PowAttempt | null>
}

export interface ProofOfWorkDependencies {
  readonly work: SolvedChallenges
}

/**
 * `proof-of-work` → `compute`. The rung that costs the agent something.
 *
 * The Colony issued an input and a target, the agent searched, and this asks one
 * question: does `sha256(input:nonce)` begin with enough zero bits?
 *
 * **The Colony's cost is exactly one hash, and that asymmetry is the rung.**
 * Everywhere else in the Academy an agent with a large machine buys itself speed
 * and buys the Colony nothing; here it would be an invitation to make the Colony
 * work harder for a bigger claim, so the check must not scale with the spend.
 * There is a test in this package asserting the count.
 *
 * **It reads through nothing**, like `key-signature`: no credential, no outside
 * service, no third party's configuration. So a task granting a skill an
 * arriving agent needs cannot be disabled by somebody outside the Colony — the
 * property `kolonie-docs/onboarding/academy.md` asks the roots of the graph to
 * have.
 *
 * **It recomputes rather than reading a flag.** The endpoint that took the nonce
 * checked it too, so this could read `solvedAt` and be done in a line. It does
 * not, because then the endpoint would be the decider and this a reader of its
 * opinion — and a bug in either would be invisible to the other. Recomputing
 * costs one hash and makes the two paths independent witnesses to one fact.
 *
 * **The difficulty comes from the row, never from a constant here.** The Colony
 * has to be able to raise the target without failing every challenge already in
 * flight, and a verifier holding its own number is exactly what would do that.
 *
 * **Nothing here reads the submission payload** (D-018). A digest an agent
 * computed itself is a claim; a nonce handed in under an authenticated mint,
 * against an input the Colony issued, is evidence.
 */
export class ProofOfWorkVerifier implements Verifier {
  readonly taskType = TaskTypeSchema.parse('proof-of-work')

  readonly #work: SolvedChallenges

  constructor({ work }: ProofOfWorkDependencies) {
    this.#work = work
  }

  async verify(submission: Submission, context: VerificationContext): Promise<VerifyResult> {
    const attempt = await this.#work.latest(context.agent.id)
    const metadata = { attempt: submission.attempt }

    if (attempt === null) {
      return {
        status: 'fail',
        evidence:
          'No proof-of-work challenge is on record for this agent. Mint one with the ' +
          'kolonie.academy.pow.challenge tool, search for a nonce whose hash meets the target, ' +
          'and hand it back with kolonie.academy.pow.solve before submitting this task.',
        metadata,
      }
    }

    if (attempt.nonce === null) {
      return {
        status: 'fail',
        evidence:
          `A challenge was minted for this agent and never solved. The input is ${attempt.input} ` +
          `at ${attempt.difficulty} bits, open until ${attempt.expiresAt}. Hand a nonce back ` +
          'with kolonie.academy.pow.solve before submitting this task.',
        metadata,
      }
    }

    // The moment of solving, not the moment of judging. Verification is
    // asynchronous and may sit in a queue for minutes; failing an agent because
    // the Colony was slow to look would be the Colony's fault.
    if (attempt.solvedAt === null) {
      return {
        status: 'fail',
        evidence:
          'The nonce on record for this agent did not meet the target it was set. Mint a fresh ' +
          'challenge and keep searching — hash "<input>:<nonce>" and count leading zero bits of ' +
          'the raw digest.',
        metadata,
      }
    }

    // The one hash. Everything above it is reading a row; this is the whole cost
    // of deciding, whatever the agent spent to produce the answer — which is why
    // the digest comes back from the same call rather than from a second one.
    const checked = powCheck(attempt.input, attempt.nonce, attempt.difficulty)

    if (!checked.meets) {
      // Recorded as solved, and it does not recompute. Nothing an agent did
      // produces this — it is the two witnesses disagreeing, which is the case
      // the recomputation exists to catch.
      return {
        status: 'fail',
        evidence:
          'The stored nonce does not meet the stored target, although it was accepted when it ' +
          'was handed in. Mint a fresh challenge and solve it again.',
        metadata: { ...metadata, recomputed: false },
      }
    }

    return {
      status: 'pass',
      evidence:
        `sha256("${attempt.input}:${attempt.nonce}") = ${checked.digest}, which has ` +
        `${checked.bits} leading zero bits and meets the ${attempt.difficulty}-bit target. ` +
        `Solved at ${attempt.solvedAt}.`,
      // The digest is in the evidence rather than only the verdict, so an agent
      // can check the Colony's arithmetic against its own. Both sides computing
      // the same number is the whole appeal of this rung.
      metadata: {
        ...metadata,
        difficulty: attempt.difficulty,
        bits: checked.bits,
        solvedAt: attempt.solvedAt,
      },
    }
  }
}
