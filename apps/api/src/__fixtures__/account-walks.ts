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
    /** Which capability the walk measured (`#1023`); absent is the unscoped null. */
    readonly direction?: AccountWalk['direction']
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
  /** Rows created by a report itself, rather than by an observed account event. */
  const direct = new Set<string>()
  /**
   * `from_provider_report` in miniature (`#1036`): the rows the retiring
   * `provider-report` alias wrote, which are the only ones it may withdraw. Not
   * a field on `AccountWalk` because no reader of a walk is told this — it
   * decides what the alias may take back and what a briefing counts as thin.
   */
  const converted = new Set<string>()

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
      direction: input.direction ?? null,
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

  const finish: WalkStore['finish'] = async (walkId, input) => {
    const at = rows.findIndex((walk) => walk.id === walkId && walk.finishedAt === null)
    if (at === -1) return undefined
    const previous = rows[at]
    if (previous === undefined) return undefined

    const walk: AccountWalk = {
      ...previous,
      finishedAt: currentTime(),
      outcome: input.outcome,
      direction: input.direction ?? null,
      wall: input.wall ?? null,
      note: input.note ?? null,
      did: input.did ?? null,
      broke: input.broke ?? null,
      changed: input.changed ?? null,
      discarded: input.discarded ?? null,
      takenStepPositions: input.takenStepPositions == null ? null : [...input.takenStepPositions],
      /**
       * **The long form lands on the walk here too** (`#982`), the way
       * `finishWalk` writes it. Without it the fake answered a report carrying
       * four walls with a walk carrying none, and the tool result — which now
       * tells the agent where its walls went — would have been tested against a
       * walk no real report produces.
       */
      recipe: input.recipe ?? null,
    }
    rows[at] = walk
    /** Set on the row as `finishWalk` sets the column, from the report itself. */
    if (input.fromProviderReport === true) converted.add(walk.id)
    /**
     * **The fake knows of no published entry, so it mirrors `walkVerdict`'s
     * no-entry path** (`#1032`). There, a walk that got through and a walk that
     * stopped part-way both write the row — an abandoned walk measured where it
     * stopped, and where citizens stop is the half of a briefing nothing else
     * observes. Only a refusal that names no wall proposes nothing.
     */
    const verdict: WalkVerdict =
      input.outcome === 'refused'
        ? input.wall == null
          ? { kind: 'nothing', why: 'a refusal has to name the wall it ended at' }
          : { kind: 'refusal', wall: input.wall }
        : { kind: 'writes' }

    /** Stamped on exactly the verdict that wrote the row, as `finishWalk` stamps it. */
    if (verdict.kind === 'writes') proposed.add(walk.id)

    return { walk, verdict }
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
    finish,
    // @mirrors packages/db/src/storage/account-walks.ts submitWalkReport 3049f647
    async submit(agentId, input, report) {
      const open = rows.find(
        (walk) =>
          walk.agentId === agentId &&
          walk.kind === input.kind &&
          walk.provider === input.provider &&
          walk.finishedAt === null,
      )
      let walkId = open?.id

      if (walkId === undefined) {
        /**
         * **Every finished walk at this pair, not only the ones a report wrote**
         * (`#1060`). `direct.has(...)` stood here and made the walks a
         * declaration opened — which is every walk filed the ordinary way —
         * unreplaceable. The storage's own hard stop is `rewarded_at`, which
         * this fake does not model because nothing here books a reward.
         */
        const replacement = rows.find(
          (walk) =>
            walk.agentId === agentId &&
            walk.kind === input.kind &&
            walk.provider === input.provider &&
            walk.finishedAt !== null,
        )

        if (replacement === undefined) {
          const created = add({ agentId, ...input, finished: false })
          direct.add(created.id)
          walkId = created.id
        } else {
          const at = rows.findIndex((walk) => walk.id === replacement.id)
          rows[at] = {
            ...replacement,
            /**
             * A walk with steps keeps the moment it actually started, and keeps
             * the steps: the prose is what the author was asked for, the steps
             * are what the Colony observed. Equal endpoints are what `direct`
             * stands in for here, so only a stepless walk joins that set.
             */
            ...(replacement.steps.length === 0 ? { startedAt: currentTime() } : {}),
            finishedAt: null,
            outcome: null,
            direction: null,
            wall: null,
            note: null,
            did: null,
            broke: null,
            changed: null,
            discarded: null,
            takenStepPositions: null,
            recipe: null,
          }
          if (replacement.steps.length === 0) direct.add(replacement.id)
          proposed.delete(replacement.id)
          /**
           * Cleared with the rest of the row, as the storage clears the column:
           * what the replacement is came from the report now being filed, not
           * from the one it replaces.
           */
          converted.delete(replacement.id)
          walkId = replacement.id
        }
      }

      return finish(walkId, report)
    },
    /**
     * Only what the alias itself wrote (`#1036`), which is `converted` here and
     * `from_provider_report` in the storage. A walk somebody described survives
     * a withdrawal, and answering `false` for it is the whole assertion.
     */
    async withdrawReported(agentId, input) {
      const at = rows.findIndex(
        (walk) =>
          walk.agentId === agentId &&
          walk.kind === input.kind &&
          walk.provider === input.provider &&
          converted.has(walk.id),
      )
      const gone = rows[at]
      if (gone === undefined) return false

      rows.splice(at, 1)
      converted.delete(gone.id)
      direct.delete(gone.id)
      proposed.delete(gone.id)

      return true
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
          !direct.has(walk.id) &&
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
    /**
     * Votes are not modelled here (`#1035`). The rules a vote is refused under
     * are all cross-walk — did this citizen walk this pair, is the note its own
     * — and a fake that answered them from this array would be asserting the
     * storage layer's decisions rather than exercising them. The tests that mean
     * anything for a vote run against real PostgreSQL.
     */
    async voteNote() {
      return { outcome: 'no-such-note' as const }
    },
    async divergences() {
      return []
    },
  }
}
