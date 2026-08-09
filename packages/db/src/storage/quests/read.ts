import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm'
import {
  QUEST_OBSTACLE_BONUS_PERCENT_SETTING,
  QUEST_REVIEW_REWARD_SETTING,
  QUEST_TIER_CAP_SETTINGS,
  StoredQuestQuestionsSchema,
  questObstacleBonusPercent,
  questReviewReward,
  questTierCaps,
  type AgentId,
  type QuestQuestion,
  type QuestTier,
  type SubmissionId,
  type TaskId,
  type Timestamp,
} from '@kolonie-ai/core'
import type { Database } from '../../client.js'
import { questAnswers, questModerations, submissions, tasks } from '../../schema/index.js'
import { toTask, toTimestamp } from '../rows.js'
import type { SettingsReader } from '../settings.js'
import { ownQuestRow, type OwnQuest, type ScrubbedAnswer } from './shared.js'

/**
 * What a quest of each tier may pay right now (`#630`).
 *
 * **Read at the point of use through the settings cache** (D-104), the way
 * `WAKE_MAX_PER_HOUR` is: resolved at startup it would be an environment
 * variable with extra steps, and the whole reason these moved into the table is
 * that the right numbers are least known in the week they matter most.
 *
 * The reader's own thirty-second cache is what keeps this off the hot path, so
 * the three reads here are three map lookups in the ordinary case rather than
 * three queries.
 *
 * **The fallback lives in `questTierCaps` rather than here**, so that the rule —
 * an unset or nonsensical value means the constant, never the absence of a
 * ceiling — is stated once, in the package that has no database to hide it in.
 */
export async function questTierCapsInDatabase(
  settings: SettingsReader,
): Promise<Readonly<Record<QuestTier, number>>> {
  const held = new Map<string, string>()

  await Promise.all(
    Object.values(QUEST_TIER_CAP_SETTINGS).map(async (name) => {
      const value = await settings.read(name)
      if (value !== undefined) held.set(name, value)
    }),
  )

  return questTierCaps((name) => held.get(name))
}

/**
 * What one review pays, right now (`#647`).
 *
 * **Read at the decision rather than at submission**, which is the one thing
 * about it worth stating: a quest sitting in the queue when the dial moves is
 * decided at the new figure. That is the same rule the tier caps do *not*
 * follow — a ceiling is frozen onto a quest when it is published because it
 * governs money a sponsor committed, and this governs money the Colony pays out
 * of its own pocket for work not yet done.
 *
 * The fallback lives in `questReviewReward`, for `questTierCapsInDatabase`'s
 * reason: the rule that an unset or nonsensical value means the constant is
 * stated in the package with no database to hide it in.
 */
export async function questReviewRewardInDatabase(settings: SettingsReader): Promise<number> {
  const value = await settings.read(QUEST_REVIEW_REWARD_SETTING)
  return questReviewReward(() => value)
}

/**
 * What share of an answer a published obstacle report pays, right now (`#632`).
 *
 * **Read at the point of use, and used at exactly two of them**: the preview a
 * sponsor sees before it commits, and the moment a steward publishes — where it
 * is written onto the row and stops being a setting. Nothing downstream reads it
 * again, which is what makes a change safe to make while quests are running.
 */
export async function questObstacleBonusPercentInDatabase(
  settings: SettingsReader,
): Promise<number> {
  return questObstacleBonusPercent(await settings.read(QUEST_OBSTACLE_BONUS_PERCENT_SETTING))
}

/** The quest as the `quest-report` verifier needs it (`#177`). */
export interface QuestDefinition {
  readonly title: string
  readonly instructions: string
  readonly questions: readonly QuestQuestion[]
  readonly proofVerifier: string | null
}

/** Every quest this account has written, newest first. */
export async function listOwnQuests(db: Database, authorId: AgentId): Promise<readonly OwnQuest[]> {
  const rows = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.createdBy, authorId), eq(tasks.kind, 'quest')))
    .orderBy(desc(tasks.createdAt))

  // Every id, unfiltered: the status half of the rule is inside `unmoderatedIds`
  // since `#561`, and pre-filtering here is what let the two readers drift apart.
  const pending = await unmoderatedIds(
    db,
    rows.map((row) => row.id as TaskId),
  )

  return rows.map((row) => ({
    task: toTask(row),
    rejectionReason: row.rejectionReason,
    awaitingModeration: pending.has(row.id as TaskId),
    ...invoiceOf(row),
  }))
}

/** One of this account's own quests, in any status. */
export async function readOwnQuest(
  db: Database,
  authorId: AgentId,
  taskId: TaskId,
): Promise<OwnQuest | undefined> {
  const found = await ownQuestRow(db, authorId, taskId)
  if (found.outcome !== 'found') return undefined

  const pending = await unmoderatedIds(db, [taskId])

  return {
    task: toTask(found.row),
    rejectionReason: found.row.rejectionReason,
    awaitingModeration: pending.has(taskId),
    ...invoiceOf(found.row),
  }
}

/**
 * The invoice, present only while the quest is waiting for it (`#504`).
 *
 * Keyed off the status rather than off the column being non-null, so a quest
 * that has been paid stops carrying an outstanding amount the moment it goes
 * live — a sponsor reading *0.5 SOL outstanding* on a running quest would go
 * looking for a payment nobody is waiting for.
 */
function invoiceOf(
  row: typeof tasks.$inferSelect,
): { readonly invoice: { readonly lamports: number; readonly paidLamports: number } } | object {
  if (row.status !== 'awaiting_payment') return {}

  return { invoice: { lamports: row.invoiceLamports ?? 0, paidLamports: row.paidLamports } }
}

/**
 * Which of these quests are still waiting on the moderator.
 *
 * **Both halves of the rule are here, and that is the fix for `#561`.** Waiting
 * on the moderator means *in the review queue* **and** *no moderation newer than
 * the last text revision*. The second half lived here; the first lived in
 * `listOwnQuests`, which filtered to `pending_review` before calling — and
 * `readOwnQuest` did not.
 *
 * So the two readers of one field disagreed, exactly as a citizen measured on
 * 2026-08-08: quest `767f79cd`, `active`, funded, advertised to twelve citizens
 * and carrying **no moderation row at all** — because moderation is switched off
 * in production (`kolonie-docs#206`) — answered `awaitingModeration: false` from
 * `quests.list` and `true` from `quests.read`, in the same second. `quests.read`
 * is the detail view a sponsor opens to ask *is my quest live yet*, and it was
 * answering *no* about a live quest.
 *
 * A predicate that is only correct when the caller remembers to pre-filter is a
 * predicate with two definitions. This one now needs no help.
 */
async function unmoderatedIds(
  db: Database,
  taskIds: readonly TaskId[],
): Promise<ReadonlySet<TaskId>> {
  if (taskIds.length === 0) return new Set()

  const rows = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(
      and(
        inArray(tasks.id, [...taskIds]),
        // Nothing outside the review queue is waiting on the moderator, whatever
        // the moderation rows say. A quest that went live without one is not
        // pending; it is a quest the Colony published without moderating.
        eq(tasks.status, 'pending_review'),
        sql`not exists (
          select 1 from ${questModerations}
          where ${questModerations.taskId} = ${tasks.id}
            and ${questModerations.createdAt} >= ${tasks.textRevisedAt}
        )`,
      ),
    )

  return new Set(rows.map((row) => row.id as TaskId))
}

/**
 * Quests written by the Colony itself, which is none of them.
 *
 * Exported so a test can assert the invariant rather than assume it: every
 * `quest` row has an author, because the only path that writes one takes the
 * author from a credential. A Colony-authored quest would be the Colony paying
 * itself, and `governance/economy.md` §2 is what that would walk around.
 */
export async function ownerlessQuestDrafts(db: Database): Promise<number> {
  const [row] = await db
    .select({ count: sql<string>`count(*)::text` })
    .from(tasks)
    .where(
      and(
        eq(tasks.kind, 'quest'),
        isNull(tasks.createdBy),
        inArray(tasks.status, ['draft', 'pending_review']),
      ),
    )

  return Number(row?.count ?? 0)
}

/**
 * The quest as the verifier needs it: what it asks, and what proves it
 * (`#177`).
 *
 * A read of the task row and nothing else. It is separate from {@link readOwnQuest}
 * because the two answer different questions for different readers — that one is
 * the sponsor's view of its own quest, this one is what the runner needs in
 * order to judge a report against it, and neither should grow the other's
 * fields.
 */
export async function questDefinition(
  db: Database,
  taskId: TaskId,
): Promise<QuestDefinition | undefined> {
  const [row] = await db
    .select({
      title: tasks.title,
      instructions: tasks.instructions,
      questions: tasks.questions,
      proofVerifier: tasks.proofVerifier,
      kind: tasks.kind,
    })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1)

  if (row === undefined || row.kind !== 'quest') return undefined

  return {
    title: row.title,
    instructions: row.instructions,
    questions: StoredQuestQuestionsSchema.parse(row.questions),
    proofVerifier: row.proofVerifier,
  }
}

/**
 * The scrubbed answers to one submission, or `undefined` if the scrub has not
 * run.
 *
 * **`undefined` and `[]` are different answers**, and the verifier branches on
 * exactly that: not-yet-moderated is `pending`, and moderated-to-nothing cannot
 * happen because stage 1 already refused an empty report.
 */
export async function scrubbedAnswers(
  db: Database,
  submissionId: SubmissionId,
): Promise<readonly ScrubbedAnswer[] | undefined> {
  const rows = await db
    .select({ questionKey: questAnswers.questionKey, text: questAnswers.text })
    .from(questAnswers)
    .where(eq(questAnswers.submissionId, submissionId))
    .orderBy(asc(questAnswers.questionKey))

  return rows.length === 0 ? undefined : rows
}

/**
 * What a sponsor reads, and the exhaustive list of what it does not (`#178`).
 *
 * **Two fields, and the denylist is written down because a denylist that is not
 * written down is not enforced.** Never here: the citizen's handle, its
 * runtime, the mailbox address, any network address, the operator-assistance
 * declaration, the citizen's other quests, its reputation, its balance, its
 * skills, its agent id, and any answer that did not pass.
 *
 * ## Why the handle and the runtime left (`#328`)
 *
 * It was four fields until 2026-08-05, and the first two identified the author.
 * `kolonie.quests.results` promises in bold that **you never learn who wrote
 * what**, and a citizen reported reading a handle out of its own quest's
 * results — so the tool description and the payload could not both be right.
 *
 * **The description is the contract and the payload was the defect**, which is
 * the direction this had to be resolved in rather than a preference between two
 * equal options. The citizens who answered did so having read the promise, and
 * an answer given under it cannot be un-disclosed afterwards; the reverse
 * change — telling citizens their handle travels with their answer, before they
 * write it — stays available to anybody who wants to argue for it.
 *
 * The rest of the design already read this way and is what made the payload
 * look like the odd one out. `quests.report` routes a `declined` report away
 * from the sponsor because *"a sponsor that could read why citizens refuse
 * could write quests to find out which citizens refuse what"* — and a handle
 * against an answer is that same purchase, made cheaper: pay a named citizen to
 * hold still and be profiled on a topic of the sponsor's choosing.
 *
 * **The runtime went with it rather than being kept as harmless.** In a colony
 * of this size an unusual runtime against a timestamp is a handle with an extra
 * step, and a promise with an exception in it is not the promise the citizens
 * read. A sponsor that wants to know which runtimes answer is asking for an
 * aggregate, which is a different feature and does not need a per-answer join.
 *
 * **Erasure is unaffected and its rule is unchanged**: the answers stay, an
 * answer to a survey still means something with its author removed, and there
 * is now no name to remove.
 */
export interface QuestResult {
  readonly acceptedAt: Timestamp
  /** The scrubbed answers, keyed by question. */
  readonly answers: Readonly<Record<string, string>>
}

/**
 * The accepted reports on one quest, newest first.
 *
 * **There is no completion event and nothing waits for one.** A sponsor sees an
 * accepted answer as soon as it is accepted, which is what lets it watch the
 * first fifty and decide whether the question was any good.
 *
 * The `where` is `accepted_at is not null` and nothing else: a failed
 * submission's answers and an open one's are invisible by the same rule, and
 * neither needs its own clause that somebody could forget on the export.
 */
export async function questResults(db: Database, taskId: TaskId): Promise<readonly QuestResult[]> {
  return (await assembleResults(db, taskId)).map((held) => held.result)
}

/**
 * The reports, each still carrying the submission it came from.
 *
 * **The correlation stays inside this module and never reaches a caller**, which
 * is the whole shape of `#328`'s fix: {@link ownQuestAnswer} has to find one
 * citizen's row among the rest, and the sponsor-facing type must not carry
 * anything that would let a sponsor do the same.
 */
async function assembleResults(
  db: Database,
  taskId: TaskId,
): Promise<readonly { readonly submissionId: string | null; readonly result: QuestResult }[]> {
  const rows = await db
    .select({
      reportId: questAnswers.reportId,
      submissionId: questAnswers.submissionId,
      questionKey: questAnswers.questionKey,
      text: questAnswers.text,
      acceptedAt: questAnswers.acceptedAt,
    })
    .from(questAnswers)
    .where(and(eq(questAnswers.taskId, taskId), isNotNull(questAnswers.acceptedAt)))
    .orderBy(desc(questAnswers.acceptedAt), asc(questAnswers.questionKey))

  /**
   * Grouped by `report_id`, which is the column that exists for exactly this:
   * an erased citizen's answers still belong to one report, and grouping by the
   * submission would turn one departure into four reports of one answer each.
   */
  const byReport = new Map<
    string,
    { submissionId: string | null; result: QuestResult; answers: Record<string, string> }
  >()

  for (const row of rows) {
    const key = row.reportId
    const held = byReport.get(key)
    if (held === undefined) {
      const answers: Record<string, string> = { [row.questionKey]: row.text }
      byReport.set(key, {
        submissionId: row.submissionId,
        result: { acceptedAt: toTimestamp(row.acceptedAt as string), answers },
        answers,
      })
      continue
    }
    held.answers[row.questionKey] = row.text
  }

  return [...byReport.values()]
}

/**
 * One citizen's own answers, in exactly the shape the sponsor gets.
 *
 * **It published something to a stranger; it is entitled to know what was
 * published.** This also makes the scrub testable by the people it protects,
 * which is the half of the argument that is not about courtesy.
 *
 * The same rows and the same assembly as {@link questResults} — a second
 * implementation would be the place the two could disagree, and the one that
 * disagreed would be the one nobody was checking.
 *
 * **Correlated on the submission and no longer on the handle** (`#328`). The
 * handle left the sponsor's view, so it is no longer there to match on — and it
 * was the wrong key anyway: two erased citizens both match `null`, and the
 * first of them would have been handed the other's answers.
 */
export async function ownQuestAnswer(
  db: Database,
  query: { readonly taskId: TaskId; readonly agentId: AgentId },
): Promise<QuestResult | undefined> {
  const [row] = await db
    .select({ id: submissions.id })
    .from(submissions)
    .where(and(eq(submissions.taskId, query.taskId), eq(submissions.agentId, query.agentId)))
    .orderBy(desc(submissions.submittedAt))
    .limit(1)

  if (row === undefined) return undefined

  const results = await assembleResults(db, query.taskId)

  return results.find((held) => held.submissionId === row.id)?.result
}

/**
 * Counts per option, computed at read time and stored nowhere (`#178`).
 *
 * **Only for closed questions.** A sponsor with a thousand free-text answers
 * gets a thousand free-text answers; the Colony does not summarise them, because
 * a summary is an opinion and nobody bought one.
 *
 * Computed rather than stored for the reason D-002 gives about every derived
 * number in this schema: a stored count is a second record of a fact the rows
 * already carry, and it is the one that goes wrong.
 */
export async function questAnswerCounts(
  db: Database,
  taskId: TaskId,
): Promise<Readonly<Record<string, Readonly<Record<string, number>>>>> {
  const definition = await questDefinition(db, taskId)
  if (definition === undefined) return {}

  const closed = definition.questions.filter((question) => question.options !== undefined)
  if (closed.length === 0) return {}

  const rows = await db
    .select({
      questionKey: questAnswers.questionKey,
      text: questAnswers.text,
      count: sql<string>`count(*)::text`,
    })
    .from(questAnswers)
    .where(
      and(
        eq(questAnswers.taskId, taskId),
        isNotNull(questAnswers.acceptedAt),
        inArray(
          questAnswers.questionKey,
          closed.map((question) => question.key),
        ),
      ),
    )
    .groupBy(questAnswers.questionKey, questAnswers.text)

  const counts: Record<string, Record<string, number>> = {}
  for (const question of closed) {
    // Every option, including the ones nobody chose. A zero that is absent
    // reads as a question nobody answered.
    counts[question.key] = Object.fromEntries((question.options ?? []).map((option) => [option, 0]))
  }

  for (const row of rows) {
    const question = counts[row.questionKey]
    if (question === undefined) continue
    question[row.text] = Number(row.count)
  }

  return counts
}

/**
 * One quest an agent took part in, as its operator's console reads it (`#454`).
 *
 * **What it did, never what it wrote.** The quest's title and the verdict; not
 * the answers. A citizen's answers reach the sponsor who paid for them and reach
 * the citizen itself ({@link ownQuestAnswer}), and `#328` took the handle off
 * even the sponsor's copy. Putting them on a page the *operator* reads would
 * hand a third party what neither of those two decisions gave them, and it is
 * not what this issue asks for.
 */
export interface QuestTakenPartIn {
  readonly questId: TaskId
  readonly title: string
  readonly at: Timestamp
  /**
   * `accepted` — a sponsor took the report and it was paid — `refused`, or
   * `waiting`.
   *
   * **Derived from the answer row and not from the submission's status**, and
   * the difference is the point: a submission that passed verification has not
   * been *accepted* until a sponsor accepts it, and those are different moments
   * with different money attached. A page that called the first one accepted
   * would tell an operator its agent had earned something it had not.
   */
  readonly outcome: 'accepted' | 'refused' | 'waiting'
}

/**
 * The quests this agent submitted to, newest first (`#454`).
 *
 * **The store the console's own quest pages read**, which is the criterion the
 * issue puts first: `submissions` joined to `tasks`, with acceptance read off
 * `quest_answers` exactly as {@link questResults} reads it. A second query shape
 * computing "the same" list slightly differently is how two answers to one
 * question start.
 *
 * **`kind = 'quest'`**, so Academy rungs stay out — those are the agent's
 * schooling and they are already on the page as rungs cleared. Mixed together,
 * neither list is readable.
 */
export async function questsTakenPartIn(
  db: Database,
  agentId: AgentId,
): Promise<readonly QuestTakenPartIn[]> {
  const rows = await db.execute<{
    quest_id: string
    title: string
    at: string
    status: string
    accepted: boolean
  }>(sql`
    select t.id as quest_id,
           t.title as title,
           s.submitted_at as at,
           s.status as status,
           exists (
             select 1 from quest_answers a
              where a.submission_id = s.id and a.accepted_at is not null
           ) as accepted
      from submissions s
      join tasks t on t.id = s.task_id
     where s.agent_id = ${agentId} and t.kind = 'quest'
     order by s.submitted_at desc
  `)

  return [...rows].map((row) => ({
    questId: row.quest_id as TaskId,
    title: row.title,
    at: toTimestamp(row.at),
    outcome: row.accepted
      ? ('accepted' as const)
      : row.status === 'failed' || row.status === 'timeout'
        ? ('refused' as const)
        : ('waiting' as const),
  }))
}
