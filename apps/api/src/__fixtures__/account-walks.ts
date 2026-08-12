import {
  AccountKindSchema,
  AccountProviderSchema,
  now as currentTime,
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
  }) => AccountWalk
}

/** Walk storage for API tests; recipe publication remains in the recipe fixture. */
export function fakeWalks(): FakeWalkStore {
  const rows: AccountWalk[] = []

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

      return { walk, verdict }
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
