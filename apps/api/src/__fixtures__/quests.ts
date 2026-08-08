import { randomUUID } from 'node:crypto'
import {
  QUEST_PENDING_LIMIT,
  QUEST_TASK_TYPE,
  QuestDraftSchema,
  QuestPatchSchema,
  TaskIdSchema,
  TaskTypeSchema,
  nonWithdrawableNotice,
  questCommitment,
  type AgentId,
  type CreditMovement,
  type SubmissionId,
  type Task,
  type TaskId,
} from '@kolonie-ai/core'
import type {
  AudienceCriteria,
  HeldReport,
  OwnQuest,
  QuestResult as AcceptedReport,
} from '@kolonie-ai/db'
import type { QuestDesk } from '../quests.js'
import type { HoldingCount } from '@kolonie-ai/db'
import type { QuestTakenPartIn } from '@kolonie-ai/db'

/**
 * The audience a quest with no activity window reaches, in the fake (`#227`).
 *
 * A named number rather than a literal, so a test asserting the page carries the
 * count says what it is asserting about.
 */
export const FAKE_AUDIENCE = 7

export interface FakeQuestDesk extends QuestDesk {
  /** Every criterion set the audience count was asked about (`#227`). */
  readonly audienceAsked: readonly AudienceCriteria[]
  /** Say what the population holds, for a test about `#524`'s figure. */
  readonly populationHolds: (counts: readonly HoldingCount[]) => void
  /**
   * Clear the moderation stage, which no route can do.
   *
   * The runner is the only thing that writes a quest's verdict, and it is in
   * another workspace — so without this, every steward test would be testing the
   * refusal rather than the review.
   */
  readonly moderate: (taskId: TaskId, decision?: 'approved' | 'rejected') => void
  /** Credit a sponsor's balance, which is `packages/db`'s job in the real one. */
  readonly credit: (agentId: AgentId, amount: number) => void
  /** Put rows into the two `/backend` sections (`#487`). */
  readonly showsOnBackend: (input: {
    readonly registrations?: readonly { name: string; registeredAt: string; path: string }[]
    readonly tickets?: readonly { subject: string; openedAt: string; status: string }[]
  }) => void
  /**
   * Record participation that was **not** accepted (`#454`).
   *
   * An accepted report already produces a row through `accept`, so this exists
   * for the two outcomes that one cannot express: a report a sponsor refused,
   * and one still waiting on a verdict.
   */
  readonly tookPartIn: (agentId: AgentId, row: QuestTakenPartIn) => void
  /**
   * What the ledger reader answers with (`#346`).
   *
   * Still not a ledger — the rows are handed in rather than booked. What the
   * wake-up digest does with them *is* this layer's job, though: it keeps only
   * the arrivals and sums them, and a fixture that could only answer empty
   * would let both halves of that pass untested.
   */
  readonly answersMovements: (movements: readonly CreditMovement[]) => void
  /**
   * Accept a report on a quest, which only a verdict can do in the real one
   * (`#178`).
   *
   * The whole read path is defined by *accepted*, so without this every results
   * test would be testing the empty case.
   */
  readonly accept: (input: {
    readonly taskId: TaskId
    readonly answers: Readonly<Record<string, string>>
    readonly agentId?: AgentId
  }) => void
  /**
   * Fix what the next audience count answers, whatever it is asked (`#350`).
   *
   * The floor that suppresses a small count is a rule about counts the real
   * population would have to be shrunk to produce — so a test of it cannot go
   * through the criteria, only through the number they returned.
   */
  readonly countAudienceAs: (citizens: number) => void
  /**
   * Hold a report on a red line, which only the moderation runner can do
   * (`#446`).
   *
   * It is in another workspace, so without this every steward test would be
   * testing the empty queue — and the withheld count a sponsor reads would have
   * no way to be anything but zero.
   */
  readonly holdOnRedLine: (input: {
    readonly submissionId: SubmissionId
    readonly taskId: TaskId
    readonly authorId?: AgentId
    readonly flaggedFor?: string
  }) => void
}

/**
 * The quest desk, in memory.
 *
 * **It reproduces the four rules the routes are allowed to rely on** rather than
 * answering yes to everything: a quest belongs to its author, an unmoderated
 * quest is invisible to a steward, nobody decides its own quest, and one account
 * occupies the review queue once. A fake that skipped them would let the API
 * tests pass while the SQL leaked — which is the failure a fixture is supposed
 * to make impossible rather than hide.
 *
 * Whether Postgres enforces them is asserted in `packages/db` against a real
 * one. What the API does with the answers is asserted here.
 */
export function fakeQuests(): FakeQuestDesk {
  const quests = new Map<
    string,
    { readonly own: OwnQuest; moderated: 'approved' | 'rejected' | null }
  >()
  const balances = new Map<string, number>()
  let movements: readonly CreditMovement[] = []
  const audienceAsked: AudienceCriteria[] = []
  /** `#524`'s figure. Empty until a test says otherwise. */
  let holdings: readonly HoldingCount[] = []
  const sections: {
    registrations: readonly { name: string; registeredAt: string; path: string }[]
    tickets: readonly { subject: string; openedAt: string; status: string }[]
  } = { registrations: [], tickets: [] }
  let fixedAudience: number | null = null

  const task = (input: {
    readonly id: TaskId
    readonly authorId: AgentId
    readonly draft: ReturnType<typeof QuestDraftSchema.parse>
    readonly status: Task['status']
  }): Task => ({
    id: input.id,
    type: TaskTypeSchema.parse(QUEST_TASK_TYPE),
    kind: 'quest',
    requires: input.draft.requires,
    suggests: [],
    grants: [],
    requiresAccounts: [],
    // A quest is answered in the sitting it is taken up in; `#343`'s flag is
    // about the four Academy rungs that measure a gap.
    spansSessions: false,
    minReputation: input.draft.minReputation,
    recommendedOrder: 100,
    title: input.draft.title,
    description: input.draft.description,
    instructions: input.draft.instructions,
    reward: input.draft.reward,
    slots: input.draft.slots,
    expiresAt: input.draft.expiresAt,
    audience: input.draft.audience,
    minActivityDays: input.draft.minActivityDays,
    distinctOperators: input.draft.distinctOperators,
    publishObstacles: input.draft.publishObstacles,
    // A draft, so no rate has been recorded yet (`#463`).
    platformFeePercent: null,
    rejectionReason: null,
    assistanceAllowed: input.draft.assistanceAllowed,
    prerequisiteTaskIds: [],
    timeoutHours: input.draft.timeoutHours,
    status: input.status,
    questions: input.draft.questions,
    proofVerifier: input.draft.proofVerifier,
    rewardNotice: nonWithdrawableNotice(input.draft.reward) ?? null,
    createdBy: input.authorId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })

  const put = (own: OwnQuest, moderated: 'approved' | 'rejected' | null = null): OwnQuest => {
    quests.set(own.task.id, { own, moderated })
    return own
  }

  const mine = (authorId: AgentId, taskId: TaskId) => {
    const held = quests.get(taskId)
    if (held === undefined) return undefined
    return held.own.task.createdBy === authorId ? held : undefined
  }

  const reserved = (authorId: AgentId): number =>
    [...quests.values()]
      .filter(
        (held) => held.own.task.createdBy === authorId && held.own.task.status === 'pending_review',
      )
      .reduce(
        (total, held) =>
          total +
          questCommitment({
            reward: held.own.task.reward,
            slots: held.own.task.slots ?? 0,
            publishObstacles: held.own.task.publishObstacles,
          }),
        0,
      )

  const accepted = new Map<string, (AcceptedReport & { readonly agentId?: AgentId })[]>()
  /** Participation that was not accepted — refused, or still waiting (`#454`). */
  const tookPart = new Map<AgentId, QuestTakenPartIn[]>()

  const audits = new Map<string, { agrees: boolean }>()

  /** Reports a red line was raised against, waiting on a steward (`#446`). */
  const heldRedLine = new Map<string, HeldReport & { readonly authorId?: AgentId }>()

  /**
   * What citizens said about the quests themselves (`#240`), keyed the way the
   * unique index keys it: one per citizen per quest.
   *
   * The fixture reproduces the one rule the routes rely on — **a `declined` row
   * never reaches `reports()`** — because a fake that served it would let an API
   * test pass while the sponsor read text it must never see. Whether Postgres
   * also refuses it is asserted in `packages/db` against a real one.
   */
  const reports = new Map<
    string,
    { taskId: string; kind: string; text: string | null; scrubbed: string | null }
  >()

  return {
    /**
     * The audit surface, in memory (`#221`).
     *
     * The rate and the draw are `packages/db`'s to get right and are asserted
     * there against a real Postgres; what this reproduces is the one rule the
     * routes rely on — a verdict is audited once.
     */
    async report(input) {
      const key = `${input.taskId}:${input.agentId}`
      const replaced = reports.has(key)
      /**
       * An `obstacle` report carries three answers and no paragraph (`#367`).
       * What the sponsor reads is all three, so the fake joins them — the
       * runner's own join is richer, and what these tests are about is the
       * route.
       */
      const text =
        input.text ??
        [input.did, input.broke, input.changed].filter((answer) => answer !== undefined).join('\n')

      reports.set(key, {
        taskId: input.taskId,
        kind: input.kind,
        text,
        // Approved immediately here, because the scrub is the moderation
        // runner's and these tests are about the route. `declined` gets none,
        // which is the rule being reproduced.
        scrubbed: input.kind === 'declined' ? null : text,
      })
      return { outcome: 'filed' as const, replaced }
    },

    async reports(taskId) {
      return [...reports.values()]
        .filter((row) => row.taskId === taskId && row.scrubbed !== null && row.kind !== 'declined')
        .map((row) => ({
          kind: row.kind as 'unclear' | 'feedback',
          text: row.scrubbed!,
          filedAt: new Date().toISOString() as never,
        }))
    },

    async reportCounts(taskId) {
      const own = [...reports.values()].filter((row) => row.taskId === taskId)
      return {
        claims: 0,
        acceptedReports: accepted.get(taskId)?.length ?? 0,
        unclear: own.filter((row) => row.kind === 'unclear').length,
        declined: own.filter((row) => row.kind === 'declined').length,
      }
    },

    async retire(taskId) {
      const held = quests.get(taskId)
      if (held === undefined || held.own.task.status !== 'active') {
        return { outcome: 'not-active' as const }
      }
      quests.set(taskId, {
        ...held,
        own: { ...held.own, task: { ...held.own.task, status: 'retired' } },
      })
      return { outcome: 'retired' as const }
    },

    /**
     * The queue as a steward reads it (`#181`).
     *
     * It reproduces the two rules the page depends on: a steward's **own** quest
     * is listed and marked rather than filtered out, and the cost shown is
     * capacity × price. Whether Postgres joins the sponsor and the moderation
     * verdict correctly is `packages/db`'s question.
     */
    async stewardQueue(stewardId) {
      return [...quests.values()]
        .filter((held) => held.own.task.status === 'pending_review')
        .map((held) => ({
          task: held.own.task,
          sponsor: { id: held.own.task.createdBy ?? null, name: 'a-sponsor' },
          sponsorBalance: { balance: 0, reserved: 0, available: 0 },
          total: held.own.task.reward.credits * (held.own.task.slots ?? 0),
          moderation: { decision: 'approved', model: 'test-model' },
          ownedByReader: held.own.task.createdBy === stewardId,
        })) as never
    },

    showsOnBackend: (input) => {
      if (input.registrations !== undefined) sections.registrations = input.registrations
      if (input.tickets !== undefined) sections.tickets = input.tickets
    },

    /**
     * What the population holds (`#524`).
     *
     * **Settable and empty by default**, and the floor is not reimplemented
     * here: the suppression is a `having` clause asserted against a real
     * Postgres, and a fake with its own copy would be a second opinion about the
     * one rule that protects citizens.
     */
    async holdings() {
      return holdings
    },

    async numbers() {
      return {
        accountsByPath: { mcp: 1 },
        agentsByRuntime: { openclaw: 1 },
        modelFamilies: {},
        modelsUndeclared: 1,
        citizens: 0,
        skillsGranted: {},
        questsByStatus: {},
        acceptedQuestReports: { market: 0, intraSwarm: 0 },
        // Empty, which on the steward's page reads as *no group is large enough to
        // show* rather than *nobody is blocked* (#147).
        permissionBlocks: [],
        escrowHeld: 0,
        ledgerSum: 0,
        mintBalance: 0,
        computedAt: new Date().toISOString(),
      } as never
    },

    /**
     * Who arrived and what is waiting (`#487`).
     *
     * Empty by default and settable, because what the routes rely on is the
     * shape and the gate — the *ordering* and the twenty-row cap are SQL and are
     * asserted against a real Postgres in `packages/db`, which is where a fake
     * would only be a second opinion.
     */
    async backendSections() {
      return {
        registrations: { rows: sections.registrations, computedAt: new Date().toISOString() },
        tickets: { rows: sections.tickets, computedAt: new Date().toISOString() },
      } as never
    },

    async auditQueue() {
      return []
    },

    /**
     * The red-line hold, in memory (`#446`).
     *
     * The queue and the SQL that decides *which state is current* are
     * `packages/db`'s and are asserted there against a real Postgres. What this
     * reproduces is what the routes rely on: a case is held until somebody rules
     * on it, one ruling ends it, and a steward does not rule on its own quest.
     */
    async heldReports() {
      return [...heldRedLine.values()]
    },

    async ruleOnHeldReport({ submissionId, stewardId, crossed }) {
      const held = heldRedLine.get(submissionId)
      if (held === undefined) return { outcome: 'not-held' }
      if (held.authorId !== undefined && held.authorId === stewardId) {
        return { outcome: 'own-quest' }
      }
      heldRedLine.delete(submissionId)
      return { outcome: crossed ? 'upheld' : 'released' }
    },

    async withheld(taskId) {
      return [...heldRedLine.values()].filter((report) => report.taskId === taskId).length
    },

    async audit({ submissionId, agrees, reason }) {
      if (reason.trim().length < 10) return { outcome: 'unknown-submission' }
      if (audits.has(submissionId)) return { outcome: 'already-audited' }
      audits.set(submissionId, { agrees })
      return { outcome: 'recorded' }
    },

    async disagreement() {
      const decisions = [...audits.values()]
      const disagreed = decisions.filter((decision) => !decision.agrees).length
      return {
        rate: decisions.length === 0 ? 0 : disagreed / decisions.length,
        audited: decisions.length,
      }
    },

    accept({ taskId, answers, agentId }) {
      const held = accepted.get(taskId) ?? []
      held.push({
        acceptedAt: new Date().toISOString(),
        answers,
        ...(agentId !== undefined && { agentId }),
      })
      accepted.set(taskId, held)
    },

    async results(taskId) {
      return (accepted.get(taskId) ?? []).map(({ acceptedAt, answers }) => ({
        acceptedAt,
        answers,
      }))
    },

    /**
     * The other direction through the same rows (`#454`): what this agent took
     * part in, rather than who took part in this quest.
     *
     * **Assembled from `accepted` and `tookPart` rather than a third map**, so a
     * test that arranges an accepted report gets a row here without arranging it
     * twice — which is the drift a fixture is most likely to introduce.
     */
    tookPartIn(agentId: AgentId, row: QuestTakenPartIn) {
      tookPart.set(agentId, [...(tookPart.get(agentId) ?? []), row])
    },

    async takenPartIn(agentId) {
      const wasAccepted = [...accepted.entries()].flatMap(([taskId, held]) =>
        held
          .filter((row) => row.agentId === agentId)
          .map((row) => ({
            questId: taskId as TaskId,
            title: quests.get(taskId)?.own.task.title ?? 'a quest',
            at: row.acceptedAt,
            outcome: 'accepted' as const,
          })),
      )

      // The row's own title wins: a test arranging participation names the
      // quest it is talking about, and looking it up would discard that for a
      // quest this fake was never told to hold.
      const rest = tookPart.get(agentId) ?? []

      return [...wasAccepted, ...rest].sort((one, two) => (one.at < two.at ? 1 : -1))
    },

    async counts(taskId) {
      const held = quests.get(taskId)
      const closed = (held?.own.task.questions ?? []).filter(
        (question) => question.options !== undefined,
      )
      const counts: Record<string, Record<string, number>> = {}

      for (const question of closed) {
        counts[question.key] = Object.fromEntries(
          (question.options ?? []).map((option) => [option, 0]),
        )
        for (const report of accepted.get(taskId) ?? []) {
          const answer = report.answers[question.key]
          if (answer !== undefined && counts[question.key]?.[answer] !== undefined) {
            counts[question.key]![answer] = (counts[question.key]![answer] ?? 0) + 1
          }
        }
      }

      return counts
    },

    async ownAnswer({ taskId, agentId }) {
      const mine = (accepted.get(taskId) ?? []).find((report) => report.agentId === agentId)
      if (mine === undefined) return undefined
      const { acceptedAt, answers } = mine
      return { acceptedAt, answers }
    },

    moderate(taskId, decision = 'approved') {
      const held = quests.get(taskId)
      if (held === undefined) return
      held.moderated = decision
      if (decision === 'rejected') {
        quests.set(taskId, {
          own: {
            task: { ...held.own.task, status: 'rejected' },
            rejectionReason: 'It crosses a red line.',
            awaitingModeration: false,
          },
          moderated: decision,
        })
      }
    },

    credit(agentId, amount) {
      balances.set(agentId, (balances.get(agentId) ?? 0) + amount)
    },

    countAudienceAs(citizens) {
      fixedAudience = citizens
    },

    holdOnRedLine({ submissionId, taskId, authorId, flaggedFor }) {
      heldRedLine.set(submissionId, {
        submissionId,
        taskId,
        questTitle: 'A quest',
        questInstructions: 'What the sponsor asked for.',
        flaggedFor: flaggedFor ?? 'It tells the reader to run a script.',
        model: 'test-model',
        heldAt: new Date().toISOString() as HeldReport['heldAt'],
        answers: [{ questionKey: 'what-happened', text: 'The report, as written.' }],
        ...(authorId !== undefined && { authorId }),
      })
    },

    answersMovements(next) {
      movements = next
    },

    async create({ authorId, draft }) {
      const parsed = QuestDraftSchema.parse(draft)
      const id = TaskIdSchema.parse(randomUUID())
      return put({
        task: task({ id, authorId, draft: parsed, status: 'draft' }),
        rejectionReason: null,
        awaitingModeration: false,
      })
    },

    async update({ authorId, taskId, patch }) {
      const held = mine(authorId, taskId)
      if (held === undefined) {
        return quests.has(taskId) ? { outcome: 'not-yours' } : { outcome: 'unknown-quest' }
      }

      const { status } = held.own.task
      if (status !== 'draft' && status !== 'rejected') return { outcome: 'not-editable', status }

      const parsed = QuestPatchSchema.parse(patch)
      const updated: OwnQuest = {
        task: {
          ...held.own.task,
          ...(parsed.title !== undefined && { title: parsed.title }),
          ...(parsed.instructions !== undefined && { instructions: parsed.instructions }),
          ...(parsed.description !== undefined && { description: parsed.description }),
          ...(parsed.reward !== undefined && { reward: parsed.reward }),
          ...(parsed.slots !== undefined && { slots: parsed.slots }),
          ...(parsed.expiresAt !== undefined && { expiresAt: parsed.expiresAt }),
          /**
           * The targeting, which a patch may change like anything else
           * (`storage/quests/write.ts`). A fake that dropped it would let a test
           * of what a change costs in reach pass while changing nothing.
           */
          ...(parsed.audience !== undefined && { audience: parsed.audience }),
          ...(parsed.requires !== undefined && { requires: parsed.requires }),
          ...(parsed.minReputation !== undefined && { minReputation: parsed.minReputation }),
          ...(parsed.minActivityDays !== undefined && {
            minActivityDays: parsed.minActivityDays,
          }),
          ...(parsed.distinctOperators !== undefined && {
            distinctOperators: parsed.distinctOperators,
          }),
          ...(parsed.publishObstacles !== undefined && {
            publishObstacles: parsed.publishObstacles,
          }),
        },
        rejectionReason: held.own.rejectionReason,
        awaitingModeration: false,
      }

      return { outcome: 'written', quest: put(updated) }
    },

    async submit({ authorId, taskId }) {
      const held = mine(authorId, taskId)
      if (held === undefined) {
        return quests.has(taskId) ? { outcome: 'not-yours' } : { outcome: 'unknown-quest' }
      }

      const { status } = held.own.task
      if (status !== 'draft' && status !== 'rejected') return { outcome: 'not-editable', status }

      const queued = [...quests.values()].filter(
        (other) =>
          other.own.task.createdBy === authorId && other.own.task.status === 'pending_review',
      )
      const first = queued[0]
      if (queued.length >= QUEST_PENDING_LIMIT && first !== undefined) {
        return { outcome: 'queue-occupied', by: first.own.task.id }
      }

      const wanted = questCommitment({
        reward: held.own.task.reward,
        slots: held.own.task.slots ?? 0,
        publishObstacles: held.own.task.publishObstacles,
      })
      const free = (balances.get(authorId) ?? 0) - reserved(authorId)
      if (free < wanted) return { outcome: 'insufficient-funds', shortfall: wanted - free }

      return {
        outcome: 'submitted',
        quest: put(
          {
            task: { ...held.own.task, status: 'pending_review' },
            rejectionReason: null,
            awaitingModeration: true,
          },
          null,
        ),
      }
    },

    /**
     * The same money per quest (`#324`), reproducing the one property the route
     * relies on: the rows sum to the scalar above.
     */
    async commitments(authorId) {
      return [...quests.values()]
        .filter((held) => held.own.task.createdBy === authorId)
        .filter(
          (held) => held.own.task.status === 'pending_review' || held.own.task.status === 'active',
        )
        .map((held) => ({
          taskId: held.own.task.id,
          title: held.own.task.title,
          status: held.own.task.status,
          reserved:
            held.own.task.status === 'pending_review'
              ? questCommitment({
                  reward: held.own.task.reward,
                  slots: held.own.task.slots ?? 0,
                  publishObstacles: held.own.task.publishObstacles,
                })
              : 0,
          escrowed:
            held.own.task.status === 'active'
              ? questCommitment({
                  reward: held.own.task.reward,
                  slots: held.own.task.slots ?? 0,
                  publishObstacles: held.own.task.publishObstacles,
                })
              : 0,
          // The fixture never books a payout, so the whole cost is still in
          // escrow and this is zero. It is present rather than omitted because
          // the route contract is `escrowed + paid` adds up to what was funded,
          // and a fixture that dropped the field would let a caller forget it.
          paid: 0,
        }))
    },

    /**
     * The citizen's own credit movements (`#333`).
     *
     * **Empty, and that is the whole fixture.** The rows are the ledger's and
     * this file holds no ledger — reproducing one would be reimplementing double
     * entry to test a route that does nothing but pass the list through. What
     * the route contract actually needs from here is the *shape*: three fields,
     * and `balance` and `total` served alongside the rows rather than derived
     * from them. The behaviour is tested against a real database in
     * `packages/db/src/storage/credits.test.ts`, which is where it belongs.
     */
    async movements() {
      return { balance: 0, total: movements.length, movements: [...movements] }
    },

    /**
     * The undo for `submit` (`#323`), reproducing the one rule the route is
     * allowed to rely on: it works from `pending_review` and from nowhere else.
     * The reservation needs no unwinding here for the same reason it needs none
     * in storage — `reserved` is summed from the quests currently in the queue.
     */
    async withdraw({ authorId, taskId }) {
      const held = mine(authorId, taskId)
      if (held === undefined) {
        return quests.has(taskId) ? { outcome: 'not-yours' } : { outcome: 'unknown-quest' }
      }

      const { status } = held.own.task
      if (status !== 'pending_review') return { outcome: 'not-in-review', status }

      return {
        outcome: 'withdrawn',
        quest: put(
          {
            task: { ...held.own.task, status: 'draft' },
            rejectionReason: held.own.rejectionReason,
            awaitingModeration: false,
          },
          null,
        ),
      }
    },

    /**
     * Balance minus what is reserved, reproducing `#174`'s rule rather than
     * returning the raw balance.
     *
     * **The reservation is the half a fake would be tempted to skip**, and
     * skipping it would let the console's tests pass while a sponsor with one
     * quest in review appeared able to fund a second one out of the same
     * credits. Whether Postgres computes it the same way is asserted in
     * `packages/db` against a real one.
     */
    async balance(authorId) {
      const balance = balances.get(authorId) ?? 0
      const reserved = [...quests.values()]
        .filter(
          (held) =>
            held.own.task.createdBy === authorId && held.own.task.status === 'pending_review',
        )
        .reduce(
          (total, held) =>
            total +
            questCommitment({
              reward: held.own.task.reward,
              slots: held.own.task.slots ?? 0,
              publishObstacles: held.own.task.publishObstacles,
            }),
          0,
        )

      return { balance, reserved, available: balance - reserved }
    },

    /**
     * A fixed population rather than a modelled one (`#227`).
     *
     * The count is `packages/db`'s question — it reads statuses, currently held
     * skills, a reputation sum and a timestamp, and `activity.test.ts` asserts
     * all four against a real database. Reimplementing that here would be a
     * second definition of the audience that agrees until one of them grows a
     * condition; what these tests need is that the number reaches the page and
     * that the criteria it is asked about are the quest's own.
     */
    audienceAsked,
    populationHolds: (counts) => {
      holdings = counts
    },

    async audience(criteria) {
      audienceAsked.push(criteria)
      if (fixedAudience !== null) return fixedAudience

      return criteria.minActivityDays === null ? FAKE_AUDIENCE : 0
    },

    async listOwn(authorId) {
      return [...quests.values()]
        .filter((held) => held.own.task.createdBy === authorId)
        .map((held) => held.own)
    },

    async readOwn(authorId, taskId) {
      return mine(authorId, taskId)?.own
    },

    async reviewQueue() {
      return [...quests.values()]
        .filter(
          (held) => held.own.task.status === 'pending_review' && held.moderated === 'approved',
        )
        .map((held) => held.own.task)
    },

    async publish({ stewardId, taskId }) {
      const held = quests.get(taskId)
      if (held === undefined) return { outcome: 'unknown-quest' }
      if (held.own.task.status !== 'pending_review') {
        return { outcome: 'not-in-review', status: held.own.task.status }
      }
      if (held.own.task.createdBy === stewardId) return { outcome: 'own-quest' }
      if (held.moderated !== 'approved') return { outcome: 'awaiting-moderation' }

      const escrowed = questCommitment({
        reward: held.own.task.reward,
        slots: held.own.task.slots ?? 0,
        publishObstacles: held.own.task.publishObstacles,
      })

      put(
        {
          task: { ...held.own.task, status: 'active' },
          rejectionReason: null,
          awaitingModeration: false,
        },
        'approved',
      )

      return { outcome: 'published', escrowed }
    },

    async refuse({ stewardId, taskId, reason }) {
      const held = quests.get(taskId)
      if (held === undefined) return { outcome: 'unknown-quest' }
      if (held.own.task.status !== 'pending_review') {
        return { outcome: 'not-in-review', status: held.own.task.status }
      }
      if (held.own.task.createdBy === stewardId) return { outcome: 'own-quest' }

      put(
        {
          task: { ...held.own.task, status: 'rejected' },
          rejectionReason: reason,
          awaitingModeration: false,
        },
        held.moderated,
      )

      return { outcome: 'refused' }
    },
  }
}
