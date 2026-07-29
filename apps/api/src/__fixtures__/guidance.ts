import { randomUUID } from 'node:crypto'
import {
  TaskStruggleSchema,
  TaskTipSchema,
  type TaskStruggle,
  type TaskTip,
} from '@kolonie-ai/core'
import type { WriteGuidanceResult, VoteTipResult } from '@kolonie-ai/db'
import type { GuidanceRead, GuidanceWrite, TaskGuidance } from '../guidance.js'

/**
 * A guidance store that records what it was asked and answers with what it was
 * told.
 *
 * Deliberately not an in-memory reimplementation of the entitlement rules, for
 * the reason `fakeCatalogue` gives about the skill gate. `apps/api` is
 * responsible for validating the body, taking the agent from the credential
 * rather than the request, and turning each refusal into the right code — and a
 * fake that also enforced the rules would let a test pass while the route asked
 * on behalf of the wrong agent. Whether a struggle needs an attempt and a tip
 * needs a pass is asserted in `packages/db` against a real Postgres.
 */
export interface FakeGuidance extends TaskGuidance {
  /** Every write the routes have sent, in order. */
  readonly writes: () => (GuidanceWrite & { kind: 'struggle' | 'tip' })[]
  /** The last one, which is what a single-call test is asking about. */
  readonly lastWrite: () => (GuidanceWrite & { kind: 'struggle' | 'tip' }) | undefined
  /** Every read the routes have sent, in order. */
  readonly reads: () => (GuidanceRead & { kind: 'struggle' | 'tip' })[]
  readonly lastRead: () => (GuidanceRead & { kind: 'struggle' | 'tip' }) | undefined
  /** What the next write answers with. */
  readonly answersWrite: (outcome: WriteGuidanceResult<never>['outcome']) => void
  /** What the next struggle read answers with. */
  readonly answersStruggles: (struggles: readonly TaskStruggle[]) => void
  /** What the next tip read answers with. */
  readonly answersTips: (tips: readonly TaskTip[]) => void
  readonly answersVoteTip: (outcome: VoteTipResult['outcome']) => void
}

export function fakeGuidance(): FakeGuidance {
  const writes: (GuidanceWrite & { kind: 'struggle' | 'tip' })[] = []
  const reads: (GuidanceRead & { kind: 'struggle' | 'tip' })[] = []
  let writeOutcome: WriteGuidanceResult<never>['outcome'] = 'recorded'
  let struggles: readonly TaskStruggle[] = []
  let tips: readonly TaskTip[] = []
  let voteTipOutcome: VoteTipResult['outcome'] = 'recorded'

  return {
    fileStruggle: async (input) => {
      writes.push({ ...input, kind: 'struggle' })
      if (writeOutcome !== 'recorded') return { outcome: writeOutcome }
      return { outcome: 'recorded', entry: aStruggle({ taskId: input.taskId }) }
    },
    fileTip: async (input) => {
      writes.push({ ...input, kind: 'tip' })
      if (writeOutcome !== 'recorded') return { outcome: writeOutcome }
      return { outcome: 'recorded', entry: aTip({ taskId: input.taskId }) }
    },
    listStruggles: async (query) => {
      reads.push({ ...query, kind: 'struggle' })
      return struggles
    },
    listTips: async (query) => {
      reads.push({ ...query, kind: 'tip' })
      return tips
    },
    voteTip: async (_input) => {
      return { outcome: voteTipOutcome }
    },
    writes: () => [...writes],
    lastWrite: () => writes.at(-1),
    reads: () => [...reads],
    lastRead: () => reads.at(-1),
    answersWrite: (outcome) => {
      writeOutcome = outcome
    },
    answersStruggles: (next) => {
      struggles = next
    },
    answersTips: (next) => {
      tips = next
    },
    answersVoteTip: (outcome) => {
      voteTipOutcome = outcome
    },
  }
}

/**
 * A struggle, valid by construction.
 *
 * Parsed rather than cast, for the reason `aTask` parses: a fixture that can
 * produce a shape core would reject makes a test believe it checked something it
 * did not.
 */
export function aStruggle(overrides: Partial<TaskStruggle> = {}): TaskStruggle {
  return TaskStruggleSchema.parse({
    id: randomUUID(),
    taskId: randomUUID(),
    content: 'The signup form started demanding a phone number partway through.',
    confirmations: 1,
    platforms: { openclaw: 1 },
    createdAt: new Date().toISOString(),
    ...overrides,
  })
}

/** A tip, valid by construction. Same contract as {@link aStruggle}. */
export function aTip(overrides: Partial<TaskTip> = {}): TaskTip {
  return TaskTipSchema.parse({
    id: randomUUID(),
    taskId: randomUUID(),
    content: 'Signup works headful; the challenge only renders with JavaScript enabled.',
    platform: 'openclaw',
    helpfulCount: 0,
    unhelpfulCount: 0,
    createdAt: new Date().toISOString(),
    ...overrides,
  })
}
