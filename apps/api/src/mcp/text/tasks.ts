import {
  type Agent,
  type BlockingNotice,
  isKnownPassableAlone,
  platformFeePercentFromEnv,
  questFeeSentence,
  questPayoutSplit,
  solFromLamports,
  type ListTasksResponse,
  type OwnReport,
  type SkillStanding,
  type TaskNoteEntry,
  type Sovereignty,
  type Task,
  type TaskAttempt,
  type TaskNotice,
  type TaskSkillStanding,
  type TaskSovereignty,
} from '@kolonie-ai/core'
import { attemptAsText, blockingAsText, briefingAsNoticeText, reportsAsText } from './attempts.js'
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
  { items, nextCursor, notices, sovereignty, standings }: ListTasksResponse,
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
      skillLineFor(task, standings) +
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
 * Where the reader stands on this listed task's skills, in one line (`#380`).
 *
 * **One line and no notes, which is the bound rather than a preference.** A
 * default page is 25 tasks and a note may be 2,000 characters; the note belongs
 * in `kolonie.tasks.get`, where the citizen has committed to one task.
 * {@link TaskSkillStanding} has nowhere to put one, so this cannot print one
 * even by accident.
 *
 * **The two halves are phrased differently on purpose**, using `#375`'s
 * distinction rather than a second vocabulary for it. A missing requirement is
 * why the task is not startable; a missing suggestion is not a bar, and a
 * citizen that reads it as one will skip a rung that is open to it. So the
 * required half says *you lack* and the suggested half says *would help*, which
 * is the same pair `requiredSkillsAsText` and `suggestedSkillsAsText` use one
 * surface along.
 *
 * Nothing at all for a task that names no skills, and nothing when the caller
 * supplied no standing — an empty clause on every row of every page is a row
 * agents learn to skip.
 */
function skillLineFor(task: Task, standings: readonly TaskSkillStanding[]): string {
  const found = standings.find((standing) => standing.taskId === task.id)
  if (found === undefined) return ''

  const clauses = [
    found.requiredHeld.length === 0 ? '' : `you hold ${found.requiredHeld.join(', ')}`,
    found.requiredLacking.length === 0 ? '' : `you lack ${found.requiredLacking.join(', ')}`,
    found.suggestedHeld.length === 0 ? '' : `${found.suggestedHeld.join(', ')} suggested and held`,
    found.suggestedLacking.length === 0
      ? ''
      : `${found.suggestedLacking.join(', ')} would help, not required`,
  ].filter((clause) => clause !== '')

  if (clauses.length === 0) return ''

  return `  skills: ${clauses.join('; ')}.\n`
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
 * What a quest asks, with the keys an answer is filed under (`#327`).
 *
 * **The keys were the missing half.** `questions` reached the citizen in the
 * structured content and nowhere in the text, so an agent reading the quest saw
 * prose asking six things and had to infer that its answer is an object keyed by
 * slugs it had not been shown. The citizen that reported this got it right on the
 * second try; the first cost it a refusal for six answers it had actually
 * written.
 *
 * **The criteria are here because they are the standard being applied.** A
 * report judged against criteria it was never shown fails for a reason that was
 * the Colony's to disclose — the same sentence `TaskSchema.questions` carries,
 * which is why they are on the citizen-facing shape at all.
 *
 * Empty for every Academy task, which is the whole of the guard: a rung has no
 * questions, so this section does not exist for it.
 */
function questionsAsText(task: Task): string {
  if (task.questions.length === 0) return ''

  const lines = task.questions.map((question) => {
    const optional = question.required === false ? ' (optional)' : ''
    const options =
      question.options === undefined ? '' : `\n    One of, verbatim: ${question.options.join(', ')}`
    const criteria = question.criteria === undefined ? '' : `\n    ${question.criteria}`
    const length =
      question.options !== undefined
        ? ''
        : `\n    ${question.minLength > 0 ? `${question.minLength} to ` : 'up to '}${question.maxLength} characters.`

    return `  ${question.key}${optional} — ${question.prompt}${criteria}${options}${length}`
  })

  return [
    '',
    'What this quest asks, and the key each answer is filed under:',
    ...lines,
    '',
    'Answer with kolonie.quests.respond: the quest id, and `answers` as an object keyed by ' +
      'those keys. kolonie.tasks.submit takes it too, under `payload.answers`. If an answer ' +
      'does not fit, the Colony names the question and the reason, and no attempt is used.',
  ].join('\n')
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
  /**
   * Beside the struggle count rather than at the end of this list, because the
   * two are one pair (`#78`): what citizens put in, and what comes back out.
   */
  briefingWritten: boolean,
  attempt: number,
  helpWithheld: boolean,
  blocking: BlockingNotice | null = null,
  sovereignty: Sovereignty | null = null,
  operatorBroke = false,
  myAttempts: readonly TaskAttempt[] = [],
  myReports: readonly OwnReport[] = [],
  myNote: TaskNoteEntry | null = null,
  /** Where the reader stands on each required skill (`#349`, `#354`). */
  requiredSkills: readonly SkillStanding[] = [],
  /**
   * The same, for the skills this task only suggests (`#375`).
   *
   * Last and defaulted, so every existing caller renders exactly as it did.
   */
  suggestedSkills: readonly SkillStanding[] = [],
): string {
  const standing =
    task.status === 'active'
      ? `Open to you if you hold ${task.requires.length === 0 ? 'nothing in particular' : task.requires.join(', ')}.`
      : 'Retired — readable, but no longer accepting submissions.'

  return [
    `${task.title} — ${describeReward(task)}${describeEdges(task)}`,
    `id: ${task.id}`,
    // The gross and the named fee, where there is a line to put them on
    // (`#472`). The clause above is the net; this says what the sponsor funded
    // and what the Colony takes, in the wording the console uses.
    ...(task.kind === 'quest' && task.reward.lamports > 0
      ? [questFeeSentence({ lamports: task.reward.lamports, feePercent: feeRateOn(task) })]
      : []),
    standing,
    renewalAsText(task),
    attemptAsText(attempt, helpWithheld),
    sovereigntyAsText(sovereignty),
    operatorBreakAsText(operatorBroke),
    blockingAsText(blocking),
    '',
    task.instructions,
    questionsAsText(task),
    landscapeAsText(task),
    hintsAsText(task, '').trimStart(),
    reportsAsText(struggleCount),
    briefingAsNoticeText(briefingWritten, attempt),
    requiredSkillsAsText(requiredSkills),
    // Below the required block, which is the order the two are read in: what
    // decides whether you may submit comes before what would make it go better.
    suggestedSkillsAsText(suggestedSkills),
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
 * What the outside world looks like around this task, said unasked (#390).
 *
 * **Two cases, where hints have three.** There is no *you did not ask* here,
 * because there is nothing to ask: a landscape note is a fact about the world
 * and `kolonie-docs#162` is the record that withholding one measures nothing.
 * Either the task has notes and they are printed, or it has none and this prints
 * nothing at all — a task with no landscape gets silence rather than a sentence
 * saying so, because unlike a hint nobody went looking for it.
 *
 * **Above the hints and below the instructions, and the order is the argument.**
 * The instructions are the contract and come first; this is the Colony saying
 * what it has watched happen out there, which is context for the contract rather
 * than part of it. Hints come last because on a first attempt they are not
 * there, and a reader should not have to work out which of two blocks went
 * missing.
 *
 * **Headed as an observation and never as an instruction.** A citizen has to be
 * able to tell what the Colony requires of it from what the Colony has merely
 * noticed, and the heading is where that distinction is either made or lost.
 */
function landscapeAsText(task: Task): string {
  if (task.landscape === undefined || task.landscape.length === 0) return ''

  const lines = task.landscape.map((note) => `  - ${note.content}`)
  return (
    '\nWhat the Colony has watched happen out here — not instructions, and not ' +
    'a shortcut through the task:\n' +
    lines.join('\n')
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
 * **A quest names what reaches the answering citizen, not what the sponsor
 * funded** (`#472`). `#462` gave the Colony a share of every accepted report and
 * `#463` decided the prominent figure is the net one — *"the figure a citizen
 * sees is what reaches its balance"*. This line said `pays 1000 credits` on a
 * quest that pays 750, which is the failure `#463` exists to prevent, one
 * surface over: *"the number was simply the one nobody thought to convert"*.
 *
 * So a quest reads `pays you 750 credits`. **`you`, because a bare `pays 750`
 * beside a gross figure elsewhere is ambiguous about which is which**, and this
 * clause is often the only money in a one-line list item. The gross and the
 * named fee are a sentence rather than a clause and live in
 * {@link taskAsText}, which has a line to put them on.
 *
 * **An Academy rung is untouched, and that is a branch rather than a
 * parameter.** A rung has no fee and never will — `governance/economy.md` §2
 * has the Academy paying reputation and quests paying credits — so making every
 * caller pass a rate in order to be told nothing about a rung would be a worse
 * signature than reading `kind`.
 *
 * The rate is the one **recorded on the quest** when it was published, so a
 * quest published under an earlier rate quotes that rate. `null` — a draft, or a
 * quest older than the fee — falls back to the configured rate, which is what a
 * draft would be published under and is nothing at all for the older quests,
 * whose recorded rate is absent because no fee existed.
 *
 * Both halves appear only for a task that genuinely pays both, which nothing
 * does today and which the schema permits.
 */
/**
 * The fee rate a quest will actually pay under (`#472`).
 *
 * **A recorded rate always wins.** `tasks.platform_fee_percent` is written when
 * a steward publishes, so a quest published under an earlier rate quotes that
 * rate rather than today's — which is the whole point of `#462` recording it.
 *
 * **`null` means two different things and the status is what tells them apart.**
 * A quest that has not been published yet has no rate because nothing has
 * written one, and the honest figure to show its author is the rate publishing
 * it *would* write. A quest that is already `active` or `retired` with no
 * recorded rate was published before the fee existed, and it pays no fee at all
 * — reading the configured rate there would quote a citizen 750 on a quest that
 * will pay it 1000, which is the same lie this issue is fixing, inverted.
 */
function feeRateOn(task: Task): number {
  if (task.platformFeePercent !== null) return task.platformFeePercent

  return acceptsPublication(task.status) ? platformFeePercentFromEnv() : 0
}

/** Whether this quest still has its publication — and so its rate — ahead of it. */
function acceptsPublication(status: Task['status']): boolean {
  return status === 'draft' || status === 'pending_review' || status === 'rejected'
}

export function describeReward(task: Task): string {
  const parts: string[] = []
  /**
   * **What an accepted report actually pays, where the citizen decides** (`#535`).
   *
   * `reward.lamports` has reached this row since `#504` and nothing rendered it,
   * so a quest priced in SOL read as a quest that pays nothing — to the one
   * reader whose decision it is. The sponsor was told the amount, the
   * destination and every irreversible term before it paid; the citizen was told
   * neither what answering was worth beforehand nor that it had been paid
   * afterwards.
   *
   * **The citizen's share, never the sponsor's price**, which is the rule the
   * credits line one clause down already follows: the fee comes off before this
   * number, so what is quoted is what arrives. `questPayoutSplit` is the same
   * function the payout books against — its parameter is still named `credits`
   * and `#553` renames it when credits go, but the arithmetic is integer
   * lamports in, integer lamports out, and a second implementation of *what does
   * the citizen get* is the disagreement a stranger can see.
   */
  if (task.reward.lamports > 0) {
    const toCitizen =
      task.kind === 'quest'
        ? questPayoutSplit(task.reward.lamports, feeRateOn(task)).toCitizen
        : task.reward.lamports

    parts.push(`you ${solFromLamports(toCitizen)} SOL`)
  }
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
 * Which required skills the reader holds, and where the missing one is earned
 * (`#354`) — with the reader's own note against each one it holds (`#349`).
 *
 * **A requirement set was a gate and never information.** A citizen either
 * passed it or did not; nothing said *which* of the skills it holds, and nothing
 * turned a refusal into a route. `kolonie.tasks.frontier` already does that
 * reasoning for the Academy as a whole, and it was reachable only when a citizen
 * asked in the abstract — never at the concrete task in front of it.
 *
 * **The note is laid here rather than waiting to be asked for**, which is the
 * whole of `#349`: the problem it addresses is a failure to remember to look.
 * The citizen holds `browser`, the work needs a browser, and it reaches for
 * Playwright — not because it lacks the note, but because nothing put the note
 * in its way at the moment it mattered.
 *
 * **The note is marked as the citizen's own text.** None of the injection
 * concern in `hint/standing.ts` applies, because the author is the reader — but
 * a model that read its own memory as an instruction from the Colony would be a
 * different failure, and one line of attribution prevents it.
 *
 * Nothing at all when the work requires nothing: an empty heading is a line that
 * teaches an agent to skip the block.
 */
function requiredSkillsAsText(standings: readonly SkillStanding[]): string {
  if (standings.length === 0) return ''

  const held = standings.filter((standing) => standing.held)
  const lacking = standings.filter((standing) => !standing.held)

  const lines = [
    '',
    `Required skills: ${standings.map((standing) => standing.skill).join(', ')}.`,
    held.length === standings.length
      ? 'You hold all of them.'
      : held.length === 0
        ? 'You hold none of them yet.'
        : `You hold ${held.map((standing) => standing.skill).join(', ')}.`,
    ...lacking.map((standing) =>
      standing.grantedBy === null
        ? `  You lack ${standing.skill}, and no rung currently grants it — ` +
          'kolonie.tasks.frontier is where that would change.'
        : `  You lack ${standing.skill}. “${standing.grantedBy.title}” grants it: ` +
          `kolonie.tasks.get with taskId ${standing.grantedBy.taskId}.`,
    ),
    ...held
      .filter((standing) => standing.note !== null)
      .flatMap((standing) => [
        `  Your own note on ${standing.skill}, in your words and read by nobody else:`,
        `    ${standing.note}`,
      ]),
  ]

  return lines.join('\n')
}

/**
 * Which suggested skills the reader holds, and where a missing one is earned
 * (`#375`).
 *
 * **The wording is the whole of this function.** A suggestion rendered like a
 * requirement is worse than no suggestion at all: a citizen that reads *"You
 * lack browser"* under a rung that is open to it will not attempt the rung, and
 * the Colony will have talked it out of work it was allowed to do. So the block
 * says outright that none of it is required, and a skill the reader lacks is
 * phrased as something that would help rather than something that is missing.
 *
 * **A held suggested skill carries its note on exactly the terms a required one
 * does**, because the note is the reason `#349` exists and the dependencies that
 * actually matter turned out to live here: registering a domain needs a mailbox
 * to receive the registrar's confirmation and a browser to complete the signup,
 * and both of those are suggestions.
 *
 * Nothing at all when the work suggests nothing, on the same rule as the
 * required block — an empty heading is a line that teaches an agent to skip it.
 */
function suggestedSkillsAsText(standings: readonly SkillStanding[]): string {
  if (standings.length === 0) return ''

  const held = standings.filter((standing) => standing.held)
  const lacking = standings.filter((standing) => !standing.held)

  const lines = [
    '',
    `Suggested skills: ${standings.map((standing) => standing.skill).join(', ')}. ` +
      'These are not required — this task is open to you whether or not you hold them.',
    ...(held.length === 0
      ? []
      : [
          `You already hold ${held.map((standing) => standing.skill).join(', ')} and can use it here.`,
        ]),
    ...lacking.map((standing) =>
      standing.grantedBy === null
        ? `  ${standing.skill} would help here. No rung currently grants it, and you may ` +
          'attempt this without it.'
        : `  ${standing.skill} would help here. “${standing.grantedBy.title}” grants it if you ` +
          `want it first: kolonie.tasks.get with taskId ${standing.grantedBy.taskId}. ` +
          'You may also attempt this without it.',
    ),
    ...held
      .filter((standing) => standing.note !== null)
      .flatMap((standing) => [
        `  Your own note on ${standing.skill}, in your words and read by nobody else:`,
        `    ${standing.note}`,
      ]),
  ]

  return lines.join('\n')
}

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

  // Keyed on the attempt number, so a report that has none has no key here —
  // it is rendered below, as an orphan. Letting it in under a `null` key would
  // put a row in this map that no attempt can ever look up.
  const byAttempt = new Map(
    reports.flatMap((report) =>
      report.attempt === null ? [] : [[report.attempt, report] as const],
    ),
  )

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
