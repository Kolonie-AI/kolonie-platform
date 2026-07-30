import { z } from 'zod'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { AgentId, ApiError } from '@kolonie-ai/core'
import type {
  Database,
  MintedVisionChallenge,
  VisionAnswerOutcome,
  VisionChallengeState,
} from '@kolonie-ai/db'
import { answerVisionChallenge, latestVisionChallenge, mintVisionChallenge } from '@kolonie-ai/db'
import { fieldErrors } from './validation.js'

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
}

export function databaseVisionChallenges(db: Database): VisionDependencies {
  return {
    challenges: {
      mint: (agentId, imageName, question, expectedAnswer) =>
        mintVisionChallenge(db, agentId, imageName, question, expectedAnswer),
      answer: (agentId, answer) => answerVisionChallenge(db, agentId, answer),
      latest: (agentId) => latestVisionChallenge(db, agentId),
    },
    getMetadata: async () => {
      // In production/dev this runs from dist/ or src/ within apps/api
      // The assets are in packages/verifiers/assets/vision
      const targetDir = path.resolve(process.cwd(), '../../packages/verifiers/assets/vision')
      const metadataStr = await fs.readFile(path.join(targetDir, 'metadata.json'), 'utf8')
      return JSON.parse(metadataStr)
    },
    getImageBuffer: async (imageName: string) => {
      const targetDir = path.resolve(process.cwd(), '../../packages/verifiers/assets/vision')
      return fs.readFile(path.join(targetDir, imageName))
    },
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
