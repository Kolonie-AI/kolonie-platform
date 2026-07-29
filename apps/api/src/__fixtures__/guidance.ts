import { randomUUID } from 'node:crypto'
import {
  OwnStruggleSchema,
  OwnTipSchema,
  TaskStruggleSchema,
  TaskTipSchema,
  type OwnStruggle,
  type OwnTip,
  type TaskStruggle,
  type TaskTip,
} from '@kolonie-ai/core'
import type { RevisableWriteResult, WriteOnceResult } from '@kolonie-ai/db'
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
 * on behalf of the wrong agent. Whether a struggle needs `profile`, whether a tip
 * needs a pass and whether a revision is allowed are asserted in `packages/db`
 * against a real Postgres.
 */
export interface FakeGuidance extends TaskGuidance {
  /** Every write the routes have sent, in order. */
  readonly writes: () => (GuidanceWrite & { kind: 'struggle' | 'tip' })[]
  /** The last one, which is what a single-call test is asking about. */
  readonly lastWrite: () => (GuidanceWrite & { kind: 'struggle' | 'tip' }) | undefined
  /** Every read the routes have sent, in order. */
  readonly reads: () => (GuidanceRead & { kind: 'struggle' | 'tip' })[]
  readonly lastRead: () => (GuidanceRead & { kind: 'struggle' | 'tip' }) | undefined
  /**
   * What the next write answers with.
   *
   * The two unions together, because one setter serves both kinds and a test that
   * asks a tip for `revised` is asking the wrong question — the type is what says
   * so. `not-revisable` carries a reason, so it is set as the whole result rather
   * than as a bare outcome.
   */
  readonly answersWrite: (
    result: WriteOutcomeName | Extract<RevisableWriteResult<never>, { outcome: 'not-revisable' }>,
  ) => void
  /** What the next struggle read answers with. */
  readonly answersStruggles: (struggles: readonly TaskStruggle[]) => void
  /** What the next tip read answers with. */
  readonly answersTips: (tips: readonly TaskTip[]) => void
  /** What the author's own reads answer with. */
  readonly answersOwnStruggles: (struggles: readonly OwnStruggle[]) => void
  readonly answersOwnTips: (tips: readonly OwnTip[]) => void
  /** What `GET /v1/tasks/:taskId` is told about how many reports a task has. */
  readonly answersStruggleCount: (count: number) => void
}

type WriteOutcomeName =
  (RevisableWriteResult<never> | WriteOnceResult<never>)['outcome'] | 'not-revisable'

export function fakeGuidance(): FakeGuidance {
  const writes: (GuidanceWrite & { kind: 'struggle' | 'tip' })[] = []
  const reads: (GuidanceRead & { kind: 'struggle' | 'tip' })[] = []
  let writeResult:
    WriteOutcomeName | Extract<RevisableWriteResult<never>, { outcome: 'not-revisable' }> =
    'recorded'
  let struggles: readonly TaskStruggle[] = []
  let tips: readonly TaskTip[] = []
  let ownStruggles: readonly OwnStruggle[] = []
  let ownTips: readonly OwnTip[] = []
  let struggleCount = 0

  /** The configured answer as the union the caller expects, or undefined for a write. */
  const refusalFor = <T>(): Exclude<
    RevisableWriteResult<T> | WriteOnceResult<T>,
    { outcome: 'recorded' | 'revised' }
  > | null => {
    if (typeof writeResult !== 'string') return writeResult
    if (writeResult === 'recorded' || writeResult === 'revised') return null
    if (writeResult === 'not-revisable')
      return { outcome: 'not-revisable', because: 'merged-into-another' }
    return { outcome: writeResult }
  }

  return {
    fileStruggle: async (input) => {
      writes.push({ ...input, kind: 'struggle' })
      const refusal = refusalFor<TaskStruggle>()
      if (refusal !== null) {
        // A struggle never answers `already-written`; it revises instead. A test
        // that asked for one is asking about the tip path, so this fake answers
        // the closest true thing rather than a shape the real storage cannot
        // produce.
        return refusal.outcome === 'already-written'
          ? { outcome: 'not-revisable', because: 'confirmed-by-others' }
          : refusal
      }
      const entry = aStruggle({ taskId: input.taskId })
      return writeResult === 'revised'
        ? { outcome: 'revised', entry }
        : { outcome: 'recorded', entry }
    },
    fileTip: async (input) => {
      writes.push({ ...input, kind: 'tip' })
      const refusal = refusalFor<TaskTip>()
      if (refusal !== null) {
        // The mirror of the above: a tip cannot be `not-revisable`, because it
        // cannot be revised at all.
        return refusal.outcome === 'not-revisable' ? { outcome: 'already-written' } : refusal
      }
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
    listOwnStruggles: async () => ownStruggles,
    listOwnTips: async () => ownTips,
    countStruggles: async () => struggleCount,
    writes: () => [...writes],
    lastWrite: () => writes.at(-1),
    reads: () => [...reads],
    lastRead: () => reads.at(-1),
    answersWrite: (result) => {
      writeResult = result
    },
    answersStruggles: (next) => {
      struggles = next
    },
    answersTips: (next) => {
      tips = next
    },
    answersOwnStruggles: (next) => {
      ownStruggles = next
    },
    answersOwnTips: (next) => {
      ownTips = next
    },
    answersStruggleCount: (count) => {
      struggleCount = count
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
    attemptedCount: 1,
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

/** The author's own view of a struggle — status and moderation note included. */
export function anOwnStruggle(overrides: Partial<OwnStruggle> = {}): OwnStruggle {
  return OwnStruggleSchema.parse({
    ...aStruggle(),
    status: 'pending',
    moderationNote: null,
    ...overrides,
  })
}

/** The author's own view of a tip. */
export function anOwnTip(overrides: Partial<OwnTip> = {}): OwnTip {
  return OwnTipSchema.parse({
    ...aTip(),
    status: 'pending',
    moderationNote: null,
    ...overrides,
  })
}
