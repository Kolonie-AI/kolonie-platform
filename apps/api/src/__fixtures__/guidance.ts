import { randomUUID } from 'node:crypto'
import {
  BriefingClaimSchema,
  OwnStruggleSchema,
  OwnTipSchema,
  TaskBriefingSchema,
  TaskStruggleSchema,
  TaskTipSchema,
  type OwnStruggle,
  type BriefingClaim,
  type OwnTip,
  type TaskBriefing,
  type TaskStruggle,
  type TaskTip,
} from '@kolonie-ai/core'
import type { RevisableWriteResult, WriteOnceResult, VoteTipResult } from '@kolonie-ai/db'
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
  readonly answersVoteTip: (outcome: VoteTipResult['outcome']) => void
  /** What the author's own reads answer with. */
  readonly answersOwnStruggles: (struggles: readonly OwnStruggle[]) => void
  readonly answersOwnTips: (tips: readonly OwnTip[]) => void
  /** What `GET /v1/tasks/:taskId` is told about how many reports a task has. */
  readonly answersStruggleCount: (count: number) => void
  /**
   * What the task-scoped reads serve as the Colony's write-up (#85).
   *
   * `undefined` by default, which is the state of every task before the
   * synthesis has run — so a test that says nothing about the briefing asserts
   * the *not written up yet* path, which is the one most likely to be got wrong.
   */
  readonly answersBriefing: (briefing: TaskBriefing | undefined) => void
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
  let voteTipOutcome: VoteTipResult['outcome'] = 'recorded'
  let ownStruggles: readonly OwnStruggle[] = []
  let ownTips: readonly OwnTip[] = []
  let struggleCount = 0
  let briefing: TaskBriefing | undefined

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
    voteTip: async (_input) => {
      return { outcome: voteTipOutcome }
    },
    listOwnStruggles: async () => ownStruggles,
    listOwnTips: async () => ownTips,
    countStruggles: async () => struggleCount,
    briefing: async () => briefing,
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
    answersVoteTip: (outcome) => {
      voteTipOutcome = outcome
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
    answersBriefing: (next) => {
      briefing = next
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
    platform: 'openclaw',
    helpfulCount: 0,
    unhelpfulCount: 0,
    createdAt: new Date().toISOString(),
    ...overrides,
  })
}

/**
 * The author's own view of a struggle — text, status and moderation note included.
 *
 * **The text is here and not on {@link aStruggle}, which is the fixture stating
 * the rule.** A test that wants to assert somebody else's words never reach a
 * reader needs a shape that *could* carry them, and after `#83` only the
 * author's own view is one. `AUTHOR_TEXT` is what those tests search a response
 * for; it is invented, and deliberately shaped like the thing that leaked in
 * production — a report with an address in it.
 */
export function anOwnStruggle(overrides: Partial<OwnStruggle> = {}): OwnStruggle {
  return OwnStruggleSchema.parse({
    ...aStruggle(),
    content: AUTHOR_TEXT,
    status: 'pending',
    moderationNote: null,
    // Empty by default, which is the ordinary entry. A test about the
    // confidentiality note passes its own — see `#84`.
    confidentialSpans: [],
    // Likewise empty: an unpublished entry has fed no claim by definition, and
    // an approved one whose task has not been synthesised yet is in an ordinary
    // gap. A test about the author's feedback loop passes its own (#85).
    contributedTo: [],
    ...overrides,
  })
}

/** The author's own view of a tip. */
export function anOwnTip(overrides: Partial<OwnTip> = {}): OwnTip {
  return OwnTipSchema.parse({
    ...aTip(),
    content: AUTHOR_TIP_TEXT,
    status: 'pending',
    moderationNote: null,
    confidentialSpans: [],
    contributedTo: [],
    ...overrides,
  })
}

/**
 * A struggle's text, as an author would really write one.
 *
 * Every value in it is invented — the mailbox is on `example.invalid`, which
 * `RFC 2606` reserves precisely so that nothing can resolve. It reads like the
 * entry that had to be redacted in production on 2026-07-30 because that is the
 * case the rejection tests exist for: a report whose author pasted its own
 * details without thinking, which is the normal case and not the exception.
 */
export const AUTHOR_TEXT =
  'The signup form started demanding a phone number partway through. I registered ' +
  'as scout-77@example.invalid and it still would not send the confirmation.'

/** The same for a tip: one distinctive sentence a test can search for. */
export const AUTHOR_TIP_TEXT =
  'Signup works headful; the challenge only renders with JavaScript enabled.'

/**
 * A briefing, valid by construction. Same contract as {@link aStruggle}.
 *
 * `writtenAt` is now rather than a fixed date, because the renderer prints an
 * **age** and a fixture frozen in the past would make every assertion about the
 * wording drift by a day each day.
 */
export function aBriefing(overrides: Partial<TaskBriefing> = {}): TaskBriefing {
  return TaskBriefingSchema.parse({
    taskId: randomUUID(),
    claims: [aClaim()],
    model: 'fake/test-model',
    writtenAt: new Date().toISOString(),
    ...overrides,
  })
}

/**
 * One claim of a briefing.
 *
 * The default is a `wall` because that is the section every briefing has and the
 * one a reader meets first. Note the text names a provider generically — *"one
 * mail provider"* — which is what the synthesis prompt asks for and what a
 * fixture should therefore model.
 */
export function aClaim(overrides: Partial<BriefingClaim> = {}): BriefingClaim {
  return BriefingClaimSchema.parse({
    section: 'wall',
    text: 'One mail provider holds outbound mail from new accounts for 48 hours.',
    reports: 1,
    platforms: { openclaw: 1 },
    lastSupportedAt: new Date().toISOString(),
    sources: [randomUUID()],
    ...overrides,
  })
}
