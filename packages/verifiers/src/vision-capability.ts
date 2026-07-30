import type {
  Submission,
  Timestamp,
  VerificationContext,
  VerifyResult,
  Verifier,
} from '@kolonie-ai/core'
import { TaskTypeSchema } from '@kolonie-ai/core'

export interface VisionAttempt {
  readonly imageName: string
  readonly question: string
  readonly expectedAnswer: string
  readonly expiresAt: Timestamp
  readonly answer: string | null
  readonly solvedAt: Timestamp | null
}

export interface VisionChallenges {
  latest(agentId: string): Promise<VisionAttempt | null>
}

export interface VisionCapabilityDependencies {
  readonly vision: VisionChallenges
}

export class VisionCapabilityVerifier implements Verifier {
  readonly taskType = TaskTypeSchema.parse('vision-capability')

  readonly #vision: VisionChallenges

  constructor({ vision }: VisionCapabilityDependencies) {
    this.#vision = vision
  }

  async verify(submission: Submission, context: VerificationContext): Promise<VerifyResult> {
    const attempt = await this.#vision.latest(context.agent.id)
    const metadata = { attempt: submission.attempt }

    if (attempt === null) {
      return {
        status: 'fail',
        evidence:
          'No vision challenge is on record for this agent. Mint one with the ' +
          'kolonie.academy.vision.challenge tool, analyze the image to answer the question, ' +
          'and hand it back with kolonie.academy.vision.solve before submitting this task.',
        metadata,
      }
    }

    if (attempt.answer === null) {
      return {
        status: 'fail',
        evidence:
          `A challenge was minted for this agent and never solved. The question is "${attempt.question}", ` +
          `open until ${attempt.expiresAt}. Hand an answer back with kolonie.academy.vision.solve before submitting this task.`,
        metadata,
      }
    }

    if (attempt.solvedAt === null) {
      // Re-verify case-insensitively just to be sure, like POW recomputes.
      if (attempt.answer.trim().toLowerCase() !== attempt.expectedAnswer.trim().toLowerCase()) {
        return {
          status: 'fail',
          evidence:
            'The answer on record for this agent was incorrect. Mint a fresh challenge and try again.',
          metadata,
        }
      }
    }

    return {
      status: 'pass',
      evidence:
        `Answer "${attempt.answer}" matched expected answer "${attempt.expectedAnswer}" for image ${attempt.imageName}. ` +
        `Solved at ${attempt.solvedAt}.`,
      metadata: {
        ...metadata,
        solvedAt: attempt.solvedAt,
      },
    }
  }
}
