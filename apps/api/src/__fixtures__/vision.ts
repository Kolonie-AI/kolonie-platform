import { randomUUID } from 'node:crypto'
import { now as currentTime, type AgentId } from '@kolonie-ai/core'
import type {
  MintedVisionChallenge,
  VisionAnswerOutcome,
  VisionChallengeState,
} from '@kolonie-ai/db'
import type { VisionChallenges, VisionDependencies } from '../vision.js'
import { noObstruction } from './obstruction.js'

export interface FakeVisionChallenges extends VisionChallenges {
  readonly expire: (agentId: AgentId) => void
  readonly questionFor: (agentId: AgentId) => string | undefined
  readonly expectedAnswerFor: (agentId: AgentId) => string | undefined
}

export function fakeVisionChallenges(): FakeVisionChallenges {
  interface Row {
    agentId: AgentId
    imageName: string
    question: string
    expectedAnswer: string
    expired: boolean
    answer: string | null
    solvedAt: string | null
  }

  const rows: Row[] = []

  const latestFor = (agentId: AgentId): Row | undefined =>
    [...rows]
      .filter((row) => row.agentId === agentId)
      .sort((a, b) => Number(b.solvedAt !== null) - Number(a.solvedAt !== null))[0]

  return {
    async mint(agentId, imageName, question, expectedAnswer) {
      const row: Row = {
        agentId,
        imageName,
        question,
        expectedAnswer,
        expired: false,
        answer: null,
        solvedAt: null,
      }
      rows.unshift(row)

      return {
        id: randomUUID(),
        imageName: row.imageName,
        question: row.question,
        expectedAnswer: row.expectedAnswer,
        expiresAt: currentTime(),
      } satisfies MintedVisionChallenge
    },

    async answer(agentId, answer) {
      const row = latestFor(agentId)

      if (row === undefined) return { outcome: 'no_open_challenge' } satisfies VisionAnswerOutcome
      if (row.solvedAt !== null)
        return { outcome: 'already_answered' } satisfies VisionAnswerOutcome
      if (row.expired) return { outcome: 'expired' } satisfies VisionAnswerOutcome
      if (answer.trim().toLowerCase() !== row.expectedAnswer.trim().toLowerCase()) {
        row.answer = answer
        return { outcome: 'incorrect' } satisfies VisionAnswerOutcome
      }

      row.answer = answer
      row.solvedAt = currentTime()

      return {
        outcome: 'solved',
        question: row.question,
        expectedAnswer: row.expectedAnswer,
      } satisfies VisionAnswerOutcome
    },

    async latest(agentId) {
      const row = latestFor(agentId)
      if (row === undefined) return null

      return {
        imageName: row.imageName,
        question: row.question,
        expectedAnswer: row.expectedAnswer,
        expiresAt: currentTime(),
        answer: row.answer,
        solvedAt: row.solvedAt,
      } satisfies VisionChallengeState
    },

    expire(agentId) {
      const row = latestFor(agentId)
      if (row !== undefined) row.expired = true
    },

    questionFor: (agentId) => latestFor(agentId)?.question,
    expectedAnswerFor: (agentId) => latestFor(agentId)?.expectedAnswer,
  }
}

export function fakeVision(
  challenges: VisionChallenges = fakeVisionChallenges(),
): VisionDependencies {
  return {
    challenges,
    getMetadata: async () => ({
      'vision_01.jpg': { question: 'What is this?', answer: 'fake' },
    }),
    getImageBuffer: async () => Buffer.from('fake'),
    obstruction: noObstruction,
  }
}
