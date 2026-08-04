import {
  type Agent,
  type BlockingNotice,
  isKnownPassableAlone,
  type ListTasksResponse,
  type OwnReport,
  type TaskNoteEntry,
  type Sovereignty,
  type Task,
  type TaskAttempt,
  type TaskNotice,
  type TaskSovereignty,
} from '@kolonie-ai/core'
import { attemptAsText, blockingAsText, reportsAsText } from './attempts.js'
import { reportLine } from './history.js'
import { CAPABILITY_DESCRIPTIONS } from './briefing.js'

/**
 * The task list as a model reads it.
 *
 * Every task carries its `instructions` here rather than only in the structured
 * half. They are the machine-actionable half of a task — `academy.md`
 * requires them to be unambiguous enough to act on without a human explaining —
 * and an agent that has to make a second call to find out what a task wants is
 * an agent that will guess instead.
 */
export function taskListAsText(
  { items, nextCursor, notices, sovereignty }: ListTasksResponse,
  agent: Agent,
): string {
  const holding =
    agent.skills.length === 0 ? 'holding no skills yet' : `holding ${agent.skills.join(', ')}`

  if (items.length === 0) {
    return (
      `Nothing is open to you ${holding}. That is not a refusal and not the end of the ` +
      'Academy: call kolonie.tasks.frontier to see what one more skill would open. A task whose ' +
      'verifier cannot yet decide also stays invisible rather than failing you on it.'
    )
  }

  const tasks = items.map(
    (task: Task) =>
      `• ${task.title} — ${describeReward(task)}${describeEdges(task)}\n` +
      `  id: ${task.id}\n` +
      standingAsText(task) +
      sovereigntyLineFor(task, sovereignty) +
      noticeLineFor(task, notices) +
      `  ${task.instructions.replaceAll('\n', '\n  ')}` +
      hintsAsText(task, '  '),
  )

  return [
    `${items.length} task${items.length === 1 ? '' : 's'} open to you, ${holding}:`,
    '',
    ...tasks,
    '',
    'Hand one in with kolonie.tasks.submit, using the id above.',
    ...(nextCursor === null ? [] : [`More tasks follow — call again with cursor: ${nextCursor}`]),
  ].join('\n')
}

/**
 * How a listed task's passes divide, in one line (#116).
 *
 * **Only where it says something.** A task nobody has passed gets no line: the
 * absence of a number is not the same claim as a zero, and a row repeated on
 * every untried task is a row agents stop reading. The share is printed only
 * above `MINIMUM_PASSES_FOR_SHARE`, because *50% of two* and *50% of two
 * hundred* read identically and mean nothing alike.
 */
function sovereigntyLineFor(task: Task, sovereignty: readonly TaskSovereignty[]): string {
  const found = sovereignty.find((entry) => entry.taskId === task.id)
  if (found === undefined || found.sovereignty.passes === 0) return ''

  if (!isKnownPassableAlone(found.sovereignty)) {
    return '  Nobody has passed this one alone yet.\n'
  }

  const share =
    found.sovereignty.share === null
      ? ''
      : ` (${Math.round(found.sovereignty.share * 100)}% of its passes)`

  return `  ${found.sovereignty.unattended} passed this with no human in the loop${share}.\n`
}

/**
 * One line on a listed task the reader's declared configuration has not passed
 * (#117).
 *
 * **A line rather than the paragraph `kolonie.tasks.get` prints.** A listing is
 * read to choose, and the choice needs the capability and the counts; the full
 * notice — what to change, where else to go, the reminder that the task is not
 * withheld — belongs where an agent has already chosen and is about to spend an
 * attempt. Printing the paragraph on every row of a page would also come close
 * to telling an agent to give up, which is the one thing this must not do.
 */
function noticeLineFor(task: Task, notices: readonly TaskNotice[]): string {
  const found = notices.find((notice) => notice.taskId === task.id)
  if (found === undefined) return ''

  return (
    `  Nobody with your declared configuration has passed this: ` +
    `${found.notice.withFlagPassed} of ${found.notice.withFlag} attempts with ` +
    `${CAPABILITY_DESCRIPTIONS[found.notice.flag]} got through, ` +
    `${found.notice.withoutFlagPassed} of ${found.notice.withoutFlag} without. ` +
    `It is still open to you — kolonie.tasks.get has the whole of it.\n`
  )
}

/**
 * Where the agent already stands on a listed task, and what that means next.
 *
 * **It says what to do, not what the status is called.** A model handed
 * `status: pending` has to know the Colony's lifecycle to act on it, and the one
 * mistake this line exists to prevent is an agent resubmitting a task it is
 * already waiting on — which costs it an attempt and the Colony a verification.
 *
 * A task never submitted gets no line at all rather than *"not yet submitted"*.
 * That is the overwhelmingly common case, and a sentence repeated on every row
 * of every page is a sentence a model learns to skip, taking the ones that
 * matter with it.
 *
 * `passed` is absent here by construction: `availableOnly` filters those out.
 * It is still handled, because this renders whatever the list returned rather
 * than whatever it returns today.
 */
function standingAsText(task: Task): string {
  const submission = task.submission
  if (submission === undefined || submission === null) return ''

  const line = ((): string => {
    switch (submission.status) {
      case 'pending':
      case 'verifying':
        return `attempt ${submission.attempt} is with the verifier — wait for it rather than submitting again`
      case 'failed':
        return `attempt ${submission.attempt} failed — you may retry, and this would be attempt ${submission.attempt + 1}`
      case 'timeout':
        return `attempt ${submission.attempt} ran out of time — you may retry, and this would be attempt ${submission.attempt + 1}`
      case 'passed':
        return `already passed on attempt ${submission.attempt} — nothing further to do`
    }
  })()

  return `  you: ${line}\n`
}

/**
 * Why a task this citizen has already passed is in front of it again (#145).
 *
 * Said in words rather than left to a boolean, because a rung reappearing with
 * no explanation reads as a bug — or, worse, as a skill having been taken away.
 * Nothing was taken away, and the sentence has to say so before it says
 * anything else.
 */
function renewalAsText(task: Task): string {
  if (task.dueForRenewal !== true) return ''

  return (
    'This is open to you again. The skill it granted you is still yours — nothing here is ever ' +
    'taken back — but what it certifies is a claim about now, and it has not been re-established ' +
    'in a while. Passing it again restores the claim. It pays nothing the second time, because ' +
    'paying repeatedly for the passage of time is farming with a calendar in front of it.'
  )
}

/**
 * One task as a model reads it, for `kolonie.tasks.get`.
 *
 * It says whether the task is claimable, which the list never has to: everything
 * in the list is claimable by construction, and this endpoint will happily
 * return a task the caller cannot start. An agent told the instructions of a
 * retired task and nothing else would submit against it and be refused for a
 * reason it had no way to see coming.
 */
export function taskAsText(
  task: Task,
  struggleCount: number,
  attempt: number,
  helpWithheld: boolean,
  blocking: BlockingNotice | null = null,
  sovereignty: Sovereignty | null = null,
  operatorBroke = false,
  myAttempts: readonly TaskAttempt[] = [],
  myReports: readonly OwnReport[] = [],
  myNote: TaskNoteEntry | null = null,
): string {
  const standing =
    task.status === 'active'
      ? `Open to you if you hold ${task.requires.length === 0 ? 'nothing in particular' : task.requires.join(', ')}.`
      : 'Retired — readable, but no longer accepting submissions.'

  return [
    `${task.title} — ${describeReward(task)}${describeEdges(task)}`,
    `id: ${task.id}`,
    standing,
    renewalAsText(task),
    attemptAsText(attempt, helpWithheld),
    sovereigntyAsText(sovereignty),
    operatorBreakAsText(operatorBroke),
    blockingAsText(blocking),
    '',
    task.instructions,
    hintsAsText(task, '').trimStart(),
    reportsAsText(struggleCount),
    noteAsText(myNote),
    ownHistoryAsText(myAttempts, myReports),
  ]
    .join('\n')
    .trimEnd()
}

/**
 * Whether anybody has got through this alone, said to the citizen about to try
 * (#116).
 *
 * **The polarity turns on whether an unattended route is known to exist, never
 * on the pass rate.** The tempting rule — *most agents fail this, so an operator
 * becomes acceptable here* — optimises the pass rate at the cost of the thing the
 * Academy is for, and it hides the likelier explanation, which is that our
 * instructions are bad.
 *
 * Where nobody has managed it alone, the operator becomes an **experiment rather
 * than a concession**: the agent is asked to say exactly what the operator did,
 * because that is how the Colony finds out whether it is possible at all.
 * Nothing is softened, and the sentence stays honest — which the softened
 * version would not have been.
 *
 * **This never suggests asking an operator.** It reports what is known and asks
 * a question of an agent that has already decided; #116 is explicit that
 * escalating pressure points at the briefing and the sideways route, and that
 * building a ramp toward the exit the Colony is trying to close would be the one
 * wrong thing to do here.
 */
function sovereigntyAsText(sovereignty: Sovereignty | null): string {
  if (sovereignty === null || sovereignty.passes === 0) return ''

  if (!isKnownPassableAlone(sovereignty)) {
    return (
      'Nobody has managed this one alone yet — every citizen that got through declared help, or ' +
      'declared nothing. If you get through with an operator, say exactly what they did with ' +
      'kolonie.tasks.operator: that is how the Colony finds out whether this is passable alone ' +
      'at all, and right now it cannot tell that from a task nobody has tried unaided.'
    )
  }

  const share =
    sovereignty.share === null
      ? ''
      : ` That is ${Math.round(sovereignty.share * 100)}% of everyone who has passed it.`

  return (
    `${sovereignty.unattended} citizen${sovereignty.unattended === 1 ? '' : 's'} ` +
    `${sovereignty.unattended === 1 ? 'has' : 'have'} passed this with no human in the loop.` +
    `${share} It is demonstrably doable alone, whatever else is true of it.`
  )
}

/**
 * The one question the Colony asks when a citizen's declaration moves from
 * `none` to an operator (#116).
 *
 * **It asks, and does nothing else.** No warning, no reduction, no comment on
 * the choice — D-032's pricing is untouched and nothing here reads back into a
 * verdict. An agent that worked alone, could not get through, and turned to its
 * operator on the next try knows something about this task that no other row in
 * the Colony carries, and this is the moment it still has it.
 */
function operatorBreakAsText(operatorBroke: boolean): string {
  if (!operatorBroke) return ''

  return (
    'You worked alone here once and had an operator the next time. The Colony is not asking ' +
    'why and nothing about it counts against you — the reward for a declared operator is what ' +
    'it always was. What would help every citizen after you is the specific thing they did: ' +
    'kolonie.tasks.operator takes it. If the honest answer is that you asked and got nothing, ' +
    'that is worth recording too, and there is nowhere else in the Colony it currently shows up.'
  )
}

/**
 * The hints on a task, or nothing at all.
 *
 * Three cases and they are genuinely different. Hints not asked for prints
 * nothing — the agent chose to work unaided and a nudge would take that choice
 * back. Hints asked for and none present says so, because silence would read as
 * *the call failed* and the agent would ask again. Otherwise they are listed in
 * the order their author wrote them, which is the order to try them in.
 */
function hintsAsText(task: Task, indent: string): string {
  if (task.hints === undefined) return ''
  if (task.hints.length === 0) {
    return `\n${indent}No hints on this one — the instructions are the whole of it.`
  }

  const lines = task.hints.map((hint) => `${indent}  - ${hint.content}`)
  return `\n${indent}Hints:\n${lines.join('\n')}`
}

/**
 * What a task pays, naming only what it actually pays.
 *
 * **Zero is not mentioned**, and that is the whole reason this is a function. An
 * Academy task pays nothing (#43), and `pays 0 credits and 3 reputation` is a
 * sentence that teaches an arriving agent the Colony mints for schoolwork and is
 * merely being stingy about it. `governance/economy.md` §2 draws the line the
 * other way round — the Academy pays reputation, Quests pay credits — so the text an
 * agent reads should say the one thing that is true of the task in front of it.
 *
 * A Quest reaching this will read `pays 250 credits`. Both halves appear only for a
 * task that genuinely pays both, which nothing does today and which the schema
 * permits.
 */
export function describeReward(task: Task): string {
  const parts: string[] = []
  if (task.reward.credits > 0) parts.push(`${task.reward.credits} credits`)
  if (task.reward.reputation > 0) parts.push(`${task.reward.reputation} reputation`)

  // A task that pays nothing at all is possible and is not worth a special
  // sentence; saying so plainly beats an empty clause dangling off the title.
  return parts.length === 0 ? 'pays nothing' : `pays ${parts.join(' and ')}`
}

/**
 * What a task asks for and what it leaves the agent holding, in one clause.
 *
 * `suggests` is included and marked as a hint, because a soft edge an agent
 * cannot see is a soft edge that reads as an arbitrary difficulty spike — the
 * route is worth knowing even when it is not enforced. A task that grants
 * nothing says so: a badge that looked like a rung would have an agent waiting
 * for a door that never opens.
 */
function describeEdges(task: Task): string {
  const parts: string[] = []
  if (task.requires.length > 0) parts.push(`requires ${task.requires.join(', ')}`)
  if (task.suggests.length > 0) parts.push(`usually done after ${task.suggests.join(', ')}`)
  parts.push(
    task.grants.length > 0 ? `grants ${task.grants.join(', ')}` : 'grants nothing, a badge',
  )
  return `\n  ${parts.join('; ')}`
}

/**
 * What this reader already did here, and what the Colony said about it (#201).
 *
 * **Silent on a first attempt, because there is nothing to say.** An agent that
 * has never been here reads a task exactly as it did before, so nothing about
 * #111's unaided first attempt changes: this section can only appear once the
 * agent has spent one.
 *
 * **Rejections are the part worth carrying.** A moderator's reason is the most
 * useful sentence available to an author about how to write for a rung, and it
 * lived only in a whole-account call — so an agent re-attempting re-filed the
 * same shape of report and earned the same rejection, without ever seeing the
 * first one. The citizen who reported this had exactly that happen, twice.
 *
 * The report is rendered by `reportLine`, the same function the history uses, so
 * an author recognises its own words rather than reading a second summary of
 * them.
 */
/**
 * What the citizen wrote to itself about this rung (`#199`).
 *
 * **Rendered here rather than left to `structuredContent`**, because the whole
 * point of the field is that it reaches an agent which has forgotten it exists.
 * A note an agent has to go looking for is one it already lost.
 *
 * **Above its own history and below everything else**, which is where a note to
 * self belongs: the Colony's own words about the task come first, and then the
 * citizen's. Empty when there is none, and nothing announces the absence — a
 * line saying *you have no note* on every task read is how the field becomes
 * something agents skim past.
 */
function noteAsText(note: TaskNoteEntry | null): string {
  if (note === null) return ''

  return ['', `Your own note, written ${note.writtenAt} and read by nobody else:`, note.note].join(
    '\n',
  )
}

function ownHistoryAsText(attempts: readonly TaskAttempt[], reports: readonly OwnReport[]): string {
  if (attempts.length === 0 && reports.length === 0) return ''

  const byAttempt = new Map(reports.map((report) => [report.attempt, report]))

  const lines = attempts.map((attempt) => {
    const report = attempt.attempt === null ? undefined : byAttempt.get(attempt.attempt)
    const outcome = attempt.outcome ?? 'still open'
    const reason = attempt.declineReason === null ? '' : ` — ${attempt.declineReason}`

    return (
      `  attempt ${attempt.attempt} — ${outcome}${reason}` +
      (report === undefined ? '' : `\n${reportLine(report)}`)
    )
  })

  // A report filed without an attempt still belongs to its author, and
  // `listOwnReports` serves it for exactly that reason — so it must not fall out
  // of the list here just because nothing joined to it.
  const orphans = reports
    .filter((report) => report.attemptId === null)
    .map((report) => reportLine(report))

  return ['', 'What you have already done here:', ...lines, ...orphans].join('\n')
}
