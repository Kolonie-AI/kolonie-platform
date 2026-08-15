import {
  AccountKindSchema,
  AccountProviderSchema,
  now as currentTime,
  walkIsReported,
  walkReportAnswers,
  type AccountWalk,
  type AgentId,
  type WalkVerdict,
} from '@kolonie-ai/core'
import type { WalkStore } from '../account-walks.js'

export interface FakeWalkStore extends WalkStore {
  readonly add: (input: {
    readonly agentId: AgentId
    readonly kind: string
    readonly provider: string
    readonly finished?: boolean
    readonly outcome?: AccountWalk['outcome']
    /** Whether this walk's verdict wrote the draft, which is what `amend` reaches. */
    readonly proposed?: boolean
  }) => AccountWalk
}

/** Walk storage for API tests; recipe publication remains in the recipe fixture. */
export function fakeWalks(): FakeWalkStore {
  const rows: AccountWalk[] = []
  /**
   * `proposed_at` in miniature (`#986`): the walks whose verdict wrote a draft.
   * The storage guards the amendment on this and on the entry still being a
   * draft; the entry lives in the recipe fixture, so only the first half is
   * modelled here and the other is covered where the two are in one database.
   */
  const proposed = new Set<string>()

  const add: FakeWalkStore['add'] = (input) => {
    const startedAt = currentTime()
    const finishedAt = input.finished === false ? null : currentTime()
    const walk: AccountWalk = {
      id: crypto.randomUUID(),
      agentId: input.agentId,
      kind: AccountKindSchema.parse(input.kind),
      provider: AccountProviderSchema.parse(input.provider),
      startedAt,
      finishedAt,
      outcome: finishedAt === null ? null : (input.outcome ?? 'proved'),
      wall: null,
      note: null,
      did: null,
      broke: null,
      changed: null,
      discarded: null,
      takenStepPositions: null,
      recipe: null,
      steps: [],
    }
    rows.unshift(walk)
    if (input.proposed === true) proposed.add(walk.id)
    return walk
  }

  return {
    add,
    async open(agentId, input) {
      return (
        rows.find(
          (walk) =>
            walk.agentId === agentId &&
            walk.kind === input.kind &&
            walk.provider === input.provider &&
            walk.finishedAt === null,
        ) ?? add({ agentId, ...input, finished: false })
      ).id
    },
    async record() {},
    async finish(walkId, input) {
      const at = rows.findIndex((walk) => walk.id === walkId && walk.finishedAt === null)
      if (at === -1) return undefined
      const previous = rows[at]
      if (previous === undefined) return undefined

      const walk: AccountWalk = {
        ...previous,
        finishedAt: currentTime(),
        outcome: input.outcome,
        wall: input.wall ?? null,
        note: input.note ?? null,
        did: input.did ?? null,
        broke: input.broke ?? null,
        changed: input.changed ?? null,
        discarded: input.discarded ?? null,
        takenStepPositions: input.takenStepPositions == null ? null : [...input.takenStepPositions],
      }
      rows[at] = walk
      const verdict: WalkVerdict =
        input.outcome === 'proved'
          ? { kind: 'draft', steps: [] }
          : input.outcome === 'refused'
            ? { kind: 'refusal', wall: input.wall ?? '' }
            : { kind: 'nothing', why: 'the walk was abandoned' }

      if (verdict.kind === 'draft') proposed.add(walk.id)

      return { walk, verdict }
    },
    async amend(agentId, input, recipe) {
      const at = rows.findIndex(
        (walk) =>
          walk.agentId === agentId &&
          walk.kind === input.kind &&
          walk.provider === input.provider &&
          walk.finishedAt !== null &&
          proposed.has(walk.id),
      )
      const previous = rows[at]
      if (previous === undefined) return undefined

      const walk: AccountWalk = { ...previous, recipe }
      rows[at] = walk

      return walk
    },
    /**
     * The last walk here that ended without a word (`#811`). Newest first is
     * how `rows` is kept, so the first match is the one the gate names.
     */
    async unreported(agentId, input) {
      const owed = rows.find(
        (walk) =>
          walk.agentId === agentId &&
          walk.kind === input.kind &&
          walk.provider === input.provider &&
          walk.finishedAt !== null &&
          walk.outcome !== 'proved',
      )

      return owed === undefined || walkIsReported(owed) ? undefined : owed
    },
    async report(agentId, walkId, answers) {
      const at = rows.findIndex((walk) => walk.id === walkId && walk.agentId === agentId)
      const previous = rows[at]
      if (previous === undefined || previous.finishedAt === null) return undefined
      /** Answers only where there are none, exactly as the storage does. */
      if (walkReportAnswers(previous).length > 0) return undefined

      const walk: AccountWalk = {
        ...previous,
        note: answers.note ?? null,
        did: answers.did ?? null,
        broke: answers.broke ?? null,
        changed: answers.changed ?? null,
        discarded: answers.discarded ?? null,
      }
      rows[at] = walk

      return walk
    },
    async inProgress(agentId, input) {
      return rows.find(
        (walk) =>
          walk.agentId === agentId &&
          walk.kind === input.kind &&
          walk.provider === input.provider &&
          walk.finishedAt === null,
      )
    },
    async one(agentId, walkId) {
      return rows.find((walk) => walk.agentId === agentId && walk.id === walkId)
    },
    async list(agentId, kind) {
      return rows.filter(
        (walk) => walk.agentId === agentId && (kind === undefined || walk.kind === kind),
      )
    },
    async divergences() {
      return []
    },
  }
}
