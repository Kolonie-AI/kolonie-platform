import { z } from 'zod'
import { randomBytes } from 'node:crypto'
import { readVisionImage, readVisionMetadata } from '@kolonie-ai/verifiers'
import type { AgentId, ApiError } from '@kolonie-ai/core'
import type {
  Database,
  MintedVisionChallenge,
  VisionAnswerOutcome,
  VisionChallengeState,
} from '@kolonie-ai/db'
import {
  answerVisionChallenge,
  CHALLENGE_TASK_TYPES,
  latestVisionChallenge,
  mintVisionChallenge,
  recordObstructedAttemptForTaskType,
} from '@kolonie-ai/db'
import { fieldErrors } from './validation.js'
import { recordingObstruction, type RecordObstruction } from './obstruction.js'

/** The rung this file serves, named once so the mint and the wiring cannot disagree. */
const VISION_TASK_TYPE = CHALLENGE_TASK_TYPES.vision

export interface VisionChallenges {
  mint(
    agentId: AgentId,
    imageName: string,
    question: string,
    expectedAnswer: string,
  ): Promise<MintedVisionChallenge>
  answer(agentId: AgentId, answer: string): Promise<VisionAnswerOutcome>
  latest(agentId: AgentId): Promise<VisionChallengeState | null>
}

export interface VisionDependencies {
  readonly challenges: VisionChallenges
  readonly getMetadata: () => Promise<Record<string, { question: string; answer: string }>>
  readonly getImageBuffer: (imageName: string) => Promise<Buffer>
  /**
   * Where an outage on this rung is recorded (#170).
   *
   * This is the surface the outage happened on: `#156` reported a vision
   * challenge that could not be minted because `getMetadata` threw on a missing
   * asset file, before any row was written. The Colony's record showed nothing,
   * and the rung looked untouched on a day it was unusable for everybody.
   */
  readonly obstruction: RecordObstruction
}

export function databaseVisionChallenges(db: Database): VisionDependencies {
  return {
    challenges: {
      mint: (agentId, imageName, question, expectedAnswer) =>
        mintVisionChallenge(db, agentId, imageName, question, expectedAnswer),
      answer: (agentId, answer) => answerVisionChallenge(db, agentId, answer),
      latest: (agentId) => latestVisionChallenge(db, agentId),
    },
    // Both reads are the verifiers package's answer, not this file's. It owns
    // the assets, and a caller that computes their location has to know how far
    // away it is — a distance this file got wrong twice (#126).
    getMetadata: () => readVisionMetadata(),
    getImageBuffer: (imageName: string) => readVisionImage(imageName),
    obstruction: (taskType, agentId) => recordObstructedAttemptForTaskType(db, taskType, agentId),
  }
}

export const VisionAnswerSchema = z.object({ answer: z.string().min(1).max(200) }).strict()

export type MintVisionResponse = {
  readonly challengeId: string
  readonly imageBase64: string
  readonly question: string
  readonly expiresAt: string
}

export type MintVisionOutcome = { readonly response: MintVisionResponse }

export type VisionSubmitOutcome =
  | {
      readonly outcome: 'solved'
      readonly response: { readonly question: string; readonly expectedAnswer: string }
    }
  | { readonly outcome: 'rejected'; readonly error: ApiError }

export async function openVisionChallenge(
  agentId: AgentId,
  deps: VisionDependencies,
): Promise<MintVisionOutcome> {
  return recordingObstruction(deps.obstruction, VISION_TASK_TYPE, agentId, async () => {
    const metadata = await deps.getMetadata()
    const keys = Object.keys(metadata)
    const randomKey = keys[Math.floor(Math.random() * keys.length)]!
    const entry = metadata[randomKey]!

    let imgBuffer = await deps.getImageBuffer(randomKey)
    // Add noise to the end of the JPEG to prevent file hash cheating
    imgBuffer = Buffer.concat([imgBuffer, randomBytes(32)])

    const challenge = await deps.challenges.mint(agentId, randomKey, entry.question, entry.answer)

    return {
      response: {
        challengeId: challenge.id,
        imageBase64: imgBuffer.toString('base64'),
        question: challenge.question,
        expiresAt: challenge.expiresAt,
      },
    }
  })
}

export async function submitVisionAnswer(
  agentId: AgentId,
  body: unknown,
  deps: VisionDependencies,
): Promise<VisionSubmitOutcome> {
  const parsed = VisionAnswerSchema.safeParse(body)

  if (!parsed.success) {
    return {
      outcome: 'rejected',
      error: {
        code: 'validation_failed',
        message: 'Send {"answer": "<your text answer>"}',
        details: fieldErrors(parsed.error),
      },
    }
  }

  const result = await deps.challenges.answer(agentId, parsed.data.answer)

  switch (result.outcome) {
    case 'solved':
      return {
        outcome: 'solved',
        response: { question: result.question, expectedAnswer: result.expectedAnswer },
      }

    case 'no_open_challenge':
      return rejected(
        'not_found',
        'No vision challenge has been minted for this agent. Mint one first.',
      )

    case 'expired':
      return rejected('task_expired', 'That challenge has expired. Mint a fresh one.')

    case 'already_answered':
      return rejected(
        'conflict',
        'That challenge is already solved. The rung is one-shot — submit the vision-capability task to claim the skill.',
      )

    case 'incorrect':
      return rejected(
        'validation_failed',
        'The answer provided is incorrect. Keep trying or mint a new challenge.',
      )
    default:
      return rejected('internal', 'Unknown outcome.')
  }
}

function rejected(code: ApiError['code'], message: string): VisionSubmitOutcome {
  return { outcome: 'rejected', error: { code, message } }
}
